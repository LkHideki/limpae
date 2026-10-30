//! Extras of the Applications module: last-use dates, store/vendor grouping, leftovers of apps that are already
//! gone, installer files and a read-only Sparkle updater. Nothing here removes anything; items it produces carry
//! `Policy::MoveToTrash` and still go through the `Guard` at removal time.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64};

use rayon::prelude::*;
use serde::Serialize;

use crate::apps::AppInfo;
use crate::model::{Group, Item, Policy, Progress};
use crate::running::cache_in_use;
use crate::size::alloc_size;

/// An app unused for this long is listed under "Não usados".
pub const UNUSED_DAYS: i64 = 180;
const DAY: i64 = 86_400;

// ---------------------------------------------------------------------------------------------------------------
// Last use, store, vendor
// ---------------------------------------------------------------------------------------------------------------

/// Spotlight's `kMDItemLastUsedDate` of `path`, in unix seconds. `None` when the item was never used or Spotlight
/// has no record (unknown is not the same as unused).
///
/// Safe off the main thread: `NSMetadataItem` is a plain Foundation object that only reads the index.
pub fn last_used(path: &Path) -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        use objc2::AnyThread;
        use objc2::rc::autoreleasepool;
        use objc2_foundation::{NSDate, NSMetadataItem, NSString, NSURL};

        autoreleasepool(|_| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
            let item = NSMetadataItem::initWithURL(NSMetadataItem::alloc(), &url)?;
            let value = item.valueForAttribute(&NSString::from_str("kMDItemLastUsedDate"))?;
            let date = value.downcast::<NSDate>().ok()?;
            Some(date.timeIntervalSince1970().floor() as i64)
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

/// Whether a last-use timestamp is older than `days`. Unknown counts as not unused.
pub fn is_unused(last: Option<i64>, now: i64, days: i64) -> bool {
    last.is_some_and(|t| now.saturating_sub(t) > days.saturating_mul(DAY))
}

/// Last-use date of every app, looked up in parallel (one Spotlight query each).
pub fn last_used_all(apps: &[AppInfo]) -> Vec<Option<i64>> {
    apps.par_iter().map(|a| last_used(&a.path)).collect()
}

/// Indexes (into `apps`) of apps not opened for `days` days given their `lasts` dates. Running apps are never unused.
pub fn unused_from(apps: &[AppInfo], lasts: &[Option<i64>], now: i64, days: i64) -> Vec<usize> {
    apps.iter()
        .zip(lasts)
        .enumerate()
        .filter(|(_, (a, last))| !a.running && is_unused(**last, now, days))
        .map(|(i, _)| i)
        .collect()
}

/// [`unused_from`] backed by Spotlight, using the default 180-day window.
pub fn unused(apps: &[AppInfo], now: i64) -> Vec<usize> {
    unused_from(apps, &last_used_all(apps), now, UNUSED_DAYS)
}

pub const STORE_APP_STORE: &str = "App Store";
pub const STORE_SETAPP: &str = "Setapp";
pub const STORE_OTHER: &str = "Outros";

/// Distribution channel of an app: a Mac App Store receipt wins, then Setapp (folder or `-setapp` bundle id).
pub fn store_of(app: &AppInfo) -> &'static str {
    if fs::symlink_metadata(app.path.join("Contents/_MASReceipt/receipt")).is_ok() {
        STORE_APP_STORE
    } else if app.path.starts_with("/Applications/Setapp/") || app.bundle_id.to_lowercase().ends_with("-setapp") {
        STORE_SETAPP
    } else {
        STORE_OTHER
    }
}

const KNOWN_VENDORS: &[(&str, &str)] = &[
    ("google", "Google"),
    ("microsoft", "Microsoft"),
    ("adobe", "Adobe"),
    ("jetbrains", "JetBrains"),
    ("tinyspeck", "Slack"),
    ("apple", "Apple"),
    ("mozilla", "Mozilla"),
    ("github", "GitHub"),
    ("valvesoftware", "Valve"),
    ("spotify", "Spotify"),
    ("docker", "Docker"),
    ("zoom", "Zoom"),
    ("dropbox", "Dropbox"),
    ("openai", "OpenAI"),
    ("anthropic", "Anthropic"),
    ("figma", "Figma"),
    ("notion", "Notion"),
    ("1password", "1Password"),
    ("agilebits", "1Password"),
    ("brave", "Brave"),
    ("vivaldi", "Vivaldi"),
    ("operasoftware", "Opera"),
    ("videolan", "VideoLAN"),
    ("obsproject", "OBS Project"),
    ("postmanlabs", "Postman"),
    ("sublimetext", "Sublime"),
    ("blackmagic-design", "Blackmagic Design"),
    ("blackmagicdesign", "Blackmagic Design"),
    ("tencent", "Tencent"),
    ("whispersystems", "Signal"),
    ("telegram", "Telegram"),
    ("discord", "Discord"),
];

/// Country-code reverse-DNS prefixes (`br.com.acme.app`): the vendor is the label after the commercial TLD.
const TLD_LABELS: &[&str] = &["com", "co", "org", "net", "gov", "edu", "ac"];

/// Vendor name from a bundle id: the second reverse-DNS label, mapped through a small table of well-known names
/// and capitalised otherwise. Ids that don't look like reverse-DNS come back as "Outros".
pub fn vendor_of(bundle_id: &str) -> String {
    let labels: Vec<&str> = bundle_id.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() < 2 {
        return "Outros".into();
    }
    let idx = if labels.len() >= 3 && labels[0].len() == 2 && TLD_LABELS.contains(&labels[1].to_lowercase().as_str()) {
        2
    } else {
        1
    };
    let label = labels[idx].to_lowercase();
    if let Some((_, nice)) = KNOWN_VENDORS.iter().find(|(k, _)| *k == label) {
        return (*nice).to_owned();
    }
    let mut chars = label.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => "Outros".into(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Leftovers of apps that are already gone
// ---------------------------------------------------------------------------------------------------------------

const NOTE_ORPHAN: &str = "App não encontrado; pode guardar dados";
const NOTE_INSTALLER: &str = "Instalador";

struct OrphanKind {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    /// Folder under `~/Library`.
    dir: &'static str,
    /// Accepted name suffixes (the id is what remains). `""` means the bare id.
    suffixes: &'static [&'static str],
    /// Regenerable data comes pre-selected; the rest may hold user data and must be chosen by hand.
    regenerable: bool,
}

const ORPHAN_KINDS: &[OrphanKind] = &[
    OrphanKind {
        id: "orphan_caches",
        title: "Caches de apps removidos",
        description: "Dados temporários de apps que não estão mais instalados.",
        dir: "Caches",
        suffixes: &[""],
        regenerable: true,
    },
    OrphanKind {
        id: "orphan_saved_state",
        title: "Estado salvo de apps removidos",
        description: "Janelas e documentos abertos de apps que não estão mais instalados.",
        dir: "Saved Application State",
        suffixes: &[".savedState"],
        regenerable: true,
    },
    OrphanKind {
        id: "orphan_http",
        title: "Armazenamento HTTP de apps removidos",
        description: "Cookies e sessões de rede de apps que não estão mais instalados.",
        dir: "HTTPStorages",
        suffixes: &["", ".binarycookies"],
        regenerable: true,
    },
    OrphanKind {
        id: "orphan_webkit",
        title: "Dados WebKit de apps removidos",
        description: "Armazenamento web de apps que não estão mais instalados.",
        dir: "WebKit",
        suffixes: &[""],
        regenerable: true,
    },
    OrphanKind {
        id: "orphan_logs",
        title: "Registros de apps removidos",
        description: "Logs de apps que não estão mais instalados.",
        dir: "Logs",
        suffixes: &[""],
        regenerable: true,
    },
    OrphanKind {
        id: "orphan_support",
        title: "Dados de suporte de apps removidos",
        description: "Pastas em Application Support; podem conter documentos e configurações.",
        dir: "Application Support",
        suffixes: &[""],
        regenerable: false,
    },
    OrphanKind {
        id: "orphan_containers",
        title: "Contêineres de apps removidos",
        description: "Dados de apps em sandbox; podem conter documentos do app.",
        dir: "Containers",
        suffixes: &[""],
        regenerable: false,
    },
    OrphanKind {
        id: "orphan_prefs",
        title: "Preferências de apps removidos",
        description: "Arquivos de ajustes de apps que não estão mais instalados.",
        dir: "Preferences",
        suffixes: &[".plist"],
        regenerable: false,
    },
    OrphanKind {
        id: "orphan_scripts",
        title: "Scripts de apps removidos",
        description: "Scripts de extensões de apps que não estão mais instalados.",
        dir: "Application Scripts",
        suffixes: &[""],
        regenerable: false,
    },
    OrphanKind {
        id: "orphan_agents",
        title: "Agentes de inicialização de apps removidos",
        description: "Itens que abrem sozinhos no login e pertencem a apps que não estão mais instalados.",
        dir: "LaunchAgents",
        suffixes: &[".plist"],
        regenerable: false,
    },
];

/// Reverse-DNS bundle id: at least three labels of `[A-Za-z0-9-]`, the first starting with a letter.
pub fn is_bundle_id(s: &str) -> bool {
    let labels: Vec<&str> = s.split('.').collect();
    labels.len() >= 3
        && labels.iter().all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        && labels[0].starts_with(|c: char| c.is_ascii_alphabetic())
}

/// Ids that are never an uninstalled third-party app: Apple's (also as an app group, `group.com.apple.*`, or behind a
/// team id), app-group identifiers (`group.*`, `<TEAMID>.*`) and macOS's own CUPS printing preferences.
fn is_system_or_group_id(id: &str, lower: &str) -> bool {
    let first = id.split('.').next().unwrap_or_default();
    let team_id = first.len() == 10 && first.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    format!(".{lower}.").contains(".com.apple.")
        || lower.starts_with("group.")
        || lower.starts_with("systemgroup.")
        || lower.starts_with("org.cups.")
        || team_id
}

/// `a` equals `b` or one is a dotted prefix of the other (`com.foo.app.helper` vs `com.foo.app`), case-insensitive.
fn related_ids(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    a == b || a.starts_with(&format!("{b}.")) || b.starts_with(&format!("{a}."))
}

struct Candidate {
    kind: usize,
    item_path: std::path::PathBuf,
}

/// Leftover folders of apps that are no longer installed, grouped per kind of folder under `~/Library`.
///
/// An entry qualifies when its name (minus the kind's suffix) is a bundle id that is not Apple's, not
/// `own_bundle_id`'s, not related to any of `installed`, not `is_known` (LaunchServices) and not a running app.
/// Real entries only: symlinks are skipped, and nothing is traversed beyond sizing.
pub fn find_orphans(
    home: &Path,
    installed: &[String],
    own_bundle_id: &str,
    running: &HashSet<String>,
    is_known: &(dyn Fn(&str) -> bool + Sync),
    p: &Progress,
) -> Vec<Group> {
    let lib = home.join("Library");
    let mut known: HashMap<String, bool> = HashMap::new();
    let mut found: Vec<Candidate> = Vec::new();

    for (kind_idx, kind) in ORPHAN_KINDS.iter().enumerate() {
        let Ok(rd) = fs::read_dir(lib.join(kind.dir)) else { continue };
        for entry in rd.filter_map(Result::ok) {
            if p.cancelled() {
                return Vec::new();
            }
            // DirEntry::file_type does not follow symlinks.
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() || !(ft.is_dir() || ft.is_file()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = kind.suffixes.iter().filter_map(|s| name.strip_suffix(s)).find(|i| is_bundle_id(i)) else {
                continue;
            };
            let lower = id.to_lowercase();
            if is_system_or_group_id(id, &lower)
                || related_ids(id, own_bundle_id)
                || installed.iter().any(|b| related_ids(id, b))
                || cache_in_use(id, running)
            {
                continue;
            }
            let id_known = *known.entry(lower).or_insert_with(|| is_known(id));
            if !id_known {
                found.push(Candidate { kind: kind_idx, item_path: entry.path() });
            }
        }
    }

    let total = AtomicU64::new(0);
    let sized: Vec<(usize, Item)> = found
        .into_par_iter()
        .map(|c| {
            let size = alloc_size(&c.item_path, p.cancel_flag());
            p.report(&c.item_path, total.fetch_add(size, std::sync::atomic::Ordering::Relaxed) + size);
            let item = Item::new(c.item_path, size, Policy::MoveToTrash);
            let item = if ORPHAN_KINDS[c.kind].regenerable { item } else { item.unselected(NOTE_ORPHAN) };
            (c.kind, item)
        })
        .collect();
    if p.cancelled() {
        return Vec::new();
    }

    let mut groups = Vec::new();
    for (idx, kind) in ORPHAN_KINDS.iter().enumerate() {
        let mut items: Vec<Item> = sized.iter().filter(|(k, _)| *k == idx).map(|(_, i)| i.clone()).collect();
        if items.is_empty() {
            continue;
        }
        items.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
        groups.push(Group {
            id: kind.id.into(),
            title: kind.title.into(),
            description: kind.description.into(),
            items,
        });
    }
    groups
}

/// Whether LaunchServices resolves `bundle_id` to an installed app anywhere on this Mac.
pub fn launch_services_knows(bundle_id: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::autoreleasepool;
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::NSString;

        autoreleasepool(|_| {
            NSWorkspace::sharedWorkspace()
                .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))
                .is_some()
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle_id;
        false
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Installation files
// ---------------------------------------------------------------------------------------------------------------

const INSTALLER_EXTS: &[&str] = &["dmg", "pkg", "mpkg", "xip"];

/// Installers (`.dmg .pkg .mpkg .xip`) directly inside `~/Downloads` and `~/Desktop`. No recursion, no symlinks.
/// They can be downloaded again, so they come pre-selected.
pub fn find_installers(home: &Path, cancel: &AtomicBool) -> Vec<Group> {
    let mut paths = Vec::new();
    for dir in ["Downloads", "Desktop"] {
        let Ok(rd) = fs::read_dir(home.join(dir)) else { continue };
        for e in rd.filter_map(Result::ok) {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() || !(ft.is_file() || ft.is_dir()) {
                continue;
            }
            let path = e.path();
            let ext = path.extension().map(|x| x.to_string_lossy().to_lowercase());
            if ext.is_some_and(|x| INSTALLER_EXTS.contains(&x.as_str())) {
                paths.push(path);
            }
        }
    }
    let mut items: Vec<Item> = paths
        .into_par_iter()
        .map(|path| {
            let size = alloc_size(&path, cancel);
            let mut item = Item::new(path, size, Policy::MoveToTrash);
            item.note = Some(NOTE_INSTALLER.into());
            item
        })
        .collect();
    if cancel.load(std::sync::atomic::Ordering::Relaxed) || items.is_empty() {
        return Vec::new();
    }
    items.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    vec![Group {
        id: "installers".into(),
        title: "Arquivos de instalação".into(),
        description: "Instaladores em Downloads e na Mesa que podem ser baixados de novo.".into(),
        items,
    }]
}

// ---------------------------------------------------------------------------------------------------------------
// Updater (read-only: finds newer versions, never installs)
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum Tok {
    Num(String),
    Word(String),
}

fn tokens(v: &str) -> Vec<Tok> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut numeric = false;
    for c in v.chars() {
        if c.is_ascii_alphanumeric() {
            let is_digit = c.is_ascii_digit();
            if !cur.is_empty() && is_digit != numeric {
                out.push(if numeric {
                    Tok::Num(std::mem::take(&mut cur))
                } else {
                    Tok::Word(std::mem::take(&mut cur))
                });
            }
            numeric = is_digit;
            cur.push(c.to_ascii_lowercase());
        } else if !cur.is_empty() {
            out.push(if numeric { Tok::Num(std::mem::take(&mut cur)) } else { Tok::Word(std::mem::take(&mut cur)) });
        }
    }
    if !cur.is_empty() {
        out.push(if numeric { Tok::Num(cur) } else { Tok::Word(cur) });
    }
    out
}

fn cmp_num(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (a.trim_start_matches('0'), b.trim_start_matches('0'));
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// Pre-release words sort below a plain release and in this order; unknown words sort alphabetically after them.
fn word_rank(w: &str) -> u8 {
    match w {
        "alpha" | "a" | "dev" => 0,
        "beta" | "b" => 1,
        "pre" | "preview" => 2,
        "rc" | "c" => 3,
        _ => 4,
    }
}

/// Numeric-aware version compare: `1.10 > 1.9`, `1.0 == 1.0.0`, `1.0b2 < 1.0`, `2.0rc1 < 2.0`.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::{Equal, Greater, Less};
    let (ta, tb) = (tokens(a), tokens(b));
    for i in 0..ta.len().max(tb.len()) {
        let ord = match (ta.get(i), tb.get(i)) {
            (Some(Tok::Num(x)), Some(Tok::Num(y))) => cmp_num(x, y),
            (Some(Tok::Word(x)), Some(Tok::Word(y))) => word_rank(x).cmp(&word_rank(y)).then_with(|| x.cmp(y)),
            (Some(Tok::Num(_)), Some(Tok::Word(_))) => Greater,
            (Some(Tok::Word(_)), Some(Tok::Num(_))) => Less,
            // A missing component is 0 against a number, and a plain release beats a pre-release tag.
            (Some(Tok::Num(x)), None) => cmp_num(x, "0"),
            (None, Some(Tok::Num(y))) => cmp_num("0", y),
            (Some(Tok::Word(_)), None) => Less,
            (None, Some(Tok::Word(_))) => Greater,
            (None, None) => Equal,
        };
        if ord != Equal {
            return ord;
        }
    }
    Equal
}

/// One `<item>` of a Sparkle appcast, reduced to what the updater needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppcastItem {
    pub short_version: Option<String>,
    pub build: Option<String>,
    pub download_url: Option<String>,
    pub notes_url: Option<String>,
    pub min_system: Option<String>,
}

fn https_only(s: &str) -> Option<String> {
    let s = s.trim();
    let ok = s.len() < 2048
        && s.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("https://"))
        && s.len() > 8
        && !s.chars().any(|c| c.is_control() || c.is_whitespace());
    ok.then(|| s.to_owned())
}

fn nonempty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

/// Part of a qualified name after the namespace prefix; `None` for unprefixed names.
fn prefixed(name: &str) -> Option<&str> {
    name.rsplit_once(':').map(|(_, local)| local)
}

#[derive(Default)]
struct ItemBuilder {
    item: AppcastItem,
    channel: bool,
    foreign_os: bool,
    link: Option<String>,
}

impl ItemBuilder {
    fn enclosure(&mut self, e: &quick_xml::events::BytesStart<'_>) {
        for a in e.attributes().with_checks(false).filter_map(Result::ok) {
            let key = a.key.as_ref().to_owned();
            let Ok(val) = a.normalized_value(quick_xml::XmlVersion::Implicit1_0) else { continue };
            match (prefixed(&key), key.as_str()) {
                (Some("version"), _) => self.item.build = self.item.build.take().or_else(|| nonempty(&val)),
                (Some("shortVersionString"), _) => {
                    self.item.short_version = self.item.short_version.take().or_else(|| nonempty(&val));
                }
                (Some("minimumSystemVersion"), _) => {
                    self.item.min_system = self.item.min_system.take().or_else(|| nonempty(&val));
                }
                (None, "url") => self.item.download_url = https_only(&val),
                _ => {}
            }
        }
    }

    /// Text of an element directly under `<item>`; element values override the enclosure's attributes.
    fn text(&mut self, name: &str, text: &str) {
        match (prefixed(name), name) {
            (Some("version"), _) => self.item.build = nonempty(text).or(self.item.build.take()),
            (Some("shortVersionString"), _) => {
                self.item.short_version = nonempty(text).or(self.item.short_version.take())
            }
            (Some("minimumSystemVersion"), _) => self.item.min_system = nonempty(text).or(self.item.min_system.take()),
            (Some("releaseNotesLink" | "fullReleaseNotesLink"), _) => {
                self.item.notes_url = self.item.notes_url.take().or_else(|| https_only(text));
            }
            (Some("channel"), _) => self.channel |= nonempty(text).is_some(),
            (Some("os"), _) => self.foreign_os |= nonempty(text).is_some_and(|o| !o.eq_ignore_ascii_case("macos")),
            (None, "link") => self.link = https_only(text),
            _ => {}
        }
    }

    fn finish(mut self) -> Option<AppcastItem> {
        // Items on a named channel (beta) are opt-in in Sparkle; items for another OS don't apply.
        if self.channel || self.foreign_os || (self.item.short_version.is_none() && self.item.build.is_none()) {
            return None;
        }
        if self.item.notes_url.is_none() {
            self.item.notes_url = self.link.take();
        }
        Some(self.item)
    }
}

/// Items of a Sparkle appcast. Delta enclosures, beta-channel items and items for other systems are ignored;
/// non-https links are dropped. Malformed XML yields whatever was parsed before the error.
pub fn parse_appcast(xml: &str) -> Vec<AppcastItem> {
    use quick_xml::events::Event;

    let mut reader = quick_xml::Reader::from_str(xml);
    let mut items = Vec::new();
    let mut cur: Option<ItemBuilder> = None;
    let mut deltas = 0u32;
    let mut text_of: Option<String> = None;
    let mut buf = String::new();

    while let Ok(ev) = reader.read_event() {
        match ev {
            Event::Eof => break,
            Event::Start(e) => {
                let name = e.name().as_ref().to_owned();
                if name == "item" {
                    cur = Some(ItemBuilder::default());
                } else if let Some(b) = cur.as_mut() {
                    if prefixed(&name) == Some("deltas") {
                        deltas += 1;
                    } else if name == "enclosure" && deltas == 0 {
                        b.enclosure(&e);
                    } else if deltas == 0 {
                        text_of = Some(name);
                        buf.clear();
                    }
                }
            }
            Event::Empty(e) => {
                let name = e.name().as_ref().to_owned();
                if let Some(b) = cur.as_mut()
                    && name == "enclosure"
                    && deltas == 0
                {
                    b.enclosure(&e);
                }
            }
            Event::Text(t) => {
                if text_of.is_some() {
                    buf.push_str(&t.xml10_content());
                }
            }
            Event::CData(t) => {
                if text_of.is_some() {
                    buf.push_str(&t.xml10_content());
                }
            }
            Event::GeneralRef(r) => {
                if text_of.is_some() {
                    match r.resolve_char_ref() {
                        Ok(Some(c)) => buf.push(c),
                        _ => match &*r {
                            "amp" => buf.push('&'),
                            "lt" => buf.push('<'),
                            "gt" => buf.push('>'),
                            "quot" => buf.push('"'),
                            "apos" => buf.push('\''),
                            _ => {}
                        },
                    }
                }
            }
            Event::End(e) => {
                let name = e.name().as_ref().to_owned();
                if name == "item" {
                    if let Some(item) = cur.take().and_then(ItemBuilder::finish) {
                        items.push(item);
                    }
                    deltas = 0;
                    text_of = None;
                } else if prefixed(&name) == Some("deltas") {
                    deltas = deltas.saturating_sub(1);
                } else if text_of.as_deref() == Some(name.as_str()) {
                    if let Some(b) = cur.as_mut() {
                        b.text(&name, &buf);
                    }
                    text_of = None;
                }
            }
            _ => {}
        }
    }
    items
}

/// What the updater reports for one app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Update {
    pub current: String,
    pub latest: String,
    pub notes_url: Option<String>,
    pub download_url: Option<String>,
}

/// Newest item that the host can run (by build number when both have one, else by short version).
pub fn newest<'a>(items: &'a [AppcastItem], host_macos: Option<&str>) -> Option<&'a AppcastItem> {
    items
        .iter()
        .filter(|i| match (i.min_system.as_deref(), host_macos) {
            (Some(min), Some(host)) => version_cmp(min, host) != std::cmp::Ordering::Greater,
            _ => true,
        })
        .max_by(|a, b| match (&a.build, &b.build, &a.short_version, &b.short_version) {
            (Some(x), Some(y), ..) => version_cmp(x, y),
            (_, _, Some(x), Some(y)) => version_cmp(x, y),
            _ => std::cmp::Ordering::Equal,
        })
}

/// Whether `item` is newer than the installed `cur_short`/`cur_build`: the short version decides when both sides
/// have one and they differ; otherwise the build numbers decide.
pub fn is_newer(item: &AppcastItem, cur_short: Option<&str>, cur_build: Option<&str>) -> bool {
    use std::cmp::Ordering::{Equal, Greater, Less};
    if let (Some(a), Some(b)) = (item.short_version.as_deref(), cur_short) {
        match version_cmp(a, b) {
            Greater => return true,
            Less => return false,
            Equal => {}
        }
    }
    matches!((item.build.as_deref(), cur_build), (Some(a), Some(b)) if version_cmp(a, b) == Greater)
}

/// Update (if any) offered by an appcast document to an app at `cur_short`/`cur_build`.
pub fn update_from_appcast(
    xml: &str,
    cur_short: Option<&str>,
    cur_build: Option<&str>,
    host_macos: Option<&str>,
) -> Option<Update> {
    let items = parse_appcast(xml);
    let item = newest(&items, host_macos)?;
    if !is_newer(item, cur_short, cur_build) {
        return None;
    }
    Some(Update {
        current: cur_short.or(cur_build)?.to_owned(),
        latest: item.short_version.clone().or_else(|| item.build.clone())?,
        notes_url: item.notes_url.clone(),
        download_url: item.download_url.clone(),
    })
}

/// What an app's Info.plist says about its Sparkle feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feed {
    pub url: String,
    pub short_version: Option<String>,
    pub build: Option<String>,
}

/// Sparkle feed of `app`: needs an https `SUFeedURL` and no App Store receipt (the store updates those).
pub fn feed_of(app: &AppInfo) -> Option<Feed> {
    if store_of(app) == STORE_APP_STORE {
        return None;
    }
    let value = plist::Value::from_file(app.path.join("Contents/Info.plist")).ok()?;
    let dict = value.as_dictionary()?;
    let text = |k: &str| dict.get(k).and_then(|v| v.as_string()).and_then(nonempty);
    Some(Feed {
        url: https_only(&text("SUFeedURL")?)?,
        short_version: text("CFBundleShortVersionString"),
        build: text("CFBundleVersion"),
    })
}

const MAX_APPCAST: u64 = 3_000_000;
const MAX_CONCURRENT: usize = 8;

/// Fetches `url` with the system `curl` (argument vector, no shell). `None` on any failure.
fn curl(url: &str) -> Option<String> {
    let mut child = Command::new("/usr/bin/curl")
        .args(["-fsSL", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "5"])
        .args(["--max-time", "10", "--max-filesize", "3000000", "-A", "Limpae", "--"])
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut body = Vec::new();
    // `--max-filesize` can't see the size of a chunked response, so cap what is read as well.
    let read = child.stdout.take()?.take(MAX_APPCAST + 1).read_to_end(&mut body);
    if body.len() as u64 > MAX_APPCAST {
        let _ = child.kill();
    }
    let status = child.wait().ok()?;
    (read.is_ok() && status.success() && body.len() as u64 <= MAX_APPCAST)
        .then(|| String::from_utf8_lossy(&body).into_owned())
}

fn host_macos_version() -> Option<&'static str> {
    static V: OnceLock<Option<String>> = OnceLock::new();
    V.get_or_init(|| {
        let out = Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|s| !s.is_empty())
    })
    .as_deref()
}

/// Updates available for `apps` (read-only). Returns `(index into apps, update)`, at most 8 feeds in flight.
/// Apps without a usable feed, and feeds that fail to load or parse, are skipped silently.
pub fn check_updates(apps: &[AppInfo], cancel: &AtomicBool) -> Vec<(usize, Update)> {
    check_updates_with(apps, cancel, &curl, host_macos_version())
}

/// [`check_updates`] with an injectable fetcher and host version (for tests).
pub fn check_updates_with(
    apps: &[AppInfo],
    cancel: &AtomicBool,
    fetch: &(dyn Fn(&str) -> Option<String> + Sync),
    host_macos: Option<&str>,
) -> Vec<(usize, Update)> {
    use std::sync::atomic::Ordering;

    let feeds: Vec<(usize, Feed)> = apps.iter().enumerate().filter_map(|(i, a)| feed_of(a).map(|f| (i, f))).collect();
    let work = || {
        feeds
            .par_iter()
            .filter_map(|(i, feed)| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let xml = fetch(&feed.url)?;
                let upd = update_from_appcast(&xml, feed.short_version.as_deref(), feed.build.as_deref(), host_macos)?;
                Some((*i, upd))
            })
            .collect::<Vec<_>>()
    };
    let mut out = match rayon::ThreadPoolBuilder::new().num_threads(MAX_CONCURRENT).build() {
        Ok(pool) => pool.install(work),
        Err(_) => Vec::new(),
    };
    out.sort_by_key(|(i, _)| *i);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::Guard;
    use std::cmp::Ordering::{Equal, Greater, Less};
    use std::path::PathBuf;

    fn touch(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![3u8; bytes]).unwrap();
    }

    fn fake_home() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(t.path()).unwrap();
        (t, home)
    }

    fn app(path: PathBuf, id: &str) -> AppInfo {
        AppInfo { path, name: "App".into(), bundle_id: id.into(), version: None, size: 0, running: false }
    }

    fn write_info(app_dir: &Path, pairs: &[(&str, &str)]) {
        fs::create_dir_all(app_dir.join("Contents")).unwrap();
        let mut d = plist::Dictionary::new();
        for (k, v) in pairs {
            d.insert((*k).into(), plist::Value::String((*v).into()));
        }
        plist::Value::Dictionary(d).to_file_xml(app_dir.join("Contents/Info.plist")).unwrap();
    }

    // ----- unused -----

    #[test]
    fn unused_threshold_and_unknown() {
        let now = 1_000_000_000;
        assert!(is_unused(Some(now - 181 * DAY), now, 180));
        assert!(!is_unused(Some(now - 180 * DAY), now, 180));
        assert!(!is_unused(Some(now - DAY), now, 180));
        assert!(!is_unused(None, now, 180), "unknown is not unused");
    }

    #[test]
    fn unused_from_skips_running_and_unknown() {
        let now = 1_000_000_000;
        let mut running = app("/a/R.app".into(), "com.r.r");
        running.running = true;
        let apps = vec![
            app("/a/Old.app".into(), "com.o.o"),
            app("/a/New.app".into(), "com.n.n"),
            app("/a/Unk.app".into(), "com.u.u"),
            running,
        ];
        let lasts = [Some(now - 400 * DAY), Some(now - 10 * DAY), None, Some(now - 400 * DAY)];
        assert_eq!(unused_from(&apps, &lasts, now, 180), [0]);
    }

    // ----- store / vendor -----

    #[test]
    fn store_detection() {
        let t = tempfile::tempdir().unwrap();
        let mas = t.path().join("Mas.app");
        touch(&mas.join("Contents/_MASReceipt/receipt"), 10);
        assert_eq!(store_of(&app(mas, "com.x.mas")), "App Store");
        assert_eq!(store_of(&app("/Applications/Setapp/Foo.app".into(), "com.x.foo")), "Setapp");
        assert_eq!(store_of(&app(t.path().join("Bar.app"), "com.example.Bar-setapp")), "Setapp");
        assert_eq!(store_of(&app(t.path().join("Plain.app"), "com.x.plain")), "Outros");
        // The receipt wins over a Setapp-looking path.
        let both = t.path().join("Both.app");
        touch(&both.join("Contents/_MASReceipt/receipt"), 10);
        assert_eq!(store_of(&app(both, "com.x.both-setapp")), "App Store");
    }

    #[test]
    fn vendor_names() {
        assert_eq!(vendor_of("com.google.Chrome"), "Google");
        assert_eq!(vendor_of("com.microsoft.VSCode"), "Microsoft");
        assert_eq!(vendor_of("com.adobe.Photoshop"), "Adobe");
        assert_eq!(vendor_of("com.jetbrains.intellij"), "JetBrains");
        assert_eq!(vendor_of("com.tinyspeck.slackmacgap"), "Slack");
        assert_eq!(vendor_of("org.acme.thing"), "Acme");
        assert_eq!(vendor_of("com.sublimehq.Sublime"), "Sublimehq");
        assert_eq!(vendor_of("br.com.limpae"), "Limpae");
        assert_eq!(vendor_of("noDots"), "Outros");
        assert_eq!(vendor_of(""), "Outros");
        assert_eq!(vendor_of("com."), "Outros");
    }

    // ----- version compare -----

    #[test]
    fn version_compare_is_numeric_aware() {
        assert_eq!(version_cmp("1.10", "1.9"), Greater);
        assert_eq!(version_cmp("2.9.11", "2.9.9"), Greater);
        assert_eq!(version_cmp("1.0", "1.0.0"), Equal);
        assert_eq!(version_cmp("1.0.1", "1.0"), Greater);
        assert_eq!(version_cmp("1.0", "1.0.1"), Less);
        assert_eq!(version_cmp("007", "7"), Equal);
        assert_eq!(version_cmp("v2.0", "1.99"), Greater);
        assert_eq!(version_cmp("99999999999999999999", "9999999999999999999"), Greater);
        assert_eq!(version_cmp("407", "406"), Greater);
        assert_eq!(version_cmp("", "0"), Equal);
    }

    #[test]
    fn version_compare_prerelease() {
        assert_eq!(version_cmp("1.0b2", "1.0"), Less);
        assert_eq!(version_cmp("1.0", "1.0b2"), Greater);
        assert_eq!(version_cmp("2.0rc1", "2.0"), Less);
        assert_eq!(version_cmp("2.0-beta.1", "2.0-beta.2"), Less);
        assert_eq!(version_cmp("2.0-alpha", "2.0-beta"), Less);
        assert_eq!(version_cmp("2.0-rc1", "2.0-beta9"), Greater);
        assert_eq!(version_cmp("2.0.1", "2.0-rc1"), Greater);
        assert_eq!(version_cmp("1.2.3", "1.2.3"), Equal);
    }

    // ----- appcast -----

    const ATTR_STYLE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
 <channel>
  <title>App</title>
  <item>
   <title>Version 2.0</title>
   <sparkle:releaseNotesLink>https://example.com/notes/2.0.html</sparkle:releaseNotesLink>
   <enclosure url="https://example.com/App-2.0.zip" sparkle:version="200" sparkle:shortVersionString="2.0" length="1" type="application/octet-stream"/>
  </item>
  <item>
   <title>Version 1.5</title>
   <enclosure url="https://example.com/App-1.5.zip" sparkle:version="150" sparkle:shortVersionString="1.5"/>
  </item>
 </channel>
</rss>"#;

    const ELEMENT_STYLE: &str = r#"<rss xmlns:sparkle="x"><channel>
  <item>
   <title>3.1</title>
   <link>https://example.com/product</link>
   <sparkle:version>310</sparkle:version>
   <sparkle:shortVersionString>3.1</sparkle:shortVersionString>
   <sparkle:minimumSystemVersion>11.0</sparkle:minimumSystemVersion>
   <sparkle:fullReleaseNotesLink><![CDATA[https://example.com/n?a=1&b=2]]></sparkle:fullReleaseNotesLink>
   <enclosure url="https://example.com/App-3.1.dmg?x=1&amp;y=2" type="application/x-apple-diskimage"/>
  </item>
</channel></rss>"#;

    #[test]
    fn parses_attribute_style() {
        let items = parse_appcast(ATTR_STYLE);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].build.as_deref(), Some("200"));
        assert_eq!(items[0].short_version.as_deref(), Some("2.0"));
        assert_eq!(items[0].download_url.as_deref(), Some("https://example.com/App-2.0.zip"));
        assert_eq!(items[0].notes_url.as_deref(), Some("https://example.com/notes/2.0.html"));
        assert_eq!(items[1].notes_url, None);
    }

    #[test]
    fn parses_element_style_with_entities_and_cdata() {
        let items = parse_appcast(ELEMENT_STYLE);
        assert_eq!(items.len(), 1);
        let i = &items[0];
        assert_eq!((i.build.as_deref(), i.short_version.as_deref()), (Some("310"), Some("3.1")));
        assert_eq!(i.min_system.as_deref(), Some("11.0"));
        assert_eq!(i.notes_url.as_deref(), Some("https://example.com/n?a=1&b=2"));
        assert_eq!(i.download_url.as_deref(), Some("https://example.com/App-3.1.dmg?x=1&y=2"));
    }

    #[test]
    fn link_is_notes_fallback() {
        let xml = r#"<rss xmlns:sparkle="x"><channel><item><link>https://e.com/p</link>
            <enclosure url="https://e.com/a.zip" sparkle:version="5"/></item></channel></rss>"#;
        let items = parse_appcast(xml);
        assert_eq!(items[0].notes_url.as_deref(), Some("https://e.com/p"));
        assert_eq!(items[0].short_version, None);
    }

    #[test]
    fn missing_fields_and_garbage() {
        assert!(parse_appcast("").is_empty());
        assert!(parse_appcast("not xml at all <<<").is_empty());
        // No version at all: not an update candidate.
        assert!(parse_appcast("<rss><channel><item><title>x</title></item></channel></rss>").is_empty());
        // Truncated document keeps the complete items before the cut.
        let cut = &ATTR_STYLE[..ATTR_STYLE.find("<item>\n   <title>Version 1.5").unwrap() + 20];
        assert_eq!(parse_appcast(cut).len(), 1);
    }

    #[test]
    fn non_https_urls_are_dropped() {
        let xml = r#"<rss xmlns:sparkle="x"><channel><item>
            <sparkle:releaseNotesLink>http://e.com/n</sparkle:releaseNotesLink>
            <enclosure url="http://e.com/a.zip" sparkle:version="5" sparkle:shortVersionString="5.0"/>
            </item><item>
            <enclosure url="javascript:alert(1)" sparkle:version="6" sparkle:shortVersionString="6.0"/>
            </item><item>
            <enclosure url="https://e.com/with space.zip" sparkle:version="7" sparkle:shortVersionString="7.0"/>
            </item></channel></rss>"#;
        let items = parse_appcast(xml);
        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|i| i.download_url.is_none() && i.notes_url.is_none()));
    }

    #[test]
    fn deltas_betas_and_other_os_are_ignored() {
        let xml = r#"<rss xmlns:sparkle="x"><channel>
          <item><sparkle:shortVersionString>9.0</sparkle:shortVersionString><sparkle:version>900</sparkle:version>
            <sparkle:channel>beta</sparkle:channel>
            <enclosure url="https://e.com/beta.zip"/></item>
          <item><sparkle:os>windows</sparkle:os><sparkle:version>800</sparkle:version>
            <enclosure url="https://e.com/win.zip"/></item>
          <item><sparkle:shortVersionString>2.0</sparkle:shortVersionString><sparkle:version>200</sparkle:version>
            <enclosure url="https://e.com/full.zip"/>
            <sparkle:deltas>
              <enclosure url="https://e.com/delta.delta" sparkle:version="200" sparkle:deltaFrom="190"/>
            </sparkle:deltas></item>
        </channel></rss>"#;
        let items = parse_appcast(xml);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].download_url.as_deref(), Some("https://e.com/full.zip"));
    }

    #[test]
    fn newest_picks_highest_build_and_respects_min_system() {
        let xml = r#"<rss xmlns:sparkle="x"><channel>
          <item><sparkle:version>10</sparkle:version><sparkle:shortVersionString>1.10</sparkle:shortVersionString></item>
          <item><sparkle:version>9</sparkle:version><sparkle:shortVersionString>1.9</sparkle:shortVersionString></item>
          <item><sparkle:version>11</sparkle:version><sparkle:shortVersionString>1.11</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>99.0</sparkle:minimumSystemVersion></item>
        </channel></rss>"#;
        let items = parse_appcast(xml);
        assert_eq!(newest(&items, Some("14.5")).unwrap().short_version.as_deref(), Some("1.10"));
        assert_eq!(newest(&items, Some("99.1")).unwrap().short_version.as_deref(), Some("1.11"));
        assert_eq!(newest(&items, None).unwrap().short_version.as_deref(), Some("1.11"));
    }

    #[test]
    fn update_decision() {
        let u = update_from_appcast(ATTR_STYLE, Some("1.5"), Some("150"), None).unwrap();
        assert_eq!((u.current.as_str(), u.latest.as_str()), ("1.5", "2.0"));
        assert_eq!(u.download_url.as_deref(), Some("https://example.com/App-2.0.zip"));
        assert_eq!(u.notes_url.as_deref(), Some("https://example.com/notes/2.0.html"));
        // Up to date, or ahead of the feed.
        assert!(update_from_appcast(ATTR_STYLE, Some("2.0"), Some("200"), None).is_none());
        assert!(update_from_appcast(ATTR_STYLE, Some("2.1"), Some("201"), None).is_none());
        // Same short version, newer build.
        assert!(update_from_appcast(ATTR_STYLE, Some("2.0"), Some("199"), None).is_some());
        // Short compare wins over a build scheme change.
        assert!(update_from_appcast(ATTR_STYLE, Some("2.1"), Some("1"), None).is_none());
        // Only a build number on the app side.
        assert!(update_from_appcast(ATTR_STYLE, None, Some("100"), None).is_some());
        // Nothing to compare against.
        assert!(update_from_appcast(ATTR_STYLE, None, None, None).is_none());
        assert!(update_from_appcast("", Some("1.0"), None, None).is_none());
    }

    #[test]
    fn feed_of_requires_https_feed_and_no_receipt() {
        let t = tempfile::tempdir().unwrap();
        let ok = t.path().join("Ok.app");
        write_info(
            &ok,
            &[
                ("CFBundleIdentifier", "com.x.ok"),
                ("SUFeedURL", "https://x.com/appcast.xml"),
                ("CFBundleShortVersionString", "1.2"),
                ("CFBundleVersion", "12"),
            ],
        );
        let f = feed_of(&app(ok.clone(), "com.x.ok")).unwrap();
        assert_eq!(f.url, "https://x.com/appcast.xml");
        assert_eq!((f.short_version.as_deref(), f.build.as_deref()), (Some("1.2"), Some("12")));

        let http = t.path().join("Http.app");
        write_info(&http, &[("CFBundleIdentifier", "com.x.h"), ("SUFeedURL", "http://x.com/a.xml")]);
        assert!(feed_of(&app(http, "com.x.h")).is_none());
        let none = t.path().join("None.app");
        write_info(&none, &[("CFBundleIdentifier", "com.x.n")]);
        assert!(feed_of(&app(none, "com.x.n")).is_none());

        touch(&ok.join("Contents/_MASReceipt/receipt"), 4);
        assert!(feed_of(&app(ok, "com.x.ok")).is_none(), "App Store apps are updated by the store");
    }

    #[test]
    fn check_updates_with_fake_fetcher() {
        let t = tempfile::tempdir().unwrap();
        let mk = |name: &str, id: &str, url: &str, short: &str, build: &str| {
            let p = t.path().join(name);
            write_info(
                &p,
                &[
                    ("CFBundleIdentifier", id),
                    ("SUFeedURL", url),
                    ("CFBundleShortVersionString", short),
                    ("CFBundleVersion", build),
                ],
            );
            app(p, id)
        };
        let apps = vec![
            mk("Old.app", "com.x.old", "https://feeds.test/old.xml", "1.5", "150"),
            mk("Cur.app", "com.x.cur", "https://feeds.test/cur.xml", "2.0", "200"),
            mk("Down.app", "com.x.down", "https://feeds.test/down.xml", "1.0", "100"),
            mk("Bad.app", "com.x.bad", "https://feeds.test/bad.xml", "1.0", "100"),
        ];
        let fetch = |url: &str| match url {
            "https://feeds.test/old.xml" | "https://feeds.test/cur.xml" => Some(ATTR_STYLE.to_owned()),
            "https://feeds.test/bad.xml" => Some("<<<".to_owned()),
            _ => None,
        };
        let r = check_updates_with(&apps, &AtomicBool::new(false), &fetch, Some("15.0"));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, 0);
        assert_eq!(r[0].1.latest, "2.0");
        let cancelled = check_updates_with(&apps, &AtomicBool::new(true), &fetch, None);
        assert!(cancelled.is_empty());
    }

    // ----- orphans -----

    fn orphans(home: &Path, installed: &[&str], running: &[&str], known: &[&str]) -> Vec<Group> {
        let installed: Vec<String> = installed.iter().map(|s| (*s).to_owned()).collect();
        let running: HashSet<String> = running.iter().map(|s| (*s).to_owned()).collect();
        let known: HashSet<String> = known.iter().map(|s| (*s).to_owned()).collect();
        find_orphans(home, &installed, "br.com.limpae", &running, &move |id| known.contains(id), &Progress::silent())
    }

    fn rel(home: &Path, groups: &[Group]) -> Vec<String> {
        let mut v: Vec<String> = groups
            .iter()
            .flat_map(|g| g.items.iter())
            .map(|i| i.path.strip_prefix(home).unwrap().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn bundle_id_shape() {
        assert!(is_bundle_id("com.acme.app"));
        assert!(is_bundle_id("com.acme-inc.my-app.helper"));
        assert!(!is_bundle_id("com.acme"));
        assert!(!is_bundle_id("com.acme.my_app"));
        assert!(!is_bundle_id("com..app"));
        assert!(!is_bundle_id("com.acme.app "));
        assert!(!is_bundle_id("1.2.3"));
        assert!(!is_bundle_id("Google Chrome"));
        assert!(!is_bundle_id("com.acme.app.plist.lock/x"));
    }

    #[test]
    fn orphans_grouped_by_kind_with_preselection() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        let id = "com.gone.app";
        touch(&l.join(format!("Caches/{id}/c")), 8_000);
        touch(&l.join(format!("Saved Application State/{id}.savedState/w")), 10);
        touch(&l.join(format!("HTTPStorages/{id}/h")), 10);
        touch(&l.join(format!("HTTPStorages/{id}.binarycookies")), 10);
        touch(&l.join(format!("WebKit/{id}/w")), 10);
        touch(&l.join(format!("Logs/{id}/l")), 10);
        touch(&l.join(format!("Application Support/{id}/d")), 10);
        touch(&l.join(format!("Containers/{id}/d")), 10);
        touch(&l.join(format!("Preferences/{id}.plist")), 10);
        touch(&l.join(format!("Application Scripts/{id}/s")), 10);
        touch(&l.join(format!("LaunchAgents/{id}.plist")), 10);

        let groups = orphans(&home, &[], &[], &[]);
        assert_eq!(groups.len(), 10, "{:?}", groups.iter().map(|g| &g.id).collect::<Vec<_>>());
        let selected: Vec<&str> =
            groups.iter().filter(|g| g.items.iter().all(|i| i.selected)).map(|g| g.id.as_str()).collect();
        assert_eq!(selected, ["orphan_caches", "orphan_saved_state", "orphan_http", "orphan_webkit", "orphan_logs"]);
        for g in groups.iter().filter(|g| !selected.contains(&g.id.as_str())) {
            for i in &g.items {
                assert!(!i.selected, "{}", g.id);
                assert_eq!(i.note.as_deref(), Some("App não encontrado; pode guardar dados"));
            }
        }
        assert_eq!(groups[2].items.len(), 2, "folder and .binarycookies both listed");
        assert!(groups.iter().flat_map(|g| &g.items).all(|i| i.policy == Policy::MoveToTrash));
        assert!(groups[0].items[0].size >= 8_000);
    }

    #[test]
    fn orphans_exclusions() {
        let (_t, home) = fake_home();
        let c = home.join("Library/Caches");
        for n in [
            "com.apple.Safari",
            "com.apple.foo.bar",
            "group.com.apple.mail",
            "systemgroup.com.apple.icloud.x",
            "PTN9T2S29T.com.apple.VAWorkspace",
            "AW9CBV6SY7.group.Acme.Thing",
            "group.com.acme.shared",
            "org.cups.PrintingPrefs",
            "br.com.limpae",
            "br.com.limpae.helper",
            "com.installed.app",
            "com.installed.app.helper",
            "com.installed",
            "com.known.app",
            "com.running.app",
            "com.running.app.helper",
            "com.short",
            "com.bad.my_app",
            "Google Chrome",
            "org.mozilla.firefox.extra",
            "com.gone.app",
        ] {
            touch(&c.join(n).join("x"), 10);
        }
        // `com.installed` has two labels so it is never a candidate; the installed id itself must not match either.
        let got = rel(
            &home,
            &orphans(&home, &["com.installed.app", "org.mozilla.firefox"], &["com.running.app"], &["com.known.app"]),
        );
        assert_eq!(got, ["Library/Caches/com.gone.app"]);
    }

    #[test]
    fn installed_prefix_and_subid_both_directions() {
        let (_t, home) = fake_home();
        let c = home.join("Library/Caches");
        touch(&c.join("com.acme.suite/x"), 10); // prefix of installed com.acme.suite.editor
        touch(&c.join("com.acme.suite.editor.helper/x"), 10); // sub-id of installed
        touch(&c.join("com.acme.suiteX.thing/x"), 10); // different id, only textual prefix
        let got = rel(&home, &orphans(&home, &["com.acme.suite.editor"], &[], &[]));
        assert_eq!(got, ["Library/Caches/com.acme.suiteX.thing"]);
    }

    #[test]
    fn id_check_is_case_insensitive() {
        let (_t, home) = fake_home();
        let c = home.join("Library/Caches");
        touch(&c.join("COM.APPLE.thing.x/x"), 10);
        touch(&c.join("com.Installed.App/x"), 10);
        assert!(orphans(&home, &["com.installed.app"], &[], &[]).is_empty());
    }

    #[test]
    fn symlinked_entries_are_skipped() {
        let (_t, home) = fake_home();
        let outside = tempfile::tempdir().unwrap();
        let c = home.join("Library/Caches");
        fs::create_dir_all(&c).unwrap();
        std::os::unix::fs::symlink(outside.path(), c.join("com.gone.link")).unwrap();
        touch(&home.join("Library/Preferences/real.txt"), 1);
        std::os::unix::fs::symlink(outside.path(), home.join("Library/Preferences/com.gone.pref.plist")).unwrap();
        assert!(orphans(&home, &[], &[], &[]).is_empty());
    }

    #[test]
    fn plist_kinds_need_their_suffix_and_dirs_do_not() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        touch(&l.join("Preferences/com.gone.a.txt"), 10); // wrong suffix
        touch(&l.join("Preferences/com.gone.b.plist"), 10);
        touch(&l.join("Saved Application State/com.gone.c/x"), 10); // missing .savedState
        touch(&l.join("LaunchAgents/com.gone.d.plist"), 10);
        let got = rel(&home, &orphans(&home, &[], &[], &[]));
        assert_eq!(got, ["Library/LaunchAgents/com.gone.d.plist", "Library/Preferences/com.gone.b.plist"]);
    }

    #[test]
    fn orphans_sorted_by_size_and_cancel() {
        let (_t, home) = fake_home();
        let c = home.join("Library/Caches");
        touch(&c.join("com.gone.small/x"), 10);
        touch(&c.join("com.gone.big/x"), 50_000);
        let g = orphans(&home, &[], &[], &[]);
        assert!(g[0].items[0].path.ends_with("com.gone.big"));
        let p = Progress::new(std::sync::Arc::new(AtomicBool::new(true)), |_, _| {});
        assert!(find_orphans(&home, &[], "x", &HashSet::new(), &|_| false, &p).is_empty());
    }

    #[test]
    fn launch_services_lookup_is_memoized_per_id() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        touch(&l.join("Caches/com.gone.app/x"), 10);
        touch(&l.join("Logs/com.gone.app/x"), 10);
        touch(&l.join("WebKit/com.gone.app/x"), 10);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let probe = |_: &str| {
            calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            false
        };
        let g = find_orphans(&home, &[], "x.y.z", &HashSet::new(), &probe, &Progress::silent());
        assert_eq!(g.len(), 3);
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1);
    }

    #[test]
    fn every_orphan_and_installer_passes_the_guard() {
        let (_t, home) = fake_home();
        let l = home.join("Library");
        let id = "com.gone.app";
        for rel in [
            format!("Caches/{id}/c"),
            format!("Saved Application State/{id}.savedState/w"),
            format!("HTTPStorages/{id}/h"),
            format!("WebKit/{id}/w"),
            format!("Logs/{id}/l"),
            format!("Application Support/{id}/d"),
            format!("Containers/{id}/d"),
            format!("Preferences/{id}.plist"),
            format!("Application Scripts/{id}/s"),
            format!("LaunchAgents/{id}.plist"),
        ] {
            touch(&l.join(rel), 10);
        }
        touch(&home.join("Downloads/a.dmg"), 10);
        touch(&home.join("Desktop/b.pkg"), 10);
        let mut groups = orphans(&home, &[], &[], &[]);
        groups.extend(find_installers(&home, &AtomicBool::new(false)));
        let guard = Guard::new(&home);
        let mut n = 0;
        for i in groups.iter().flat_map(|g| &g.items) {
            assert!(guard.check(&i.path, &i.policy).is_ok(), "{:?}", i.path);
            n += 1;
        }
        assert_eq!(n, 12);
    }

    // ----- installers -----

    #[test]
    fn installers_top_level_only() {
        let (_t, home) = fake_home();
        touch(&home.join("Downloads/App.dmg"), 20_000);
        touch(&home.join("Downloads/Tool.PKG"), 10);
        touch(&home.join("Downloads/Suite.mpkg"), 10);
        touch(&home.join("Desktop/Xcode.xip"), 30_000);
        touch(&home.join("Downloads/notes.txt"), 10);
        touch(&home.join("Downloads/archive.zip"), 10);
        touch(&home.join("Downloads/sub/Nested.dmg"), 10);
        touch(&home.join("Documents/Doc.dmg"), 10);
        touch(&home.join("Downloads/dmg"), 10);
        let outside = tempfile::tempdir().unwrap();
        touch(&outside.path().join("Link.dmg"), 10);
        std::os::unix::fs::symlink(outside.path().join("Link.dmg"), home.join("Downloads/Link.dmg")).unwrap();

        let groups = find_installers(&home, &AtomicBool::new(false));
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "installers");
        assert_eq!(
            rel(&home, &groups),
            ["Desktop/Xcode.xip", "Downloads/App.dmg", "Downloads/Suite.mpkg", "Downloads/Tool.PKG"]
        );
        let items = &groups[0].items;
        assert!(items.iter().all(|i| i.selected && i.note.as_deref() == Some("Instalador")));
        assert!(items.windows(2).all(|w| w[0].size >= w[1].size));
        assert!(items[0].path.ends_with("Desktop/Xcode.xip"));
    }

    #[test]
    fn installers_empty_and_cancelled() {
        let (_t, home) = fake_home();
        assert!(find_installers(&home, &AtomicBool::new(false)).is_empty());
        touch(&home.join("Downloads/a.dmg"), 10);
        assert!(find_installers(&home, &AtomicBool::new(true)).is_empty());
    }

    // ----- real Spotlight -----

    #[test]
    #[ignore = "reads the real Spotlight index of this Mac"]
    fn real_machine_last_used() {
        let fin = last_used(Path::new("/System/Library/CoreServices/Finder.app"));
        println!("Finder last used: {fin:?}");
        assert!(last_used(Path::new("/nonexistent/Foo.app")).is_none());
    }

    #[test]
    #[ignore = "reads the real LaunchServices database of this Mac"]
    fn real_machine_launch_services() {
        assert!(launch_services_knows("com.apple.finder"));
        assert!(!launch_services_knows("com.nonexistent.limpae.testing"));
    }
}
