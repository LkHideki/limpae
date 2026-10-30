use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// How an item may be removed. Assigned by the scanner, never by the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Policy {
    /// Regenerable data (caches, logs) inside a known junk root; deleted permanently.
    DeleteJunk { root: PathBuf },
    /// User data, apps and app leftovers; moved to the Trash (reversible).
    MoveToTrash,
    /// Direct child of ~/.Trash; deleted permanently.
    EmptyTrashEntry,
}

#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub path: PathBuf,
    pub name: String,
    /// Allocated bytes on disk.
    pub size: u64,
    /// Pre-selected for removal.
    pub selected: bool,
    pub note: Option<String>,
    /// Last modification, unix seconds.
    pub modified: Option<i64>,
    #[serde(skip)]
    pub policy: Policy,
    /// (device, inode) seen by the scan. Removal refuses the item if the path now points at something else.
    #[serde(skip)]
    pub ident: Option<(u64, u64)>,
}

impl Item {
    pub fn new(path: PathBuf, size: u64, policy: Policy) -> Self {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let md = std::fs::symlink_metadata(&path).ok();
        let modified = md
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        let ident = md.as_ref().map(|m| (m.dev(), m.ino()));
        Self { path, name, size, selected: true, note: None, modified, policy, ident }
    }

    pub fn unselected(mut self, note: impl Into<String>) -> Self {
        self.selected = false;
        self.note = Some(note.into());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Group {
    pub id: String,
    pub title: String,
    pub description: String,
    pub items: Vec<Item>,
}

impl Group {
    pub fn total(&self) -> u64 {
        self.items.iter().map(|i| i.size).sum()
    }
}

type PathCallback = Box<dyn Fn(&Path, u64) + Send + Sync>;

/// Cancellation flag plus a progress sink (current path, bytes found so far).
/// Throttling is the consumer's job.
pub struct Progress {
    cancel: Arc<AtomicBool>,
    on_path: PathCallback,
}

impl Progress {
    pub fn new(cancel: Arc<AtomicBool>, on_path: impl Fn(&Path, u64) + Send + Sync + 'static) -> Self {
        Self { cancel, on_path: Box::new(on_path) }
    }

    pub fn silent() -> Self {
        Self::new(Arc::new(AtomicBool::new(false)), |_, _| {})
    }

    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn report(&self, path: &Path, bytes: u64) {
        (self.on_path)(path, bytes);
    }
}
