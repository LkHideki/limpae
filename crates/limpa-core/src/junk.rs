use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::prelude::*;

use crate::model::{Group, Item, Policy, Progress};
use crate::running::cache_in_use;
use crate::size::alloc_size;

const GROUPS: [(&str, &str, &str); 4] = [
    ("user_caches", "Cache do usuário", "Arquivos temporários que os apps recriam automaticamente."),
    ("user_logs", "Logs do usuário", "Registros de diagnóstico de apps e do sistema."),
    ("xcode", "Lixo do Xcode", "Dados de build e suporte a dispositivos que o Xcode recria."),
    ("dev_caches", "Caches de desenvolvimento", "Pacotes baixados por gerenciadores como npm, Homebrew e pip."),
];
const USER_CACHES: usize = 0;
const USER_LOGS: usize = 1;
const XCODE: usize = 2;
const DEV_CACHES: usize = 3;

/// Caches whose removal resets system services (iCloud sync, HomeKit, Find My...) or aborts downloads in progress.
const CACHES_DENYLIST: &[&str] = &[
    "CloudKit",
    "com.apple.bird",
    "com.apple.HomeKit",
    "com.apple.homed",
    "FamilyCircle",
    "com.apple.passd",
    "com.apple.containermanagerd",
    "com.apple.ap.adprivacyd",
    "com.apple.findmy.fmipcore",
    "com.apple.icloud.fmfd",
    // In-flight downloads (background URL sessions, App Store, macOS updates): deleting them aborts the download.
    "com.apple.nsurlsessiond",
    "com.apple.appstore",
    "com.apple.appstoreagent",
    "com.apple.SoftwareUpdate",
    "com.apple.softwareupdated",
    "com.apple.iCloudHelper",
    "com.apple.cloudd",
    "br.com.limpaemeo",
];

/// Our own action log.
const OWN_LOGS: &str = "Limpaemeo";

const XCODE_ROOTS: &[&str] = &[
    "Library/Developer/Xcode/DerivedData",
    "Library/Developer/Xcode/iOS DeviceSupport",
    "Library/Developer/Xcode/watchOS DeviceSupport",
    "Library/Developer/Xcode/tvOS DeviceSupport",
    "Library/Developer/Xcode/visionOS DeviceSupport",
    "Library/Developer/CoreSimulator/Caches",
];

/// (junk root, item path, costly to download again), all relative to home.
const DEV_ITEMS: &[(&str, &str, bool)] = &[
    ("Library/Caches", "Library/Caches/Homebrew", false),
    ("Library/Caches", "Library/Caches/pip", false),
    ("Library/Caches", "Library/Caches/Yarn", false),
    ("Library/Caches", "Library/Caches/pnpm", false),
    ("Library/Caches", "Library/Caches/go-build", false),
    ("Library/Caches", "Library/Caches/node-gyp", false),
    ("Library/Caches", "Library/Caches/typescript", false),
    ("Library/Caches", "Library/Caches/CocoaPods", false),
    ("Library/Caches", "Library/Caches/org.swift.swiftpm", false),
    ("Library/Caches", "Library/Caches/ms-playwright", true),
    ("Library/Caches", "Library/Caches/JetBrains", true),
    (".npm", ".npm/_cacache", false),
    (".cargo", ".cargo/registry/cache", true),
    (".gradle", ".gradle/caches", true),
];

const HEAVY_NOTE: &str = "Grande para baixar de novo";
const RUNNING_NOTE: &str = "App em execução";

struct Candidate {
    path: PathBuf,
    root: PathBuf,
    group: usize,
    /// Present means the item starts unselected.
    note: Option<&'static str>,
}

/// Regenerable junk under the user's home. Groups: `user_caches`,
/// `user_logs`, `xcode`, `dev_caches`. `running` holds bundle ids or names of open apps
/// (see [`crate::running::running_keys`]); their caches start unselected.
pub fn scan_junk(home: &Path, running: &HashSet<String>, p: &Progress) -> Vec<Group> {
    let found = AtomicU64::new(0);
    let sized: Vec<(Candidate, u64)> = candidates(home, running)
        .into_par_iter()
        .filter_map(|c| {
            if p.cancelled() {
                return None;
            }
            let size = alloc_size(&c.path, p.cancel_flag());
            p.report(&c.path, found.fetch_add(size, Ordering::Relaxed) + size);
            (size > 0).then_some((c, size))
        })
        .collect();

    let mut groups: Vec<Vec<Item>> = GROUPS.iter().map(|_| Vec::new()).collect();
    for (c, size) in sized {
        let item = Item::new(c.path, size, Policy::DeleteJunk { root: c.root });
        groups[c.group].push(match c.note {
            Some(note) => item.unselected(note),
            None => item,
        });
    }
    GROUPS
        .iter()
        .zip(groups)
        .filter(|(_, items)| !items.is_empty())
        .map(|(&(id, title, description), mut items)| {
            items.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
            Group { id: id.into(), title: title.into(), description: description.into(), items }
        })
        .collect()
}

fn candidates(home: &Path, running: &HashSet<String>) -> Vec<Candidate> {
    let running: HashSet<String> = running.iter().map(|b| b.to_lowercase()).collect();
    let caches = home.join("Library/Caches");
    let mut out = Vec::new();

    for path in children(&caches) {
        let name = file_name(&path);
        let denied = CACHES_DENYLIST.iter().any(|d| d.eq_ignore_ascii_case(&name));
        // Dev caches get their own group, with their own policy.
        let dev = DEV_ITEMS.iter().any(|&(root, rel, _)| {
            root == "Library/Caches" && rel.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case(&name))
        });
        if denied || dev {
            continue;
        }
        let is_running = cache_in_use(&name, &running);
        out.push(Candidate {
            path,
            root: caches.clone(),
            group: USER_CACHES,
            note: is_running.then_some(RUNNING_NOTE),
        });
    }

    let logs = home.join("Library/Logs");
    for path in children(&logs) {
        if file_name(&path) != OWN_LOGS {
            out.push(Candidate { path, root: logs.clone(), group: USER_LOGS, note: None });
        }
    }

    for rel in XCODE_ROOTS {
        let root = home.join(rel);
        for path in children(&root) {
            out.push(Candidate { path, root: root.clone(), group: XCODE, note: None });
        }
    }

    for &(root, rel, heavy) in DEV_ITEMS {
        let path = home.join(rel);
        if fs::symlink_metadata(&path).is_ok() {
            out.push(Candidate { path, root: home.join(root), group: DEV_CACHES, note: heavy.then_some(HEAVY_NOTE) });
        }
    }
    out
}

/// Direct children of `root`; a missing or unreadable root yields none.
fn children(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root).map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).collect()).unwrap_or_default()
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
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

    /// Scans and asserts that the guard accepts every produced item.
    fn scan(home: &Path, running: &[&str]) -> Vec<Group> {
        let running = running.iter().map(|s| s.to_string()).collect();
        let groups = scan_junk(home, &running, &Progress::silent());
        let guard = Guard::new(home);
        for item in groups.iter().flat_map(|g| &g.items) {
            assert!(guard.check(&item.path, &item.policy).is_ok(), "guard rejects {:?}", item.path);
        }
        groups
    }

    fn group<'a>(groups: &'a [Group], id: &str) -> &'a Group {
        groups.iter().find(|g| g.id == id).unwrap_or_else(|| panic!("group {id} missing"))
    }

    fn names(g: &Group) -> Vec<&str> {
        g.items.iter().map(|i| i.name.as_str()).collect()
    }

    #[test]
    fn denylist_skipped_case_insensitive() {
        let (_t, home) = fake_home();
        let caches = home.join("Library/Caches");
        for n in ["CloudKit", "com.apple.bird", "COM.APPLE.HOMED", "br.com.limpaemeo", "com.foo.app"] {
            write(&caches.join(n).join("data"), KB64);
        }
        let groups = scan(&home, &[]);
        assert_eq!(names(group(&groups, "user_caches")), ["com.foo.app"]);
    }

    #[test]
    fn running_app_cache_unselected_with_note() {
        let (_t, home) = fake_home();
        let caches = home.join("Library/Caches");
        for n in ["com.foo.app", "com.foo.app.helper", "com.foo.application", "com.bar"] {
            write(&caches.join(n).join("data"), KB64);
        }
        let groups = scan(&home, &["com.Foo.App"]);
        let g = group(&groups, "user_caches");
        assert_eq!(g.items.len(), 4);
        for item in &g.items {
            let running = item.name == "com.foo.app" || item.name == "com.foo.app.helper";
            assert_eq!(item.selected, !running, "{}", item.name);
            assert_eq!(item.note.as_deref(), running.then_some("App em execução"), "{}", item.name);
        }
    }

    #[test]
    fn dev_names_routed_to_dev_caches() {
        let (_t, home) = fake_home();
        let caches = home.join("Library/Caches");
        for n in ["Homebrew", "ms-playwright", "JetBrains", "com.foo"] {
            write(&caches.join(n).join("data"), KB64);
        }
        write(&home.join(".npm/_cacache/x"), KB64);
        write(&home.join(".cargo/registry/cache/x"), KB64);
        write(&home.join(".cargo/registry/src/x"), KB64);
        write(&home.join(".gradle/caches/x"), KB64);
        let groups = scan(&home, &[]);
        assert_eq!(names(group(&groups, "user_caches")), ["com.foo"]);

        let dev = group(&groups, "dev_caches");
        assert_eq!(dev.items.len(), 6);
        for item in &dev.items {
            let heavy = ["ms-playwright", "JetBrains", "cache", "caches"].contains(&item.name.as_str());
            assert_eq!(item.selected, !heavy, "{}", item.name);
            assert_eq!(item.note.as_deref(), heavy.then_some("Grande para baixar de novo"), "{}", item.name);
            let Policy::DeleteJunk { root } = &item.policy else { panic!("policy") };
            let expected = match item.name.as_str() {
                "_cacache" => home.join(".npm"),
                "cache" => home.join(".cargo"),
                "caches" => home.join(".gradle"),
                _ => caches.clone(),
            };
            assert_eq!(root, &expected, "{}", item.name);
        }
    }

    #[test]
    fn own_logs_dir_skipped() {
        let (_t, home) = fake_home();
        write(&home.join("Library/Logs/Limpaemeo/action.log"), KB64);
        write(&home.join("Library/Logs/DiagnosticReports/a.ips"), KB64);
        let groups = scan(&home, &[]);
        assert_eq!(groups.len(), 1);
        assert_eq!(names(group(&groups, "user_logs")), ["DiagnosticReports"]);
    }

    #[test]
    fn xcode_roots_and_per_item_root() {
        let (_t, home) = fake_home();
        let xc = home.join("Library/Developer/Xcode");
        write(&xc.join("DerivedData/App-abc/b"), KB64);
        write(&xc.join("iOS DeviceSupport/17.0/s"), KB64);
        write(&xc.join("watchOS DeviceSupport/10.0/s"), KB64);
        write(&xc.join("tvOS DeviceSupport/17.0/s"), KB64);
        write(&xc.join("visionOS DeviceSupport/1.0/s"), KB64);
        write(&xc.join("Archives/2024/App.xcarchive/a"), KB64);
        write(&home.join("Library/Developer/CoreSimulator/Caches/dyld/x"), KB64);
        write(&home.join("Library/Developer/CoreSimulator/Devices/D/x"), KB64);
        let groups = scan(&home, &[]);
        assert_eq!(groups.len(), 1);
        let g = group(&groups, "xcode");
        assert_eq!(g.items.len(), 6);
        for item in &g.items {
            assert!(item.selected && item.note.is_none());
            let Policy::DeleteJunk { root } = &item.policy else { panic!("policy") };
            assert_eq!(Some(root.as_path()), item.path.parent(), "{:?}", item.path);
            assert!(!item.path.to_string_lossy().contains("Archives"));
            assert!(!item.path.to_string_lossy().contains("Devices"));
        }
    }

    #[test]
    fn empty_and_missing_groups_omitted() {
        let (_t, home) = fake_home();
        assert!(scan(&home, &[]).is_empty());
        fs::create_dir_all(home.join("Library/Caches/com.empty")).unwrap();
        fs::create_dir_all(home.join("Library/Logs")).unwrap();
        fs::create_dir_all(home.join(".npm/_cacache")).unwrap();
        assert!(scan(&home, &[]).is_empty());
    }

    #[test]
    fn sorted_by_size_desc() {
        let (_t, home) = fake_home();
        let caches = home.join("Library/Caches");
        write(&caches.join("small/d"), KB64);
        write(&caches.join("big/d"), 8 * KB64);
        write(&caches.join("mid/d"), 3 * KB64);
        let groups = scan(&home, &[]);
        assert_eq!(names(group(&groups, "user_caches")), ["big", "mid", "small"]);
    }

    #[test]
    fn progress_reported_and_cancel_honored() {
        let (_t, home) = fake_home();
        write(&home.join("Library/Caches/com.a/d"), KB64);
        write(&home.join("Library/Logs/b/d"), KB64);
        let calls = Arc::new(AtomicU64::new(0));
        let c = calls.clone();
        let p = Progress::new(Arc::new(AtomicBool::new(false)), move |_, _| {
            c.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(scan_junk(&home, &HashSet::new(), &p).len(), 2);
        assert_eq!(calls.load(Ordering::Relaxed), 2);

        let cancelled = Progress::new(Arc::new(AtomicBool::new(true)), |_, _| {});
        assert!(scan_junk(&home, &HashSet::new(), &cancelled).is_empty());
    }
}
