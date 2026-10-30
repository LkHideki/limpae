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

/// Evidence taken from the installed bundle itself, independent of folder names in `~/Library`: which
/// sub-identifiers and app groups really belong to the app.
#[derive(Debug, Default, Clone)]
pub struct Ownership {
    /// Bundle ids of helpers, XPC services, login items and extensions shipped inside the app.
    pub embedded_ids: HashSet<String>,
    /// App groups declared in the app's signed entitlements.
    pub app_groups: HashSet<String>,
}

/// Reads the app's embedded bundles and signed entitlements (one `codesign` call, a few ms). Only components
/// whose id extends the app's own (`<app id>.helper`) count: bundles shipped inside frameworks or under a
/// foreign id (Sparkle's Autoupdate, Google's updater, Squirrel's ShipIt) are shared by many apps.
pub fn ownership(app: &AppInfo) -> Ownership {
    let prefix = format!("{}.", app.bundle_id);
    let embedded_ids = embedded_bundle_ids(&app.path).into_iter().filter(|id| id.starts_with(&prefix)).collect();
    Ownership { embedded_ids, app_groups: entitlement_groups(&app.path) }
}

const EMBEDDED_EXTS: &[&str] = &["app", "appex", "xpc", "systemextension"];

/// Identifiers of nested bundles under `Contents/` (depth-limited, symlinks not followed).
fn embedded_bundle_ids(app: &Path) -> HashSet<String> {
    fn walk(dir: &Path, depth: u8, out: &mut HashSet<String>) {
        if depth == 0 {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.filter_map(Result::ok) {
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let path = e.path();
            let name = e.file_name();
            let name = name.to_string_lossy();
            // Frameworks are shared code; resources and localizations hold no bundles but thousands of files.
            if name == "Resources"
                || name == "_CodeSignature"
                || name.ends_with(".framework")
                || name.ends_with(".lproj")
            {
                continue;
            }
            if path.extension().is_some_and(|x| EMBEDDED_EXTS.iter().any(|k| x == *k)) {
                let info = plist::Value::from_file(path.join("Contents/Info.plist")).ok();
                if let Some(id) = info.as_ref().and_then(|v| v.as_dictionary()?.get("CFBundleIdentifier")?.as_string())
                {
                    out.insert(id.to_string());
                }
            }
            walk(&path, depth - 1, out);
        }
    }
    let mut out = HashSet::new();
    walk(&app.join("Contents"), 7, &mut out);
    out
}

/// `com.apple.security.application-groups` from the code signature; empty when unsigned or unreadable.
fn entitlement_groups(app: &Path) -> HashSet<String> {
    let Ok(out) = std::process::Command::new("/usr/bin/codesign")
        .args(["-d", "--entitlements", "-", "--xml"])
        .arg(app)
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return HashSet::new();
    };
    plist::Value::from_reader_xml(out.stdout.as_slice())
        .ok()
        .and_then(|v| v.into_dictionary())
        .and_then(|mut d| d.remove("com.apple.security.application-groups"))
        .and_then(|v| v.into_array())
        .map(|a| a.into_iter().filter_map(|v| v.into_string()).collect())
        .unwrap_or_default()
}

/// Locations macOS frameworks key by bundle id: (folder in ~/Library, suffix, label shown to the user).
const BY_ID: &[(&str, &str, &str)] = &[
    ("Application Support", "", "Suporte do app"),
    ("Caches", "", "Caches"),
    ("Preferences", ".plist", "Preferências"),
    ("Containers", "", "Contêiner do app"),
    ("Application Scripts", "", "Scripts do app"),
    ("Saved Application State", ".savedState", "Estado das janelas"),
    ("HTTPStorages", "", "Armazenamento web"),
    ("HTTPStorages", ".binarycookies", "Cookies"),
    ("WebKit", "", "Dados do WebKit"),
    ("Logs", "", "Registros"),
    ("Cookies", ".binarycookies", "Cookies"),
    ("LaunchAgents", ".plist", "Agente de inicialização"),
];

/// Locations that hold the app's documents/state rather than caches.
const DATA_LABELS: &[&str] = &["Suporte do app", "Contêiner do app", "Contêiner compartilhado"];
const BIG_DATA_BYTES: u64 = 1_000_000_000;

const NOTE_PREFIX: &str = "Mesmo prefixo do app, sem confirmação";
const NOTE_AGENT_OUTSIDE: &str = "O agente executa um programa fora do app";
const NOTE_AGENT_UNREADABLE: &str = "Não foi possível ler o agente";
const NOTE_GROUP_UNDECLARED: &str = "Grupo não declarado pelo app";
const NOTE_GROUP_SHARED: &str = "Grupo do fornecedor, pode ser compartilhado";

/// How sure we are that a path belongs to the app being uninstalled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Evidence {
    /// Named after the app's (or an embedded component's) bundle id, or proven by the bundle itself.
    Confirmed,
    /// Plausible but unproven: listed unselected with the reason.
    Weak(&'static str),
}

struct Candidate {
    path: PathBuf,
    label: &'static str,
    evidence: Evidence,
}

/// `Program` / `ProgramArguments[0]` of a launch agent plist.
fn agent_program(plist_path: &Path) -> Option<Option<PathBuf>> {
    let v = plist::Value::from_file(plist_path).ok()?;
    let d = v.as_dictionary()?;
    let first = || d.get("ProgramArguments")?.as_array()?.first()?.as_string();
    Some(d.get("Program").and_then(|p| p.as_string()).or_else(first).map(PathBuf::from))
}

/// A launch agent is the app's when its executable lives inside the bundle, or no longer exists at all.
fn agent_evidence(plist_path: &Path, app: &Path) -> Evidence {
    match agent_program(plist_path) {
        None => Evidence::Weak(NOTE_AGENT_UNREADABLE),
        Some(Some(prog)) if prog.starts_with(app) || fs::symlink_metadata(&prog).is_err() => Evidence::Confirmed,
        Some(Some(_)) => Evidence::Weak(NOTE_AGENT_OUTSIDE),
        Some(None) => Evidence::Weak(NOTE_AGENT_UNREADABLE),
    }
}

/// `com.foo.app.0123ABCD-...` (Preferences/ByHost) → `com.foo.app`.
fn strip_host_uuid(stem: &str) -> &str {
    match stem.rsplit_once('.') {
        Some((head, tail)) if tail.len() >= 12 && tail.chars().all(|c| c.is_ascii_hexdigit() || c == '-') => head,
        _ => stem,
    }
}

fn candidates(lib: &Path, app: &AppInfo, own: &Ownership, other_app: &dyn Fn(&str) -> bool) -> Vec<Candidate> {
    let b = app.bundle_id.as_str();
    let mut ids: Vec<&str> = vec![b];
    // Components shipped inside this bundle keep their own data under their own ids.
    ids.extend(own.embedded_ids.iter().map(String::as_str).filter(|id| is_plain_component(id) && *id != b));
    let mine = |id: &str| id == b || own.embedded_ids.contains(id);
    let mut out = Vec::new();

    for id in &ids {
        for (dir, suffix, label) in BY_ID {
            let path = lib.join(dir).join(format!("{id}{suffix}"));
            if fs::symlink_metadata(&path).is_err() {
                continue;
            }
            let evidence = if *dir == "LaunchAgents" { agent_evidence(&path, &app.path) } else { Evidence::Confirmed };
            out.push(Candidate { path, label, evidence });
        }
    }

    // Other `b.*` plists: helpers we could not prove, unless another installed app owns that id.
    let dotted = format!("{b}.");
    for (dir, label) in [
        ("Preferences", "Preferências"),
        ("Preferences/ByHost", "Preferências deste Mac"),
        ("LaunchAgents", "Agente de inicialização"),
    ] {
        for path in entries(&lib.join(dir), |n| n.starts_with(&dotted) && n.ends_with(".plist")) {
            let name = file_name_str(&path);
            let stem = name.trim_end_matches(".plist");
            let id = if dir == "Preferences/ByHost" { strip_host_uuid(stem) } else { stem };
            if dir != "Preferences/ByHost" && mine(id) {
                continue; // already listed as a by-id location above
            }
            let evidence = if dir == "LaunchAgents" {
                agent_evidence(&path, &app.path)
            } else if mine(id) {
                Evidence::Confirmed
            } else if other_app(id) {
                continue; // belongs to a different installed app
            } else {
                Evidence::Weak(NOTE_PREFIX)
            };
            out.push(Candidate { path, label, evidence });
        }
    }

    // App groups: confirmed only when the signed entitlements declare them.
    let team_suffix = format!(".{b}");
    let group_exact = format!("group.{b}");
    for path in entries(&lib.join("Group Containers"), |_| true) {
        let name = file_name_str(&path);
        let named_after_app = name.ends_with(&team_suffix) || name == group_exact;
        let declared = own.app_groups.contains(&name);
        let evidence = match (named_after_app, declared) {
            (true, true) => Evidence::Confirmed,
            (true, false) => Evidence::Weak(NOTE_GROUP_UNDECLARED),
            (false, true) => Evidence::Weak(NOTE_GROUP_SHARED),
            (false, false) => continue,
        };
        out.push(Candidate { path, label: "Contêiner compartilhado", evidence });
    }

    if name_is_matchable(&app.name) {
        for (dir, label) in [("Application Support", "Suporte do app"), ("Caches", "Caches"), ("Logs", "Registros")] {
            let path = lib.join(dir).join(&app.name);
            if fs::symlink_metadata(&path).is_ok() {
                out.push(Candidate { path, label, evidence: Evidence::Weak(NAME_MATCH_NOTE) });
            }
        }
    }
    out
}

fn file_name_str(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn entries(dir: &Path, keep: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(Result::ok).filter(|e| keep(&e.file_name().to_string_lossy())).map(|e| e.path()).collect()
}

fn name_is_matchable(name: &str) -> bool {
    name.chars().count() >= 4 && is_plain_component(name) && !GENERIC_NAMES.contains(&name.to_lowercase().as_str())
}

/// Leftover files of `app` under `home`, biggest first. Each one needs proof of ownership to be pre-selected:
/// a folder named after the app's bundle id (or an id embedded in the bundle), a launch agent that runs code
/// from inside the app, or an app group declared in its signed entitlements. Anything only plausible is listed
/// unselected with the reason; ids owned by another installed app are never listed. Everything goes to the
/// Trash, so even a wrong manual pick is recoverable.
pub fn find_leftovers(home: &Path, app: &AppInfo, cancel: &AtomicBool) -> Vec<Item> {
    find_leftovers_with(home, app, &ownership(app), &crate::apps_extra::launch_services_knows, cancel)
}

pub fn find_leftovers_with(
    home: &Path,
    app: &AppInfo,
    own: &Ownership,
    other_app: &dyn Fn(&str) -> bool,
    cancel: &AtomicBool,
) -> Vec<Item> {
    if !is_plain_component(&app.bundle_id) {
        return Vec::new();
    }
    let lib = home.join("Library");
    // APFS is usually case-insensitive, so `Foo` and `foo` are the same directory; the first (strongest) wins.
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(app.path.to_string_lossy().to_lowercase());
    let mut items = Vec::new();
    for c in candidates(&lib, app, own, other_app) {
        if cancel.load(Ordering::Relaxed) {
            return Vec::new();
        }
        if !seen.insert(c.path.to_string_lossy().to_lowercase()) {
            continue;
        }
        let mut item = Item::new(c.path.clone(), alloc_size(&c.path, cancel), Policy::MoveToTrash);
        item.name = c.label.to_string();
        let big_data = DATA_LABELS.contains(&c.label) && item.size > BIG_DATA_BYTES;
        items.push(match c.evidence {
            // The app's own, but large stores (VM disks, chat media, databases) deserve a deliberate click.
            Evidence::Confirmed if big_data => {
                let gb = format!("{:.1}", item.size as f64 / 1e9).replace('.', ",");
                item.unselected(format!("Dados do app com {gb} GB; revise antes de remover"))
            }
            Evidence::Confirmed => item,
            Evidence::Weak(why) => item.unselected(why),
        });
    }
    items.sort_by(|a, b| b.selected.cmp(&a.selected).then(b.size.cmp(&a.size)).then_with(|| a.path.cmp(&b.path)));
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
        leftovers_with(home, app, &Ownership::default(), &|_| false)
    }

    fn leftovers_with(home: &Path, app: &AppInfo, own: &Ownership, other: &dyn Fn(&str) -> bool) -> Vec<Item> {
        find_leftovers_with(home, app, own, other, &AtomicBool::new(false))
    }

    fn agent(path: &Path, program: &str) {
        let mut d = plist::Dictionary::new();
        d.insert("Label".into(), plist::Value::String("x".into()));
        d.insert("ProgramArguments".into(), plist::Value::Array(vec![plist::Value::String(program.into())]));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        plist::Value::Dictionary(d).to_file_xml(path).unwrap();
    }

    fn selected(home: &Path, items: &[Item]) -> Vec<String> {
        rel(home, &items.iter().filter(|i| i.selected).cloned().collect::<Vec<_>>())
    }

    fn by_path<'a>(home: &Path, items: &'a [Item], rel_path: &str) -> &'a Item {
        items.iter().find(|i| i.path == home.join(rel_path)).unwrap_or_else(|| panic!("{rel_path} not listed"))
    }

    fn rel(home: &Path, items: &[Item]) -> Vec<String> {
        let mut v: Vec<_> =
            items.iter().map(|i| i.path.strip_prefix(home).unwrap().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn exact_bundle_id_locations_are_confirmed_and_labeled() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        let id = "com.acme.foo";
        touch(&l.join(format!("Application Support/{id}/data")), 10_000);
        touch(&l.join(format!("Caches/{id}/c")), 10);
        touch(&l.join(format!("Preferences/{id}.plist")), 10);
        touch(&l.join(format!("Containers/{id}/c")), 10);
        touch(&l.join(format!("Application Scripts/{id}/s")), 10);
        touch(&l.join(format!("Saved Application State/{id}.savedState/w")), 10);
        touch(&l.join(format!("HTTPStorages/{id}/h")), 10);
        touch(&l.join(format!("HTTPStorages/{id}.binarycookies")), 10);
        touch(&l.join(format!("WebKit/{id}/w")), 10);
        touch(&l.join(format!("Logs/{id}/l")), 10);
        touch(&l.join(format!("Cookies/{id}.binarycookies")), 10);
        touch(&l.join(format!("Preferences/{id}x.plist")), 10);
        touch(&l.join("Caches/com.acme.foobar/c"), 10);
        let items = leftovers(&home, &app_info("Foo", id));
        assert_eq!(selected(&home, &items).len(), 11, "{:#?}", rel(&home, &items));
        assert_eq!(items.len(), 11, "lookalikes (foobar, idx.plist) are never listed");
        assert!(items.iter().all(|i| i.note.is_none() && i.policy == Policy::MoveToTrash));
        assert_eq!(by_path(&home, &items, &format!("Library/Caches/{id}")).name, "Caches");
        assert_eq!(
            by_path(&home, &items, &format!("Library/Saved Application State/{id}.savedState")).name,
            "Estado das janelas"
        );
        assert!(items[0].path.ends_with(format!("Application Support/{id}")), "biggest selected first");
    }

    #[test]
    fn sub_ids_need_proof_from_the_bundle() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        let id = "com.acme.foo";
        touch(&l.join(format!("Preferences/{id}.helper.plist")), 10); // embedded helper -> confirmed
        touch(&l.join(format!("Caches/{id}.helper/c")), 10); // helper's own cache -> confirmed
        touch(&l.join(format!("Preferences/{id}.installer.plist")), 10); // unknown -> weak
        touch(&l.join(format!("Preferences/{id}.pro.plist")), 10); // another installed app -> never listed
        touch(&l.join(format!("Preferences/ByHost/{id}.0123ABCD-4567-89EF-0123-456789ABCDEF.plist")), 10);
        let own = Ownership { embedded_ids: [format!("{id}.helper")].into(), ..Default::default() };
        let other = |x: &str| x == "com.acme.foo.pro";
        let items = leftovers_with(&home, &app_info("Foo", id), &own, &other);
        assert_eq!(
            selected(&home, &items),
            [
                format!("Library/Caches/{id}.helper"),
                format!("Library/Preferences/ByHost/{id}.0123ABCD-4567-89EF-0123-456789ABCDEF.plist"),
                format!("Library/Preferences/{id}.helper.plist"),
            ]
        );
        let weak = by_path(&home, &items, &format!("Library/Preferences/{id}.installer.plist"));
        assert!(!weak.selected);
        assert_eq!(weak.note.as_deref(), Some("Mesmo prefixo do app, sem confirmação"));
        assert!(!items.iter().any(|i| i.path.ends_with(format!("{id}.pro.plist"))));
    }

    #[test]
    fn launch_agents_confirmed_only_when_running_code_from_the_app() {
        let (_t, home) = fake_home();
        let a = home.join("Library/LaunchAgents");
        let id = "com.acme.foo";
        let app = app_info("Foo", id);
        agent(&a.join(format!("{id}.plist")), &format!("{}/Contents/MacOS/foo", app.path.display()));
        agent(&a.join(format!("{id}.updater.plist")), "/usr/bin/true"); // exists outside the app
        agent(&a.join(format!("{id}.gone.plist")), "/nonexistent/limpae/helper"); // dangling: the app's own
        touch(&a.join(format!("{id}.junk.plist")), 10); // unreadable plist
        let items = leftovers(&home, &app);
        assert_eq!(
            selected(&home, &items),
            [format!("Library/LaunchAgents/{id}.gone.plist"), format!("Library/LaunchAgents/{id}.plist")]
        );
        let outside = by_path(&home, &items, &format!("Library/LaunchAgents/{id}.updater.plist"));
        assert_eq!(outside.note.as_deref(), Some("O agente executa um programa fora do app"));
        let junk = by_path(&home, &items, &format!("Library/LaunchAgents/{id}.junk.plist"));
        assert_eq!(junk.note.as_deref(), Some("Não foi possível ler o agente"));
    }

    #[test]
    fn group_containers_need_signed_entitlements() {
        let (_t, home) = fake_home();
        let g = home.join("Library/Group Containers");
        let id = "com.acme.foo";
        for n in
            ["TEAM123.com.acme.foo", "group.com.acme.foo", "TEAM123.com.acme.foobar", "TEAM123.shared", "TEAM123.other"]
        {
            touch(&g.join(n).join("x"), 10);
        }
        let own = Ownership {
            app_groups: ["TEAM123.com.acme.foo".into(), "TEAM123.shared".into()].into(),
            ..Default::default()
        };
        let items = leftovers_with(&home, &app_info("Q", id), &own, &|_| false);
        assert_eq!(selected(&home, &items), ["Library/Group Containers/TEAM123.com.acme.foo"]);
        assert_eq!(
            by_path(&home, &items, "Library/Group Containers/group.com.acme.foo").note.as_deref(),
            Some("Grupo não declarado pelo app")
        );
        assert_eq!(
            by_path(&home, &items, "Library/Group Containers/TEAM123.shared").note.as_deref(),
            Some("Grupo do fornecedor, pode ser compartilhado")
        );
        assert_eq!(items.len(), 3, "undeclared, unrelated groups are never listed");
    }

    #[test]
    fn embedded_ids_and_entitlements_are_read_from_a_real_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let app = make_app(dir.path(), "Host.app", Some(&[("CFBundleIdentifier", "com.acme.host")]));
        make_app(
            &app.join("Contents/Library/LoginItems"),
            "Helper.app",
            Some(&[("CFBundleIdentifier", "com.acme.host.helper")]),
        );
        make_app(&app.join("Contents/PlugIns"), "Ext.appex", Some(&[("CFBundleIdentifier", "com.acme.host.ext")]));
        let own = ownership(&AppInfo { path: app, ..app_info("Host", "com.acme.host") });
        assert_eq!(own.embedded_ids, ["com.acme.host.helper".to_string(), "com.acme.host.ext".to_string()].into());
        assert!(own.app_groups.is_empty(), "unsigned bundle declares no groups");
        let calc = ownership(&AppInfo {
            path: "/System/Applications/Calculator.app".into(),
            ..app_info("Calculator", "com.apple.calculator")
        });
        assert!(calc.app_groups.iter().all(|g| !g.is_empty()));
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
        let mut labels: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        labels.sort();
        assert_eq!(labels, ["Caches", "Registros", "Suporte do app"]);
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

    #[test]
    fn shared_framework_components_and_foreign_ids_do_not_count() {
        let dir = tempfile::tempdir().unwrap();
        let app = make_app(dir.path(), "Host.app", Some(&[("CFBundleIdentifier", "com.acme.host")]));
        let fw = app.join("Contents/Frameworks/Sparkle.framework/Versions/B");
        make_app(&fw, "Autoupdate.app", Some(&[("CFBundleIdentifier", "org.sparkle-project.Sparkle.Autoupdate")]));
        make_app(
            &app.join("Contents/Library/LoginItems"),
            "Updater.app",
            Some(&[("CFBundleIdentifier", "com.google.GoogleUpdater")]),
        );
        make_app(
            &app.join("Contents/Resources"),
            "Hidden.app",
            Some(&[("CFBundleIdentifier", "com.acme.host.hidden")]),
        );
        let own = ownership(&AppInfo { path: app, ..app_info("Host", "com.acme.host") });
        assert!(own.embedded_ids.is_empty(), "{:?}", own.embedded_ids);
    }

    #[test]
    fn large_app_data_is_listed_unselected_with_size() {
        let (_t, home) = fake_home();
        let big = home.join("Library/Containers/com.acme.vm/disk.img");
        fs::create_dir_all(big.parent().unwrap()).unwrap();
        let f = fs::File::create(&big).unwrap();
        // Allocate real blocks (a sparse file would report ~0 allocated bytes).
        let chunk = vec![1u8; 8 << 20];
        let mut w = std::io::BufWriter::new(f);
        for _ in 0..130 {
            std::io::Write::write_all(&mut w, &chunk).unwrap();
        }
        drop(w);
        touch(&home.join("Library/Caches/com.acme.vm/c"), 10);
        let items = leftovers(&home, &app_info("VM", "com.acme.vm"));
        let c = by_path(&home, &items, "Library/Containers/com.acme.vm");
        assert!(!c.selected);
        assert!(
            c.note
                .as_deref()
                .is_some_and(|n| n.starts_with("Dados do app com 1,") && n.ends_with("GB; revise antes de remover")),
            "{:?}",
            c.note
        );
        assert!(by_path(&home, &items, "Library/Caches/com.acme.vm").selected, "small caches stay selected");
    }
}
