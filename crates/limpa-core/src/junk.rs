use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use rayon::prelude::*;

use crate::model::{Group, Item, Policy, Progress};
use crate::running::cache_in_use;
use crate::size::alloc_size;

const GROUPS: [(&str, &str, &str); 9] = [
    ("user_caches", "Cache do usuário", "Arquivos temporários que os apps recriam automaticamente."),
    ("user_logs", "Logs do usuário", "Registros de diagnóstico de apps e do sistema."),
    ("ai_clutter", "Lixo de IA", "Caches e logs de ferramentas de IA, além de modelos locais que ocupam muito espaço."),
    ("xcode", "Lixo do Xcode", "Dados de build e suporte a dispositivos que o Xcode recria."),
    ("dev_caches", "Caches de desenvolvimento", "Pacotes baixados por gerenciadores como npm, Homebrew e pip."),
    (
        "broken_prefs",
        "Preferências corrompidas",
        "Arquivos de preferência ilegíveis; o app cria um novo na próxima abertura.",
    ),
    (
        "broken_login_items",
        "Itens de login quebrados",
        "Agentes de login que apontam para um executável que não existe mais.",
    ),
    ("ios_backups", "Backups de iPhone e iPad", "Cópias de dispositivos feitas pelo Finder; vão para o Lixo."),
    ("mail_attachments", "Anexos do Mail", "Cópias de anexos que o Mail baixa de novo quando você os abre."),
];
const USER_CACHES: usize = 0;
const USER_LOGS: usize = 1;
const AI_CLUTTER: usize = 2;
const XCODE: usize = 3;
const DEV_CACHES: usize = 4;
const BROKEN_PREFS: usize = 5;
const BROKEN_LOGIN_ITEMS: usize = 6;
const IOS_BACKUPS: usize = 7;
const MAIL_ATTACHMENTS: usize = 8;

/// Caches of AI tools (exact names under `~/Library/Caches`, case-insensitive): regenerable, deleted permanently.
const AI_CACHES: &[&str] = &[
    "claude-cli-nodejs",
    "com.anthropic.claudefordesktop",
    "com.openai.chat",
    "com.openai.codex",
    "Codex",
    // Bundle ids of Cursor (ToDesktop build) and Windsurf.
    "com.todesktop.230313mzl4w4u92",
    "com.exafunction.windsurf",
];

/// Logs of AI tools under `~/Library/Logs`.
const AI_LOGS: &[&str] = &["Claude", "com.openai.codex"];

/// Roots (relative to home) holding LM Studio models as `<publisher>/<model>` directories.
const LMSTUDIO_MODEL_ROOTS: &[&str] = &[".lmstudio/models", ".cache/lm-studio/models"];

const MODEL_NOTE: &str = "Modelo local; baixe de novo se precisar";
const ARCHIVES_NOTE: &str = "Necessário para símbolos de depuração";
const LATEST_BACKUP_NOTE: &str = "Backup mais recente";

/// A preference file touched more recently than this may be mid-write by cfprefsd.
const PREFS_SETTLE: Duration = Duration::from_secs(60);
/// Larger plists are never parsed, so they are never flagged as broken.
const MAX_PLIST_BYTES: u64 = 64 * 1024 * 1024;

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
    "br.com.limpae",
    "br.com.limpaemeo", // name before the rebrand
];

/// Our own action log.
/// Our own action log folder, current and pre-rebrand names.
const OWN_LOGS: [&str; 2] = ["Limpae", "Limpaemeo"];

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
    policy: Policy,
    group: usize,
    /// Display name, when the file name alone is not meaningful.
    name: Option<String>,
    note: Option<String>,
    selected: bool,
}

impl Candidate {
    fn junk(path: PathBuf, root: &Path, group: usize) -> Self {
        Self {
            path,
            policy: Policy::DeleteJunk { root: root.to_path_buf() },
            group,
            name: None,
            note: None,
            selected: true,
        }
    }

    fn trash(path: PathBuf, group: usize) -> Self {
        Self { path, policy: Policy::MoveToTrash, group, name: None, note: None, selected: true }
    }

    /// Starts unselected, with `note` saying why.
    fn unselected(mut self, note: &str) -> Self {
        self.selected = false;
        self.note = Some(note.to_string());
        self
    }

    /// Informative note on a selected item.
    fn noted(mut self, note: String) -> Self {
        self.note = Some(note);
        self
    }

    fn named(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }
}

/// Junk under the user's home. Groups: `user_caches`, `user_logs`, `ai_clutter`, `xcode`, `dev_caches`,
/// `broken_prefs`, `broken_login_items`, `ios_backups`, `mail_attachments`. `running` holds bundle ids or names of open apps
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
        let mut item = Item::new(c.path, size, c.policy);
        if let Some(name) = c.name {
            item.name = name;
        }
        item.note = c.note;
        item.selected = c.selected;
        groups[c.group].push(item);
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
        let ai = AI_CACHES.iter().any(|a| a.eq_ignore_ascii_case(&name));
        let c = Candidate::junk(path, &caches, if ai { AI_CLUTTER } else { USER_CACHES });
        out.push(if cache_in_use(&name, &running) { c.unselected(RUNNING_NOTE) } else { c });
    }

    let logs = home.join("Library/Logs");
    for path in children(&logs) {
        let name = file_name(&path);
        if OWN_LOGS.contains(&name.as_str()) {
            continue;
        }
        let ai = AI_LOGS.iter().any(|a| a.eq_ignore_ascii_case(&name));
        out.push(Candidate::junk(path, &logs, if ai { AI_CLUTTER } else { USER_LOGS }));
    }

    for rel in XCODE_ROOTS {
        let root = home.join(rel);
        for path in children(&root) {
            out.push(Candidate::junk(path, &root, XCODE));
        }
    }
    // Archives hold the dSYMs needed to symbolicate shipped builds: Trash, never pre-selected.
    for path in real_dirs(&home.join("Library/Developer/Xcode/Archives")) {
        out.push(Candidate::trash(path, XCODE).unselected(ARCHIVES_NOTE));
    }

    for &(root, rel, heavy) in DEV_ITEMS {
        let path = home.join(rel);
        if fs::symlink_metadata(&path).is_ok() {
            let c = Candidate::junk(path, &home.join(root), DEV_CACHES);
            out.push(if heavy { c.unselected(HEAVY_NOTE) } else { c });
        }
    }

    local_models(home, &mut out);
    broken_prefs(home, &mut out);
    broken_login_items(home, &mut out);
    ios_backups(home, &mut out);
    mail_attachments(home, &mut out);
    out
}

/// Ollama's model store and each LM Studio `<publisher>/<model>` directory. These are user downloads: Trash,
/// never pre-selected.
fn local_models(home: &Path, out: &mut Vec<Candidate>) {
    let ollama = home.join(".ollama/models");
    if fs::symlink_metadata(&ollama).is_ok_and(|m| m.is_dir()) {
        out.push(Candidate::trash(ollama, AI_CLUTTER).unselected(MODEL_NOTE));
    }
    for rel in LMSTUDIO_MODEL_ROOTS {
        for publisher in real_dirs(&home.join(rel)) {
            for model in real_dirs(&publisher) {
                out.push(Candidate::trash(model, AI_CLUTTER).unselected(MODEL_NOTE));
            }
        }
    }
}

/// `~/Library/Preferences/*.plist` regular files that no longer parse. Files changed in the last minute are left
/// alone: cfprefsd may be writing them.
fn broken_prefs(home: &Path, out: &mut Vec<Candidate>) {
    let now = SystemTime::now();
    let found: Vec<PathBuf> = children(&home.join("Library/Preferences"))
        .into_par_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "plist"))
        .filter(|p| {
            let Ok(md) = fs::symlink_metadata(p) else { return false };
            md.is_file() && md.len() <= MAX_PLIST_BYTES && settled(&md, now) && plist::Value::from_file(p).is_err()
        })
        .collect();
    out.extend(found.into_iter().map(|p| Candidate::trash(p, BROKEN_PREFS)));
}

/// Modified at least [`PREFS_SETTLE`] ago. An unreadable or future mtime counts as not settled.
fn settled(md: &fs::Metadata, now: SystemTime) -> bool {
    md.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age >= PREFS_SETTLE)
}

/// `~/Library/LaunchAgents/*.plist` whose executable (`Program`, else `ProgramArguments[0]`) is an absolute path
/// that no longer exists. Paths under /Volumes are skipped: that volume may just be unmounted.
fn broken_login_items(home: &Path, out: &mut Vec<Candidate>) {
    for path in children(&home.join("Library/LaunchAgents")) {
        if path.extension().is_none_or(|e| e != "plist") || !fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Some(exe) = launch_executable(&path) else { continue };
        if exe.is_absolute() && !exe.starts_with("/Volumes") && fs::symlink_metadata(&exe).is_err() {
            let note = format!("Executável ausente: {}", exe.display());
            out.push(Candidate::trash(path, BROKEN_LOGIN_ITEMS).noted(note));
        }
    }
}

fn launch_executable(plist_path: &Path) -> Option<PathBuf> {
    let value = plist::Value::from_file(plist_path).ok()?;
    let dict = value.as_dictionary()?;
    let program = dict.get("Program").and_then(plist::Value::as_string).filter(|s| !s.is_empty());
    let first = || dict.get("ProgramArguments")?.as_array()?.first()?.as_string().filter(|s| !s.is_empty());
    program.or_else(first).map(PathBuf::from)
}

/// Finder/iTunes device backups. The newest backup of each device starts unselected (a device with a single
/// backup keeps it), the older ones of the same device are selected. Needs Full Disk Access: unreadable means none.
fn ios_backups(home: &Path, out: &mut Vec<Candidate>) {
    let root = home.join("Library/Application Support/MobileSync/Backup");
    let found: Vec<(Candidate, String, i64)> = real_dirs(&root)
        .into_iter()
        .map(|path| {
            let info = fs::File::open(path.join("Info.plist"))
                .ok()
                .and_then(|f| plist::Value::from_reader(std::io::BufReader::new(f)).ok());
            let dict = info.as_ref().and_then(plist::Value::as_dictionary);
            let device = dict.and_then(|d| d.get("Device Name")).and_then(plist::Value::as_string).map(str::to_string);
            let date = dict.and_then(|d| d.get("Last Backup Date")).and_then(plist::Value::as_date).map(unix_secs);
            let device_id = ["Unique Identifier", "Target Identifier", "GUID"]
                .iter()
                .find_map(|k| dict.and_then(|d| d.get(k)).and_then(plist::Value::as_string))
                .map(str::to_lowercase)
                .unwrap_or_else(|| backup_device_key(&file_name(&path)));
            let mtime = fs::symlink_metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs() as i64);
            let c = Candidate::trash(path.clone(), IOS_BACKUPS);
            let c = match (device, date) {
                (Some(d), Some(t)) => c.named(format!("{d} · {}", local_date(t))),
                (Some(d), None) => c.named(d),
                (None, Some(t)) => c.named(format!("{} · {}", file_name(&path), local_date(t))),
                (None, None) => c,
            };
            (c, device_id, date.unwrap_or(mtime))
        })
        .collect();
    let mut newest: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for (_, dev, t) in &found {
        let e = newest.entry(dev.as_str()).or_insert(*t);
        *e = (*e).max(*t);
    }
    let newest: std::collections::HashMap<String, i64> = newest.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    let mut kept = HashSet::new();
    for (c, dev, t) in found {
        // Exactly one backup per device is kept, even when two share the newest timestamp.
        let keep = newest.get(&dev) == Some(&t) && kept.insert(dev);
        out.push(if keep { c.unselected(LATEST_BACKUP_NOTE) } else { c });
    }
}

/// Device part of a backup folder name: archived copies are `<UDID>-YYYYMMDD-HHMMSS`; modern UDIDs contain a
/// dash themselves (`00008030-001A…`), so only that exact date suffix is stripped.
fn backup_device_key(dir: &str) -> String {
    let b = dir.as_bytes();
    let n = b.len();
    let dated = n > 16
        && b[n - 16] == b'-'
        && b[n - 7] == b'-'
        && b[n - 15..n - 7].iter().all(u8::is_ascii_digit)
        && b[n - 6..].iter().all(u8::is_ascii_digit);
    (if dated { &dir[..n - 16] } else { dir }).to_lowercase()
}

fn unix_secs(d: plist::Date) -> i64 {
    match SystemTime::from(d).duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(e) => -(e.duration().as_secs() as i64),
    }
}

/// `dd/mm/aaaa` in the local time zone.
fn local_date(secs: i64) -> String {
    // SAFETY: `tm` is plain data and zero is a valid value for every field; localtime_r only writes into it.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&secs, &mut tm);
        tm
    };
    format!("{:02}/{:02}/{}", tm.tm_mday, tm.tm_mon + 1, tm.tm_year + 1900)
}

/// Mail's re-downloadable attachment copies. They live in the Mail container, so it needs Full Disk Access:
/// unreadable means none.
fn mail_attachments(home: &Path, out: &mut Vec<Candidate>) {
    let root = home.join("Library/Containers/com.apple.mail/Data/Library/Mail Downloads");
    for path in children(&root) {
        let c = Candidate::junk(path.clone(), &root, MAIL_ATTACHMENTS);
        // Mail stores each attachment as `<uuid>/<file>`: show the file name instead of the uuid.
        let inner = if fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) { children(&path) } else { Vec::new() };
        out.push(match inner.as_slice() {
            [only] => c.named(file_name(only)),
            _ => c,
        });
    }
}

/// Direct children of `root` that are real directories (symlinks are not followed).
fn real_dirs(root: &Path) -> Vec<PathBuf> {
    children(root).into_iter().filter(|p| fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())).collect()
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
        for n in ["CloudKit", "com.apple.bird", "COM.APPLE.HOMED", "br.com.limpae", "com.foo.app"] {
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
        write(&home.join("Library/Logs/Limpae/action.log"), KB64);
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

    fn age(path: &Path, secs: u64) {
        let t = SystemTime::now() - Duration::from_secs(secs);
        fs::File::open(path).unwrap().set_modified(t).unwrap();
    }

    /// Writes a valid XML plist from `(key, value)` pairs.
    fn write_plist(path: &Path, entries: Vec<(&str, plist::Value)>) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut dict = plist::Dictionary::new();
        for (k, v) in entries {
            dict.insert(k.into(), v);
        }
        plist::Value::Dictionary(dict).to_file_xml(path).unwrap();
    }

    /// Text that `plist` rejects (a run of control bytes would parse as an empty old-style plist).
    fn not_a_plist(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "isto não é um plist. ".repeat(400)).unwrap();
    }

    fn s(text: &str) -> plist::Value {
        plist::Value::String(text.into())
    }

    fn is_trash(item: &Item) -> bool {
        item.policy == Policy::MoveToTrash
    }

    #[test]
    fn ai_tools_routed_to_ai_clutter() {
        let (_t, home) = fake_home();
        let caches = home.join("Library/Caches");
        for n in
            ["claude-cli-nodejs", "COM.ANTHROPIC.CLAUDEFORDESKTOP", "Codex", "com.todesktop.230313mzl4w4u92", "com.foo"]
        {
            write(&caches.join(n).join("d"), KB64);
        }
        write(&home.join("Library/Logs/Claude/main.log"), KB64);
        write(&home.join("Library/Logs/com.openai.codex/a.log"), KB64);
        write(&home.join("Library/Logs/Other/a.log"), KB64);
        let groups = scan(&home, &[]);
        assert_eq!(names(group(&groups, "user_caches")), ["com.foo"]);
        assert_eq!(names(group(&groups, "user_logs")), ["Other"]);
        let ai = group(&groups, "ai_clutter");
        assert_eq!(ai.items.len(), 6);
        for item in &ai.items {
            assert!(item.selected && item.note.is_none(), "{}", item.name);
            let Policy::DeleteJunk { root } = &item.policy else { panic!("policy") };
            let expected =
                if item.path.starts_with(home.join("Library/Logs")) { "Library/Logs" } else { "Library/Caches" };
            assert_eq!(root, &home.join(expected), "{}", item.name);
        }
    }

    #[test]
    fn running_ai_cache_unselected() {
        let (_t, home) = fake_home();
        write(&home.join("Library/Caches/com.anthropic.claudefordesktop/d"), KB64);
        let groups = scan(&home, &["com.anthropic.claudefordesktop"]);
        let item = &group(&groups, "ai_clutter").items[0];
        assert!(!item.selected);
        assert_eq!(item.note.as_deref(), Some("App em execução"));
    }

    #[test]
    fn local_models_are_unselected_and_trashed() {
        let (_t, home) = fake_home();
        write(&home.join(".ollama/models/blobs/sha256-x"), KB64);
        write(&home.join(".lmstudio/models/lmstudio-community/Llama-8B/m.gguf"), KB64);
        write(&home.join(".lmstudio/models/lmstudio-community/Qwen-7B/m.gguf"), KB64);
        write(&home.join(".cache/lm-studio/models/pub/Mistral/m.gguf"), KB64);
        // A loose file at publisher level and a symlinked model are not models of their own.
        write(&home.join(".lmstudio/models/lmstudio-community/readme.txt"), KB64);
        std::os::unix::fs::symlink("/tmp", home.join(".lmstudio/models/lmstudio-community/Linked")).unwrap();
        let groups = scan(&home, &[]);
        let ai = group(&groups, "ai_clutter");
        let mut got = names(ai);
        got.sort_unstable();
        assert_eq!(got, ["Llama-8B", "Mistral", "Qwen-7B", "models"]);
        for item in &ai.items {
            assert!(is_trash(item) && !item.selected, "{}", item.name);
            assert_eq!(item.note.as_deref(), Some("Modelo local; baixe de novo se precisar"));
        }
    }

    #[test]
    fn broken_prefs_only_unparsable_old_regular_plists() {
        let (_t, home) = fake_home();
        let prefs = home.join("Library/Preferences");
        write_plist(&prefs.join("com.good.plist"), vec![("a", s("b"))]);
        age(&prefs.join("com.good.plist"), 3600);
        not_a_plist(&prefs.join("com.bad.plist"));
        age(&prefs.join("com.bad.plist"), 3600);
        not_a_plist(&prefs.join("com.fresh.plist")); // just written: may be mid-write
        write(&prefs.join("notes.txt"), KB64);
        age(&prefs.join("notes.txt"), 3600);
        not_a_plist(&prefs.join("ByHost/com.bad.plist"));
        age(&prefs.join("ByHost/com.bad.plist"), 3600);
        std::os::unix::fs::symlink(prefs.join("com.bad.plist"), prefs.join("com.link.plist")).unwrap();
        let groups = scan(&home, &[]);
        let g = group(&groups, "broken_prefs");
        assert_eq!(names(g), ["com.bad.plist"]);
        assert!(is_trash(&g.items[0]) && g.items[0].selected);
    }

    #[test]
    fn broken_login_items_flag_only_missing_absolute_executables() {
        let (_t, home) = fake_home();
        let la = home.join("Library/LaunchAgents");
        let args = |p: &str| plist::Value::Array(vec![s(p), s("--x")]);
        write_plist(
            &la.join("missing.plist"),
            vec![("Label", s("a")), ("ProgramArguments", args("/nonexistent/app/bin"))],
        );
        write_plist(&la.join("missing-program.plist"), vec![("Program", s("/nonexistent/prog"))]);
        write_plist(&la.join("ok.plist"), vec![("ProgramArguments", args("/bin/sh"))]);
        write_plist(
            &la.join("program-wins.plist"),
            vec![("Program", s("/bin/sh")), ("ProgramArguments", args("/nonexistent/x"))],
        );
        write_plist(&la.join("relative.plist"), vec![("ProgramArguments", args("node"))]);
        write_plist(&la.join("noexe.plist"), vec![("Label", s("a"))]);
        write_plist(&la.join("unmounted.plist"), vec![("ProgramArguments", args("/Volumes/Gone/bin"))]);
        not_a_plist(&la.join("garbage.plist"));
        write(&la.join("readme.txt"), KB64);
        let groups = scan(&home, &[]);
        let g = group(&groups, "broken_login_items");
        let mut got = names(g);
        got.sort_unstable();
        assert_eq!(got, ["missing-program.plist", "missing.plist"]);
        for item in &g.items {
            assert!(is_trash(item) && item.selected);
            let expected = if item.name == "missing.plist" { "/nonexistent/app/bin" } else { "/nonexistent/prog" };
            assert!(item.note.as_deref().is_some_and(|n| n.ends_with(expected)), "{:?}", item.note);
        }
    }

    #[test]
    fn ios_backups_newest_unselected_and_named() {
        let (_t, home) = fake_home();
        let root = home.join("Library/Application Support/MobileSync/Backup");
        let date = |secs_ago: u64| plist::Value::Date((SystemTime::now() - Duration::from_secs(secs_ago)).into());
        // AAA and CCC are two backups of the same iPhone; BBB is another device; DDD has no Info.plist.
        for (dir, name, udid, ago) in [
            ("AAA", "iPhone da Ana", "UDID-ANA", 10 * 86_400),
            ("BBB", "iPad", "UDID-IPAD", 86_400),
            ("CCC", "iPhone da Ana", "UDID-ANA", 400 * 86_400),
        ] {
            write_plist(
                &root.join(dir).join("Info.plist"),
                vec![("Device Name", s(name)), ("Unique Identifier", s(udid)), ("Last Backup Date", date(ago))],
            );
            write(&root.join(dir).join("Manifest.db"), KB64);
        }
        write(&root.join("DDD/Manifest.db"), KB64); // no Info.plist: listed under its directory name, ranked by mtime
        age(&root.join("DDD/Manifest.db"), 0);
        age(&root.join("DDD"), 500 * 86_400);
        write(&root.join("loose.txt"), KB64);
        let groups = scan(&home, &[]);
        let g = group(&groups, "ios_backups");
        assert_eq!(g.items.len(), 4);
        for item in &g.items {
            assert!(is_trash(item));
            // Only the older backup of a device that has a newer one is selected.
            let older_copy = item.path.ends_with("CCC");
            assert_eq!(item.selected, older_copy, "{}", item.name);
            assert_eq!(item.note.as_deref(), (!older_copy).then_some("Backup mais recente"), "{}", item.name);
        }
        let by = |dir: &str| g.items.iter().find(|i| i.path.ends_with(dir)).unwrap();
        assert!(by("AAA").name.starts_with("iPhone da Ana · "), "{}", by("AAA").name);
        assert!(by("BBB").name.starts_with("iPad · "));
        assert_eq!(by("DDD").name, "DDD");
        let (d, m, y) = by("AAA")
            .name
            .rsplit(" · ")
            .next()
            .and_then(|t| {
                let mut p = t.split('/');
                Some((p.next()?.len(), p.next()?.len(), p.next()?.len()))
            })
            .unwrap();
        assert_eq!((d, m, y), (2, 2, 4));
    }

    #[test]
    fn backup_device_key_strips_only_archive_date() {
        assert_eq!(backup_device_key("00008030-001A2B3C3E88802E"), "00008030-001a2b3c3e88802e");
        assert_eq!(backup_device_key("00008030-001A2B3C3E88802E-20231010-101010"), "00008030-001a2b3c3e88802e");
        assert_eq!(backup_device_key("abc-2023"), "abc-2023");
    }

    #[test]
    fn ios_backups_unreadable_or_missing_is_silent() {
        let (_t, home) = fake_home();
        assert!(scan(&home, &[]).is_empty());
        fs::create_dir_all(home.join("Library/Application Support/MobileSync/Backup")).unwrap();
        assert!(scan(&home, &[]).is_empty());
    }

    #[test]
    fn mail_downloads_deleted_with_root_and_named_by_file() {
        let (_t, home) = fake_home();
        let root = home.join("Library/Containers/com.apple.mail/Data/Library/Mail Downloads");
        write(&root.join("UUID-1/contrato.pdf"), KB64);
        write(&root.join("UUID-2/a.png"), KB64);
        write(&root.join("UUID-2/b.png"), KB64);
        let groups = scan(&home, &[]);
        let g = group(&groups, "mail_attachments");
        let mut got = names(g);
        got.sort_unstable();
        assert_eq!(got, ["UUID-2", "contrato.pdf"]);
        for item in &g.items {
            assert!(item.selected && item.note.is_none());
            assert_eq!(item.policy, Policy::DeleteJunk { root: root.clone() });
        }
    }

    #[test]
    fn xcode_archives_trashed_unselected() {
        let (_t, home) = fake_home();
        let xc = home.join("Library/Developer/Xcode");
        write(&xc.join("DerivedData/App-abc/b"), KB64);
        write(&xc.join("Archives/2024-05-01/App.xcarchive/a"), KB64);
        write(&xc.join("Archives/2024-06-01/App.xcarchive/a"), KB64);
        let groups = scan(&home, &[]);
        let g = group(&groups, "xcode");
        assert_eq!(g.items.len(), 3);
        for item in &g.items {
            let archive = item.path.starts_with(xc.join("Archives"));
            assert_eq!(is_trash(item), archive, "{}", item.name);
            assert_eq!(item.selected, !archive, "{}", item.name);
            assert_eq!(item.note.as_deref(), archive.then_some("Necessário para símbolos de depuração"));
        }
    }
}
