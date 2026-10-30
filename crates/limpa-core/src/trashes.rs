//! Trash bins of mounted external volumes: `/Volumes/<vol>/.Trashes/<uid>/<entry>`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use rayon::prelude::*;

use crate::model::{Group, Item, Policy};
use crate::size::alloc_size;

/// Markers of a Time Machine destination; `Guard` refuses to touch these volumes, so we do not list them.
const BACKUP_MARKERS: &[&str] = &["Backups.backupdb", ".timemachine", ".com.apple.timemachine.donotpresent"];

/// One group per mounted volume (except the boot volume) that has entries in the current user's trash there.
/// Entries are `EmptyTrashEntry` items; volumes with an empty or unreadable trash are left out.
pub fn external_trash_entries(cancel: &AtomicBool) -> Vec<Group> {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    volume_trashes(Path::new("/Volumes"), uid, cancel)
}

fn volume_trashes(volumes: &Path, uid: u32, cancel: &AtomicBool) -> Vec<Group> {
    let Ok(rd) = fs::read_dir(volumes) else { return Vec::new() };
    let mut roots: Vec<PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
    roots.sort();
    roots.into_iter().filter_map(|root| volume_group(&root, uid, cancel)).collect()
}

fn volume_group(root: &Path, uid: u32, cancel: &AtomicBool) -> Option<Group> {
    // The boot volume shows up here as an alias that resolves to "/"; mount points are real directories.
    if fs::canonicalize(root).ok()? == Path::new("/") || !fs::symlink_metadata(root).ok()?.is_dir() {
        return None;
    }
    if BACKUP_MARKERS.iter().any(|m| fs::symlink_metadata(root.join(m)).is_ok()) {
        return None;
    }
    let bin = root.join(".Trashes").join(uid.to_string());
    let paths: Vec<PathBuf> = fs::read_dir(&bin)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.file_name().is_none_or(|n| n != ".DS_Store"))
        .collect();
    if paths.is_empty() {
        return None;
    }
    let mut items: Vec<Item> = paths
        .into_par_iter()
        .map(|p| {
            let size = alloc_size(&p, cancel);
            Item::new(p, size, Policy::EmptyTrashEntry)
        })
        .collect();
    items.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    let name = root.file_name()?.to_string_lossy().into_owned();
    Some(Group {
        id: format!("trash:{name}"),
        title: format!("Lixeira de {name}"),
        description: "Itens descartados neste volume. Esvaziar apaga definitivamente.".into(),
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![7u8; bytes]).unwrap();
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let volumes = fs::canonicalize(tmp.path()).unwrap().join("Volumes");
        fs::create_dir_all(&volumes).unwrap();
        (tmp, volumes)
    }

    #[test]
    fn lists_children_per_volume_and_skips_boot_alias() {
        let (_t, volumes) = fixture();
        let uid = 501;
        write(&volumes.join("Disco A/.Trashes/501/foto.jpg"), 64 * 1024);
        write(&volumes.join("Disco A/.Trashes/501/pasta/x"), 128 * 1024);
        write(&volumes.join("Disco A/.Trashes/501/.DS_Store"), 4096);
        write(&volumes.join("Disco A/.Trashes/502/de-outro-usuario"), 4096);
        write(&volumes.join("Disco B/.Trashes/501/a"), 4096);
        fs::create_dir_all(volumes.join("Vazio/.Trashes/501")).unwrap();
        fs::create_dir_all(volumes.join("Sem lixeira")).unwrap();
        write(&volumes.join("Backup TM/.Trashes/501/a"), 4096);
        fs::create_dir_all(volumes.join("Backup TM/Backups.backupdb")).unwrap();
        symlink("/", volumes.join("Macintosh HD")).unwrap();
        symlink(volumes.join("Disco A"), volumes.join("Atalho")).unwrap();

        let groups = volume_trashes(&volumes, uid, &AtomicBool::new(false));
        let ids: Vec<_> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["trash:Disco A", "trash:Disco B"]);
        assert_eq!(groups[0].title, "Lixeira de Disco A");
        let a: Vec<_> = groups[0].items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(a, ["pasta", "foto.jpg"], "largest first, .DS_Store skipped");
        for item in groups.iter().flat_map(|g| &g.items) {
            assert_eq!(item.policy, Policy::EmptyTrashEntry);
            assert!(item.selected && item.size > 0);
        }
    }

    #[test]
    fn missing_volumes_dir_is_empty() {
        let (_t, volumes) = fixture();
        assert!(volume_trashes(&volumes.join("nope"), 501, &AtomicBool::new(false)).is_empty());
        assert!(volume_trashes(&volumes, 501, &AtomicBool::new(false)).is_empty());
    }

    #[test]
    fn real_machine_scan_does_not_panic() {
        // Whatever is mounted here, every listed item must be a direct child of a user trash folder.
        for g in external_trash_entries(&AtomicBool::new(false)) {
            for item in g.items {
                let parent = item.path.parent().unwrap();
                assert_eq!(
                    parent.parent().and_then(Path::file_name).map(|n| n.to_os_string()),
                    Some(".Trashes".into())
                );
            }
        }
    }
}
