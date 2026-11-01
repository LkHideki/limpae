//! Mac health: a pure scoring function over cheap, already-gathered inputs, plus the cheap probes that feed it
//! (sysctl, and three short-lived system tools run with a timeout).
//!
//! # Weighting
//! The score starts at 100 and each problem subtracts a penalty; the result is clamped to 0..=100. A factor with
//! no problem produces nothing, and an input that is unknown (`None`) is never counted.
//!
//! | factor            | condition                                         | penalty | severity |
//! |-------------------|---------------------------------------------------|---------|----------|
//! | `disk`            | free < 5 % or < 5 GB                              | 50      | critical |
//! |                   | free < 10 % or < 10 GB                            | 30      | warn     |
//! |                   | free < 15 % or < 20 GB                            | 12      | warn     |
//! | `trash`           | >= 10 GB / >= 2 GB / >= 1 GB                      | 8 / 4 / 2 | warn / info / info |
//! | `fda`             | Full Disk Access not granted                      | 5       | info     |
//! | `smart_care`      | never, or > 30 days / > 14 days / > 7 days        | 8 / 8 / 4 / 2 | info / warn / info / info |
//! | `uptime`          | >= 30 days / >= 14 days                           | 8 / 4   | warn / info |
//! | `memory`          | pressure warning / critical                       | 12 / 25 | warn / critical |
//! | `gatekeeper`      | off                                               | 10      | warn     |
//! | `sip`             | off                                               | 15      | warn     |
//! | `filevault`       | off                                               | 5       | info     |
//!
//! Percentage thresholds for the disk only apply while free space is below 200 GB (9 % of a 4 TB disk is plenty).
//! GB are decimal, like Finder. Levels: >= 90 Excelente, >= 75 Boa, >= 60 Regular, >= 40 Requer atenção, below
//! that Crítica. Any `critical` factor caps the score at 59, so a Mac with a critical problem is never "Boa"
//! just because everything else is fine.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

const GB: u64 = 1_000_000_000;
/// Above this much free space the percentage rule for the disk is ignored.
const PLENTY_FREE: u64 = 200 * GB;
/// Score ceiling while a critical factor exists.
const CRITICAL_CAP: u8 = 59;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Level {
    #[serde(rename = "Excelente")]
    Excelente,
    #[serde(rename = "Boa")]
    Boa,
    #[serde(rename = "Regular")]
    Regular,
    #[serde(rename = "Requer atenção")]
    RequerAtencao,
    #[serde(rename = "Crítica")]
    Critica,
}

impl Level {
    pub fn from_score(score: u8) -> Self {
        match score {
            90.. => Self::Excelente,
            75..=89 => Self::Boa,
            60..=74 => Self::Regular,
            40..=59 => Self::RequerAtencao,
            _ => Self::Critica,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Excelente => "Excelente",
            Self::Boa => "Boa",
            Self::Regular => "Regular",
            Self::RequerAtencao => "Requer atenção",
            Self::Critica => "Crítica",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warn,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryPressure {
    Normal,
    Warning,
    Critical,
}

/// Where a recommendation button leads: a UI module id (`smart`, `trash`, `perf`...) or the pseudo module `fda`
/// (open the Full Disk Access pane of System Settings).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Action {
    pub label: &'static str,
    pub module: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Factor {
    pub id: &'static str,
    pub title: String,
    pub detail: String,
    pub severity: Severity,
    pub action: Option<Action>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Health {
    pub level: Level,
    pub score: u8,
    /// Only the factors that cost points, most severe first.
    pub factors: Vec<Factor>,
}

/// Everything `score` looks at. `None` = unknown, never counted (except `days_since_smart_care`, where `None`
/// means "never ran").
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    pub disk_total: u64,
    pub disk_free: u64,
    pub trash_bytes: Option<u64>,
    pub fda: bool,
    pub days_since_smart_care: Option<u32>,
    pub uptime_days: Option<f64>,
    pub memory: Option<MemoryPressure>,
    pub gatekeeper: Option<bool>,
    pub sip: Option<bool>,
    pub filevault: Option<bool>,
}

/// pt-BR decimal bytes, same rule as the UI (`format.js`): one decimal from MB up while the value is < 100.
pub fn fmt_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1000.0 && i < 4 {
        v /= 1000.0;
        i += 1;
    }
    if i >= 2 && (v * 10.0).round() / 10.0 >= 1000.0 && i < 4 {
        v /= 1000.0;
        i += 1;
    }
    let num = if i <= 1 || v >= 100.0 { format!("{v:.0}") } else { format!("{v:.1}").replace('.', ",") };
    let num = num.strip_suffix(",0").map_or(num.clone(), str::to_string);
    format!("{num} {}", UNITS[i])
}

struct Entry {
    penalty: u32,
    factor: Factor,
}

fn entry(
    penalty: u32,
    id: &'static str,
    severity: Severity,
    title: &str,
    detail: String,
    action: Option<(&'static str, &'static str)>,
) -> Entry {
    Entry {
        penalty,
        factor: Factor {
            id,
            title: title.into(),
            detail,
            severity,
            action: action.map(|(label, module)| Action { label, module }),
        },
    }
}

fn disk_entry(total: u64, free: u64) -> Option<Entry> {
    if total == 0 {
        return None;
    }
    let pct = free as f64 / total as f64 * 100.0;
    let by_pct = |limit: f64| pct < limit && free < PLENTY_FREE;
    let (penalty, severity) = if by_pct(5.0) || free < 5 * GB {
        (50, Severity::Critical)
    } else if by_pct(10.0) || free < 10 * GB {
        (30, Severity::Warn)
    } else if by_pct(15.0) || free < 20 * GB {
        (12, Severity::Warn)
    } else {
        return None;
    };
    let title = if severity == Severity::Critical { "Disco quase cheio" } else { "Pouco espaço livre no disco" };
    Some(entry(
        penalty,
        "disk",
        severity,
        title,
        format!(
            "Restam {} de {} ({:.0} %). Libere espaço para o Mac não ficar lento.",
            fmt_bytes(free),
            fmt_bytes(total),
            pct
        ),
        Some(("Liberar espaço", "smart")),
    ))
}

fn trash_entry(bytes: u64) -> Option<Entry> {
    let (penalty, severity) = if bytes >= 10 * GB {
        (8, Severity::Warn)
    } else if bytes >= 2 * GB {
        (4, Severity::Info)
    } else if bytes >= GB {
        (2, Severity::Info)
    } else {
        return None;
    };
    Some(entry(
        penalty,
        "trash",
        severity,
        "Lixeira cheia",
        format!("A Lixeira ocupa {}. Esvaziar devolve esse espaço.", fmt_bytes(bytes)),
        Some(("Esvaziar Lixeira", "trash")),
    ))
}

fn smart_care_entry(days: Option<u32>) -> Option<Entry> {
    let action = Some(("Executar Faxina", "smart"));
    match days {
        None => Some(entry(
            8,
            "smart_care",
            Severity::Info,
            "Nenhuma Faxina ainda",
            "Você ainda não fez uma Faxina neste Mac.".into(),
            action,
        )),
        Some(d) if d > 30 => Some(entry(
            8,
            "smart_care",
            Severity::Warn,
            "Faz tempo desde a última limpeza",
            format!("A última Faxina foi há {d} dias."),
            action,
        )),
        Some(d) if d > 14 => Some(entry(
            4,
            "smart_care",
            Severity::Info,
            "Hora de cuidar do Mac",
            format!("A última Faxina foi há {d} dias."),
            action,
        )),
        Some(d) if d > 7 => Some(entry(
            2,
            "smart_care",
            Severity::Info,
            "Hora de cuidar do Mac",
            format!("A última Faxina foi há {d} dias."),
            action,
        )),
        Some(_) => None,
    }
}

fn uptime_entry(days: f64) -> Option<Entry> {
    let (penalty, severity) = if days >= 30.0 {
        (8, Severity::Warn)
    } else if days >= 14.0 {
        (4, Severity::Info)
    } else {
        return None;
    };
    Some(entry(
        penalty,
        "uptime",
        severity,
        "Mac ligado há muito tempo",
        format!("O Mac está ligado há {:.0} dias. Reiniciar libera memória e aplica atualizações.", days.floor()),
        None,
    ))
}

fn memory_entry(m: MemoryPressure) -> Option<Entry> {
    let action = Some(("Ver Velocidade", "perf"));
    match m {
        MemoryPressure::Normal => None,
        MemoryPressure::Warning => Some(entry(
            12,
            "memory",
            Severity::Warn,
            "Memória sob pressão",
            "O macOS está comprimindo memória. Feche apps que você não usa.".into(),
            action,
        )),
        MemoryPressure::Critical => Some(entry(
            25,
            "memory",
            Severity::Critical,
            "Memória quase esgotada",
            "O Mac está sem memória livre e vai ficar lento. Feche apps agora.".into(),
            action,
        )),
    }
}

/// Pure: the same inputs always give the same health.
pub fn score(i: &Inputs) -> Health {
    let mut entries: Vec<Entry> = Vec::new();
    entries.extend(disk_entry(i.disk_total, i.disk_free));
    entries.extend(i.trash_bytes.and_then(trash_entry));
    if !i.fda {
        entries.push(entry(
            5,
            "fda",
            Severity::Info,
            "Acesso Total ao Disco desligado",
            "Sem ele o Limpae não lê a Lixeira nem parte da Biblioteca, e a análise fica incompleta.".into(),
            Some(("Abrir Ajustes", "fda")),
        ));
    }
    entries.extend(smart_care_entry(i.days_since_smart_care));
    entries.extend(i.uptime_days.and_then(uptime_entry));
    entries.extend(i.memory.and_then(memory_entry));
    if i.gatekeeper == Some(false) {
        entries.push(entry(10, "gatekeeper", Severity::Warn, "Gatekeeper desligado", "O Mac aceita apps de qualquer origem sem verificar. Reative em Ajustes do Sistema › Privacidade e Segurança.".into(), None));
    }
    if i.sip == Some(false) {
        entries.push(entry(
            15,
            "sip",
            Severity::Warn,
            "Proteção de Integridade do Sistema desligada",
            "O SIP protege arquivos do macOS contra alterações. Reative pelo modo de recuperação (csrutil enable)."
                .into(),
            None,
        ));
    }
    if i.filevault == Some(false) {
        entries.push(entry(
            5,
            "filevault",
            Severity::Info,
            "FileVault desligado",
            "Os dados do disco não estão criptografados. Ative em Ajustes do Sistema › Privacidade e Segurança.".into(),
            None,
        ));
    }

    let penalty: u32 = entries.iter().map(|e| e.penalty).sum();
    let mut score = 100u32.saturating_sub(penalty) as u8;
    if entries.iter().any(|e| e.factor.severity == Severity::Critical) {
        score = score.min(CRITICAL_CAP);
    }
    // Stable: most severe first, then biggest penalty.
    entries.sort_by(|a, b| b.factor.severity.cmp(&a.factor.severity).then(b.penalty.cmp(&a.penalty)));
    Health { level: Level::from_score(score), score, factors: entries.into_iter().map(|e| e.factor).collect() }
}

/// Whole days between a stored unix time and now (`None` = never ran; a clock set backwards counts as 0).
pub fn days_since(last: Option<u64>, now: u64) -> Option<u32> {
    last.map(|t| (now.saturating_sub(t) / 86_400).min(u32::MAX as u64) as u32)
}

// ---------------------------------------------------------------------------------------------------------------
// Probes. Each is cheap (a sysctl or a short-lived tool) and returns `None` when the answer is unavailable.

fn sysctl_raw(name: &std::ffi::CStr, buf: &mut [u8]) -> Option<usize> {
    let mut len = buf.len();
    // SAFETY: `buf` and `len` describe a valid writable region; the kernel writes at most `len` bytes.
    let rc = unsafe { libc::sysctlbyname(name.as_ptr(), buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
    (rc == 0).then_some(len)
}

/// Days since boot (sleep included), from `kern.boottime`.
pub fn uptime_days() -> Option<f64> {
    let mut tv = [0u8; std::mem::size_of::<libc::timeval>()];
    let len = sysctl_raw(c"kern.boottime", &mut tv)?;
    if len != tv.len() {
        return None;
    }
    // SAFETY: `tv` holds exactly one timeval written by the kernel; read_unaligned copes with the byte alignment.
    let boot: libc::timeval = unsafe { std::ptr::read_unaligned(tv.as_ptr().cast()) };
    // SAFETY: time(NULL) has no preconditions.
    let now = unsafe { libc::time(std::ptr::null_mut()) };
    Some((now - boot.tv_sec).max(0) as f64 / 86_400.0)
}

/// `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical.
pub fn memory_pressure() -> Option<MemoryPressure> {
    let mut b = [0u8; 4];
    (sysctl_raw(c"kern.memorystatus_vm_pressure_level", &mut b)? == 4).then_some(())?;
    match i32::from_ne_bytes(b) {
        1 => Some(MemoryPressure::Normal),
        2 => Some(MemoryPressure::Warning),
        4 => Some(MemoryPressure::Critical),
        _ => None,
    }
}

/// `hw.model`, e.g. "MacBookPro18,3".
pub fn hw_model() -> Option<String> {
    let mut b = [0u8; 64];
    let len = sysctl_raw(c"hw.model", &mut b)?;
    let s = String::from_utf8_lossy(&b[..len]);
    let s = s.trim_end_matches('\0').trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// Friendly family name of a `hw.model` identifier: "MacBookPro18,3" -> "MacBook Pro". Identifiers that name no
/// family ("Mac14,13", Apple silicon Studio/mini/Pro share the "Mac" prefix) become plain "Mac".
pub fn friendly_model(model: &str) -> String {
    let family = model.trim_end_matches(|c: char| c.is_ascii_digit() || c == ',');
    match family {
        "MacBookPro" => "MacBook Pro",
        "MacBookAir" => "MacBook Air",
        "MacBook" => "MacBook",
        "Macmini" => "Mac mini",
        "MacPro" => "Mac Pro",
        "MacStudio" => "Mac Studio",
        "iMac" | "iMacPro" => "iMac",
        "VirtualMac" => "Mac virtual",
        _ => "Mac",
    }
    .to_string()
}

/// Runs a system tool and returns its stdout, or `None` if it cannot start, fails, or exceeds `timeout`
/// (the child is then killed).
fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// `spctl --status`: "assessments enabled" / "assessments disabled".
pub fn parse_gatekeeper(out: &str) -> Option<bool> {
    let o = out.to_lowercase();
    if o.contains("assessments enabled") {
        Some(true)
    } else if o.contains("assessments disabled") {
        Some(false)
    } else {
        None
    }
}

/// `csrutil status`: "System Integrity Protection status: enabled." (or "disabled.", or "enabled (Custom ...)").
pub fn parse_sip(out: &str) -> Option<bool> {
    let o = out.to_lowercase();
    let status = o.split("status:").nth(1)?;
    if status.trim_start().starts_with("enabled") {
        Some(true)
    } else if status.trim_start().starts_with("disabled") {
        Some(false)
    } else {
        None
    }
}

/// `fdesetup status`: "FileVault is On." / "FileVault is Off."
pub fn parse_filevault(out: &str) -> Option<bool> {
    let o = out.to_lowercase();
    if o.contains("filevault is on") {
        Some(true)
    } else if o.contains("filevault is off") {
        Some(false)
    } else {
        None
    }
}

/// Gatekeeper, SIP and FileVault state. The three tools run in parallel, each killed after `timeout`.
pub fn probe_security(timeout: Duration) -> (Option<bool>, Option<bool>, Option<bool>) {
    let run = |program: &'static str, args: &'static [&'static str], parse: fn(&str) -> Option<bool>| {
        std::thread::spawn(move || run_with_timeout(program, args, timeout).and_then(|o| parse(&o)))
    };
    let g = run("/usr/sbin/spctl", &["--status"], parse_gatekeeper);
    let s = run("/usr/bin/csrutil", &["status"], parse_sip);
    let f = run("/usr/bin/fdesetup", &["status"], parse_filevault);
    (g.join().ok().flatten(), s.join().ok().flatten(), f.join().ok().flatten())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TB: u64 = 1_000 * GB;

    /// A healthy baseline: roomy disk, small Trash, FDA on, recent Sweep, normal memory, short uptime.
    fn healthy() -> Inputs {
        Inputs {
            disk_total: TB,
            disk_free: 500 * GB,
            trash_bytes: Some(0),
            fda: true,
            days_since_smart_care: Some(1),
            uptime_days: Some(2.0),
            memory: Some(MemoryPressure::Normal),
            gatekeeper: Some(true),
            sip: Some(true),
            filevault: Some(true),
        }
    }

    fn ids(h: &Health) -> Vec<&'static str> {
        h.factors.iter().map(|f| f.id).collect()
    }

    fn penalty_of(mutate: impl FnOnce(&mut Inputs)) -> u8 {
        let mut i = healthy();
        mutate(&mut i);
        100 - score(&i).score
    }

    #[test]
    fn healthy_mac_is_excellent_with_no_factors() {
        let h = score(&healthy());
        assert_eq!((h.score, h.level), (100, Level::Excelente));
        assert!(h.factors.is_empty());
    }

    #[test]
    fn unknown_inputs_are_not_counted() {
        let h = score(&Inputs {
            disk_total: TB,
            disk_free: 500 * GB,
            fda: true,
            days_since_smart_care: Some(0),
            ..Inputs::default()
        });
        assert_eq!(h.score, 100);
        assert!(h.factors.is_empty());
    }

    #[test]
    fn disk_penalty_tiers() {
        let at = |total: u64, free: u64| penalty_of(|i| (i.disk_total, i.disk_free) = (total, free));
        assert_eq!(at(100 * GB, 20 * GB), 0, "20 GB / 20 %: no problem");
        assert_eq!(at(100 * GB, 19 * GB), 12, "bytes rule: < 20 GB");
        assert_eq!(at(100 * GB, 10 * GB), 12, "10 GB: not < 10 GB, still < 20 GB");
        assert_eq!(at(100 * GB, 9 * GB), 30, "< 10 GB and < 10 %");
        assert_eq!(at(100 * GB, 5 * GB), 30, "exactly 5 GB / 5 %: not strictly below");
        assert_eq!(at(100 * GB, 4 * GB), 50, "< 5 GB");
        // 1 TB disk: percentages rule while free < 200 GB.
        assert_eq!(at(TB, 150 * GB), 0, "exactly 15 %");
        assert_eq!(at(TB, 149 * GB), 12, "< 15 %");
        assert_eq!(at(TB, 99 * GB), 30, "< 10 %");
        assert_eq!(at(TB, 49 * GB), 50, "< 5 %");
        // Plenty of free space overrides the percentage on huge disks.
        assert_eq!(at(8 * TB, 300 * GB), 0, "3.75 % of 8 TB is still 300 GB");
        assert_eq!(at(8 * TB, 199 * GB), 50, "below the 200 GB plenty line the percentage applies");
        assert_eq!(at(0, 0), 0, "unknown capacity is not counted");
    }

    #[test]
    fn disk_factor_wording_and_action() {
        let mut i = healthy();
        i.disk_free = 20 * GB;
        i.disk_total = 500 * GB;
        let h = score(&i);
        let f = &h.factors[0];
        assert_eq!((f.id, f.severity), ("disk", Severity::Critical));
        assert_eq!(f.title, "Disco quase cheio");
        assert!(f.detail.contains("20 GB de 500 GB (4 %)"), "{}", f.detail);
        assert_eq!(f.action, Some(Action { label: "Liberar espaço", module: "smart" }));
        i.disk_free = 60 * GB;
        let h = score(&i);
        assert_eq!(
            (h.factors[0].severity, h.factors[0].title.as_str()),
            (Severity::Warn, "Pouco espaço livre no disco")
        );
    }

    #[test]
    fn trash_thresholds() {
        let at = |b: u64| penalty_of(|i| i.trash_bytes = Some(b));
        assert_eq!(at(GB - 1), 0);
        assert_eq!(at(GB), 2);
        assert_eq!(at(2 * GB - 1), 2);
        assert_eq!(at(2 * GB), 4);
        assert_eq!(at(10 * GB - 1), 4);
        assert_eq!(at(10 * GB), 8);
        assert_eq!(penalty_of(|i| i.trash_bytes = None), 0, "unknown Trash (no FDA) is not counted");
        let mut i = healthy();
        i.trash_bytes = Some(3 * GB);
        let f = &score(&i).factors[0];
        assert_eq!((f.id, f.action.clone()), ("trash", Some(Action { label: "Esvaziar Lixeira", module: "trash" })));
        assert!(f.detail.contains("3 GB"), "{}", f.detail);
    }

    #[test]
    fn full_disk_access_missing_costs_five_and_opens_settings() {
        assert_eq!(penalty_of(|i| i.fda = false), 5);
        let mut i = healthy();
        i.fda = false;
        let h = score(&i);
        assert_eq!(h.factors[0].action, Some(Action { label: "Abrir Ajustes", module: "fda" }));
    }

    #[test]
    fn smart_care_age() {
        let at = |d: Option<u32>| penalty_of(|i| i.days_since_smart_care = d);
        assert_eq!(at(Some(0)), 0);
        assert_eq!(at(Some(7)), 0);
        assert_eq!(at(Some(8)), 2);
        assert_eq!(at(Some(14)), 2);
        assert_eq!(at(Some(15)), 4);
        assert_eq!(at(Some(30)), 4);
        assert_eq!(at(Some(31)), 8);
        assert_eq!(at(None), 8, "never ran");
        let mut i = healthy();
        i.days_since_smart_care = None;
        assert_eq!(score(&i).factors[0].title, "Nenhuma Faxina ainda");
        assert_eq!(
            score(&i).factors[0].action,
            Some(Action { label: "Executar Faxina", module: "smart" })
        );
    }

    #[test]
    fn uptime_thresholds() {
        let at = |d: Option<f64>| penalty_of(|i| i.uptime_days = d);
        assert_eq!(at(Some(13.99)), 0);
        assert_eq!(at(Some(14.0)), 4);
        assert_eq!(at(Some(29.99)), 4);
        assert_eq!(at(Some(30.0)), 8);
        assert_eq!(at(None), 0);
    }

    #[test]
    fn memory_pressure_levels() {
        let at = |m: MemoryPressure| penalty_of(|i| i.memory = Some(m));
        assert_eq!(at(MemoryPressure::Normal), 0);
        assert_eq!(at(MemoryPressure::Warning), 12);
        assert_eq!(at(MemoryPressure::Critical), 41, "25 points, then the critical cap (100 -> 59)");
        assert_eq!(penalty_of(|i| i.memory = None), 0);
    }

    #[test]
    fn security_switches_count_only_when_known_off() {
        assert_eq!(penalty_of(|i| i.gatekeeper = Some(false)), 10);
        assert_eq!(penalty_of(|i| i.sip = Some(false)), 15);
        assert_eq!(penalty_of(|i| i.filevault = Some(false)), 5);
        assert_eq!(penalty_of(|i| (i.gatekeeper, i.sip, i.filevault) = (None, None, None)), 0);
        assert_eq!(penalty_of(|i| (i.gatekeeper, i.sip, i.filevault) = (Some(true), Some(true), Some(true))), 0);
    }

    #[test]
    fn level_boundaries() {
        let cases = [
            (100, Level::Excelente),
            (90, Level::Excelente),
            (89, Level::Boa),
            (75, Level::Boa),
            (74, Level::Regular),
            (60, Level::Regular),
            (59, Level::RequerAtencao),
            (40, Level::RequerAtencao),
            (39, Level::Critica),
            (0, Level::Critica),
        ];
        for (score, level) in cases {
            assert_eq!(Level::from_score(score), level, "{score}");
        }
        assert_eq!(Level::RequerAtencao.label(), "Requer atenção");
    }

    #[test]
    fn combined_levels() {
        // Stale Sweep + big Trash + no FDA = 8 + 8 + 5 = 21 -> 79 Boa.
        let mut i = healthy();
        (i.days_since_smart_care, i.trash_bytes, i.fda) = (Some(40), Some(12 * GB), false);
        let h = score(&i);
        assert_eq!((h.score, h.level), (79, Level::Boa));
        // Add a tight disk (12) and a warning memory (12): 79 - 24 = 55 -> Requer atenção.
        (i.disk_free, i.memory) = (140 * GB, Some(MemoryPressure::Warning));
        let h = score(&i);
        assert_eq!((h.score, h.level), (55, Level::RequerAtencao));
        // Disk down to 1 % (50 instead of 12): 8 + 8 + 5 + 50 + 12 = 83 -> 17 Crítica.
        i.disk_free = 10 * GB;
        let h = score(&i);
        assert_eq!((h.score, h.level), (17, Level::Critica));
        assert_eq!(h.factors[0].severity, Severity::Critical, "most severe first");
    }

    #[test]
    fn a_critical_factor_caps_the_score() {
        // Critical memory alone costs 25 -> 75 (Boa) without the cap; with it, 59.
        let h = score(&Inputs { memory: Some(MemoryPressure::Critical), ..healthy() });
        assert_eq!((h.score, h.level), (59, Level::RequerAtencao));
        // Cap never raises a lower score.
        let h = score(&Inputs { memory: Some(MemoryPressure::Critical), disk_free: 10 * GB, ..healthy() });
        assert!(h.score < 59);
    }

    #[test]
    fn factors_sorted_by_severity_then_penalty() {
        let mut i = healthy();
        i.fda = false; // info 5
        i.trash_bytes = Some(11 * GB); // warn 8
        i.memory = Some(MemoryPressure::Critical); // critical 25
        i.days_since_smart_care = Some(20); // info 4
        let h = score(&i);
        assert_eq!(ids(&h), ["memory", "trash", "fda", "smart_care"]);
    }

    #[test]
    fn score_is_deterministic() {
        let mut i = healthy();
        i.fda = false;
        assert_eq!(score(&i), score(&i));
    }

    #[test]
    fn days_since_handles_never_and_clock_skew() {
        assert_eq!(days_since(None, 1_000_000), None);
        assert_eq!(days_since(Some(0), 86_399), Some(0));
        assert_eq!(days_since(Some(0), 86_400), Some(1));
        assert_eq!(days_since(Some(2_000_000), 1_000_000), Some(0), "clock moved backwards");
    }

    #[test]
    fn formats_bytes_like_the_ui() {
        assert_eq!(fmt_bytes(0), "0 B");
        assert_eq!(fmt_bytes(999), "999 B");
        assert_eq!(fmt_bytes(1_500), "2 KB");
        assert_eq!(fmt_bytes(2_300_000_000), "2,3 GB");
        assert_eq!(fmt_bytes(234 * GB), "234 GB");
        assert_eq!(fmt_bytes(TB), "1 TB");
        assert_eq!(fmt_bytes(999_960_000), "1 GB");
        assert_eq!(fmt_bytes(15_000_000_000), "15 GB");
    }

    #[test]
    fn maps_hw_model_to_friendly_names() {
        for (m, name) in [
            ("MacBookPro18,3", "MacBook Pro"),
            ("MacBookAir10,1", "MacBook Air"),
            ("Macmini9,1", "Mac mini"),
            ("iMac21,1", "iMac"),
            ("MacPro7,1", "Mac Pro"),
            ("Mac14,13", "Mac"),
            ("VirtualMac2,1", "Mac virtual"),
            ("", "Mac"),
        ] {
            assert_eq!(friendly_model(m), name, "{m}");
        }
    }

    #[test]
    fn parses_tool_output() {
        assert_eq!(parse_gatekeeper("assessments enabled\n"), Some(true));
        assert_eq!(parse_gatekeeper("assessments disabled\n"), Some(false));
        assert_eq!(parse_gatekeeper("boom"), None);
        assert_eq!(parse_sip("System Integrity Protection status: enabled.\n"), Some(true));
        assert_eq!(parse_sip("System Integrity Protection status: disabled.\n"), Some(false));
        assert_eq!(parse_sip("System Integrity Protection status: enabled (Custom Configuration).\n"), Some(true));
        assert_eq!(parse_sip(""), None);
        assert_eq!(parse_filevault("FileVault is On.\n"), Some(true));
        assert_eq!(parse_filevault("FileVault is Off.\n"), Some(false));
        assert_eq!(parse_filevault("Error: x"), None);
    }

    #[test]
    fn timeout_kills_slow_tools_and_missing_tools_are_none() {
        let t = Instant::now();
        assert_eq!(run_with_timeout("/bin/sleep", &["5"], Duration::from_millis(100)), None);
        assert!(t.elapsed() < Duration::from_secs(2));
        assert_eq!(run_with_timeout("/nonexistent/tool", &[], Duration::from_secs(1)), None);
        assert_eq!(run_with_timeout("/bin/echo", &["oi"], Duration::from_secs(2)).as_deref(), Some("oi\n"));
    }

    #[test]
    fn real_machine_probes_do_not_panic() {
        assert!(uptime_days().is_none_or(|d| d >= 0.0));
        let _ = memory_pressure();
        let _ = hw_model();
        let _ = probe_security(Duration::from_secs(3));
    }

    #[test]
    fn serializes_for_the_ui() {
        let mut i = healthy();
        i.fda = false;
        let v = serde_json::to_value(score(&i)).unwrap();
        assert_eq!(v["level"], "Excelente");
        assert_eq!(v["factors"][0]["severity"], "info");
        assert_eq!(v["factors"][0]["action"]["module"], "fda");
        assert_eq!(serde_json::to_value(Level::RequerAtencao).unwrap(), "Requer atenção");
    }
}
