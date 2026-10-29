use std::fs;
use std::path::Path;

/// Whether the process holds Full Disk Access. ~/Library/Safari exists on
/// every Mac and is TCC-protected, so listing it only succeeds with FDA;
/// ~/.Trash is the fallback probe when Safari's folder is absent.
pub fn has_full_disk_access(home: &Path) -> bool {
    match fs::read_dir(home.join("Library/Safari")) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::read_dir(home.join(".Trash")).is_ok(),
        Err(_) => false,
    }
}
