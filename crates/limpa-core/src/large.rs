use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::prelude::*;

use crate::model::{Group, Item, Policy, Progress};
use crate::size::own_bytes;

/// Directories that are a single document or library to the user; never descended into.
const PACKAGE_EXTS: &[&str] = &[
    "app",
    "photoslibrary",
    "photolibrary",
    "musiclibrary",
    "tvlibrary",
    "imovielibrary",
    "fcpbundle",
    "logicx",
    "band",
    "bundle",
    "framework",
    "plugin",
    "kext",
    "xcodeproj",
    "xcworkspace",
    "xcarchive",
    "pkg",
    "mpkg",
    "rtfd",
    "pages",
    "numbers",
    "key",
    "lrlibrary",
    "lrdata",
    "aplibrary",
    "sparsebundle",
];

type Kind = (&'static str, &'static str, &'static str, &'static [&'static str]);

/// (id, title, description, extensions); the last entry is the catch-all.
const KINDS: &[Kind] = &[
    (
        "video",
        "Vídeos",
        "Filmes e gravações que costumam ocupar muito espaço.",
        &["mp4", "mov", "mkv", "avi", "m4v", "webm", "wmv", "flv", "mpg", "mpeg"],
    ),
    (
        "archive",
        "Arquivos compactados",
        "Pacotes que talvez você já tenha extraído.",
        &["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst"],
    ),
    (
        "disk_image",
        "Imagens de disco",
        "Instaladores e imagens que costumam ficar esquecidos.",
        &["dmg", "iso", "img", "sparseimage"],
    ),
    (
        "audio",
        "Áudio",
        "Músicas e gravações de áudio grandes.",
        &["mp3", "wav", "aiff", "aif", "flac", "m4a", "aac", "ogg"],
    ),
    ("other", "Outros", "Outros arquivos grandes na sua pasta pessoal.", &[]),
];

/// Large user files under home, grouped by kind: `video`, `archive`,
/// `disk_image`, `audio`, `other`.
pub fn scan_large(home: &Path, min_bytes: u64, p: &Progress) -> Vec<Group> {
    let Ok(md) = fs::metadata(home) else { return Vec::new() };
    let found = AtomicU64::new(0);
    let files = walk(home, true, md.dev(), min_bytes, &found, p);

    let mut groups: Vec<Vec<Item>> = KINDS.iter().map(|_| Vec::new()).collect();
    for (path, bytes) in files {
        let mut item = Item::new(path, bytes, Policy::MoveToTrash);
        // User files are never pre-selected.
        item.selected = false;
        groups[kind_of(&item.path)].push(item);
    }
    KINDS
        .iter()
        .zip(groups)
        .filter(|(_, items)| !items.is_empty())
        .map(|(&(id, title, description, _), mut items)| {
            items.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
            Group { id: id.into(), title: title.into(), description: description.into(), items }
        })
        .collect()
}

fn walk(dir: &Path, is_home: bool, dev: u64, min: u64, found: &AtomicU64, p: &Progress) -> Vec<(PathBuf, u64)> {
    if p.cancelled() {
        return Vec::new();
    }
    p.report(dir, found.load(Ordering::Relaxed));
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let entries: Vec<_> = rd.filter_map(Result::ok).collect();
    entries
        .par_iter()
        .flat_map_iter(|e| {
            // DirEntry::metadata does not traverse symlinks on unix.
            let Ok(md) = e.metadata() else { return Vec::new() };
            let name = e.file_name();
            let name = name.to_string_lossy();
            if md.dev() != dev || name.starts_with('.') || (is_home && name == "Library") {
                return Vec::new();
            }
            let path = e.path();
            if md.is_dir() {
                if is_package(&path) {
                    return Vec::new();
                }
                return walk(&path, false, dev, min, found, p);
            }
            // Allocated, not logical, size: evicted iCloud placeholders weigh nothing.
            let bytes = own_bytes(&md);
            if md.is_file() && bytes >= min {
                found.fetch_add(bytes, Ordering::Relaxed);
                return vec![(path, bytes)];
            }
            Vec::new()
        })
        .collect()
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_lowercase())
}

fn is_package(path: &Path) -> bool {
    ext_lower(path).is_some_and(|e| PACKAGE_EXTS.contains(&e.as_str()))
}

fn kind_of(path: &Path) -> usize {
    let ext = ext_lower(path).unwrap_or_default();
    KINDS.iter().position(|k| k.3.contains(&ext.as_str())).unwrap_or(KINDS.len() - 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::Guard;
    use std::io::Write;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    const KB64: usize = 64 * 1024;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(&vec![7u8; bytes]).unwrap();
        f.sync_all().unwrap();
    }

    fn fake_home() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(tmp.path()).unwrap().join("home");
        fs::create_dir_all(&home).unwrap();
        (tmp, home)
    }

    /// Scans and asserts that the guard accepts every produced item and none is pre-selected.
    fn scan(home: &Path, min: u64) -> Vec<Group> {
        let groups = scan_large(home, min, &Progress::silent());
        let guard = Guard::new(home);
        for item in groups.iter().flat_map(|g| &g.items) {
            assert!(guard.check(&item.path, &item.policy).is_ok(), "guard rejects {:?}", item.path);
            assert!(!item.selected && item.note.is_none());
            assert_eq!(item.policy, Policy::MoveToTrash);
        }
        groups
    }

    fn all_names(groups: &[Group]) -> Vec<String> {
        let mut v: Vec<_> = groups.iter().flat_map(|g| g.items.iter().map(|i| i.name.clone())).collect();
        v.sort();
        v
    }

    #[test]
    fn threshold_uses_allocated_bytes() {
        let (_t, home) = fake_home();
        write(&home.join("Documents/big.bin"), 10 * KB64);
        write(&home.join("Documents/small.bin"), 1024);
        // Sparse file: huge logical size, nothing allocated (like an evicted iCloud file).
        let sparse = fs::File::create(home.join("Documents/sparse.bin")).unwrap();
        sparse.set_len(1 << 30).unwrap();
        sparse.sync_all().unwrap();
        let groups = scan(&home, 4 * KB64 as u64);
        assert_eq!(all_names(&groups), ["big.bin"]);
    }

    #[test]
    fn skips_library_hidden_packages_and_symlinks() {
        let (_t, home) = fake_home();
        write(&home.join("Library/Movies/x.mov"), 4 * KB64);
        write(&home.join(".hidden/x.mov"), 4 * KB64);
        write(&home.join("Documents/.secret.mov"), 4 * KB64);
        write(&home.join("Apps/Foo.APP/Contents/x.mov"), 4 * KB64);
        write(&home.join("Photos.photoslibrary/original.mov"), 4 * KB64);
        write(&home.join("Documents/Sub/Library/keep.mov"), 4 * KB64);
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("out.mov"), 4 * KB64);
        std::os::unix::fs::symlink(outside.path(), home.join("linkdir")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("out.mov"), home.join("linkfile.mov")).unwrap();
        let groups = scan(&home, KB64 as u64);
        assert_eq!(all_names(&groups), ["keep.mov"]);
    }

    #[test]
    fn groups_by_kind_sorted_and_empty_omitted() {
        let (_t, home) = fake_home();
        write(&home.join("a.MP4"), 2 * KB64);
        write(&home.join("d/b.mov"), 5 * KB64);
        write(&home.join("c.zip"), 2 * KB64);
        write(&home.join("e.dmg"), 2 * KB64);
        write(&home.join("f.Flac"), 2 * KB64);
        write(&home.join("g.bin"), 2 * KB64);
        write(&home.join("noext"), 2 * KB64);
        let groups = scan(&home, KB64 as u64);
        let ids: Vec<_> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["video", "archive", "disk_image", "audio", "other"]);
        let video: Vec<_> = groups[0].items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(video, ["b.mov", "a.MP4"]);
        assert_eq!(groups[4].items.len(), 2);

        let (_t2, home2) = fake_home();
        write(&home2.join("x.iso"), 2 * KB64);
        let groups = scan(&home2, KB64 as u64);
        assert_eq!(groups.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), ["disk_image"]);
    }

    #[test]
    fn progress_reported_and_cancel_honored() {
        let (_t, home) = fake_home();
        write(&home.join("a/b/x.mov"), 4 * KB64);
        let dirs = Arc::new(AtomicU64::new(0));
        let d = dirs.clone();
        let p = Progress::new(Arc::new(AtomicBool::new(false)), move |_, _| {
            d.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(scan_large(&home, KB64 as u64, &p).len(), 1);
        assert_eq!(dirs.load(Ordering::Relaxed), 3);

        let cancelled = Progress::new(Arc::new(AtomicBool::new(true)), |_, _| {});
        assert!(scan_large(&home, KB64 as u64, &cancelled).is_empty());
    }
}
