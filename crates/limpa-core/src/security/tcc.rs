//! Permissões de apps (TCC): leitura do banco com `sqlite3 -readonly` e revogação com `tccutil reset`.
//!
//! O banco do usuário exige Acesso Total ao Disco. O banco do sistema (Acessibilidade, Gravação de tela,
//! Monitoramento de entrada, Acesso Total ao Disco) também é lido quando acessível; se não for, é ignorado.
//! O serviço e o bundle id de uma revogação vêm sempre desta leitura (nunca da interface) e são revalidados.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use super::run_capture;

const SQLITE3: &str = "/usr/bin/sqlite3";
const TCCUTIL: &str = "/usr/bin/tccutil";
const READ_TIMEOUT: Duration = Duration::from_secs(4);
const RESET_TIMEOUT: Duration = Duration::from_secs(5);
const SYSTEM_DB: &str = "/Library/Application Support/com.apple.TCC/TCC.db";

/// Serviços exibidos: (nome aceito pelo `tccutil`, título em português). Lista fechada: nada fora dela é lido nem
/// revogado.
pub const SERVICES: &[(&str, &str)] = &[
    ("Camera", "Câmera"),
    ("Microphone", "Microfone"),
    ("ScreenCapture", "Gravação de tela"),
    ("Accessibility", "Acessibilidade"),
    ("ListenEvent", "Monitoramento de entrada"),
    ("SystemPolicyAllFiles", "Acesso Total ao Disco"),
    ("AddressBook", "Contatos"),
    ("Calendar", "Calendários"),
    ("Reminders", "Lembretes"),
    ("Photos", "Fotos"),
    ("Location", "Localização"),
];

pub fn service_title(service: &str) -> Option<&'static str> {
    SERVICES.iter().find(|(s, _)| *s == service).map(|(_, t)| *t)
}

/// Nome interno do serviço na tabela `access`.
fn db_name(service: &str) -> String {
    format!("kTCCService{service}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    Allowed,
    /// Acesso limitado (ex.: Fotos selecionadas).
    Limited,
    Denied,
}

impl Auth {
    pub fn granted(self) -> bool {
        self != Self::Denied
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Um dos nomes de `SERVICES`.
    pub service: &'static str,
    pub client: String,
    pub auth: Auth,
    /// Última alteração, segundos Unix.
    pub modified: Option<i64>,
    /// Veio do banco do sistema.
    pub system: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    NeedsFda,
    Failed(String),
}

/// `^[A-Za-z0-9.-]+$`, sem começar por hífen (nunca vira opção do `tccutil`).
pub fn valid_bundle_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

pub fn user_db(home: &Path) -> PathBuf {
    home.join("Library/Application Support/com.apple.TCC/TCC.db")
}

#[derive(Deserialize)]
struct Row {
    service: String,
    client: String,
    client_type: Option<i64>,
    auth_value: Option<i64>,
    last_modified: Option<i64>,
}

/// Linhas do JSON do `sqlite3`, já filtradas: serviço da lista, cliente por bundle id válido, estado conhecido.
pub fn parse_rows(json: &str, system: bool) -> Vec<Entry> {
    if json.trim().is_empty() {
        return Vec::new();
    }
    let rows: Vec<Row> = serde_json::from_str(json).unwrap_or_default();
    rows.into_iter()
        .filter_map(|r| {
            if r.client_type.unwrap_or(0) != 0 || !valid_bundle_id(&r.client) {
                return None;
            }
            let short = r.service.strip_prefix("kTCCService")?;
            let (service, _) = SERVICES.iter().find(|(s, _)| *s == short)?;
            let auth = match r.auth_value? {
                0 => Auth::Denied,
                2 => Auth::Allowed,
                3 => Auth::Limited,
                _ => return None,
            };
            Some(Entry { service, client: r.client, auth, modified: r.last_modified, system })
        })
        .collect()
}

fn query() -> String {
    let list: Vec<String> = SERVICES.iter().map(|(s, _)| format!("'{}'", db_name(s))).collect();
    format!(
        "SELECT service, client, client_type, auth_value, last_modified FROM access WHERE client_type = 0 AND service IN ({})",
        list.join(", ")
    )
}

fn denied(stderr: &str) -> bool {
    let low = stderr.to_lowercase();
    ["authorization denied", "not authorized", "operation not permitted", "unable to open", "permission denied"]
        .iter()
        .any(|m| low.contains(m))
}

/// Lê um banco TCC. Arquivo ausente = sem entradas.
pub fn read_db(path: &Path, system: bool) -> Result<Vec<Entry>, ReadError> {
    if std::fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Ok(Vec::new());
    }
    let Some(path_str) = path.to_str() else { return Err(ReadError::Failed("caminho inválido".into())) };
    let sql = query();
    let Some(out) = run_capture(SQLITE3, &["-readonly", "-json", path_str, &sql], READ_TIMEOUT) else {
        return Err(ReadError::Failed("o sqlite3 não respondeu a tempo".into()));
    };
    if !out.ok {
        return Err(if denied(&out.stderr) {
            ReadError::NeedsFda
        } else {
            ReadError::Failed(out.stderr.trim().to_owned())
        });
    }
    Ok(parse_rows(&out.stdout, system))
}

/// Entradas dos dois bancos, sem repetição de (serviço, app); o do usuário vem primeiro. Se o do usuário não puder
/// ser lido, nada é devolvido; falha no do sistema é ignorada.
pub fn read_all(home: &Path) -> Result<Vec<Entry>, ReadError> {
    read_all_from(&user_db(home), Path::new(SYSTEM_DB))
}

pub fn read_all_from(user: &Path, system: &Path) -> Result<Vec<Entry>, ReadError> {
    let mut entries = read_db(user, false)?;
    if let Ok(sys) = read_db(system, true) {
        entries.extend(sys);
    }
    let mut seen = HashSet::new();
    entries.retain(|e| seen.insert((e.service, e.client.clone())));
    Ok(entries)
}

/// Revoga com `tccutil reset <Serviço> <bundle id>`. Valida os dois argumentos antes de executar.
pub fn revoke(service: &str, bundle_id: &str) -> Result<(), String> {
    if service_title(service).is_none() {
        return Err("Serviço de permissão desconhecido.".into());
    }
    if !valid_bundle_id(bundle_id) {
        return Err("Identificador de app inválido.".into());
    }
    let Some(out) = run_capture(TCCUTIL, &["reset", service, bundle_id], RESET_TIMEOUT) else {
        return Err("O tccutil não respondeu a tempo.".into());
    };
    if out.ok {
        Ok(())
    } else {
        let why = out.stderr.trim();
        Err(format!("O macOS recusou a revogação{}.", if why.is_empty() { String::new() } else { format!(": {why}") }))
    }
}

/// App instalado para um bundle id: (nome de exibição, caminho do `.app`). Usa o LaunchServices.
pub fn resolve_app(bundle_id: &str) -> Option<(String, PathBuf)> {
    let path = app_path(bundle_id)?;
    let name = plist::Value::from_file(path.join("Contents/Info.plist"))
        .ok()
        .and_then(|v| {
            let d = v.into_dictionary()?;
            ["CFBundleDisplayName", "CFBundleName"].iter().find_map(|k| {
                d.get(k).and_then(|v| v.as_string()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
            })
        })
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))?;
    Some((name, path))
}

#[cfg(target_os = "macos")]
fn app_path(bundle_id: &str) -> Option<PathBuf> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;

    autoreleasepool(|_| {
        let url =
            NSWorkspace::sharedWorkspace().URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))?;
        url.path().map(|p| PathBuf::from(p.to_string()))
    })
}

#[cfg(not(target_os = "macos"))]
fn app_path(_bundle_id: &str) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      {"service":"kTCCServiceCamera","client":"us.zoom.xos","client_type":0,"auth_value":2,"last_modified":1700000000},
      {"service":"kTCCServiceMicrophone","client":"us.zoom.xos","client_type":0,"auth_value":0,"last_modified":1700000001},
      {"service":"kTCCServicePhotos","client":"com.foo.app","client_type":0,"auth_value":3,"last_modified":1700000002},
      {"service":"kTCCServiceCamera","client":"/usr/bin/ssh","client_type":1,"auth_value":2,"last_modified":1},
      {"service":"kTCCServiceCamera","client":"-rf","client_type":0,"auth_value":2,"last_modified":1},
      {"service":"kTCCServiceCamera","client":"com.x y","client_type":0,"auth_value":2,"last_modified":1},
      {"service":"kTCCServiceAppleEvents","client":"com.bar.app","client_type":0,"auth_value":2,"last_modified":1},
      {"service":"kTCCServiceCalendar","client":"com.bar.app","client_type":0,"auth_value":1,"last_modified":1},
      {"service":"kTCCServiceCalendar","client":"com.bar.app","client_type":0,"auth_value":null,"last_modified":1}
    ]"#;

    #[test]
    fn rows_are_filtered_and_mapped() {
        let e = parse_rows(SAMPLE, false);
        let got: Vec<_> = e.iter().map(|x| (x.service, x.client.as_str(), x.auth)).collect();
        assert_eq!(
            got,
            [
                ("Camera", "us.zoom.xos", Auth::Allowed),
                ("Microphone", "us.zoom.xos", Auth::Denied),
                ("Photos", "com.foo.app", Auth::Limited),
            ]
        );
        assert!(e.iter().all(|x| !x.system));
        assert!(e[2].auth.granted() && !e[1].auth.granted());
        assert_eq!(e[0].modified, Some(1_700_000_000));
    }

    #[test]
    fn garbage_and_empty_output_give_nothing() {
        assert!(parse_rows("", false).is_empty());
        assert!(parse_rows("  \n", true).is_empty());
        assert!(parse_rows("not json", false).is_empty());
        assert!(parse_rows("{}", false).is_empty());
    }

    #[test]
    fn bundle_ids_are_validated() {
        assert!(valid_bundle_id("com.apple.Terminal"));
        assert!(valid_bundle_id("us.zoom.xos"));
        assert!(valid_bundle_id("com.foo-bar.App2"));
        for bad in ["", "-x", "com.foo bar", "com.foo;rm", "com/foo", "com.foo\n", "com.fóo", "a_b", "$(id)"] {
            assert!(!valid_bundle_id(bad), "{bad:?}");
        }
        assert!(!valid_bundle_id(&"a".repeat(256)));
    }

    #[test]
    fn revoke_refuses_unlisted_service_and_bad_bundle() {
        assert!(revoke("AppleEvents", "com.foo.app").is_err());
        assert!(revoke("All", "com.foo.app").is_err());
        assert!(revoke("Camera", "-a").is_err());
        assert!(revoke("Camera", "com.foo app").is_err());
        assert!(revoke("kTCCServiceCamera", "com.foo.app").is_err());
    }

    #[test]
    fn service_titles() {
        assert_eq!(service_title("Camera"), Some("Câmera"));
        assert_eq!(service_title("Nope"), None);
        assert!(query().contains("'kTCCServiceCamera'"));
    }

    #[cfg(target_os = "macos")]
    fn make_db(path: &Path, rows: &[(&str, &str, i64, i64)]) {
        let mut sql = String::from(
            "CREATE TABLE access (service TEXT NOT NULL, client TEXT NOT NULL, client_type INTEGER NOT NULL, auth_value INTEGER NOT NULL, auth_reason INTEGER, last_modified INTEGER NOT NULL DEFAULT 0);",
        );
        for (service, client, ct, auth) in rows {
            sql.push_str(&format!("INSERT INTO access (service, client, client_type, auth_value, last_modified) VALUES ('{service}', '{client}', {ct}, {auth}, 1700000000);"));
        }
        let out = run_capture(SQLITE3, &[path.to_str().unwrap(), &sql], Duration::from_secs(5)).unwrap();
        assert!(out.ok, "{}", out.stderr);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_a_real_sqlite_file_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user.db");
        let sys = dir.path().join("sys.db");
        make_db(&user, &[("kTCCServiceCamera", "us.zoom.xos", 0, 2), ("kTCCServiceCamera", "dup.app", 0, 2)]);
        make_db(&sys, &[("kTCCServiceAccessibility", "com.foo.app", 0, 2), ("kTCCServiceCamera", "dup.app", 0, 0)]);
        let before = std::fs::read(&user).unwrap();
        let all = read_all_from(&user, &sys).unwrap();
        let got: Vec<_> = all.iter().map(|e| (e.service, e.client.as_str(), e.system, e.auth)).collect();
        assert_eq!(
            got,
            [
                ("Camera", "us.zoom.xos", false, Auth::Allowed),
                ("Camera", "dup.app", false, Auth::Allowed),
                ("Accessibility", "com.foo.app", true, Auth::Allowed),
            ],
            "o banco do usuário vence a duplicata"
        );
        assert_eq!(std::fs::read(&user).unwrap(), before, "leitura não altera o banco");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn missing_user_db_is_empty_and_unreadable_one_needs_fda() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_all_from(&dir.path().join("x.db"), &dir.path().join("y.db")).unwrap(), Vec::new());
        let notdb = dir.path().join("lixo.db");
        std::fs::write(&notdb, b"isto nao e um banco sqlite").unwrap();
        assert!(matches!(read_db(&notdb, false), Err(ReadError::Failed(_))));
        let locked = dir.path().join("locked.db");
        make_db(&locked, &[("kTCCServiceCamera", "a.b", 0, 2)]);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let r = read_db(&locked, false);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(r, Err(ReadError::NeedsFda));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolves_installed_app_by_bundle_id() {
        let (name, path) = resolve_app("com.apple.finder").expect("Finder");
        assert_eq!(name, "Finder");
        assert!(path.ends_with("Finder.app"), "{path:?}");
        assert!(resolve_app("com.nao.existe.mesmo").is_none());
    }
}
