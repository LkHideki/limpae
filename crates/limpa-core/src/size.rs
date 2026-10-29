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

fn walk(path: &Path, md: &Metadata, dev: u64, seen: &Seen, cancel: &AtomicBool) -> u64 {
    if cancel.load(Ordering::Relaxed) || md.dev() != dev {
        return 0;
    }
    if !md.is_dir() {
        if md.nlink() > 1 && !seen.lock().unwrap().insert((md.dev(), md.ino())) {
            return 0;
        }
        return own_bytes(md);
    }
    let Ok(rd) = fs::read_dir(path) else { return own_bytes(md) };
    let entries: Vec<_> = rd.filter_map(Result::ok).collect();
    own_bytes(md)
        + entries
            .par_iter()
            // DirEntry::metadata does not traverse symlinks on unix.
            .map(|e| e.metadata().map_or(0, |m| walk(&e.path(), &m, dev, seen, cancel)))
            .sum::<u64>()
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
