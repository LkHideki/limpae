use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rayon::prelude::*;
use serde::Serialize;

use crate::model::{Item, Policy, Progress};
use crate::size::alloc_size;

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub path: PathBuf,
    pub name: String,
    pub bundle_id: String,
    pub version: Option<String>,
    pub size: u64,
    pub running: bool,
}

/// Vendor/folder names shared by many products: matching leftovers by them would sweep up other apps' data.
const GENERIC_NAMES: &[&str] = &[
    "google",
    "microsoft",
    "adobe",
    "apple",
    "mozilla",
    "jetbrains",
    "steam",
    "unity",
    "oracle",
    "python",
    "java",
    "default",
    "common",
    "shared",
    "data",
    "cache",
    "caches",
    "logs",
    "library",
    "support",
];

const NAME_MATCH_NOTE: &str = "Correspondência pelo nome";

/// Real (non-symlink) directories directly inside `dir`.
fn child_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    // DirEntry::file_type does not follow symlinks, so symlinked bundles/folders are skipped.
    rd.filter_map(Result::ok).filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect()
}

fn is_app(path: &Path) -> bool {
    path.extension() == Some(OsStr::new("app"))
}

/// `*.app` bundles directly under `root` plus one level of plain subfolders (e.g. `Utilities`).
fn discover(root: &Path) -> Vec<PathBuf> {
    let mut apps = Vec::new();
    for dir in child_dirs(root) {
        if is_app(&dir) {
            apps.push(dir);
        } else {
            apps.extend(child_dirs(&dir).into_iter().filter(|d| is_app(d)));
        }
    }
    apps
}

struct Meta {
    name: String,
    bundle_id: String,
    version: Option<String>,
}

fn read_meta(app: &Path) -> Option<Meta> {
    let value = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
    let dict = value.as_dictionary()?;
    let text = |key: &str| dict.get(key).and_then(|v| v.as_string()).map(str::trim).filter(|s| !s.is_empty());
    let bundle_id = text("CFBundleIdentifier")?.to_owned();
    let name = text("CFBundleDisplayName")
        .or_else(|| text("CFBundleName"))
        .map(str::to_owned)
        .or_else(|| app.file_stem().map(|s| s.to_string_lossy().into_owned()))?;
    Some(Meta { name, bundle_id, version: text("CFBundleShortVersionString").map(str::to_owned) })
}

/// Installed apps under `roots`, sorted by name. Apple's own apps and this app are left out so they can't be
/// uninstalled. Returns an empty list if cancelled, since partial sizes would mislead.
pub fn list_apps(roots: &[PathBuf], running: &HashSet<String>, own_bundle_id: &str, p: &Progress) -> Vec<AppInfo> {
    let mut seen = HashSet::new();
    let paths: Vec<PathBuf> = roots.iter().flat_map(|r| discover(r)).filter(|a| seen.insert(a.clone())).collect();

    let total = AtomicU64::new(0);
    let mut apps: Vec<AppInfo> = paths
        .into_par_iter()
        .filter_map(|path| {
            if p.cancelled() {
                return None;
            }
            let meta = read_meta(&path)?;
            if meta.bundle_id.starts_with("com.apple.") || meta.bundle_id == own_bundle_id {
                return None;
            }
            let size = alloc_size(&path, p.cancel_flag());
            p.report(&path, total.fetch_add(size, Ordering::Relaxed) + size);
            let running = running.contains(&meta.bundle_id);
            Some(AppInfo { path, name: meta.name, bundle_id: meta.bundle_id, version: meta.version, size, running })
        })
        .collect();

    if p.cancelled() {
        return Vec::new();
    }
    apps.sort_by_cached_key(|a| (a.name.to_lowercase(), a.path.clone()));
    apps
}

fn is_plain_component(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains('/')
}

/// Candidate paths derived from the bundle id, relative to `~/Library`.
fn bundle_candidates(lib: &Path, b: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = [
        format!("Application Support/{b}"),
        format!("Caches/{b}"),
        format!("Preferences/{b}.plist"),
        format!("Containers/{b}"),
        format!("Application Scripts/{b}"),
        format!("Saved Application State/{b}.savedState"),
        format!("HTTPStorages/{b}"),
        format!("HTTPStorages/{b}.binarycookies"),
        format!("WebKit/{b}"),
        format!("Logs/{b}"),
        format!("Cookies/{b}.binarycookies"),
        format!("LaunchAgents/{b}.plist"),
    ]
    .iter()
    .map(|rel| lib.join(rel))
    .collect();

    let dotted = format!("{b}.");
    let plist_of_bundle = |n: &str| n.starts_with(&dotted) && n.ends_with(".plist");
    for dir in ["Preferences", "Preferences/ByHost", "LaunchAgents"] {
        out.extend(entries(&lib.join(dir), plist_of_bundle));
    }
    let team_suffix = format!(".{b}");
    out.extend(entries(&lib.join("Group Containers"), |n| n.ends_with(&team_suffix)));
    out
}

fn entries(dir: &Path, keep: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(Result::ok).filter(|e| keep(&e.file_name().to_string_lossy())).map(|e| e.path()).collect()
}

fn name_is_matchable(name: &str) -> bool {
    name.chars().count() >= 4 && is_plain_component(name) && !GENERIC_NAMES.contains(&name.to_lowercase().as_str())
}

/// Leftover files of `app` under `home`, biggest first. Bundle-id hits are pre-selected; name hits are not,
/// because a name can collide with unrelated data. Everything goes to the Trash so a wrong match is recoverable.
pub fn find_leftovers(home: &Path, app: &AppInfo, cancel: &AtomicBool) -> Vec<Item> {
    let lib = home.join("Library");
    let mut candidates: Vec<(PathBuf, bool)> = Vec::new();
    if is_plain_component(&app.bundle_id) {
        candidates.extend(bundle_candidates(&lib, &app.bundle_id).into_iter().map(|p| (p, true)));
    }
    if name_is_matchable(&app.name) {
        let n = &app.name;
        candidates.extend(["Application Support", "Caches", "Logs"].iter().map(|d| (lib.join(d).join(n), false)));
    }

    // APFS is usually case-insensitive, so `Foo` and `foo` are the same directory.
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(app.path.to_string_lossy().to_lowercase());
    let mut items = Vec::new();
    for (path, by_id) in candidates {
        if cancel.load(Ordering::Relaxed) {
            return Vec::new();
        }
        if fs::symlink_metadata(&path).is_err() || !seen.insert(path.to_string_lossy().to_lowercase()) {
            continue;
        }
        let item = Item::new(path.clone(), alloc_size(&path, cancel), Policy::MoveToTrash);
        items.push(if by_id { item } else { item.unselected(NAME_MATCH_NOTE) });
    }
    items.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::Guard;
    use std::sync::Arc;

    fn make_app(dir: &Path, file: &str, info: Option<&[(&str, &str)]>) -> PathBuf {
        let app = dir.join(file);
        fs::create_dir_all(app.join("Contents")).unwrap();
        fs::write(app.join("Contents/MacOS"), vec![1u8; 20_000]).unwrap();
        if let Some(pairs) = info {
            let mut d = plist::Dictionary::new();
            for (k, v) in pairs {
                d.insert((*k).into(), plist::Value::String((*v).into()));
            }
            plist::Value::Dictionary(d).to_file_xml(app.join("Contents/Info.plist")).unwrap();
        }
        app
    }

    fn list(roots: &[PathBuf], running: &[&str]) -> Vec<AppInfo> {
        let running = running.iter().map(|s| (*s).to_owned()).collect();
        list_apps(roots, &running, "br.com.limpaemeo", &Progress::silent())
    }

    #[test]
    fn lists_normal_app_with_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = make_app(
            dir.path(),
            "Foo.app",
            Some(&[
                ("CFBundleIdentifier", "com.acme.foo"),
                ("CFBundleDisplayName", "Foo Display"),
                ("CFBundleName", "FooName"),
                ("CFBundleShortVersionString", "1.2.3"),
            ]),
        );
        let apps = list(&[dir.path().to_path_buf()], &[]);
        assert_eq!(apps.len(), 1);
        let a = &apps[0];
        assert_eq!((a.name.as_str(), a.bundle_id.as_str()), ("Foo Display", "com.acme.foo"));
        assert_eq!(a.version.as_deref(), Some("1.2.3"));
        assert_eq!(a.path, path);
        assert!(a.size >= 20_000, "{}", a.size);
        assert!(!a.running);
    }

    #[test]
    fn skips_apple_own_and_missing_identifier() {
        let dir = tempfile::tempdir().unwrap();
        make_app(dir.path(), "Safari.app", Some(&[("CFBundleIdentifier", "com.apple.Safari")]));
        make_app(dir.path(), "Limpa.app", Some(&[("CFBundleIdentifier", "br.com.limpaemeo")]));
        make_app(dir.path(), "NoId.app", Some(&[("CFBundleName", "NoId")]));
        make_app(dir.path(), "NoPlist.app", None);
        make_app(dir.path(), "Ok.app", Some(&[("CFBundleIdentifier", "com.acme.ok")]));
        let apps = list(&[dir.path().to_path_buf()], &[]);
        assert_eq!(apps.iter().map(|a| a.bundle_id.as_str()).collect::<Vec<_>>(), ["com.acme.ok"]);
    }

    #[test]
    fn finds_one_level_of_subfolder_only() {
        let dir = tempfile::tempdir().unwrap();
        make_app(&dir.path().join("Utilities"), "Util.app", Some(&[("CFBundleIdentifier", "com.acme.util")]));
        make_app(&dir.path().join("Utilities/Deeper"), "Deep.app", Some(&[("CFBundleIdentifier", "com.acme.deep")]));
        let apps = list(&[dir.path().to_path_buf(), dir.path().join("missing")], &[]);
        assert_eq!(apps.iter().map(|a| a.bundle_id.as_str()).collect::<Vec<_>>(), ["com.acme.util"]);
    }

    #[test]
    fn skips_symlinked_app_and_non_app_dirs_in_files() {
        let outside = tempfile::tempdir().unwrap();
        let real = make_app(outside.path(), "Real.app", Some(&[("CFBundleIdentifier", "com.acme.real")]));
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(&real, dir.path().join("Link.app")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("LinkedFolder")).unwrap();
        fs::write(dir.path().join("File.app"), b"x").unwrap();
        assert!(list(&[dir.path().to_path_buf()], &[]).is_empty());
    }

    #[test]
    fn name_falls_back_in_order() {
        let dir = tempfile::tempdir().unwrap();
        make_app(dir.path(), "A.app", Some(&[("CFBundleIdentifier", "a"), ("CFBundleName", "BundleName")]));
        make_app(dir.path(), "Stem.app", Some(&[("CFBundleIdentifier", "b")]));
        let apps = list(&[dir.path().to_path_buf()], &[]);
        let names: Vec<_> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["BundleName", "Stem"]);
    }

    #[test]
    fn running_flag_and_case_insensitive_sort() {
        let dir = tempfile::tempdir().unwrap();
        make_app(dir.path(), "zeta.app", Some(&[("CFBundleIdentifier", "com.z")]));
        make_app(dir.path(), "Alpha.app", Some(&[("CFBundleIdentifier", "com.a")]));
        make_app(dir.path(), "beta.app", Some(&[("CFBundleIdentifier", "com.b")]));
        let apps = list(&[dir.path().to_path_buf()], &["com.b"]);
        let got: Vec<_> = apps.iter().map(|a| (a.name.as_str(), a.running)).collect();
        assert_eq!(got, [("Alpha", false), ("beta", true), ("zeta", false)]);
    }

    #[test]
    fn dedupes_same_path_across_roots() {
        let dir = tempfile::tempdir().unwrap();
        make_app(dir.path(), "Foo.app", Some(&[("CFBundleIdentifier", "com.acme.foo")]));
        let root = dir.path().to_path_buf();
        assert_eq!(list(&[root.clone(), root], &[]).len(), 1);
    }

    #[test]
    fn reports_progress_and_honors_cancel() {
        let dir = tempfile::tempdir().unwrap();
        make_app(dir.path(), "Foo.app", Some(&[("CFBundleIdentifier", "com.acme.foo")]));
        let calls = Arc::new(AtomicU64::new(0));
        let c = calls.clone();
        let p = Progress::new(Arc::new(AtomicBool::new(false)), move |_, bytes| {
            assert!(bytes > 0);
            c.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(list_apps(&[dir.path().to_path_buf()], &HashSet::new(), "x", &p).len(), 1);
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        let cancelled = Progress::new(Arc::new(AtomicBool::new(true)), |_, _| {});
        assert!(list_apps(&[dir.path().to_path_buf()], &HashSet::new(), "x", &cancelled).is_empty());
    }

    fn app_info(name: &str, id: &str) -> AppInfo {
        AppInfo {
            path: PathBuf::from("/Applications").join(format!("{name}.app")),
            name: name.into(),
            bundle_id: id.into(),
            version: None,
            size: 0,
            running: false,
        }
    }

    fn touch(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![3u8; bytes]).unwrap();
    }

    fn fake_home() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(t.path()).unwrap();
        (t, home)
    }

    fn leftovers(home: &Path, app: &AppInfo) -> Vec<Item> {
        find_leftovers(home, app, &AtomicBool::new(false))
    }

    fn rel(home: &Path, items: &[Item]) -> Vec<String> {
        let mut v: Vec<_> =
            items.iter().map(|i| i.path.strip_prefix(home).unwrap().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn leftovers_by_bundle_id_are_selected() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        let id = "com.acme.foo";
        touch(&l.join(format!("Application Support/{id}/data")), 10_000);
        touch(&l.join(format!("Caches/{id}/c")), 10);
        touch(&l.join(format!("Preferences/{id}.plist")), 10);
        touch(&l.join(format!("Preferences/{id}.helper.plist")), 10);
        touch(&l.join(format!("Preferences/{id}x.plist")), 10);
        touch(&l.join(format!("Preferences/ByHost/{id}.ABC123.plist")), 10);
        touch(&l.join(format!("Containers/{id}/c")), 10);
        touch(&l.join(format!("Application Scripts/{id}/s")), 10);
        touch(&l.join(format!("Saved Application State/{id}.savedState/w")), 10);
        touch(&l.join(format!("HTTPStorages/{id}/h")), 10);
        touch(&l.join(format!("HTTPStorages/{id}.binarycookies")), 10);
        touch(&l.join(format!("WebKit/{id}/w")), 10);
        touch(&l.join(format!("Logs/{id}/l")), 10);
        touch(&l.join(format!("Cookies/{id}.binarycookies")), 10);
        touch(&l.join(format!("LaunchAgents/{id}.plist")), 10);
        touch(&l.join(format!("LaunchAgents/{id}.agent.plist")), 10);
        touch(&l.join("LaunchAgents/com.other.plist"), 10);
        touch(&l.join("Caches/com.acme.foobar/c"), 10);

        let items = leftovers(&home, &app_info("Foo", id));
        let got = rel(&home, &items);
        assert_eq!(got.len(), 15, "{got:#?}");
        assert!(!got.iter().any(|p| p.contains("foobar") || p.contains("other") || p.ends_with("x.plist")));
        assert!(items.iter().all(|i| i.selected && i.note.is_none() && i.policy == Policy::MoveToTrash));
        assert!(items.windows(2).all(|w| w[0].size >= w[1].size));
        assert!(items[0].path.ends_with(format!("Application Support/{id}")));
    }

    #[test]
    fn group_container_matches_team_prefix_suffix() {
        let (_t, home) = fake_home();
        let g = home.join("Library/Group Containers");
        touch(&g.join("TEAM123.com.acme.foo/x"), 10);
        touch(&g.join("group.com.acme.foo/x"), 10);
        touch(&g.join("TEAM123.com.acme.foobar/x"), 10);
        touch(&g.join("com.acme.foo/x"), 10);
        let got = rel(&home, &leftovers(&home, &app_info("Q", "com.acme.foo")));
        assert_eq!(
            got,
            ["Library/Group Containers/TEAM123.com.acme.foo", "Library/Group Containers/group.com.acme.foo"]
        );
    }

    #[test]
    fn name_matches_are_unselected_with_note() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        touch(&l.join("Application Support/Fancy App/d"), 10);
        touch(&l.join("Caches/Fancy App/d"), 10);
        touch(&l.join("Logs/Fancy App/d"), 10);
        let items = leftovers(&home, &app_info("Fancy App", "com.acme.fancy"));
        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|i| !i.selected && i.note.as_deref() == Some("Correspondência pelo nome")));
    }

    #[test]
    fn generic_or_short_names_are_not_matched() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        for n in ["Google", "microsoft", "JetBrains", "Foo"] {
            touch(&l.join(format!("Application Support/{n}/d")), 10);
            let items = leftovers(&home, &app_info(n, "com.acme.nomatch"));
            assert!(items.is_empty(), "{n}: {items:?}");
        }
    }

    #[test]
    fn same_path_by_id_and_name_is_deduped_and_stays_selected() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        // name equals bundle id -> same paths; also differing only by case on APFS.
        touch(&l.join("Caches/com.acme.foo/c"), 10);
        let items = leftovers(&home, &app_info("com.acme.foo", "com.acme.foo"));
        assert_eq!(items.len(), 1);
        assert!(items[0].selected);
        let items = leftovers(&home, &app_info("COM.ACME.FOO", "com.acme.foo"));
        assert_eq!(items.len(), 1);
        assert!(items[0].selected);
    }

    #[test]
    fn hostile_identifiers_do_not_escape_library() {
        let (_t, home) = fake_home();
        touch(&home.join("Library/Caches/x"), 10);
        assert!(leftovers(&home, &app_info("..", "..")).is_empty());
        assert!(leftovers(&home, &app_info("a/../b", "")).is_empty());
    }

    #[test]
    fn cancelled_returns_nothing() {
        let (_t, home) = fake_home();
        touch(&home.join("Library/Caches/com.acme.foo/c"), 10);
        assert!(find_leftovers(&home, &app_info("Foo", "com.acme.foo"), &AtomicBool::new(true)).is_empty());
    }

    #[test]
    fn every_leftover_passes_the_guard() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        let id = "com.acme.fancy";
        touch(&l.join(format!("Application Support/{id}/a")), 10);
        touch(&l.join(format!("Preferences/{id}.plist")), 10);
        touch(&l.join(format!("LaunchAgents/{id}.plist")), 10);
        touch(&l.join(format!("Group Containers/TEAM.{id}/a")), 10);
        touch(&l.join("Saved Application State/com.acme.fancy.savedState/w"), 10);
        touch(&l.join("Caches/Fancy App/a"), 10);
        let items = leftovers(&home, &app_info("Fancy App", id));
        assert!(items.len() >= 6);
        let guard = Guard::new(&home);
        for i in &items {
            assert!(guard.check(&i.path, &i.policy).is_ok(), "{:?}", i.path);
        }
    }
}
