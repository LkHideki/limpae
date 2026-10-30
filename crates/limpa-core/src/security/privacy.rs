//! Privacidade: itens recentes do sistema e dados de navegação de Chrome, Brave, Edge e Firefox.
//!
//! Tudo vai para o Lixo (reversível). Dados de navegador só são oferecidos com o navegador fechado e nada vem
//! pré-selecionado. Senhas e chaves (Login Data, logins.json, key4.db...) nunca entram: a lista de arquivos é
//! explícita e um filtro final descarta qualquer credencial. Safari fica de fora (exige Acesso Total ao Disco e
//! tem sandbox própria).

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use crate::model::{Group, Item, Policy, Progress};
use crate::size::alloc_size;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Chromium,
    Firefox,
}

#[derive(Debug, Clone, Copy)]
pub struct Browser {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Kind,
    /// Bundle ids do app (em minúsculas) que indicam navegador aberto.
    pub bundle_ids: &'static [&'static str],
    /// Pasta de dados, relativa a `~/Library/Application Support`.
    pub data_dir: &'static str,
}

pub const BROWSERS: &[Browser] = &[
    Browser {
        id: "chrome",
        name: "Google Chrome",
        kind: Kind::Chromium,
        bundle_ids: &["com.google.chrome"],
        data_dir: "Google/Chrome",
    },
    Browser {
        id: "brave",
        name: "Brave",
        kind: Kind::Chromium,
        bundle_ids: &["com.brave.browser"],
        data_dir: "BraveSoftware/Brave-Browser",
    },
    Browser {
        id: "edge",
        name: "Microsoft Edge",
        kind: Kind::Chromium,
        bundle_ids: &["com.microsoft.edgemac"],
        data_dir: "Microsoft Edge",
    },
    Browser {
        id: "firefox",
        name: "Firefox",
        kind: Kind::Firefox,
        bundle_ids: &["org.mozilla.firefox"],
        data_dir: "Firefox/Profiles",
    },
];

/// Categorias por navegador: (id, título, descrição).
pub const CATEGORIES: &[(&str, &str, &str)] = &[
    ("history", "Histórico", "Sites visitados."),
    ("cookies", "Cookies", "Você será desconectado dos sites onde está logado."),
    ("forms", "Formulários", "Dados de preenchimento automático."),
    ("downloads", "Downloads", "Registro e metadados de downloads."),
    ("sessions", "Sessões", "Abas e janelas guardadas para restaurar."),
];

const SUFFIXES: &[&str] = &["", "-journal", "-wal", "-shm"];

const RECENT_DIR: &str = "Library/Application Support/com.apple.sharedfilelist";
const APP_RECENT_DIR: &str = "com.apple.LSSharedFileList.ApplicationRecentDocuments";
/// Só listas de itens recentes: o resto da pasta (favoritos da barra lateral do Finder etc.) fica intacto.
const RECENT_PREFIX: &str = "com.apple.LSSharedFileList.Recent";

pub const NOTE_FIREFOX_BOOKMARKS: &str = "Inclui os favoritos";
pub const NOTE_CHROMIUM_AUTOFILL: &str = "Inclui cartões e endereços salvos";

/// Arquivos de credenciais: nunca oferecidos, qualquer que seja a categoria.
pub fn is_credential(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with("login data")
        || n.starts_with("logins")
        || n.starts_with("signons")
        || n.starts_with("key3.db")
        || n.starts_with("key4.db")
        || n.starts_with("cert9.db")
        || n.starts_with("cert8.db")
        || n.starts_with("pkcs11")
        || n.contains("keychain")
        || n.contains("password")
}

pub fn app_support(home: &Path) -> PathBuf {
    home.join("Library/Application Support")
}

fn data_root(home: &Path, b: &Browser) -> PathBuf {
    app_support(home).join(b.data_dir)
}

/// Perfis do navegador: pastas reais (nunca symlink) `Default` / `Profile *` ou, no Firefox, todas.
pub fn profiles(home: &Path, b: &Browser) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(data_root(home, b)) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            match b.kind {
                Kind::Chromium => name == "Default" || name.starts_with("Profile "),
                Kind::Firefox => !name.starts_with('.'),
            }
        })
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

/// Caminhos candidatos (relativos ao perfil) de uma categoria.
fn candidates(kind: Kind, category: &str, profile: &Path) -> Vec<PathBuf> {
    let fixed: &[&str] = match (kind, category) {
        (Kind::Chromium, "history") => &["History"],
        (Kind::Chromium, "cookies") => &["Cookies", "Network/Cookies"],
        (Kind::Chromium, "forms") => &["Web Data"],
        (Kind::Chromium, "downloads") => &["DownloadMetadata", "Download Service"],
        (Kind::Chromium, "sessions") => &["Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs"],
        (Kind::Firefox, "history") => &["places.sqlite"],
        (Kind::Firefox, "cookies") => &["cookies.sqlite"],
        (Kind::Firefox, "forms") => &["formhistory.sqlite"],
        (Kind::Firefox, "downloads") => &["downloads.json"],
        _ => &[],
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for rel in fixed {
        let sqlite_like = !matches!(*rel, "Sessions" | "Download Service");
        let suffixes: &[&str] = if sqlite_like { SUFFIXES } else { &[""] };
        out.extend(suffixes.iter().map(|s| profile.join(format!("{rel}{s}"))));
    }
    if kind == Kind::Firefox
        && category == "sessions"
        && let Ok(rd) = fs::read_dir(profile)
    {
        out.extend(
            rd.filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with("sessionstore"))
                .map(|e| e.path()),
        );
    }
    out
}

/// Existe, não é symlink e não é credencial.
fn eligible(path: &Path) -> bool {
    let credential = path.file_name().and_then(OsStr::to_str).is_none_or(is_credential);
    !credential && fs::symlink_metadata(path).is_ok_and(|m| !m.file_type().is_symlink())
}

fn lock_pid(link: &Path, marker: char) -> Option<i32> {
    let target = fs::read_link(link).ok()?;
    let text = target.to_string_lossy().into_owned();
    text.rsplit(marker).next()?.parse::<i32>().ok().filter(|p| *p > 0)
}

fn pid_alive(pid: i32) -> bool {
    // SAFETY: kill com sinal 0 só verifica a existência do processo; EPERM significa que existe.
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

/// Navegador aberto: o app está na lista de executando, ou a trava de instância (SingletonLock / lock) aponta para
/// um processo vivo. Travas velhas contam como aberto, o lado seguro.
pub fn is_running(home: &Path, b: &Browser, running_ids: &HashSet<String>) -> bool {
    if b.bundle_ids.iter().any(|id| running_ids.iter().any(|r| r.eq_ignore_ascii_case(id))) {
        return true;
    }
    match b.kind {
        Kind::Chromium => lock_pid(&data_root(home, b).join("SingletonLock"), '-').is_some_and(pid_alive),
        Kind::Firefox => profiles(home, b).iter().any(|p| lock_pid(&p.join("lock"), '+').is_some_and(pid_alive)),
    }
}

/// Navegador dono de um caminho (pela pasta de dados), para rechecar na remoção.
pub fn browser_for_path(home: &Path, path: &Path) -> Option<&'static Browser> {
    BROWSERS.iter().find(|b| path.starts_with(data_root(home, b)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserState {
    pub id: &'static str,
    pub name: &'static str,
    pub present: bool,
    pub running: bool,
}

pub fn browser_states(home: &Path, running_ids: &HashSet<String>) -> Vec<BrowserState> {
    BROWSERS
        .iter()
        .map(|b| {
            let present = !profiles(home, b).is_empty();
            BrowserState { id: b.id, name: b.name, present, running: present && is_running(home, b, running_ids) }
        })
        .collect()
}

fn item(path: PathBuf, cancel: &std::sync::atomic::AtomicBool) -> Item {
    let size = alloc_size(&path, cancel);
    Item::new(path, size, Policy::MoveToTrash)
}

/// Itens recentes do sistema (selecionados): só as listas `Recent*` e as de documentos recentes por app.
pub fn recent_items(home: &Path, p: &Progress) -> Group {
    let dir = home.join(RECENT_DIR);
    let mut paths: Vec<PathBuf> = Vec::new();
    let sfl = |e: &fs::DirEntry| {
        let name = e.file_name().to_string_lossy().into_owned();
        name.contains(".sfl") && e.file_type().is_ok_and(|t| t.is_file())
    };
    if let Ok(rd) = fs::read_dir(&dir) {
        paths.extend(
            rd.filter_map(Result::ok)
                .filter(|e| sfl(e) && e.file_name().to_string_lossy().starts_with(RECENT_PREFIX))
                .map(|e| e.path()),
        );
    }
    if let Ok(rd) = fs::read_dir(dir.join(APP_RECENT_DIR)) {
        paths.extend(rd.filter_map(Result::ok).filter(sfl).map(|e| e.path()));
    }
    paths.sort();
    let items = paths
        .into_iter()
        .filter(|path| !p.cancelled() && eligible(path))
        .map(|path| {
            p.report(&path, 0);
            item(path, p.cancel_flag())
        })
        .collect();
    Group {
        id: "recent".into(),
        title: "Itens recentes".into(),
        description: "Listas de documentos, apps e servidores abertos recentemente.".into(),
        items,
    }
}

fn note_for(b: &Browser, category: &str) -> Option<&'static str> {
    match (b.kind, category) {
        (Kind::Firefox, "history") => Some(NOTE_FIREFOX_BOOKMARKS),
        (Kind::Chromium, "forms") => Some(NOTE_CHROMIUM_AUTOFILL),
        _ => None,
    }
}

/// Grupos de um navegador, um por categoria. Aberto: grupos vazios com o aviso para fechar. Sem itens
/// pré-selecionados. Só os navegadores com perfil no disco são considerados.
pub fn browser_groups(home: &Path, b: &Browser, running: bool, p: &Progress) -> Vec<Group> {
    let profs = profiles(home, b);
    if profs.is_empty() {
        return Vec::new();
    }
    let multi = profs.len() > 1;
    CATEGORIES
        .iter()
        .map(|(cat, title, desc)| {
            let mut items = Vec::new();
            if !running {
                for prof in &profs {
                    let pname = prof.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    for path in candidates(b.kind, cat, prof) {
                        if p.cancelled() {
                            break;
                        }
                        if !eligible(&path) {
                            continue;
                        }
                        p.report(&path, 0);
                        let mut it = item(path.clone(), p.cancel_flag());
                        if multi {
                            it.name = format!("{} ({pname})", it.name);
                        }
                        it.selected = false;
                        it.note = note_for(b, cat).map(str::to_owned);
                        items.push(it);
                    }
                }
            }
            let description = if running { format!("Feche o {} para limpar.", b.name) } else { (*desc).to_owned() };
            Group { id: format!("{}:{cat}", b.id), title: (*title).to_owned(), description, items }
        })
        .collect()
}

/// Varredura completa: itens recentes, depois cada navegador presente.
pub fn scan(home: &Path, running_ids: &HashSet<String>, p: &Progress) -> Vec<Group> {
    let mut groups = vec![recent_items(home, p)];
    for b in BROWSERS {
        let running = is_running(home, b, running_ids);
        groups.extend(browser_groups(home, b, running, p));
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Guard;

    struct Fx {
        _tmp: tempfile::TempDir,
        home: PathBuf,
    }

    fn touch(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    fn fixture() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(tmp.path()).unwrap().join("home");
        let sup = home.join("Library/Application Support");
        // Chrome: dois perfis, com credenciais ao lado dos dados.
        for prof in ["Default", "Profile 1"] {
            let d = sup.join("Google/Chrome").join(prof);
            for f in [
                "History",
                "History-journal",
                "Cookies",
                "Cookies-journal",
                "Web Data",
                "DownloadMetadata",
                "Current Session",
                "Login Data",
                "Login Data-journal",
                "Login Data For Account",
                "Bookmarks",
                "Preferences",
                "Favicons",
            ] {
                touch(&d.join(f), 10);
            }
            touch(&d.join("Network/Cookies"), 10);
            touch(&d.join("Sessions/Session_1"), 10);
        }
        // Firefox
        let ff = sup.join("Firefox/Profiles/abc.default-release");
        for f in [
            "places.sqlite",
            "places.sqlite-wal",
            "places.sqlite-shm",
            "cookies.sqlite",
            "formhistory.sqlite",
            "sessionstore.jsonlz4",
            "logins.json",
            "key4.db",
            "cert9.db",
            "signons.sqlite",
            "prefs.js",
        ] {
            touch(&ff.join(f), 10);
        }
        touch(&ff.join("sessionstore-backups/recovery.jsonlz4"), 10);
        // Brave sem perfil; Edge com perfil Default.
        fs::create_dir_all(sup.join("BraveSoftware/Brave-Browser/NativeMessagingHosts")).unwrap();
        touch(&sup.join("Microsoft Edge/Default/History"), 10);
        // Itens recentes
        let sfl = sup.join("com.apple.sharedfilelist");
        for f in [
            "com.apple.LSSharedFileList.RecentApplications.sfl3",
            "com.apple.LSSharedFileList.RecentDocuments.sfl3",
            "com.apple.LSSharedFileList.FavoriteItems.sfl3",
            "com.apple.LSSharedFileList.ProjectsItems.sfl3",
            "outra.coisa.sfl3",
        ] {
            touch(&sfl.join(f), 10);
        }
        touch(&sfl.join("com.apple.LSSharedFileList.ApplicationRecentDocuments/com.apple.preview.sfl3"), 10);
        touch(&sfl.join("com.apple.LSSharedFileList.ApplicationRecentDocuments/leia-me.txt"), 10);
        Fx { _tmp: tmp, home }
    }

    fn names(g: &Group) -> Vec<String> {
        g.items.iter().map(|i| i.name.clone()).collect()
    }

    fn group<'a>(gs: &'a [Group], id: &str) -> &'a Group {
        gs.iter().find(|g| g.id == id).unwrap_or_else(|| panic!("sem grupo {id}"))
    }

    #[test]
    fn closed_browsers_offer_unselected_trash_items() {
        let f = fixture();
        let gs = scan(&f.home, &HashSet::new(), &Progress::silent());
        let hist = group(&gs, "chrome:history");
        assert_eq!(hist.items.len(), 4, "History + History-journal em 2 perfis: {:?}", names(hist));
        assert!(hist.items.iter().all(|i| !i.selected && i.policy == Policy::MoveToTrash));
        assert!(hist.items.iter().any(|i| i.name == "History (Profile 1)"));
        let cookies = group(&gs, "chrome:cookies");
        assert_eq!(cookies.items.len(), 6, "{:?}", names(cookies));
        assert!(cookies.items.iter().any(|i| i.path.ends_with("Default/Network/Cookies")));
        assert_eq!(group(&gs, "chrome:forms").items.len(), 2);
        assert!(group(&gs, "chrome:forms").items.iter().all(|i| i.note.as_deref() == Some(NOTE_CHROMIUM_AUTOFILL)));
        assert_eq!(group(&gs, "chrome:downloads").items.len(), 2);
        assert_eq!(group(&gs, "chrome:sessions").items.len(), 4);
        // Firefox
        assert_eq!(group(&gs, "firefox:history").items.len(), 3);
        assert!(group(&gs, "firefox:history").items.iter().all(|i| i.note.as_deref() == Some(NOTE_FIREFOX_BOOKMARKS)));
        assert_eq!(group(&gs, "firefox:cookies").items.len(), 1);
        assert_eq!(group(&gs, "firefox:forms").items.len(), 1);
        assert_eq!(group(&gs, "firefox:sessions").items.len(), 2, "sessionstore.jsonlz4 e sessionstore-backups");
        // Perfil único: nomes sem sufixo.
        assert_eq!(group(&gs, "edge:history").items[0].name, "History");
        // Brave sem perfil e sem dados: nenhum grupo.
        assert!(gs.iter().all(|g| !g.id.starts_with("brave:")));
    }

    #[test]
    fn credentials_and_bookmarks_are_never_offered() {
        let f = fixture();
        let gs = scan(&f.home, &HashSet::new(), &Progress::silent());
        for g in &gs {
            for i in &g.items {
                let name = i.path.file_name().unwrap().to_string_lossy().to_lowercase();
                for bad in [
                    "login data",
                    "logins.json",
                    "key4.db",
                    "cert9.db",
                    "signons",
                    "bookmarks",
                    "preferences",
                    "prefs.js",
                    "favicons",
                ] {
                    assert!(!name.contains(bad), "{} apareceu em {}", i.path.display(), g.id);
                }
            }
        }
        for n in [
            "Login Data",
            "Login Data-journal",
            "Login Data For Account",
            "logins.json",
            "logins-backup.json",
            "key4.db",
            "key3.db",
            "cert9.db",
            "signons.sqlite",
            "Keychain",
            "passwords.txt",
        ] {
            assert!(is_credential(n), "{n}");
        }
        for n in ["History", "Cookies", "Web Data", "places.sqlite", "cookies.sqlite", "formhistory.sqlite"] {
            assert!(!is_credential(n), "{n}");
        }
    }

    #[test]
    fn running_browser_gets_placeholder_groups_without_items() {
        let f = fixture();
        let running: HashSet<String> = ["com.google.Chrome".to_string()].into();
        let gs = scan(&f.home, &running, &Progress::silent());
        let hist = group(&gs, "chrome:history");
        assert!(hist.items.is_empty());
        assert_eq!(hist.description, "Feche o Google Chrome para limpar.");
        assert!(group(&gs, "edge:history").items.len() == 1, "outros navegadores seguem disponíveis");
        let st = browser_states(&f.home, &running);
        let chrome = st.iter().find(|s| s.id == "chrome").unwrap();
        assert!(chrome.present && chrome.running);
        assert!(st.iter().find(|s| s.id == "brave").is_some_and(|s| !s.present && !s.running));
    }

    #[test]
    fn instance_lock_marks_browser_as_running() {
        let f = fixture();
        let chrome = &BROWSERS[0];
        let lock = f.home.join("Library/Application Support/Google/Chrome/SingletonLock");
        std::os::unix::fs::symlink(format!("Mac-{}", std::process::id()), &lock).unwrap();
        assert!(is_running(&f.home, chrome, &HashSet::new()));
        fs::remove_file(&lock).unwrap();
        std::os::unix::fs::symlink("Mac-999999999", &lock).unwrap();
        assert!(!is_running(&f.home, chrome, &HashSet::new()), "pid inexistente");
        fs::remove_file(&lock).unwrap();
        assert!(!is_running(&f.home, chrome, &HashSet::new()));

        let ff = &BROWSERS[3];
        let flock = f.home.join("Library/Application Support/Firefox/Profiles/abc.default-release/lock");
        std::os::unix::fs::symlink(format!("127.0.0.1:+{}", std::process::id()), &flock).unwrap();
        assert!(is_running(&f.home, ff, &HashSet::new()));
    }

    #[test]
    fn recent_items_cover_only_recent_lists() {
        let f = fixture();
        let gs = scan(&f.home, &HashSet::new(), &Progress::silent());
        let r = group(&gs, "recent");
        let mut got: Vec<_> = r.items.iter().map(|i| i.name.as_str()).collect();
        got.sort_unstable();
        assert_eq!(
            got,
            [
                "com.apple.LSSharedFileList.RecentApplications.sfl3",
                "com.apple.LSSharedFileList.RecentDocuments.sfl3",
                "com.apple.preview.sfl3",
            ],
            "favoritos do Finder e outros .sfl ficam de fora"
        );
        assert!(r.items.iter().all(|i| i.selected && i.policy == Policy::MoveToTrash));
    }

    #[test]
    fn every_offered_item_passes_the_guard() {
        let f = fixture();
        let guard = Guard::new(&f.home);
        let gs = scan(&f.home, &HashSet::new(), &Progress::silent());
        let total: usize = gs.iter().map(|g| g.items.len()).sum();
        assert!(total > 20);
        for g in &gs {
            for i in &g.items {
                assert!(guard.check(&i.path, &i.policy).is_ok(), "{} recusado pelo Guard", i.path.display());
            }
        }
    }

    #[test]
    fn browser_is_found_from_item_path() {
        let f = fixture();
        let p = f.home.join("Library/Application Support/Google/Chrome/Default/History");
        assert_eq!(browser_for_path(&f.home, &p).unwrap().id, "chrome");
        let p = f.home.join("Library/Application Support/Firefox/Profiles/x/places.sqlite");
        assert_eq!(browser_for_path(&f.home, &p).unwrap().id, "firefox");
        assert!(
            browser_for_path(&f.home, &f.home.join("Library/Application Support/com.apple.sharedfilelist/a.sfl3"))
                .is_none()
        );
        assert!(browser_for_path(&f.home, Path::new("/etc/passwd")).is_none());
    }

    #[test]
    fn symlinked_profile_data_is_skipped() {
        let f = fixture();
        let d = f.home.join("Library/Application Support/Google/Chrome/Default");
        fs::remove_file(d.join("History")).unwrap();
        let target = f.home.join("alvo.txt");
        touch(&target, 5);
        std::os::unix::fs::symlink(&target, d.join("History")).unwrap();
        let gs = scan(&f.home, &HashSet::new(), &Progress::silent());
        assert!(group(&gs, "chrome:history").items.iter().all(|i| !i.path.ends_with("Default/History")));
        assert!(target.exists());
    }

    #[test]
    fn no_data_anywhere_gives_only_an_empty_recent_group() {
        let tmp = tempfile::tempdir().unwrap();
        let gs = scan(tmp.path(), &HashSet::new(), &Progress::silent());
        assert_eq!(gs.len(), 1);
        assert!(gs[0].items.is_empty());
    }
}
