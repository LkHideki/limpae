//! Undo for removals that went to the Trash.
//!
//! Every successful Trash move whose destination is known (NSFileManager reports it) is appended to a JSON-lines
//! journal next to the action log, grouped by removal batch. Restoring moves the item back with an exclusive
//! rename, and only when nothing has changed since: the item in the Trash is still the same inode, the original
//! path is still free and its parent folder still exists. Anything else is refused and left where it is; the
//! Finder's own "Put Back" keeps working either way.

use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::log::ActionLog;

/// Journal lines kept when pruning; older restorable entries beyond this are dropped from the undo list (the
/// items stay in the Trash and the Finder can still put them back).
const KEEP: usize = 5_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    /// Unix seconds of the move.
    t: i64,
    batch: String,
    from: PathBuf,
    to: PathBuf,
    size: u64,
    dev: u64,
    ino: u64,
}

/// What restoring an entry would do right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Ready,
    /// The Trash cannot be read: Full Disk Access is missing.
    NoAccess,
    /// Something now occupies the original path.
    Occupied,
    /// The original folder no longer exists.
    NoFolder,
    /// The item left the Trash (emptied, put back, or replaced).
    Gone,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedItem {
    pub name: String,
    pub from: PathBuf,
    pub size: u64,
    pub state: State,
}

/// One removal batch that still has something to restore.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub time: i64,
    pub items: Vec<TrashedItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub from: PathBuf,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug)]
pub struct TrashJournal {
    path: PathBuf,
    home: PathBuf,
    lock: Mutex<()>,
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A batch id unique within this process and practically across runs: unix milliseconds plus a counter.
pub fn new_batch_id() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("{ms}-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

impl TrashJournal {
    pub fn new(path: PathBuf, home: &Path) -> Self {
        Self { path, home: home.to_path_buf(), lock: Mutex::new(()) }
    }

    /// ~/Library/Logs/Limpae/trashed.jsonl
    pub fn in_home(home: &Path) -> Self {
        Self::new(home.join("Library/Logs/Limpae/trashed.jsonl"), home)
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records a finished Trash move. Best effort, like the action log: a failure only means no undo for it.
    pub fn record(&self, batch: &str, from: &Path, to: &Path, size: u64) {
        let Ok(md) = fs::symlink_metadata(to) else { return };
        let e = Entry {
            t: now(),
            batch: batch.into(),
            from: from.into(),
            to: to.into(),
            size,
            dev: md.dev(),
            ino: md.ino(),
        };
        let Ok(line) = serde_json::to_string(&e) else { return }; // non-UTF-8 path: no undo
        let _g = self.guard();
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = writeln!(f, "{line}");
        }
    }

    fn entries(&self) -> Vec<Entry> {
        let Ok(f) = File::open(&self.path) else { return Vec::new() };
        BufReader::new(f).lines().map_while(Result::ok).filter_map(|l| serde_json::from_str(&l).ok()).collect()
    }

    /// A Trash location Limpae may move things out of: ~/.Trash or a volume's .Trashes, never anything else, so a
    /// tampered journal cannot turn restore into an arbitrary move.
    fn in_a_trash(&self, p: &Path) -> bool {
        if p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) || !p.is_absolute() {
            return false;
        }
        let home_trash = self.home.join(".Trash");
        if p.starts_with(&home_trash) && p != home_trash {
            return true;
        }
        let parts: Vec<_> = p.components().collect();
        // /Volumes/<name>/.Trashes/<uid>/<item...>
        parts.len() >= 6
            && parts[1].as_os_str() == "Volumes"
            && parts[3].as_os_str() == ".Trashes"
            && parts[4].as_os_str().to_str().is_some_and(|u| u.parse::<u32>().is_ok())
    }

    fn state(&self, e: &Entry) -> State {
        if !self.in_a_trash(&e.to) || !e.from.is_absolute() {
            return State::Gone;
        }
        match fs::symlink_metadata(&e.to) {
            Ok(md) if (md.dev(), md.ino()) == (e.dev, e.ino) => {}
            Ok(_) => return State::Gone,
            Err(err) if err.kind() == io::ErrorKind::PermissionDenied => return State::NoAccess,
            Err(_) => return State::Gone,
        }
        match fs::symlink_metadata(&e.from) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            _ => return State::Occupied,
        }
        match e.from.parent().map(fs::symlink_metadata) {
            Some(Ok(md)) if md.is_dir() => State::Ready,
            _ => State::NoFolder,
        }
    }

    /// Batches with at least one item still in the Trash, newest first. Items that left the Trash are omitted.
    pub fn batches(&self) -> Vec<Batch> {
        let mut by: BTreeMap<String, Batch> = BTreeMap::new();
        for e in self.entries() {
            let state = self.state(&e);
            if state == State::Gone {
                continue;
            }
            let name = e.from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let b =
                by.entry(e.batch.clone()).or_insert_with(|| Batch { id: e.batch.clone(), time: e.t, items: vec![] });
            b.time = b.time.max(e.t);
            b.items.push(TrashedItem { name, from: e.from, size: e.size, state });
        }
        let mut out: Vec<Batch> = by.into_values().collect();
        out.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.id.cmp(&a.id)));
        out
    }

    /// Moves every restorable item of `batches` back to where it was. Each move is re-checked right before it
    /// happens and done with an exclusive rename, so an existing file is never replaced.
    pub fn restore(&self, batches: &[String], log: &ActionLog) -> Vec<RestoreOutcome> {
        let _g = self.guard();
        let mut out = Vec::new();
        for e in self.entries().into_iter().filter(|e| batches.contains(&e.batch)) {
            let res = match self.state(&e) {
                State::Ready => rename_excl(&e.to, &e.from).map_err(|err| describe(&err)),
                State::Gone => continue,
                State::NoAccess => Err("sem acesso ao Lixo; conceda o Acesso Total ao Disco".to_string()),
                State::Occupied => Err("já existe um item com esse nome no local original".to_string()),
                State::NoFolder => Err("a pasta original não existe mais".to_string()),
            };
            log.record("restaurar", &e.from, res.is_ok(), e.size);
            out.push(RestoreOutcome { from: e.from, ok: res.is_ok(), error: res.err() });
        }
        out
    }

    /// Drops entries whose item left the Trash and keeps at most `KEEP` lines. Run before any id reaches the UI.
    pub fn prune(&self) {
        let _g = self.guard();
        let all = self.entries();
        let mut keep: Vec<&Entry> = all.iter().filter(|e| self.state(e) != State::Gone).collect();
        if keep.len() == all.len() && keep.len() <= KEEP {
            return;
        }
        let skip = keep.len().saturating_sub(KEEP);
        keep.drain(..skip);
        let tmp = self.path.with_extension("jsonl.tmp");
        let body: String = keep.iter().filter_map(|e| serde_json::to_string(e).ok()).map(|l| l + "\n").collect();
        if fs::write(&tmp, body).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }
}

fn describe(e: &io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::EEXIST) => "já existe um item com esse nome no local original".into(),
        Some(libc::EXDEV) => "o item está em outro disco; use “Devolver” no Finder".into(),
        Some(libc::EPERM | libc::EACCES) => "sem permissão para restaurar este item".into(),
        _ => crate::errors::describe_io(e),
    }
}

/// rename(2) that fails with EEXIST instead of replacing the destination.
fn rename_excl(from: &Path, to: &Path) -> io::Result<()> {
    let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput));
    let (a, b) = (c(from)?, c(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    let r = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) };
    if r == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fx {
        _tmp: tempfile::TempDir,
        home: PathBuf,
        j: TrashJournal,
        log: ActionLog,
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(tmp.path()).unwrap().join("home");
        fs::create_dir_all(home.join(".Trash")).unwrap();
        fs::create_dir_all(home.join("Documents")).unwrap();
        let j = TrashJournal::in_home(&home);
        let log = ActionLog::in_home(&home);
        Fx { _tmp: tmp, home, j, log }
    }

    impl Fx {
        /// Simulates a Trash move: writes the file in the Trash and journals it.
        fn trashed(&self, batch: &str, name: &str) -> (PathBuf, PathBuf) {
            let from = self.home.join("Documents").join(name);
            let to = self.home.join(".Trash").join(name);
            fs::write(&to, b"data").unwrap();
            self.j.record(batch, &from, &to, 4);
            (from, to)
        }
    }

    #[test]
    fn restores_a_batch_and_logs_it() {
        let f = fx();
        let (a_from, a_to) = f.trashed("b1", "a.txt");
        let (b_from, _) = f.trashed("b2", "b.txt");
        let out = f.j.restore(&["b1".into()], &f.log);
        assert_eq!(out.len(), 1);
        assert!(out[0].ok, "{out:?}");
        assert!(a_from.exists() && !a_to.exists());
        assert!(!b_from.exists(), "other batches stay in the Trash");
        let log = fs::read_to_string(f.log.path()).unwrap();
        assert!(log.contains("\trestaurar\tok\t4\t"), "{log}");
        assert_eq!(f.j.batches().iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ["b2"]);
    }

    #[test]
    fn never_overwrites_what_now_occupies_the_original_path() {
        let f = fx();
        let (from, to) = f.trashed("b", "a.txt");
        fs::write(&from, b"new and important").unwrap();
        assert_eq!(f.j.batches()[0].items[0].state, State::Occupied);
        let out = f.j.restore(&["b".into()], &f.log);
        assert!(!out[0].ok);
        assert_eq!(fs::read(&from).unwrap(), b"new and important");
        assert!(to.exists());
    }

    #[test]
    fn refuses_when_the_trashed_item_was_replaced() {
        let f = fx();
        let (from, to) = f.trashed("b", "a.txt");
        fs::remove_file(&to).unwrap();
        fs::write(&to, b"another file with the same name").unwrap();
        assert!(f.j.batches().is_empty(), "a different inode is not ours to move");
        assert!(f.j.restore(&["b".into()], &f.log).is_empty());
        assert!(!from.exists() && to.exists());
    }

    #[test]
    fn missing_original_folder_is_reported_not_recreated() {
        let f = fx();
        let from = f.home.join("Documents/gone/a.txt");
        let to = f.home.join(".Trash/a.txt");
        fs::write(&to, b"x").unwrap();
        f.j.record("b", &from, &to, 1);
        let out = f.j.restore(&["b".into()], &f.log);
        assert_eq!(out[0].error.as_deref(), Some("a pasta original não existe mais"));
        assert!(to.exists() && !from.parent().unwrap().exists());
    }

    #[test]
    fn tampered_journal_cannot_move_files_outside_a_trash() {
        let f = fx();
        let victim = f.home.join("Documents/secret.txt");
        fs::write(&victim, b"s").unwrap();
        let md = fs::metadata(&victim).unwrap();
        let forged = Entry {
            t: 1,
            batch: "evil".into(),
            from: f.home.join("Documents/moved.txt"),
            to: victim.clone(),
            size: 1,
            dev: md.dev(),
            ino: md.ino(),
        };
        fs::create_dir_all(f.j.path.parent().unwrap()).unwrap();
        fs::write(&f.j.path, serde_json::to_string(&forged).unwrap() + "\n").unwrap();
        assert!(f.j.batches().is_empty());
        assert!(f.j.restore(&["evil".into()], &f.log).is_empty());
        assert!(victim.exists());
        assert!(!f.j.in_a_trash(&f.home.join(".Trash/../Documents/x")));
        assert!(f.j.in_a_trash(Path::new("/Volumes/USB/.Trashes/501/x")));
        assert!(!f.j.in_a_trash(Path::new("/Volumes/USB/.Trashes/abc/x")));
        assert!(!f.j.in_a_trash(&f.home.join(".Trash")));
    }

    #[test]
    fn prune_drops_entries_that_left_the_trash_and_survives_garbage() {
        let f = fx();
        let (_, gone) = f.trashed("b1", "a.txt");
        f.trashed("b2", "b.txt");
        fs::remove_file(gone).unwrap();
        let mut raw = fs::read_to_string(&f.j.path).unwrap();
        raw.push_str("not json\n");
        fs::write(&f.j.path, raw).unwrap();
        f.j.prune();
        let text = fs::read_to_string(&f.j.path).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains("b.txt"));
    }

    #[test]
    fn batch_ids_are_unique_and_newest_batch_comes_first() {
        let a = new_batch_id();
        let b = new_batch_id();
        assert_ne!(a, b);
        let f = fx();
        f.trashed("1-0", "a.txt");
        f.trashed("1-1", "b.txt");
        let ids: Vec<_> = f.j.batches().into_iter().map(|b| b.id).collect();
        assert_eq!(ids, ["1-1", "1-0"]);
    }
}
