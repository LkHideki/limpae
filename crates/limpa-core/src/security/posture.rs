//! Security check (read-only): Gatekeeper, SIP, FileVault, firewall, XProtect definitions and
//! automatic security updates. Nothing is changed: the "fix" only opens the right System Settings pane.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::run_capture;

const TIMEOUT: Duration = Duration::from_secs(3);
const SPCTL: &str = "/usr/sbin/spctl";
const CSRUTIL: &str = "/usr/bin/csrutil";
const FDESETUP: &str = "/usr/bin/fdesetup";
const SOCKETFILTERFW: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";
const XPROTECT_PLIST: &str = "/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist";
const XPROTECT_PLIST_OLD: &str = "/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist";
const SOFTWAREUPDATE_PLIST: &str = "/Library/Preferences/com.apple.SoftwareUpdate.plist";

/// Definitions older than this get flagged.
const XPROTECT_MAX_AGE_DAYS: i64 = 45;

const URL_SECURITY: &str = "x-apple.systempreferences:com.apple.preference.security?General";
const URL_FILEVAULT: &str = "x-apple.systempreferences:com.apple.preference.security?FileVault";
const URL_FIREWALL: &str = "x-apple.systempreferences:com.apple.Network-Settings.extension";
const URL_UPDATES: &str = "x-apple.systempreferences:com.apple.Software-Update-Settings.extension";

pub const ID_GATEKEEPER: &str = "gatekeeper";
pub const ID_SIP: &str = "sip";
pub const ID_FILEVAULT: &str = "filevault";
pub const ID_FIREWALL: &str = "firewall";
pub const ID_XPROTECT: &str = "xprotect";
pub const ID_UPDATES: &str = "updates";

/// System Settings pane that resolves the check. Fixed constants: the UI only sends the id.
/// `None` when there is nothing to do in Settings (SIP can only be changed from Recovery Mode).
pub fn fix_url(check_id: &str) -> Option<&'static str> {
    match check_id {
        ID_GATEKEEPER => Some(URL_SECURITY),
        ID_FILEVAULT => Some(URL_FILEVAULT),
        ID_FIREWALL => Some(URL_FIREWALL),
        ID_XPROTECT | ID_UPDATES => Some(URL_UPDATES),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    pub label: String,
    pub settings_url: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub title: String,
    /// `None` = could not be determined.
    pub ok: Option<bool>,
    pub detail: String,
    pub fix: Option<Fix>,
}

impl Check {
    fn new(id: &'static str, title: &str, ok: Option<bool>, detail: impl Into<String>) -> Self {
        // The fix only shows up when something is not right or could not be confirmed.
        let fix = if ok == Some(true) {
            None
        } else {
            fix_url(id).map(|settings_url| Fix { label: "Abrir Ajustes".into(), settings_url })
        };
        Self { id, title: title.into(), ok, detail: detail.into(), fix }
    }
}

// ---------- Parsers (tested with sample outputs in PT and EN) ----------

fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).map(str::to_owned).collect()
}

const NEGATIVE: &[&str] = &[
    "disabled",
    "off",
    "desativado",
    "desativada",
    "desativados",
    "desativadas",
    "desabilitado",
    "desabilitada",
    "desligado",
    "desligada",
    "inativo",
    "inativa",
];
const POSITIVE: &[&str] = &[
    "enabled",
    "on",
    "ativado",
    "ativada",
    "ativados",
    "ativadas",
    "habilitado",
    "habilitada",
    "ligado",
    "ligada",
    "ativo",
    "ativa",
];

/// Parses "enabled/disabled", "On/Off" and Portuguese equivalents. Negatives win: "not enabled" is false.
pub fn parse_toggle(text: &str) -> Option<bool> {
    let toks = tokens(text);
    let negated = |i: usize| i > 0 && matches!(toks[i - 1].as_str(), "not" | "nao" | "não");
    if toks.iter().any(|t| NEGATIVE.contains(&t.as_str())) {
        return Some(false);
    }
    let pos = toks.iter().enumerate().filter(|(_, t)| POSITIVE.contains(&t.as_str())).map(|(i, _)| i);
    let mut found = None;
    for i in pos {
        if negated(i) {
            return Some(false);
        }
        found = Some(true);
    }
    found
}

pub fn parse_gatekeeper(text: &str) -> Option<bool> {
    parse_toggle(text)
}

/// `Some(true)` only for a plain "enabled"; a custom configuration counts as weakened.
pub fn parse_sip(text: &str) -> (Option<bool>, bool) {
    let custom = text.to_lowercase().contains("custom") || text.to_lowercase().contains("personaliz");
    match parse_toggle(text) {
        Some(true) if custom => (Some(false), true),
        other => (other, custom),
    }
}

/// `(ok, in_progress)`. Encryption in progress is neither "on" nor "off".
pub fn parse_filevault(text: &str) -> (Option<bool>, bool) {
    let low = text.to_lowercase();
    if low.contains("in progress") || low.contains("andamento") || low.contains("progresso") {
        return (None, true);
    }
    (parse_toggle(text), false)
}

/// Numeric state from `socketfilterfw --getglobalstate`: 0 off, 1 on, 2 blocks all connections.
pub fn parse_firewall(text: &str) -> (Option<bool>, Option<u8>) {
    let low = text.to_lowercase();
    if let Some((pos, len)) = low.find("state").map(|p| (p, 5)).or_else(|| low.find("estado").map(|p| (p, 6))) {
        let rest = low[pos + len..].trim_start_matches([' ', '=', ':']);
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(n) = digits.parse::<u8>() {
            return (Some(n >= 1), Some(n));
        }
    }
    (parse_toggle(text), None)
}

// ---------- Sources read from disk ----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XProtectInfo {
    pub version: String,
    /// Last modification of `Info.plist`, in Unix seconds.
    pub updated: Option<i64>,
}

pub fn read_xprotect(primary: &Path, fallback: &Path) -> Option<XProtectInfo> {
    [primary, fallback].into_iter().find_map(|p| {
        let value = plist::Value::from_file(p).ok()?;
        let version = value.as_dictionary()?.get("CFBundleShortVersionString")?.as_string()?.trim().to_owned();
        if version.is_empty() {
            return None;
        }
        let updated = std::fs::metadata(p)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        Some(XProtectInfo { version, updated })
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdatePrefs {
    pub critical: bool,
    pub config: bool,
    pub macos: bool,
}

impl Default for UpdatePrefs {
    /// macOS default when the key does not exist: everything on.
    fn default() -> Self {
        Self { critical: true, config: true, macos: true }
    }
}

pub fn parse_update_prefs(dict: &plist::Dictionary) -> UpdatePrefs {
    let flag = |k: &str| dict.get(k).and_then(|v| v.as_boolean());
    let d = UpdatePrefs::default();
    UpdatePrefs {
        critical: flag("CriticalUpdateInstall").unwrap_or(d.critical),
        config: flag("ConfigDataInstall").unwrap_or(d.config),
        macos: flag("AutomaticallyInstallMacOSUpdates").unwrap_or(d.macos),
    }
}

/// `None` when the file exists but could not be read; a missing file takes the macOS default.
pub fn read_update_prefs(path: &Path) -> Option<UpdatePrefs> {
    if !path.exists() {
        return Some(UpdatePrefs::default());
    }
    let value = plist::Value::from_file(path).ok()?;
    Some(parse_update_prefs(value.as_dictionary()?))
}

// ---------- Assembling the checks ----------

/// Civil date (UTC) of a Unix instant, formatted dd/mm/yyyy.
pub fn fmt_date(unix: i64) -> String {
    let z = unix.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{day:02}/{month:02}/{year}")
}

fn gatekeeper_check(text: Option<&str>) -> Check {
    let title = "Gatekeeper";
    match text.and_then(parse_gatekeeper) {
        Some(true) => {
            Check::new(ID_GATEKEEPER, title, Some(true), "O Gatekeeper está ativo e confere os apps antes de abri-los.")
        }
        Some(false) => Check::new(
            ID_GATEKEEPER,
            title,
            Some(false),
            "O Gatekeeper está desativado: apps não verificados abrem sem nenhum aviso.",
        ),
        None => Check::new(ID_GATEKEEPER, title, None, "Não foi possível consultar o Gatekeeper."),
    }
}

fn sip_check(text: Option<&str>) -> Check {
    let title = "Proteção de Integridade do Sistema (SIP)";
    let Some(text) = text else {
        return Check::new(ID_SIP, title, None, "Não foi possível consultar o SIP.");
    };
    match parse_sip(text) {
        (Some(true), _) => Check::new(ID_SIP, title, Some(true), "O SIP está ativo e protege os arquivos do sistema."),
        (Some(false), true) => Check::new(
            ID_SIP,
            title,
            Some(false),
            "O SIP está com configuração personalizada, então parte da proteção está desligada. Só o Modo de Recuperação muda isso.",
        ),
        (Some(false), false) => Check::new(
            ID_SIP,
            title,
            Some(false),
            "O SIP está desativado. Só o Modo de Recuperação (comando csrutil enable) volta a ativá-lo.",
        ),
        (None, _) => Check::new(ID_SIP, title, None, "Não foi possível consultar o SIP."),
    }
}

fn filevault_check(text: Option<&str>) -> Check {
    let title = "Criptografia do disco (FileVault)";
    let Some(text) = text else {
        return Check::new(ID_FILEVAULT, title, None, "Não foi possível consultar o FileVault.");
    };
    match parse_filevault(text) {
        (_, true) => Check::new(ID_FILEVAULT, title, None, "A criptografia do disco está em andamento."),
        (Some(true), _) => Check::new(ID_FILEVAULT, title, Some(true), "O disco está criptografado com o FileVault."),
        (Some(false), _) => Check::new(
            ID_FILEVAULT,
            title,
            Some(false),
            "O disco não está criptografado: quem tiver o Mac em mãos pode ler os arquivos.",
        ),
        (None, _) => Check::new(ID_FILEVAULT, title, None, "Não foi possível consultar o FileVault."),
    }
}

fn firewall_check(text: Option<&str>) -> Check {
    let title = "Firewall";
    let Some(text) = text else {
        return Check::new(ID_FIREWALL, title, None, "Não foi possível consultar o firewall.");
    };
    match parse_firewall(text) {
        (Some(true), Some(2)) => Check::new(
            ID_FIREWALL,
            title,
            Some(true),
            "O firewall está ligado e bloqueia todas as conexões de entrada.",
        ),
        (Some(true), _) => Check::new(ID_FIREWALL, title, Some(true), "O firewall está ligado."),
        (Some(false), _) => Check::new(
            ID_FIREWALL,
            title,
            Some(false),
            "O firewall está desligado: apps podem aceitar conexões de entrada sem filtro.",
        ),
        (None, _) => Check::new(ID_FIREWALL, title, None, "Não foi possível consultar o firewall."),
    }
}

fn xprotect_check(info: Option<&XProtectInfo>, now: i64) -> Check {
    let title = "Proteção integrada do macOS (XProtect)";
    let Some(info) = info else {
        return Check::new(ID_XPROTECT, title, None, "Não foi possível ler a versão das definições do XProtect.");
    };
    let Some(updated) = info.updated else {
        return Check::new(ID_XPROTECT, title, None, format!("Definições na versão {}.", info.version));
    };
    let days = ((now - updated) / 86_400).max(0);
    let when = format!("Definições na versão {}, atualizadas em {} ({}).", info.version, fmt_date(updated), ago(days));
    if days <= XPROTECT_MAX_AGE_DAYS {
        Check::new(ID_XPROTECT, title, Some(true), when)
    } else {
        Check::new(
            ID_XPROTECT,
            title,
            Some(false),
            format!("{when} Estão desatualizadas: verifique as atualizações de segurança."),
        )
    }
}

fn ago(days: i64) -> String {
    match days {
        0 => "hoje".into(),
        1 => "há 1 dia".into(),
        n => format!("há {n} dias"),
    }
}

fn updates_check(prefs: Option<UpdatePrefs>) -> Check {
    let title = "Atualizações automáticas de segurança";
    let Some(p) = prefs else {
        return Check::new(ID_UPDATES, title, None, "Não foi possível ler as preferências de atualização.");
    };
    let mut off = Vec::new();
    if !p.critical {
        off.push("arquivos de segurança e respostas rápidas");
    }
    if !p.config {
        off.push("dados de configuração do sistema");
    }
    if off.is_empty() {
        let tail = if p.macos {
            "As atualizações do macOS também são instaladas sozinhas."
        } else {
            "As atualizações do macOS ficam para você instalar."
        };
        Check::new(
            ID_UPDATES,
            title,
            Some(true),
            format!("Respostas rápidas de segurança e dados do sistema são instalados sozinhos. {tail}"),
        )
    } else {
        Check::new(
            ID_UPDATES,
            title,
            Some(false),
            format!("Instalação automática desligada para: {}.", off.join(" e ")),
        )
    }
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Runs all the checks. The four external commands run in parallel, each with a timeout.
pub fn run_checks() -> Vec<Check> {
    let out = |program: &'static str, args: &'static [&'static str]| {
        move || {
            run_capture(program, args, TIMEOUT).map(|c| if c.stdout.trim().is_empty() { c.stderr } else { c.stdout })
        }
    };
    let (spctl, csr, fde, fw) = std::thread::scope(|s| {
        let a = s.spawn(out(SPCTL, &["--status"]));
        let b = s.spawn(out(CSRUTIL, &["status"]));
        let c = s.spawn(out(FDESETUP, &["status"]));
        let d = s.spawn(out(SOCKETFILTERFW, &["--getglobalstate"]));
        (a.join().ok().flatten(), b.join().ok().flatten(), c.join().ok().flatten(), d.join().ok().flatten())
    });
    let xprotect = read_xprotect(Path::new(XPROTECT_PLIST), Path::new(XPROTECT_PLIST_OLD));
    let prefs = read_update_prefs(Path::new(SOFTWAREUPDATE_PLIST));
    vec![
        gatekeeper_check(spctl.as_deref()),
        sip_check(csr.as_deref()),
        filevault_check(fde.as_deref()),
        firewall_check(fw.as_deref()),
        xprotect_check(xprotect.as_ref(), now_unix()),
        updates_check(prefs),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_en_and_pt() {
        assert_eq!(parse_toggle("assessments enabled"), Some(true));
        assert_eq!(parse_toggle("assessments disabled"), Some(false));
        assert_eq!(parse_toggle("FileVault is On."), Some(true));
        assert_eq!(parse_toggle("FileVault is Off."), Some(false));
        assert_eq!(parse_toggle("As avaliações estão ativadas"), Some(true));
        assert_eq!(parse_toggle("O FileVault está ativado no Mac."), Some(true));
        assert_eq!(parse_toggle("O FileVault está ativado."), Some(true));
        assert_eq!(parse_toggle("O FileVault está desativado."), Some(false));
        assert_eq!(parse_toggle("Gatekeeper desabilitado"), Some(false));
        assert_eq!(parse_toggle("Gatekeeper habilitado"), Some(true));
        assert_eq!(parse_toggle("is not enabled"), Some(false));
        assert_eq!(parse_toggle("O firewall está desligado"), Some(false));
        assert_eq!(parse_toggle(""), None);
        assert_eq!(parse_toggle("algo inesperado"), None);
    }

    #[test]
    fn sip_outputs() {
        assert_eq!(parse_sip("System Integrity Protection status: enabled.\n"), (Some(true), false));
        assert_eq!(
            parse_sip(
                "System Integrity Protection status: disabled.\n\nThis is an unsupported configuration, likely to break in the future and leave your machine in an unknown state."
            ),
            (Some(false), false)
        );
        assert_eq!(
            parse_sip(
                "System Integrity Protection status: enabled (Custom Configuration).\n\nConfiguration:\n\tApple Internal: disabled"
            ),
            (Some(false), true)
        );
        assert_eq!(parse_sip("Status da Proteção de Integridade do Sistema: ativado."), (Some(true), false));
        assert_eq!(parse_sip("Status da Proteção de Integridade do Sistema: desativado."), (Some(false), false));
        assert_eq!(parse_sip("???"), (None, false));
    }

    #[test]
    fn filevault_outputs() {
        assert_eq!(parse_filevault("FileVault is On.\n"), (Some(true), false));
        assert_eq!(parse_filevault("FileVault is Off.\n"), (Some(false), false));
        assert_eq!(parse_filevault("Encryption in progress: Percent completed = 20.13"), (None, true));
        assert_eq!(parse_filevault("O FileVault está desativado."), (Some(false), false));
        assert_eq!(parse_filevault("Criptografia em andamento"), (None, true));
        assert_eq!(parse_filevault("Error: could not connect"), (None, false));
    }

    #[test]
    fn firewall_outputs() {
        assert_eq!(parse_firewall("Firewall is enabled. (State = 1)"), (Some(true), Some(1)));
        assert_eq!(parse_firewall("Firewall is disabled. (State = 0)"), (Some(false), Some(0)));
        assert_eq!(
            parse_firewall("Firewall is set to block all non-essential incoming connections. (State = 2)"),
            (Some(true), Some(2))
        );
        assert_eq!(parse_firewall("O firewall está ativado. (Estado = 1)"), (Some(true), Some(1)));
        assert_eq!(parse_firewall("O firewall está desativado."), (Some(false), None));
        assert_eq!(parse_firewall(""), (None, None));
    }

    #[test]
    fn checks_from_outputs() {
        let c = gatekeeper_check(Some("assessments disabled"));
        assert_eq!(c.ok, Some(false));
        assert_eq!(c.fix.as_ref().unwrap().settings_url, URL_SECURITY);
        let c = gatekeeper_check(Some("assessments enabled"));
        assert_eq!(c.ok, Some(true));
        assert!(c.fix.is_none(), "sem conserto quando está tudo certo");
        assert_eq!(gatekeeper_check(None).ok, None);
        assert!(sip_check(Some("System Integrity Protection status: disabled.")).fix.is_none(), "SIP não tem painel");
        assert_eq!(filevault_check(Some("FileVault is Off.")).fix.unwrap().settings_url, URL_FILEVAULT);
        assert_eq!(firewall_check(Some("Firewall is disabled. (State = 0)")).ok, Some(false));
        assert_eq!(firewall_check(Some("garbage")).ok, None);
    }

    #[test]
    fn xprotect_age() {
        let now = 1_800_000_000;
        let fresh = XProtectInfo { version: "5368".into(), updated: Some(now - 13 * 86_400) };
        let c = xprotect_check(Some(&fresh), now);
        assert_eq!(c.ok, Some(true));
        assert!(c.detail.contains("5368") && c.detail.contains("há 13 dias"), "{}", c.detail);
        let old = XProtectInfo { version: "5300".into(), updated: Some(now - 90 * 86_400) };
        let c = xprotect_check(Some(&old), now);
        assert_eq!(c.ok, Some(false));
        assert_eq!(c.fix.unwrap().settings_url, URL_UPDATES);
        assert_eq!(xprotect_check(None, now).ok, None);
        assert_eq!(c.title, "Proteção integrada do macOS (XProtect)");
    }

    #[test]
    fn dates_are_formatted() {
        assert_eq!(fmt_date(0), "01/01/1970");
        assert_eq!(fmt_date(1_792_192_231), "16/10/2026");
        assert_eq!(fmt_date(951_782_400), "29/02/2000");
    }

    #[test]
    fn update_prefs_missing_keys_use_macos_default() {
        let empty = plist::Dictionary::new();
        assert_eq!(parse_update_prefs(&empty), UpdatePrefs { critical: true, config: true, macos: true });
        let mut d = plist::Dictionary::new();
        d.insert("CriticalUpdateInstall".into(), plist::Value::Boolean(false));
        d.insert("AutomaticallyInstallMacOSUpdates".into(), plist::Value::Boolean(false));
        let p = parse_update_prefs(&d);
        assert_eq!(p, UpdatePrefs { critical: false, config: true, macos: false });
        let c = updates_check(Some(p));
        assert_eq!(c.ok, Some(false));
        assert!(c.detail.contains("respostas rápidas"), "{}", c.detail);
        assert_eq!(updates_check(Some(UpdatePrefs::default())).ok, Some(true));
        assert_eq!(updates_check(None).ok, None);
    }

    #[test]
    fn update_prefs_file_states() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_update_prefs(&dir.path().join("ausente.plist")), Some(UpdatePrefs::default()));
        let bad = dir.path().join("ruim.plist");
        std::fs::write(&bad, b"nao e plist").unwrap();
        assert_eq!(read_update_prefs(&bad), None);
        let good = dir.path().join("ok.plist");
        let mut d = plist::Dictionary::new();
        d.insert("ConfigDataInstall".into(), plist::Value::Boolean(false));
        plist::Value::Dictionary(d).to_file_xml(&good).unwrap();
        assert!(!read_update_prefs(&good).unwrap().config);
    }

    #[test]
    fn xprotect_plist_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("Info.plist");
        let mut d = plist::Dictionary::new();
        d.insert("CFBundleShortVersionString".into(), plist::Value::String("5368".into()));
        plist::Value::Dictionary(d).to_file_xml(&p).unwrap();
        let info = read_xprotect(&dir.path().join("nada.plist"), &p).unwrap();
        assert_eq!(info.version, "5368");
        assert!(info.updated.is_some());
        assert!(read_xprotect(&dir.path().join("a"), &dir.path().join("b")).is_none());
    }

    #[test]
    fn fix_urls_are_fixed_constants() {
        for id in [ID_GATEKEEPER, ID_FILEVAULT, ID_FIREWALL, ID_XPROTECT, ID_UPDATES] {
            assert!(fix_url(id).unwrap().starts_with("x-apple.systempreferences:"), "{id}");
        }
        assert_eq!(fix_url(ID_SIP), None);
        assert_eq!(fix_url("https://evil.example"), None);
    }

    #[test]
    fn real_checks_always_return_six_entries() {
        let checks = run_checks();
        let ids: Vec<_> = checks.iter().map(|c| c.id).collect();
        assert_eq!(ids, [ID_GATEKEEPER, ID_SIP, ID_FILEVAULT, ID_FIREWALL, ID_XPROTECT, ID_UPDATES]);
        for c in &checks {
            assert!(!c.detail.is_empty());
        }
    }
}
