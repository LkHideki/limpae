//! iCloud Drive: lists the files that are downloaded to this Mac and evicts their local copy.
//!
//! Evicting ("Remover do Mac") frees disk space only: the file stays in iCloud and downloads again when opened.
//! Nothing here deletes anything; the actual eviction is done by `NSFileManager`, which refuses items that
//! are not in iCloud. On top of that, [`check_evictable`] re-validates the path right before eviction.

use std::fmt;
use std::fs::{self, Metadata};
use std::io;
use std::os::macos::fs::MetadataExt as MacMetadataExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use rayon::prelude::*;

use crate::model::{Group, Item, Policy, Progress};
use crate::size::own_bytes;

/// Files smaller than this are not worth listing (20 MB, decimal).
pub const MIN_BYTES: u64 = 20_000_000;

/// `SF_DATALESS`: the file is a placeholder whose data lives only in iCloud.
const SF_DATALESS: u32 = 0x4000_0000;

/// Extensions of document packages: they are directories, so their contents are not listed one by one.
const PACKAGE_EXTS: &[&str] = &["pages", "numbers", "key", "rtfd", "band", "logicx", "photoslibrary", "sparsebundle"];

pub fn container(home: &Path) -> PathBuf {
    home.join("Library/Mobile Documents")
}

/// Data is on this Mac: blocks are allocated and the file is not a dataless placeholder.
fn materialized(md: &Metadata) -> bool {
    md.is_file() && md.blocks() > 0 && md.st_flags() & SF_DATALESS == 0
}

/// iCloud Drive files of at least `min_bytes` that occupy disk space here, largest first, none pre-selected.
/// The items carry a trash policy only because the model needs one: they are never removed, only evicted, and
/// the guard forbids this whole subtree anyway.
pub fn scan_downloaded(home: &Path, min_bytes: u64, p: &Progress) -> io::Result<Vec<Group>> {
    let root = container(home);
    // Fail early (and distinguishably) when the folder is missing or unreadable.
    fs::read_dir(&root)?;
    let mut files = walk(&root, min_bytes, p);
    files.retain(|(path, _)| is_ubiquitous(path));
    files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let items = files
        .into_iter()
        .map(|(path, bytes)| {
            let mut item = Item::new(path, bytes, Policy::MoveToTrash);
            item.selected = false;
            item
        })
        .collect();
    Ok(vec![Group {
        id: "icloud".into(),
        title: "Arquivos baixados do iCloud".into(),
        description: "Cópias locais que ocupam espaço no Mac. Os arquivos continuam no iCloud.".into(),
        items,
    }])
}

fn walk(dir: &Path, min: u64, p: &Progress) -> Vec<(PathBuf, u64)> {
    if p.cancelled() {
        return Vec::new();
    }
    p.report(dir, 0);
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let entries: Vec<_> = rd.filter_map(Result::ok).collect();
    entries
        .par_iter()
        .flat_map_iter(|e| {
            // DirEntry::metadata does not traverse symlinks on unix.
            let Ok(md) = e.metadata() else { return Vec::new() };
            if e.file_name().to_string_lossy().starts_with('.') {
                return Vec::new();
            }
            let path = e.path();
            if md.is_dir() {
                let package = path
                    .extension()
                    .is_some_and(|x| PACKAGE_EXTS.contains(&x.to_string_lossy().to_lowercase().as_str()));
                return if package { Vec::new() } else { walk(&path, min, p) };
            }
            let bytes = own_bytes(&md);
            if materialized(&md) && bytes >= min { vec![(path, bytes)] } else { Vec::new() }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvictError {
    NotAbsolute,
    Traversal,
    Missing,
    /// Not inside `~/Library/Mobile Documents` once the parent folder is resolved.
    OutsideCloud,
    Symlink,
    NotRegularFile,
    /// The path now names a different file than the one the scan found.
    Changed,
    /// Already evicted (a placeholder), or never had data here.
    NotDownloaded,
    /// The system refused or failed.
    Failed(String),
}

impl fmt::Display for EvictError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAbsolute => f.write_str("caminho não é absoluto"),
            Self::Traversal => f.write_str("caminho contém '..' ou '.'"),
            Self::Missing => f.write_str("item não existe mais"),
            Self::OutsideCloud => f.write_str("fora do iCloud Drive"),
            Self::Symlink => f.write_str("o item é um atalho (symlink)"),
            Self::NotRegularFile => f.write_str("o item não é um arquivo comum"),
            Self::NotDownloaded => f.write_str("o arquivo já não está baixado neste Mac"),
            Self::Changed => f.write_str("o item mudou desde a análise; analise de novo"),
            Self::Failed(why) => write!(f, "o macOS não conseguiu remover a cópia local: {why}"),
        }
    }
}

impl std::error::Error for EvictError {}

/// Validates `path` for eviction: absolute, no `..`, a regular file (not a symlink), its resolved parent inside
/// `~/Library/Mobile Documents`, and still materialized. Returns the resolved path and its allocated bytes.
pub fn check_evictable(home: &Path, path: &Path) -> Result<(PathBuf, u64), EvictError> {
    if !path.is_absolute() {
        return Err(EvictError::NotAbsolute);
    }
    if path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err(EvictError::Traversal);
    }
    let md = fs::symlink_metadata(path).map_err(|_| EvictError::Missing)?;
    if md.file_type().is_symlink() {
        return Err(EvictError::Symlink);
    }
    if !md.is_file() {
        return Err(EvictError::NotRegularFile);
    }
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else { return Err(EvictError::OutsideCloud) };
    let root = fs::canonicalize(container(home)).map_err(|_| EvictError::OutsideCloud)?;
    let real_parent = fs::canonicalize(parent).map_err(|_| EvictError::Missing)?;
    if !real_parent.starts_with(&root) {
        return Err(EvictError::OutsideCloud);
    }
    if !materialized(&md) {
        return Err(EvictError::NotDownloaded);
    }
    Ok((real_parent.join(name), own_bytes(&md)))
}

/// Evicts the local copy of `path` through the system and returns the bytes freed. `ident` is the (device,
/// inode) the scan saw; the eviction is refused if the path now names another file.
pub fn evict(home: &Path, path: &Path, ident: Option<(u64, u64)>) -> Result<u64, EvictError> {
    evict_with(home, path, ident, system_evict)
}

/// [`evict`] with the system call injected, so validation can be tested without touching iCloud.
pub fn evict_with(
    home: &Path,
    path: &Path,
    ident: Option<(u64, u64)>,
    system: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<u64, EvictError> {
    let (real, before) = check_evictable(home, path)?;
    if let Some(want) = ident {
        let md = fs::symlink_metadata(&real).map_err(|_| EvictError::Missing)?;
        if (md.dev(), md.ino()) != want {
            return Err(EvictError::Changed);
        }
    }
    system(&real).map_err(EvictError::Failed)?;
    // The file stays as a placeholder (or is renamed to `.name.icloud` on older systems).
    let after = fs::symlink_metadata(&real).map_or(0, |md| own_bytes(&md));
    Ok(before.saturating_sub(after))
}

fn system_evict(path: &Path) -> Result<(), String> {
    use objc2::rc::autoreleasepool;
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let text = path.to_str().ok_or("nome de arquivo inválido")?;
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        NSFileManager::defaultManager()
            .evictUbiquitousItemAtURL_error(&url)
            .map_err(|e| e.localizedDescription().to_string())
    })
}

/// True when the system considers the file part of an iCloud container.
fn is_ubiquitous(path: &Path) -> bool {
    use objc2::rc::autoreleasepool;
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let Some(text) = path.to_str() else { return false };
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        NSFileManager::defaultManager().isUbiquitousItemAtURL(&url)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::Write;
    use std::os::unix::fs::symlink;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(&vec![7u8; bytes]).unwrap();
        f.sync_all().unwrap();
    }

    struct Fx {
        _t: tempfile::TempDir,
        home: PathBuf,
        docs: PathBuf,
    }

    fn fixture() -> Fx {
        let t = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(t.path()).unwrap().join("home");
        let docs = home.join("Library/Mobile Documents/com~apple~CloudDocs");
        fs::create_dir_all(&docs).unwrap();
        Fx { _t: t, home, docs }
    }

    /// Runs `evict_with`, reporting whether the system call was reached.
    fn attempt(f: &Fx, path: &Path) -> (Result<u64, EvictError>, bool) {
        let called = Cell::new(false);
        let r = evict_with(&f.home, path, None, |_| {
            called.set(true);
            Ok(())
        });
        (r, called.get())
    }

    #[test]
    fn accepts_a_downloaded_file_in_mobile_documents() {
        let f = fixture();
        let file = f.docs.join("Pasta/video.mov");
        write(&file, 200_000);
        let (r, called) = attempt(&f, &file);
        assert!(called);
        // The injected system call evicts nothing, so nothing was freed.
        assert_eq!(r, Ok(0));
        let (real, bytes) = check_evictable(&f.home, &file).unwrap();
        assert_eq!(real, file);
        assert!(bytes >= 200_000);
    }

    #[test]
    fn rejects_paths_outside_mobile_documents() {
        let f = fixture();
        write(&f.home.join("Documents/a.bin"), 100_000);
        write(&f.home.join("Library/Mobile Documents-evil/a.bin"), 100_000);
        write(&f.home.join("Library/Caches/a.bin"), 100_000);
        for p in ["Documents/a.bin", "Library/Mobile Documents-evil/a.bin", "Library/Caches/a.bin"] {
            let (r, called) = attempt(&f, &f.home.join(p));
            assert_eq!(r, Err(EvictError::OutsideCloud), "{p}");
            assert!(!called, "{p}");
        }
        let (r, called) = attempt(&f, Path::new("/etc/hosts"));
        assert_eq!(r, Err(EvictError::OutsideCloud));
        assert!(!called);
    }

    #[test]
    fn rejects_symlinks_and_escapes() {
        let f = fixture();
        write(&f.home.join("Documents/secret.bin"), 100_000);
        symlink(f.home.join("Documents/secret.bin"), f.docs.join("link.bin")).unwrap();
        let (r, called) = attempt(&f, &f.docs.join("link.bin"));
        assert_eq!((r, called), (Err(EvictError::Symlink), false));

        // A symlinked folder inside the container that leads outside: the resolved parent is outside.
        symlink(f.home.join("Documents"), f.docs.join("out")).unwrap();
        let (r, called) = attempt(&f, &f.docs.join("out/secret.bin"));
        assert_eq!((r, called), (Err(EvictError::OutsideCloud), false));

        // The symlink to a folder is not a regular file either.
        let (r, called) = attempt(&f, &f.docs.join("out"));
        assert_eq!((r, called), (Err(EvictError::Symlink), false));
    }

    #[test]
    fn rejects_relative_traversal_missing_directories_and_placeholders() {
        let f = fixture();
        write(&f.docs.join("ok.bin"), 100_000);
        write(&f.home.join("Documents/a.bin"), 100_000);
        let cases = [
            (PathBuf::from("Library/Mobile Documents/ok.bin"), EvictError::NotAbsolute),
            (f.docs.join("../../../Documents/a.bin"), EvictError::Traversal),
            (f.docs.join("sub/../ok.bin"), EvictError::Traversal),
            (f.docs.join("nope.bin"), EvictError::Missing),
            (f.docs.clone(), EvictError::NotRegularFile),
        ];
        for (p, want) in cases {
            let (r, called) = attempt(&f, &p);
            assert_eq!((r, called), (Err(want), false), "{p:?}");
        }
        // Sparse file: nothing allocated, like a dataless placeholder.
        let sparse = fs::File::create(f.docs.join("placeholder.bin")).unwrap();
        sparse.set_len(1 << 30).unwrap();
        sparse.sync_all().unwrap();
        let (r, called) = attempt(&f, &f.docs.join("placeholder.bin"));
        assert_eq!((r, called), (Err(EvictError::NotDownloaded), false));
    }

    #[test]
    fn refuses_a_file_that_changed_since_the_scan() {
        let f = fixture();
        let file = f.docs.join("a.bin");
        write(&file, 100_000);
        let md = fs::metadata(&file).unwrap();
        let ident = Some((md.dev(), md.ino()));
        assert_eq!(evict_with(&f.home, &file, ident, |_| Ok(())), Ok(0));
        // Replace the file by another one at the same path.
        fs::remove_file(&file).unwrap();
        write(&f.docs.join("other.bin"), 100_000);
        fs::rename(f.docs.join("other.bin"), &file).unwrap();
        let called = Cell::new(false);
        let r = evict_with(&f.home, &file, Some((md.dev(), md.ino() + 1_000_000)), |_| {
            called.set(true);
            Ok(())
        });
        assert_eq!(r, Err(EvictError::Changed));
        assert!(!called.get());
    }

    #[test]
    fn system_failure_is_reported_and_missing_container_rejects() {
        let f = fixture();
        write(&f.docs.join("a.bin"), 100_000);
        let r = evict_with(&f.home, &f.docs.join("a.bin"), None, |_| Err("sem permissão".into()));
        assert_eq!(r, Err(EvictError::Failed("sem permissão".into())));
        assert!(r.unwrap_err().to_string().contains("sem permissão"));

        let t = tempfile::tempdir().unwrap();
        let bare_home = fs::canonicalize(t.path()).unwrap();
        write(&bare_home.join("a.bin"), 100_000);
        assert_eq!(check_evictable(&bare_home, &bare_home.join("a.bin")), Err(EvictError::OutsideCloud));
    }

    #[test]
    fn scan_requires_the_container_and_filters_by_size_hidden_and_packages() {
        let t = tempfile::tempdir().unwrap();
        let bare = fs::canonicalize(t.path()).unwrap();
        let err = scan_downloaded(&bare, 1, &Progress::silent()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);

        let f = fixture();
        write(&f.docs.join("big.bin"), 300_000);
        write(&f.docs.join("small.bin"), 10_000);
        write(&f.docs.join(".hidden/big.bin"), 300_000);
        write(&f.docs.join("Doc.pages/Data/big.bin"), 300_000);
        // Plain files are not in an iCloud container for the system, so the real filter drops them all.
        assert!(scan_downloaded(&f.home, 100_000, &Progress::silent()).unwrap().is_empty());
        // The walk itself keeps only the materialized, large, visible, non-package files.
        let found = walk(&container(&f.home), 100_000, &Progress::silent());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, f.docs.join("big.bin"));
    }
}
