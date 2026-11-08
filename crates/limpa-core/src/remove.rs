use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use rayon::prelude::*;
use serde::Serialize;
use trash::TrashContext;
use trash::macos::{DeleteMethod, TrashContextExtMacos};

use crate::guard::{Guard, GuardError};
use crate::log::ActionLog;
use crate::model::{Group, Item, Policy};
use crate::size::alloc_size;
use crate::undo::TrashJournal;

/// Seam over the destructive calls so tests never touch the real Trash.
pub trait Remover: Sync {
    /// Moves `path` to the Trash and returns where it landed, when known (needed for undo).
    fn trash(&self, path: &Path) -> io::Result<Option<PathBuf>>;
    fn delete(&self, path: &Path) -> io::Result<()>;
}

pub struct SystemRemover;

#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    pub path: PathBuf,
    pub ok: bool,
    pub freed: u64,
    pub error: Option<String>,
}

/// NSFileManager directly (not through the `trash` crate) because only it reports where the item landed.
fn trash_ns(path: &Path) -> Result<Option<PathBuf>, String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let Some(utf8) = path.to_str() else {
        return trash_with(path, DeleteMethod::NsFileManager).map(|()| None);
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(utf8));
    let mut landed = None;
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut landed))
        .map_err(|err| format!("trashItemAtURL failed: {err} (code {})", err.code()))?;
    Ok(landed.and_then(|u| u.path()).map(|p| PathBuf::from(p.to_string())))
}

fn trash_with(path: &Path, method: DeleteMethod) -> Result<(), String> {
    let mut ctx = TrashContext::default();
    ctx.set_delete_method(method);
    ctx.delete(path).map_err(|e| e.to_string())
}

/// NSFileManager / Finder errors arrive as English debug strings; keep only what the user can act on.
fn trash_error(detail: &str) -> io::Error {
    let d = detail.to_lowercase();
    if d.contains("-128") || d.contains("user canceled") || d.contains("cancelled") {
        io::Error::new(io::ErrorKind::Interrupted, "autorização cancelada; o item continua no lugar")
    } else if d.contains("permission")
        || d.contains("not permitted")
        || d.contains("-54")
        || d.contains("-5000")
        || d.contains("(code 513)")
        || d.contains("(code 257)")
    {
        io::Error::new(io::ErrorKind::PermissionDenied, "sem permissão: o item pertence ao sistema ou a outro usuário")
    } else {
        io::Error::other(format!("não foi possível mover para o Lixo ({detail})"))
    }
}

/// Only installed `.app` bundles get the Finder fallback: apps installed by a `.pkg` are owned by root, and Finder
/// asks for an administrator password itself (keeping "Put Back"), like the Finder's own Move to Trash.
fn needs_finder(path: &Path, detail: &str) -> bool {
    path.extension().is_some_and(|e| e == "app") && trash_error(detail).kind() == io::ErrorKind::PermissionDenied
}

impl Remover for SystemRemover {
    /// NSFileManager first: no Automation prompt and no sound. Root-owned app bundles fall back to Finder.
    /// The Finder fallback does not say where the item went, so it has no in-app undo (Finder's Put Back works).
    fn trash(&self, path: &Path) -> io::Result<Option<PathBuf>> {
        match trash_ns(path) {
            Ok(landed) => Ok(landed),
            Err(e) if needs_finder(path, &e) => {
                trash_with(path, DeleteMethod::Finder).map(|()| None).map_err(|e| trash_error(&e))
            }
            Err(e) => Err(trash_error(&e)),
        }
    }

    /// Only a real directory is removed recursively; std's `remove_dir_all` never follows links inside it, and a
    /// symlink item is unlinked itself so its target survives.
    fn delete(&self, path: &Path) -> io::Result<()> {
        if fs::symlink_metadata(path)?.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
    }
}

/// The scan's (device, inode) must still be what the path names; otherwise the user reviewed a different file.
fn same_file(item: &Item, real: PathBuf) -> Result<PathBuf, GuardError> {
    let Some(ident) = item.ident else { return Ok(real) };
    let md = fs::symlink_metadata(&real).map_err(|_| GuardError::Missing)?;
    if (md.dev(), md.ino()) == ident { Ok(real) } else { Err(GuardError::Changed) }
}

/// User-facing reason for a failed removal. std's messages are English ("Permission denied (os error 13)").
fn describe(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::PermissionDenied if e.get_ref().is_none() => "sem permissão para remover este item".into(),
        io::ErrorKind::NotFound => "o item não existe mais".into(),
        io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::ResourceBusy => "o item está em uso; tente de novo".into(),
        _ => e.to_string(),
    }
}

fn is_permanent(item: &Item) -> bool {
    !matches!(item.policy, Policy::MoveToTrash)
}

/// Re-validates and removes one item. Never panics: every failure becomes an error outcome.
/// How a batch is removed. `permanent` deletes items whose policy would normally move them to the Trash (the
/// user chose "Apagar definitivamente"); every other check is unchanged. `cancel` stops the batch between items:
/// items not yet started are left untouched and reported as cancelled.
#[derive(Debug, Clone, Copy, Default)]
pub struct RemoveOptions<'a> {
    pub permanent: bool,
    pub cancel: Option<&'a AtomicBool>,
    /// Journal and batch id for undo; Trash moves are journaled only when both are set.
    pub undo: Option<(&'a TrashJournal, &'a str)>,
}

pub const CANCELLED: &str = "cancelado; o item continua no lugar";

impl RemoveOptions<'_> {
    fn cancelled(&self) -> bool {
        self.cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed))
    }

    fn deletes(&self, item: &Item) -> bool {
        is_permanent(item) || self.permanent
    }
}

/// Re-validates and removes one item. Never panics: every failure becomes an error outcome.
fn remove_one(item: &Item, guard: &Guard, r: &dyn Remover, log: &ActionLog, opts: RemoveOptions) -> Outcome {
    if opts.cancelled() {
        return Outcome { path: item.path.clone(), ok: false, freed: 0, error: Some(CANCELLED.into()) };
    }
    let real = match guard.check(&item.path, &item.policy).and_then(|real| same_file(item, real)) {
        Ok(real) => real,
        Err(err) => {
            log.record("recusado", &item.path, false, 0);
            return Outcome { path: item.path.clone(), ok: false, freed: 0, error: Some(err.to_string()) };
        }
    };
    let (action, result) = match item.policy {
        Policy::DeleteJunk { .. } => ("apagar", r.delete(&real)),
        Policy::EmptyTrashEntry => ("esvaziar", r.delete(&real)),
        Policy::MoveToTrash if opts.permanent => ("apagar-definitivo", r.delete(&real)),
        Policy::MoveToTrash => match r.trash(&real) {
            Ok(landed) => {
                if let (Some(to), Some((journal, batch))) = (landed, opts.undo) {
                    journal.record(batch, &real, &to, item.size);
                }
                ("lixo", Ok(()))
            }
            Err(e) => ("lixo", Err(e)),
        },
    };
    let (freed, error) = match result {
        Ok(()) => (item.size, None),
        // A failed permanent delete may have removed part of a directory; a failed trash move removes nothing.
        Err(e) if opts.deletes(item) => {
            (item.size.saturating_sub(alloc_size(&real, &AtomicBool::new(false))), Some(describe(&e)))
        }
        Err(e) => (0, Some(describe(&e))),
    };
    log.record(action, &real, error.is_none(), freed);
    Outcome { path: item.path.clone(), ok: error.is_none(), freed, error }
}

/// What removing one item would do right now, found by running every removal check without touching the disk.
#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub path: PathBuf,
    /// The action-log verb the removal would use ("apagar", "lixo", "esvaziar", "apagar-definitivo").
    pub action: &'static str,
    pub size: u64,
    /// Why the removal would be refused; `None` = it would go ahead.
    pub error: Option<String>,
}

/// Dry run of [`remove_items_with`]: the same Guard and identity checks, in input order, with no removal and no
/// log line. The disk can still change before a real removal, which checks everything again.
pub fn preflight(items: &[Item], guard: &Guard, permanent: bool) -> Vec<Plan> {
    items
        .iter()
        .map(|item| {
            let action = match item.policy {
                Policy::DeleteJunk { .. } => "apagar",
                Policy::EmptyTrashEntry => "esvaziar",
                Policy::MoveToTrash if permanent => "apagar-definitivo",
                Policy::MoveToTrash => "lixo",
            };
            let error = guard.check(&item.path, &item.policy).and_then(|real| same_file(item, real)).err();
            Plan { path: item.path.clone(), action, size: item.size, error: error.map(|e| e.to_string()) }
        })
        .collect()
}

/// Removes `items` and returns one outcome per item, in input order. Permanent deletes run in parallel; Trash
/// moves stay sequential so NSFileManager is used from one thread, in order.
pub fn remove_items(items: &[Item], guard: &Guard, r: &dyn Remover, log: &ActionLog) -> Vec<Outcome> {
    remove_items_with(items, guard, r, log, RemoveOptions::default())
}

pub fn remove_items_with(
    items: &[Item],
    guard: &Guard,
    r: &dyn Remover,
    log: &ActionLog,
    opts: RemoveOptions,
) -> Vec<Outcome> {
    let (deleted, trashed): (Vec<_>, Vec<_>) = items.iter().enumerate().partition(|(_, it)| opts.deletes(it));
    let mut done: Vec<(usize, Outcome)> =
        deleted.into_par_iter().map(|(i, item)| (i, remove_one(item, guard, r, log, opts))).collect();
    done.extend(trashed.into_iter().map(|(i, item)| (i, remove_one(item, guard, r, log, opts))));
    done.sort_by_key(|(i, _)| *i);
    done.into_iter().map(|(_, o)| o).collect()
}

/// Direct children of ~/.Trash as `EmptyTrashEntry` items, largest first. The read error is propagated:
/// PermissionDenied means Full Disk Access is missing and the caller must prompt for it.
pub fn trash_entries(home: &Path, cancel: &AtomicBool) -> io::Result<Group> {
    let paths: Vec<PathBuf> = fs::read_dir(home.join(".Trash"))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.file_name().is_none_or(|n| n != ".DS_Store"))
        .collect();
    let mut items: Vec<Item> = paths
        .into_par_iter()
        .map(|p| {
            let size = alloc_size(&p, cancel);
            Item::new(p, size, Policy::EmptyTrashEntry)
        })
        .collect();
    items.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    Ok(Group {
        id: "trash".into(),
        title: "Lixeira".into(),
        description: "Itens que você já descartou. Esvaziar apaga definitivamente.".into(),
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::Mutex;

    /// Records calls instead of touching the Trash; optionally fails every call.
    #[derive(Default)]
    struct FakeRemover {
        calls: Mutex<Vec<(String, PathBuf)>>,
        fail: bool,
    }

    impl FakeRemover {
        fn call(&self, kind: &str, path: &Path) -> io::Result<()> {
            self.calls.lock().unwrap().push((kind.into(), path.to_path_buf()));
            if self.fail { Err(io::Error::other("falhou")) } else { Ok(()) }
        }

        fn calls(&self) -> Vec<(String, PathBuf)> {
            let mut c = self.calls.lock().unwrap().clone();
            c.sort();
            c
        }
    }

    impl Remover for FakeRemover {
        fn trash(&self, path: &Path) -> io::Result<Option<PathBuf>> {
            self.call("trash", path).map(|()| None)
        }
        fn delete(&self, path: &Path) -> io::Result<()> {
            self.call("delete", path)
        }
    }

    /// Removes `a` inside the directory, then fails: a partial delete.
    struct PartialRemover;

    impl Remover for PartialRemover {
        fn trash(&self, _: &Path) -> io::Result<Option<PathBuf>> {
            unreachable!()
        }
        fn delete(&self, path: &Path) -> io::Result<()> {
            fs::remove_file(path.join("a"))?;
            Err(io::Error::other("parcial"))
        }
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        home: PathBuf,
        guard: Guard,
        log: ActionLog,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let home = base.join("home");
        for d in ["Library/Caches", "Documents", ".Trash"] {
            fs::create_dir_all(home.join(d)).unwrap();
        }
        let guard = Guard::new(&home);
        let log = ActionLog::new(base.join("actions.log"));
        Fixture { _tmp: tmp, home, guard, log }
    }

    impl Fixture {
        fn junk(&self) -> Policy {
            Policy::DeleteJunk { root: self.home.join("Library/Caches") }
        }

        fn item(&self, path: PathBuf, policy: Policy) -> Item {
            let size = alloc_size(&path, &AtomicBool::new(false));
            Item::new(path, size, policy)
        }

        fn cache_dir(&self, name: &str) -> PathBuf {
            let dir = self.home.join("Library/Caches").join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("a"), vec![1u8; 8192]).unwrap();
            fs::write(dir.join("b"), vec![2u8; 8192]).unwrap();
            dir
        }

        fn log_lines(&self) -> Vec<String> {
            fs::read_to_string(self.log.path()).unwrap_or_default().lines().map(String::from).collect()
        }
    }

    #[test]
    fn junk_item_is_really_deleted() {
        let f = fixture();
        let dir = f.cache_dir("com.foo");
        let item = f.item(dir.clone(), f.junk());
        assert!(item.size > 0);
        let out = remove_items(std::slice::from_ref(&item), &f.guard, &SystemRemover, &f.log);
        assert!(out[0].ok && out[0].error.is_none());
        assert_eq!(out[0].freed, item.size);
        assert_eq!(out[0].path, dir);
        assert!(!dir.exists());
    }

    #[test]
    fn guard_refusals_remove_nothing_and_are_logged() {
        let f = fixture();
        let doc = f.home.join("Documents/big.mov");
        fs::write(&doc, b"x").unwrap();
        let items = vec![
            f.item(doc.clone(), f.junk()),                               // outside its root
            Item::new(f.home.join("Library/Caches/gone"), 10, f.junk()), // missing
            f.item(f.home.join("Library/Caches"), f.junk()),             // protected root
        ];
        let fake = FakeRemover::default();
        let out = remove_items(&items, &f.guard, &fake, &f.log);
        assert!(out.iter().all(|o| !o.ok && o.freed == 0));
        assert_eq!(out[0].error.as_deref(), Some("fora da área permitida"));
        assert_eq!(out[1].error.as_deref(), Some("item não existe mais"));
        assert_eq!(out[2].error.as_deref(), Some("local protegido"));
        assert!(fake.calls().is_empty());
        assert!(doc.exists() && f.home.join("Library/Caches").exists());
        let lines = f.log_lines();
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|l| l.contains("\trecusado\terro\t0\t")), "{lines:?}");
    }

    #[test]
    fn move_to_trash_uses_resolved_path() {
        let f = fixture();
        let real_dir = f.home.join("Documents/real");
        fs::create_dir_all(&real_dir).unwrap();
        fs::write(real_dir.join("f.txt"), b"hello").unwrap();
        symlink(&real_dir, f.home.join("Documents/alias")).unwrap();
        let item = f.item(f.home.join("Documents/alias/f.txt"), Policy::MoveToTrash);
        let fake = FakeRemover::default();
        let out = remove_items(std::slice::from_ref(&item), &f.guard, &fake, &f.log);
        assert!(out[0].ok);
        assert_eq!(out[0].freed, item.size);
        assert_eq!(fake.calls(), vec![("trash".to_string(), real_dir.join("f.txt"))]);
    }

    #[test]
    fn symlink_item_deletes_link_and_keeps_target() {
        let f = fixture();
        let target = f.home.join("Documents/target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("keep.txt"), b"keep").unwrap();
        let link = f.home.join("Library/Caches/link");
        symlink(&target, &link).unwrap();
        let item = f.item(link.clone(), f.junk());
        let out = remove_items(&[item], &f.guard, &SystemRemover, &f.log);
        assert!(out[0].ok, "{:?}", out[0].error);
        assert!(fs::symlink_metadata(&link).is_err());
        assert!(target.join("keep.txt").exists());
    }

    #[test]
    fn outcomes_keep_input_order_with_mixed_results() {
        let f = fixture();
        let c1 = f.cache_dir("one");
        let c2 = f.cache_dir("two");
        let doc = f.home.join("Documents/d.txt");
        fs::write(&doc, b"d").unwrap();
        let entry = f.home.join(".Trash/old.txt");
        fs::write(&entry, b"old").unwrap();
        let missing = f.home.join("Library/Caches/gone");
        let items = vec![
            f.item(c1.clone(), f.junk()),
            Item::new(missing.clone(), 1, f.junk()),
            f.item(doc.clone(), Policy::MoveToTrash),
            f.item(c2.clone(), f.junk()),
            f.item(entry.clone(), Policy::EmptyTrashEntry),
        ];
        let fake = FakeRemover::default();
        let out = remove_items(&items, &f.guard, &fake, &f.log);
        let paths: Vec<_> = out.iter().map(|o| o.path.clone()).collect();
        assert_eq!(paths, vec![c1.clone(), missing, doc.clone(), c2.clone(), entry.clone()]);
        let oks: Vec<_> = out.iter().map(|o| o.ok).collect();
        assert_eq!(oks, [true, false, true, true, true]);
        let mut expected = vec![
            ("delete".to_string(), c1),
            ("delete".to_string(), c2),
            ("delete".to_string(), entry),
            ("trash".to_string(), doc),
        ];
        expected.sort();
        assert_eq!(fake.calls(), expected);
    }

    #[test]
    fn failing_remover_reports_error_and_frees_nothing() {
        let f = fixture();
        let dir = f.cache_dir("com.foo");
        let doc = f.home.join("Documents/d.txt");
        fs::write(&doc, b"d").unwrap();
        let items = vec![f.item(dir, f.junk()), f.item(doc, Policy::MoveToTrash)];
        let fake = FakeRemover { fail: true, ..Default::default() };
        let out = remove_items(&items, &f.guard, &fake, &f.log);
        for o in &out {
            assert!(!o.ok);
            assert_eq!(o.freed, 0);
            assert_eq!(o.error.as_deref(), Some("falhou"));
        }
        assert!(f.log_lines().iter().all(|l| l.contains("\terro\t0\t")));
    }

    #[test]
    fn partial_directory_delete_counts_freed_bytes() {
        let f = fixture();
        let dir = f.cache_dir("com.foo");
        let item = f.item(dir.clone(), f.junk());
        let out = remove_items(std::slice::from_ref(&item), &f.guard, &PartialRemover, &f.log);
        assert!(!out[0].ok);
        assert_eq!(out[0].error.as_deref(), Some("parcial"));
        let remaining = alloc_size(&dir, &AtomicBool::new(false));
        assert!(out[0].freed > 0);
        assert_eq!(out[0].freed, item.size - remaining);
    }

    #[test]
    fn writes_one_log_line_per_action() {
        let f = fixture();
        let dir = f.cache_dir("com.foo");
        let doc = f.home.join("Documents/d.txt");
        fs::write(&doc, b"d").unwrap();
        let entry = f.home.join(".Trash/old.txt");
        fs::write(&entry, b"old").unwrap();
        let items = vec![
            f.item(dir.clone(), f.junk()),
            f.item(doc.clone(), Policy::MoveToTrash),
            f.item(entry.clone(), Policy::EmptyTrashEntry),
        ];
        let out = remove_items(&items, &f.guard, &FakeRemover::default(), &f.log);
        let lines = f.log_lines();
        assert_eq!(lines.len(), 3);
        let has = |action: &str, o: &Outcome, p: &Path| {
            let tail = format!("\t{action}\tok\t{}\t{}", o.freed, p.display());
            lines.iter().any(|l| l.ends_with(&tail))
        };
        assert!(has("apagar", &out[0], &dir), "{lines:?}");
        assert!(has("lixo", &out[1], &doc), "{lines:?}");
        assert!(has("esvaziar", &out[2], &entry), "{lines:?}");
    }

    #[test]
    fn trash_entries_lists_children_sorted_and_skips_ds_store() {
        let f = fixture();
        let t = f.home.join(".Trash");
        fs::write(t.join(".DS_Store"), b"x").unwrap();
        fs::write(t.join("small.txt"), b"x").unwrap();
        fs::create_dir_all(t.join("dir")).unwrap();
        fs::write(t.join("dir/big"), vec![0u8; 64 * 1024]).unwrap();
        let g = trash_entries(&f.home, &AtomicBool::new(false)).unwrap();
        assert_eq!((g.id.as_str(), g.title.as_str()), ("trash", "Lixeira"));
        let names: Vec<_> = g.items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["dir", "small.txt"]);
        assert!(g.items[0].size > g.items[1].size);
        assert!(g.items.iter().all(|i| i.selected && i.policy == Policy::EmptyTrashEntry));
        assert_eq!(g.items[0].path, t.join("dir"));
    }

    #[test]
    fn trash_entries_errors_when_trash_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let err = trash_entries(tmp.path(), &AtomicBool::new(false)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn replaced_path_is_refused() {
        let f = fixture();
        let dir = f.cache_dir("com.swap");
        let item = f.item(dir.clone(), f.junk());
        fs::remove_dir_all(&dir).unwrap();
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("new-and-important"), b"x").unwrap();
        let out = remove_items(&[item], &f.guard, &SystemRemover, &f.log);
        assert!(!out[0].ok);
        assert_eq!(out[0].error.as_deref(), Some("o item mudou desde a análise; analise de novo"));
        assert!(dir.join("new-and-important").exists());
    }

    #[test]
    fn trash_errors_are_translated_and_finder_only_for_apps() {
        let perm = r#"Unknown { description: "trashItemAtURL failed: couldn’t be moved to the trash because you don’t have permission to access it." }"#;
        assert_eq!(trash_error(perm).kind(), io::ErrorKind::PermissionDenied);
        assert!(trash_error(perm).to_string().starts_with("sem permissão"));
        assert_eq!(trash_error("execution error: User canceled. (-128)").kind(), io::ErrorKind::Interrupted);
        assert!(needs_finder(Path::new("/Applications/DaVinci Resolve.app"), perm));
        assert!(!needs_finder(Path::new("/Users/u/Documents/a.mov"), perm), "only app bundles escalate");
        assert!(!needs_finder(Path::new("/Applications/X.app"), "some other failure"));
        assert_eq!(describe(&io::Error::from(io::ErrorKind::PermissionDenied)), "sem permissão para remover este item");
    }

    #[test]
    fn permanent_option_deletes_instead_of_trashing_with_same_checks() {
        let f = fixture();
        let doc = f.home.join("Documents/film.mov");
        fs::write(&doc, vec![1u8; 8192]).unwrap();
        let item = f.item(doc.clone(), Policy::MoveToTrash);
        let outside = tempfile::tempdir().unwrap();
        let stray = outside.path().join("x");
        fs::write(&stray, b"x").unwrap();
        let bad = Item::new(stray.clone(), 1, Policy::MoveToTrash);
        let fake = FakeRemover::default();
        let opts = RemoveOptions { permanent: true, ..Default::default() };
        let out = remove_items_with(&[item, bad], &f.guard, &fake, &f.log, opts);
        assert!(out[0].ok && !out[1].ok, "{out:?}");
        assert_eq!(fake.calls(), vec![("delete".to_string(), doc.clone())], "deleted, never trashed");
        assert!(stray.exists(), "guard still refuses outside paths");
        assert!(f.log_lines().iter().any(|l| l.contains("\tapagar-definitivo\tok\t")));
    }

    /// Moves the item into `<home>/.Trash` like NSFileManager would and reports where it landed.
    struct MovingRemover(PathBuf);

    impl Remover for MovingRemover {
        fn trash(&self, path: &Path) -> io::Result<Option<PathBuf>> {
            let to = self.0.join(".Trash").join(path.file_name().unwrap());
            fs::rename(path, &to)?;
            Ok(Some(to))
        }
        fn delete(&self, _: &Path) -> io::Result<()> {
            unreachable!()
        }
    }

    #[test]
    fn trash_moves_are_journaled_and_can_be_undone() {
        let f = fixture();
        let doc = f.home.join("Documents/report.pdf");
        fs::write(&doc, b"pdf").unwrap();
        let journal = TrashJournal::in_home(&f.home);
        let opts = RemoveOptions { undo: Some((&journal, "b1")), ..Default::default() };
        let out = remove_items_with(
            &[f.item(doc.clone(), Policy::MoveToTrash)],
            &f.guard,
            &MovingRemover(f.home.clone()),
            &f.log,
            opts,
        );
        assert!(out[0].ok && !doc.exists());
        let batches = journal.batches();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].items[0].from, doc);
        let restored = journal.restore(&["b1".into()], &f.log);
        assert!(restored[0].ok, "{restored:?}");
        assert_eq!(fs::read(&doc).unwrap(), b"pdf");
        // Without a journal nothing is recorded.
        let other = f.home.join("Documents/other.pdf");
        fs::write(&other, b"o").unwrap();
        let out = remove_items(&[f.item(other, Policy::MoveToTrash)], &f.guard, &MovingRemover(f.home.clone()), &f.log);
        assert!(out[0].ok);
        assert!(journal.batches().is_empty());
    }

    #[test]
    fn preflight_reports_without_touching_anything() {
        let f = fixture();
        let dir = f.cache_dir("com.foo");
        let doc = f.home.join("Documents/d.txt");
        fs::write(&doc, b"d").unwrap();
        let items = vec![
            f.item(dir.clone(), f.junk()),
            f.item(doc.clone(), Policy::MoveToTrash),
            f.item(doc.clone(), f.junk()), // outside its root
        ];
        let plans = preflight(&items, &f.guard, false);
        let got: Vec<_> = plans.iter().map(|p| (p.action, p.error.as_deref())).collect();
        assert_eq!(got, [("apagar", None), ("lixo", None), ("apagar", Some("fora da área permitida"))]);
        assert_eq!(preflight(&items[1..2], &f.guard, true)[0].action, "apagar-definitivo");
        assert!(dir.exists() && doc.exists());
        assert!(f.log_lines().is_empty(), "a dry run writes nothing to the log");
    }

    #[test]
    fn cancel_leaves_remaining_items_untouched() {
        let f = fixture();
        let a = f.cache_dir("com.a");
        let b = f.cache_dir("com.b");
        let items = vec![f.item(a.clone(), f.junk()), f.item(b.clone(), f.junk())];
        let stop = AtomicBool::new(true);
        let out = remove_items_with(
            &items,
            &f.guard,
            &SystemRemover,
            &f.log,
            RemoveOptions { cancel: Some(&stop), ..Default::default() },
        );
        assert!(out.iter().all(|o| !o.ok && o.error.as_deref() == Some(CANCELLED)));
        assert!(a.exists() && b.exists());
    }
}
