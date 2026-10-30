use std::collections::HashSet;
use std::fs::{self, Metadata};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;

type Seen = Mutex<HashSet<(u64, u64)>>;

/// Bytes actually allocated on disk under `path` (st_blocks * 512), which is
/// what removal frees. Symlinks are not followed, other devices are not
/// entered, and hard links are counted once. Unreadable entries count as 0.
pub fn alloc_size(path: &Path, cancel: &AtomicBool) -> u64 {
    let Ok(md) = fs::symlink_metadata(path) else { return 0 };
    let seen = Mutex::new(HashSet::new());
    walk(path, &md, md.dev(), &seen, cancel)
}

/// Allocated bytes of a single entry's own inode (no recursion).
pub fn own_bytes(md: &Metadata) -> u64 {
    md.blocks() * 512
}

/// Sandboxed app containers: every lookup inside them is checked by the sandbox, and concurrent lookups
/// serialize badly (measured: a 16k-file WhatsApp container took 6 s in parallel vs 1.3 s sequentially).
pub(crate) fn in_app_container(path: &Path) -> bool {
    let s = path.as_os_str().as_encoded_bytes();
    let has = |needle: &[u8]| s.windows(needle.len()).any(|w| w == needle);
    has(b"/Library/Containers/") || has(b"/Library/Group Containers/")
}

/// Entries of a directory with their lstat metadata, stat'ed sequentially: parallel lstat calls in one
/// directory contend on its lock, so walkers parallelize across subdirectories only.
pub(crate) fn stat_entries(rd: fs::ReadDir) -> Vec<(fs::DirEntry, Metadata)> {
    rd.filter_map(Result::ok)
        .filter_map(|e| {
            // DirEntry::metadata does not traverse symlinks on unix.
            let m = e.metadata().ok()?;
            Some((e, m))
        })
        .collect()
}

fn file_bytes(md: &Metadata, seen: &Seen) -> u64 {
    if md.nlink() > 1 && !seen.lock().unwrap().insert((md.dev(), md.ino())) {
        return 0;
    }
    own_bytes(md)
}

/// Files of one directory are stat'ed sequentially (parallel lstat in the same directory contends on its
/// lock); subdirectories are walked in parallel, except inside app containers.
fn walk(path: &Path, md: &Metadata, dev: u64, seen: &Seen, cancel: &AtomicBool) -> u64 {
    if cancel.load(Ordering::Relaxed) || md.dev() != dev {
        return 0;
    }
    if !md.is_dir() {
        return file_bytes(md, seen);
    }
    let Ok(rd) = fs::read_dir(path) else { return own_bytes(md) };
    let mut total = own_bytes(md);
    let mut dirs = Vec::new();
    for e in rd.filter_map(Result::ok) {
        // DirEntry::metadata does not traverse symlinks on unix.
        let Ok(m) = e.metadata() else { continue };
        if m.is_dir() {
            dirs.push((e.path(), m));
        } else if m.dev() == dev {
            total += file_bytes(&m, seen);
        }
    }
    let sub = |(p, m): &(std::path::PathBuf, Metadata)| walk(p, m, dev, seen, cancel);
    total + if in_app_container(path) { dirs.iter().map(sub).sum::<u64>() } else { dirs.par_iter().map(sub).sum() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, bytes: usize) {
        let mut f = fs::File::create(path).unwrap();
        f.write_all(&vec![7u8; bytes]).unwrap();
        f.sync_all().unwrap();
    }

    #[test]
    fn counts_allocated_bytes_recursively() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        write(&dir.path().join("a"), 100_000);
        write(&dir.path().join("sub/b"), 200_000);
        let size = alloc_size(dir.path(), &AtomicBool::new(false));
        assert!(size >= 300_000, "{size}");
        assert!(size < 400_000, "{size}");
    }

    #[test]
    fn hard_links_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("a"), 500_000);
        fs::hard_link(dir.path().join("a"), dir.path().join("b")).unwrap();
        let size = alloc_size(dir.path(), &AtomicBool::new(false));
        assert!(size < 700_000, "hard link double-counted: {size}");
    }

    #[test]
    fn symlinks_not_followed() {
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("big"), 1_000_000);
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        let size = alloc_size(dir.path(), &AtomicBool::new(false));
        assert!(size < 100_000, "followed symlink: {size}");
    }

    #[test]
    fn cancelled_returns_zero_and_missing_is_zero() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("a"), 100_000);
        assert_eq!(alloc_size(dir.path(), &AtomicBool::new(true)), 0);
        assert_eq!(alloc_size(&dir.path().join("nope"), &AtomicBool::new(false)), 0);
    }
}
