//! End-to-end safety tests for the removal path on a real filesystem: a scan produces items, the disk changes
//! underneath (swaps, symlinks, hard links, concurrent tampering) and removal must never touch anything the user
//! did not review. Only delete policies run against the real disk; nothing here uses the real Trash.

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use limpa_core::log::ActionLog;
use limpa_core::remove::{SystemRemover, remove_items};
use limpa_core::{Guard, Item, Policy};

struct Home {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    guard: Guard,
    log: ActionLog,
}

fn home() -> Home {
    let tmp = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(tmp.path()).unwrap().join("home");
    for d in ["Library/Caches", "Library/Logs", "Documents", "Desktop", ".Trash", ".npm"] {
        fs::create_dir_all(home.join(d)).unwrap();
    }
    let guard = Guard::new(&home);
    let log = ActionLog::new(home.join("actions.log"));
    Home { _tmp: tmp, home, guard, log }
}

impl Home {
    fn caches(&self) -> PathBuf {
        self.home.join("Library/Caches")
    }

    fn junk(&self) -> Policy {
        Policy::DeleteJunk { root: self.caches() }
    }

    /// A cache folder with two files, like the junk scanner would find.
    fn cache(&self, name: &str) -> PathBuf {
        let d = self.caches().join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("a"), b"cache").unwrap();
        fs::write(d.join("b"), b"cache").unwrap();
        d
    }

    /// A user document that must survive every test.
    fn precious(&self, rel: &str) -> PathBuf {
        let p = self.home.join("Documents").join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, b"irreplaceable").unwrap();
        p
    }

    fn remove(&self, items: &[Item]) -> Vec<limpa_core::remove::Outcome> {
        remove_items(items, &self.guard, &SystemRemover, &self.log)
    }
}

fn intact(p: &Path) {
    assert_eq!(fs::read(p).unwrap(), b"irreplaceable", "{} was touched", p.display());
}

/// Swapping (rename-dance) a reviewed cache folder for a symlink to Documents after the scan.
#[test]
fn item_swapped_for_symlink_after_scan_is_refused() {
    let h = home();
    let dir = h.cache("com.app");
    let doc = h.precious("thesis/final.tex");
    let item = Item::new(dir.clone(), 10, h.junk());
    fs::remove_dir_all(&dir).unwrap();
    symlink(doc.parent().unwrap(), &dir).unwrap();
    let out = h.remove(&[item]);
    assert!(!out[0].ok);
    intact(&doc);
}

/// The item's parent is swapped for a symlink into Documents: the resolved path leaves the junk root.
#[test]
fn parent_swapped_for_symlink_is_refused() {
    let h = home();
    let vendor = h.caches().join("Vendor");
    fs::create_dir_all(vendor.join("sub")).unwrap();
    let item = Item::new(vendor.join("sub"), 10, h.junk());
    let doc = h.precious("sub/notes.txt");
    fs::remove_dir_all(&vendor).unwrap();
    symlink(h.home.join("Documents"), &vendor).unwrap();
    let out = h.remove(&[item]);
    assert!(!out[0].ok);
    assert_eq!(out[0].error.as_deref(), Some("fora da área permitida"));
    intact(&doc);
}

/// Deleting a cache folder never follows symlinks inside it, and a hard link only drops one name.
#[test]
fn links_inside_a_deleted_folder_never_reach_their_targets() {
    let h = home();
    let dir = h.cache("com.links");
    let doc = h.precious("keep.txt");
    let docs_dir = h.home.join("Documents");
    symlink(&doc, dir.join("file-link")).unwrap();
    symlink(&docs_dir, dir.join("dir-link")).unwrap();
    fs::hard_link(&doc, dir.join("hard")).unwrap();
    let item = Item::new(dir.clone(), 10, h.junk());
    let out = h.remove(&[item]);
    assert!(out[0].ok, "{:?}", out[0].error);
    assert!(!dir.exists());
    intact(&doc);
    assert!(docs_dir.is_dir());
}

/// A junk root that is itself a symlink into the user's documents is not a cache, whatever its name.
#[test]
fn junk_root_resolving_into_user_folders_is_refused() {
    let h = home();
    let doc = h.precious("models/llm.gguf");
    let root = h.home.join(".lmstudio");
    symlink(doc.parent().unwrap().parent().unwrap(), &root).unwrap();
    let item = Item::new(root.join("models/llm.gguf"), 10, Policy::DeleteJunk { root: root.clone() });
    let out = h.remove(&[item]);
    assert!(!out[0].ok);
    assert_eq!(out[0].error.as_deref(), Some("raiz de limpeza inválida"));
    intact(&doc);
}

/// Trash entries: only direct children of ~/.Trash, and a swapped entry is refused.
#[test]
fn trash_entries_are_checked_again_at_removal() {
    let h = home();
    let trash = h.home.join(".Trash");
    fs::create_dir_all(trash.join("folder")).unwrap();
    fs::write(trash.join("folder/inner.txt"), b"x").unwrap();
    fs::write(trash.join("old.txt"), b"x").unwrap();
    let doc = h.precious("report.pdf");
    let nested = Item::new(trash.join("folder/inner.txt"), 1, Policy::EmptyTrashEntry);
    let swapped = Item::new(trash.join("old.txt"), 1, Policy::EmptyTrashEntry);
    fs::remove_file(trash.join("old.txt")).unwrap();
    symlink(&doc, trash.join("old.txt")).unwrap();
    let out = h.remove(&[nested, swapped]);
    assert!(out.iter().all(|o| !o.ok), "{out:?}");
    assert!(trash.join("folder/inner.txt").exists());
    intact(&doc);
}

/// The item vanished and something else took its name between scan and removal.
#[test]
fn recreated_path_with_new_content_is_refused() {
    let h = home();
    let dir = h.cache("com.recreated");
    let item = Item::new(dir.clone(), 10, h.junk());
    fs::remove_dir_all(&dir).unwrap();
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("fresh"), b"irreplaceable").unwrap();
    let out = h.remove(&[item]);
    assert_eq!(out[0].error.as_deref(), Some("o item mudou desde a análise; analise de novo"));
    intact(&dir.join("fresh"));
}

/// Many items deleted in parallel while another thread keeps swapping some of them for symlinks to documents.
/// Whatever the interleaving, no document is ever removed: either the identity check refuses the swapped path
/// or the delete removes the symlink itself.
#[test]
fn concurrent_tampering_never_reaches_documents() {
    let h = home();
    const N: usize = 240;
    let mut items = Vec::new();
    let mut victims = Vec::new();
    for i in 0..N {
        let dir = h.cache(&format!("c{i:03}"));
        items.push(Item::new(dir, 10, h.junk()));
        if i % 3 == 0 {
            victims.push((h.caches().join(format!("c{i:03}")), h.precious(&format!("v{i:03}/data.txt"))));
        }
    }
    let stop = Arc::new(AtomicBool::new(false));
    let swapper = {
        let stop = Arc::clone(&stop);
        let victims = victims.clone();
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                for (cache, doc) in &victims {
                    // Ignore errors: the remover may have deleted the cache (or the link) already.
                    if fs::symlink_metadata(cache).is_ok_and(|m| m.is_dir()) {
                        let _ = fs::remove_dir_all(cache);
                        let _ = symlink(doc.parent().unwrap(), cache);
                    }
                }
            }
        })
    };
    let out = h.remove(&items);
    stop.store(true, Ordering::Relaxed);
    swapper.join().unwrap();
    assert_eq!(out.len(), N);
    for (_, doc) in &victims {
        intact(doc);
    }
    // Untouched (non-victim) caches are all gone.
    for (i, o) in out.iter().enumerate() {
        if i % 3 != 0 {
            assert!(o.ok, "c{i:03}: {:?}", o.error);
        }
    }
}

/// Protected and forbidden locations are refused even when a scan somehow produced them.
#[test]
fn protected_and_forbidden_locations_are_never_removed() {
    let h = home();
    fs::create_dir_all(h.home.join(".ssh")).unwrap();
    fs::write(h.home.join(".ssh/id_ed25519"), b"irreplaceable").unwrap();
    let junk_home = Policy::DeleteJunk { root: h.home.clone() };
    let items = vec![
        Item::new(h.caches(), 1, h.junk()),
        Item::new(h.home.join("Documents"), 1, Policy::DeleteJunk { root: h.home.join("Library") }),
        Item::new(h.home.join(".ssh/id_ed25519"), 1, junk_home),
        Item::new(h.home.join(".ssh/id_ed25519"), 1, Policy::DeleteJunk { root: h.home.join(".ssh") }),
        Item::new(h.home.clone(), 1, Policy::EmptyTrashEntry),
    ];
    let out = h.remove(&items);
    assert!(out.iter().all(|o| !o.ok), "{out:?}");
    intact(&h.home.join(".ssh/id_ed25519"));
    assert!(h.caches().is_dir() && h.home.join("Documents").is_dir());
}
