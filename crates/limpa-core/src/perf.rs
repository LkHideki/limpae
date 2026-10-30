//! Desempenho: agentes em segundo plano, itens de login, monitor do sistema e snapshots locais do Time Machine.
//!
//! Sem root e sem shell: todo subprocesso usa um vetor de argumentos e tem timeout. Nada que venha da interface
//! entra em um script ou comando: rótulos e nomes são relidos do disco no momento da ação e validados aqui.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rayon::prelude::*;
use serde::Serialize;

const LAUNCHCTL: &str = "/bin/launchctl";
const CODESIGN: &str = "/usr/bin/codesign";
const OSASCRIPT: &str = "/usr/bin/osascript";
const PMSET: &str = "/usr/bin/pmset";
const IOREG: &str = "/usr/sbin/ioreg";
const PS: &str = "/bin/ps";
const TMUTIL: &str = "/usr/bin/tmutil";

const T_QUICK: Duration = Duration::from_secs(5);
const T_SCRIPT: Duration = Duration::from_secs(30);
const T_THIN: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------------------------------------------
// Execução de subprocessos
// ---------------------------------------------------------------------------------------------------------------

/// Resultado de um subprocesso. `code` é `None` quando foi encerrado por sinal ou por timeout.
#[derive(Debug, Clone, Default)]
pub struct CmdOut {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl CmdOut {
    pub fn ok(&self) -> bool {
        self.code == Some(0) && !self.timed_out
    }
}

/// Costura sobre os subprocessos: os testes trocam por um executor falso e nada toca o launchd de verdade.
pub trait Runner: Sync {
    fn run(&self, program: &str, args: &[OsString], timeout: Duration) -> io::Result<CmdOut>;
}

pub struct SystemRunner;

fn read_all(mut src: impl Read) -> String {
    let mut buf = Vec::new();
    let _ = src.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

impl Runner for SystemRunner {
    /// Argumentos em vetor (sem shell). A saída é lida em threads para o pipe nunca encher e travar o processo;
    /// ao estourar o tempo o processo é morto.
    fn run(&self, program: &str, args: &[OsString], timeout: Duration) -> io::Result<CmdOut> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let out = child.stdout.take().map(|s| std::thread::spawn(move || read_all(s)));
        let err = child.stderr.take().map(|s| std::thread::spawn(move || read_all(s)));
        let start = Instant::now();
        let (code, timed_out) = loop {
            match child.try_wait()? {
                Some(status) => break (status.code(), false),
                None if start.elapsed() >= timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break (None, true);
                }
                None => std::thread::sleep(Duration::from_millis(2)),
            }
        };
        let join = |h: Option<std::thread::JoinHandle<String>>| h.and_then(|h| h.join().ok()).unwrap_or_default();
        Ok(CmdOut { code, stdout: join(out), stderr: join(err), timed_out })
    }
}

fn a(s: impl AsRef<OsStr>) -> OsString {
    s.as_ref().to_os_string()
}

fn run(r: &dyn Runner, program: &str, args: &[OsString], timeout: Duration) -> Option<CmdOut> {
    r.run(program, args, timeout).ok()
}

// ---------------------------------------------------------------------------------------------------------------
// Agentes em segundo plano (launchd)
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    User,
    SystemAgent,
    SystemDaemon,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// Carregado no launchd.
    Active,
    /// Habilitado, mas não carregado agora.
    Inactive,
    /// Desabilitado no launchd (`launchctl disable`).
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Signature {
    Valid,
    /// Assinatura válida, mas ad hoc (sem identidade de desenvolvedor).
    AdHoc,
    Unsigned,
    Invalid,
    /// O programa do agente não existe mais.
    Missing,
    /// O plist não aponta para nenhum programa.
    NoProgram,
    /// `codesign` não respondeu a tempo.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignatureInfo {
    pub status: Signature,
    pub signer: Option<String>,
}

/// App dono do agente: o `.app` que contém o programa (ou um dos argumentos).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppRef {
    pub name: String,
    pub bundle_id: Option<String>,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Agent {
    pub plist: PathBuf,
    pub label: String,
    pub scope: Scope,
    pub program: Option<PathBuf>,
    pub run_at_load: bool,
    pub keep_alive: bool,
    pub owner: Option<AppRef>,
    pub signature: SignatureInfo,
    /// `None` para itens do sistema (somente leitura; o estado exigiria privilégios).
    pub state: Option<AgentState>,
    pub manageable: bool,
    pub note: Option<String>,
}

impl Agent {
    /// Sem assinatura válida ou sem programa: merece atenção do usuário.
    pub fn flagged(&self) -> bool {
        matches!(self.signature.status, Signature::Unsigned | Signature::Invalid | Signature::Missing)
    }
}

pub const NOTE_SYSTEM: &str = "Do sistema · requer administrador";
const NOTE_APPLE: &str = "Item da Apple";
const NOTE_OWN: &str = "Pertence ao Limpae";
const NOTE_UNREADABLE: &str = "Arquivo vazio, sem rótulo ou ilegível";

/// Rótulo aceito para `launchctl`: o mesmo conjunto que os testes e o filtro da interface esperam.
pub fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 200
        && !label.starts_with('-')
        && label.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_apple_label(label: &str) -> bool {
    label.starts_with("com.apple.")
}

/// Pastas de agentes e daemons. O usuário só pode alterar a primeira.
#[derive(Debug, Clone)]
pub struct AgentDirs {
    pub user: PathBuf,
    pub system_agents: PathBuf,
    pub system_daemons: PathBuf,
}

impl AgentDirs {
    pub fn for_home(home: &Path) -> Self {
        Self {
            user: home.join("Library/LaunchAgents"),
            system_agents: PathBuf::from("/Library/LaunchAgents"),
            system_daemons: PathBuf::from("/Library/LaunchDaemons"),
        }
    }
}

#[derive(Debug, Clone)]
struct Parsed {
    plist: PathBuf,
    scope: Scope,
    readable: bool,
    label: String,
    args: Vec<String>,
    program: Option<PathBuf>,
    run_at_load: bool,
    keep_alive: bool,
}

fn parse_plist_file(path: &Path, scope: Scope) -> Parsed {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut p = Parsed {
        plist: path.to_path_buf(),
        scope,
        readable: false,
        label: stem,
        args: Vec::new(),
        program: None,
        run_at_load: false,
        keep_alive: false,
    };
    let Some(v) = plist::Value::from_file(path).ok() else { return p };
    let Some(d) = v.as_dictionary() else { return p };
    let Some(label) = d.get("Label").and_then(|l| l.as_string()) else { return p };
    p.readable = true;
    p.label = label.to_string();
    p.args = d
        .get("ProgramArguments")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_string().map(str::to_string)).collect())
        .unwrap_or_default();
    p.program =
        d.get("Program").and_then(|x| x.as_string()).map(PathBuf::from).or_else(|| p.args.first().map(PathBuf::from));
    p.run_at_load = d.get("RunAtLoad").and_then(|x| x.as_boolean()).unwrap_or(false);
    p.keep_alive = match d.get("KeepAlive") {
        Some(plist::Value::Boolean(b)) => *b,
        Some(plist::Value::Dictionary(m)) => !m.is_empty(),
        _ => false,
    };
    p
}

/// O `.app` mais externo no caminho, se houver: `/A/B.app/Contents/MacOS/x` vira `/A/B.app`.
fn outer_app(path: &Path) -> Option<PathBuf> {
    let mut acc = PathBuf::new();
    for c in path.components() {
        acc.push(c);
        if c.as_os_str().to_string_lossy().ends_with(".app") && acc != path {
            return Some(acc);
        }
    }
    None
}

/// App dono: o primeiro caminho absoluto (programa ou argumento) que está dentro de um `.app`.
fn owner_of(program: Option<&Path>, args: &[String]) -> Option<AppRef> {
    let candidates = program.map(Path::to_path_buf).into_iter().chain(args.iter().map(PathBuf::from));
    let bundle = candidates.filter(|p| p.is_absolute()).find_map(|p| outer_app(&p))?;
    let info = plist::Value::from_file(bundle.join("Contents/Info.plist")).ok();
    let get = |key: &str| {
        info.as_ref()
            .and_then(|v| v.as_dictionary())
            .and_then(|d| d.get(key))
            .and_then(|v| v.as_string())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let name = get("CFBundleDisplayName")
        .or_else(|| get("CFBundleName"))
        .or_else(|| bundle.file_stem().map(|s| s.to_string_lossy().into_owned()))?;
    Some(AppRef { name, bundle_id: get("CFBundleIdentifier"), path: bundle })
}

fn plist_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "plist"))
        .filter(|p| p.file_name().is_some_and(|n| !n.to_string_lossy().starts_with('.')))
        .collect();
    v.sort();
    v
}

/// `launchctl print-disabled gui/<uid>`: rótulo para "desabilitado?". Rótulos ausentes estão habilitados.
pub fn parse_print_disabled(out: &str) -> HashMap<String, bool> {
    out.lines()
        .filter_map(|l| {
            let (left, right) = l.split_once("=>")?;
            let label = left.trim().strip_prefix('"')?.strip_suffix('"')?;
            let disabled = matches!(right.trim(), "disabled" | "true");
            Some((label.to_string(), disabled))
        })
        .collect()
}

/// UID do usuário que executa o app: o domínio `gui/<uid>` do launchd.
pub fn current_uid() -> u32 {
    // SAFETY: `getuid` não tem pré-condições e nunca falha.
    unsafe { libc::getuid() }
}

fn domain(uid: u32) -> String {
    format!("gui/{uid}")
}

fn target(uid: u32, label: &str) -> String {
    format!("gui/{uid}/{label}")
}

fn disabled_map(r: &dyn Runner, uid: u32) -> HashMap<String, bool> {
    run(r, LAUNCHCTL, &[a("print-disabled"), a(domain(uid))], T_QUICK)
        .filter(CmdOut::ok)
        .map(|o| parse_print_disabled(&o.stdout))
        .unwrap_or_default()
}

/// Carregado no domínio gráfico do usuário: `launchctl print gui/<uid>/<label>` sai com 0.
pub fn is_loaded(r: &dyn Runner, uid: u32, label: &str) -> bool {
    valid_label(label) && run(r, LAUNCHCTL, &[a("print"), a(target(uid, label))], T_QUICK).is_some_and(|o| o.ok())
}

/// `Authority=` (primeira, a do certificado folha) e `TeamIdentifier=` da saída de `codesign -dv`.
pub fn parse_codesign_dv(stderr: &str) -> (Option<String>, bool) {
    let mut authority = None;
    let mut team = None;
    let mut adhoc = false;
    for line in stderr.lines() {
        if let Some(v) = line.strip_prefix("Authority=") {
            authority.get_or_insert_with(|| v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("TeamIdentifier=") {
            let v = v.trim();
            if v != "not set" && !v.is_empty() {
                team = Some(v.to_string());
            }
        } else if line.trim() == "Signature=adhoc" {
            adhoc = true;
        }
    }
    (authority.or(team), adhoc)
}

fn check_signature(r: &dyn Runner, prog: &Path) -> SignatureInfo {
    let none = |status| SignatureInfo { status, signer: None };
    if std::fs::symlink_metadata(prog).is_err() {
        return none(Signature::Missing);
    }
    let Some(v) = run(r, CODESIGN, &[a("--verify"), a("--strict"), a(prog)], T_QUICK) else {
        return none(Signature::Unknown);
    };
    if v.timed_out {
        return none(Signature::Unknown);
    }
    if !v.ok() {
        // Sem permissão para ler o programa (ex.: ferramentas privilegiadas): não dá para afirmar nada.
        if v.stderr.contains("Permission denied") || v.stderr.contains("Operation not permitted") {
            return none(Signature::Unknown);
        }
        let unsigned = v.stderr.contains("not signed at all");
        return none(if unsigned { Signature::Unsigned } else { Signature::Invalid });
    }
    let (signer, adhoc) =
        run(r, CODESIGN, &[a("-dv"), a(prog)], T_QUICK).map(|o| parse_codesign_dv(&o.stderr)).unwrap_or((None, false));
    SignatureInfo { status: if adhoc { Signature::AdHoc } else { Signature::Valid }, signer }
}

/// Lista agentes e daemons. Somente leitura: `launchctl print` / `print-disabled` e `codesign --verify`.
pub fn scan_agents(dirs: &AgentDirs, uid: u32, own_bundle_id: &str, r: &dyn Runner, cancel: &AtomicBool) -> Vec<Agent> {
    let mut files: Vec<(PathBuf, Scope)> = Vec::new();
    for (dir, scope) in [
        (&dirs.user, Scope::User),
        (&dirs.system_agents, Scope::SystemAgent),
        (&dirs.system_daemons, Scope::SystemDaemon),
    ] {
        files.extend(plist_files(dir).into_iter().map(|p| (p, scope)));
    }
    let parsed: Vec<Parsed> = files.par_iter().map(|(p, scope)| parse_plist_file(p, *scope)).collect();
    if cancel.load(Ordering::Relaxed) {
        return Vec::new();
    }
    let disabled = disabled_map(r, uid);
    let programs: HashSet<&PathBuf> = parsed.iter().filter_map(|p| p.program.as_ref()).collect();
    let signatures: HashMap<&PathBuf, SignatureInfo> = programs
        .into_par_iter()
        .filter(|_| !cancel.load(Ordering::Relaxed))
        .map(|p| (p, check_signature(r, p)))
        .collect();
    let mut agents: Vec<Agent> = parsed
        .par_iter()
        .map(|p| {
            let owner = owner_of(p.program.as_deref(), &p.args);
            let signature = match &p.program {
                Some(prog) => {
                    signatures.get(prog).cloned().unwrap_or(SignatureInfo { status: Signature::Unknown, signer: None })
                }
                None => SignatureInfo { status: Signature::NoProgram, signer: None },
            };
            let own = !own_bundle_id.is_empty()
                && (p.label.starts_with(own_bundle_id)
                    || owner.as_ref().and_then(|o| o.bundle_id.as_deref()) == Some(own_bundle_id));
            let (manageable, note) = if p.scope != Scope::User {
                (false, Some(NOTE_SYSTEM))
            } else if !p.readable || !valid_label(&p.label) {
                (false, Some(NOTE_UNREADABLE))
            } else if is_apple_label(&p.label) {
                (false, Some(NOTE_APPLE))
            } else if own {
                (false, Some(NOTE_OWN))
            } else {
                (true, None)
            };
            let state = (p.scope == Scope::User && p.readable && valid_label(&p.label)).then(|| {
                if disabled.get(&p.label) == Some(&true) {
                    AgentState::Disabled
                } else if is_loaded(r, uid, &p.label) {
                    AgentState::Active
                } else {
                    AgentState::Inactive
                }
            });
            Agent {
                plist: p.plist.clone(),
                label: p.label.clone(),
                scope: p.scope,
                program: p.program.clone(),
                run_at_load: p.run_at_load,
                keep_alive: p.keep_alive,
                owner,
                signature,
                state,
                manageable,
                note: note.map(str::to_string),
            }
        })
        .collect();
    agents.sort_by_cached_key(|g| {
        let scope = u8::from(g.scope != Scope::User);
        (
            scope,
            g.owner.as_ref().map_or_else(|| g.label.to_lowercase(), |o| o.name.to_lowercase()),
            g.label.to_lowercase(),
        )
    });
    agents
}

/// Revalida, no momento da ação, que `plist` é um agente do usuário que o Limpae pode alterar, e devolve o
/// rótulo lido do arquivo (nunca o que a interface viu). Recusa itens da Apple, do próprio app, links simbólicos
/// e qualquer arquivo fora de `dirs.user`.
pub fn user_agent_label(user_dir: &Path, plist: &Path, own_bundle_id: &str) -> Result<String, &'static str> {
    if plist.parent() != Some(user_dir) || plist.extension().is_none_or(|e| e != "plist") {
        return Err("o arquivo não está na pasta de agentes do usuário");
    }
    let md = std::fs::symlink_metadata(plist).map_err(|_| "o arquivo do agente não existe mais")?;
    if !md.file_type().is_file() {
        return Err("o agente não é um arquivo comum");
    }
    let p = parse_plist_file(plist, Scope::User);
    if !p.readable || !valid_label(&p.label) {
        return Err("o rótulo do agente é inválido ou ilegível");
    }
    if is_apple_label(&p.label) {
        return Err(NOTE_APPLE);
    }
    let owner = owner_of(p.program.as_deref(), &p.args);
    let own = !own_bundle_id.is_empty()
        && (p.label.starts_with(own_bundle_id)
            || owner.as_ref().and_then(|o| o.bundle_id.as_deref()) == Some(own_bundle_id));
    if own {
        return Err(NOTE_OWN);
    }
    Ok(p.label)
}

/// Descarrega o agente do launchd. `true` quando ele não está mais carregado ao final.
pub fn bootout(r: &dyn Runner, uid: u32, label: &str) -> bool {
    if !valid_label(label) {
        return false;
    }
    let _ = run(r, LAUNCHCTL, &[a("bootout"), a(target(uid, label))], T_QUICK);
    !is_loaded(r, uid, label)
}

/// Desativar: `disable` (não volta a carregar no login) e depois `bootout` (para agora). Ativar: `enable` e
/// `bootstrap` do plist. Reversível nos dois sentidos; nenhum arquivo é tocado.
pub fn set_agent_enabled(
    r: &dyn Runner,
    uid: u32,
    label: &str,
    plist: &Path,
    enable: bool,
) -> Result<AgentState, String> {
    if !valid_label(label) {
        return Err("rótulo de agente inválido".into());
    }
    let step = |verb: &str| {
        run(r, LAUNCHCTL, &[a(verb), a(target(uid, label))], T_QUICK)
            .filter(CmdOut::ok)
            .map(|_| ())
            .ok_or_else(|| "O launchd recusou a alteração.".to_string())
    };
    if enable {
        step("enable")?;
        if !is_loaded(r, uid, label) {
            let _ = run(r, LAUNCHCTL, &[a("bootstrap"), a(domain(uid)), a(plist)], T_QUICK);
        }
        Ok(if is_loaded(r, uid, label) { AgentState::Active } else { AgentState::Inactive })
    } else {
        step("disable")?;
        if !bootout(r, uid, label) {
            return Err(
                "O agente foi desativado, mas não pôde ser parado agora. Ele deixa de abrir no próximo login.".into()
            );
        }
        Ok(AgentState::Disabled)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Itens de login (System Events)
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginItem {
    pub name: String,
    pub path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginError {
    /// Falta o consentimento de Automação para controlar o System Events.
    NeedsAutomation,
    Failed(String),
}

/// Script fixo, sem dado do usuário: uma linha por item, `nome US caminho RS`.
const LIST_SCRIPT: &[&str] = &[
    "tell application \"System Events\"",
    "set o to \"\"",
    "repeat with li in every login item",
    "set o to o & (name of li) & (ASCII character 31) & (path of li) & (ASCII character 30)",
    "end repeat",
    "return o",
    "end tell",
];

/// O nome chega por `argv` (`item 1 of argv`), nunca interpolado no texto do script.
const DELETE_SCRIPT: &[&str] =
    &["on run argv", "tell application \"System Events\" to delete login item (item 1 of argv)", "end run"];

pub fn parse_login_items(stdout: &str) -> Vec<LoginItem> {
    stdout
        .split('\u{1e}')
        .filter_map(|rec| {
            let rec = rec.trim_matches(['\n', '\r']);
            let (name, path) = rec.split_once('\u{1f}')?;
            if name.is_empty() {
                return None;
            }
            let path = path.trim();
            let path = (!path.is_empty() && path != "missing value").then(|| PathBuf::from(path));
            Some(LoginItem { name: name.to_string(), path })
        })
        .collect()
}

fn needs_automation(o: &CmdOut) -> bool {
    let e = o.stderr.to_lowercase();
    e.contains("-1743") || e.contains("not authorized") || e.contains("-1744") || e.contains("-600")
}

fn script_args(lines: &[&str], extra: Option<&str>) -> Vec<OsString> {
    let mut v = Vec::new();
    for l in lines {
        v.push(a("-e"));
        v.push(a(l));
    }
    if let Some(x) = extra {
        // `--` impede que um nome começando com `-` seja lido como opção do osascript.
        v.push(a("--"));
        v.push(a(x));
    }
    v
}

pub fn list_login_items(r: &dyn Runner) -> Result<Vec<LoginItem>, LoginError> {
    let o = r
        .run(OSASCRIPT, &script_args(LIST_SCRIPT, None), T_SCRIPT)
        .map_err(|e| LoginError::Failed(format!("não foi possível executar o osascript: {e}")))?;
    if o.timed_out {
        return Err(LoginError::Failed("o System Events não respondeu a tempo".into()));
    }
    if o.ok() {
        return Ok(parse_login_items(&o.stdout));
    }
    if needs_automation(&o) {
        return Err(LoginError::NeedsAutomation);
    }
    Err(LoginError::Failed(o.stderr.trim().to_string()))
}

/// Remove da lista de login (o app continua instalado). Recusa quando o nome não identifica um único item.
pub fn remove_login_item(r: &dyn Runner, item: &LoginItem) -> Result<(), String> {
    let current = list_login_items(r).map_err(|e| match e {
        LoginError::NeedsAutomation => "Falta a permissão de Automação para o System Events.".to_string(),
        LoginError::Failed(m) => format!("Não foi possível reler os itens de login: {m}"),
    })?;
    let same: Vec<_> = current.iter().filter(|c| c.name == item.name).collect();
    match same.as_slice() {
        [] => return Err("O item de login não existe mais.".into()),
        [one] if one.path == item.path => {}
        [_] => return Err("O item de login mudou desde a análise. Analise de novo.".into()),
        _ => return Err("Há mais de um item de login com este nome. Remova-o em Ajustes do Sistema.".into()),
    }
    let o = r
        .run(OSASCRIPT, &script_args(DELETE_SCRIPT, Some(&item.name)), T_SCRIPT)
        .map_err(|e| format!("Não foi possível executar o osascript: {e}"))?;
    if o.ok() {
        Ok(())
    } else if needs_automation(&o) {
        Err("Falta a permissão de Automação para o System Events.".into())
    } else {
        Err("O System Events não conseguiu remover o item.".into())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshots locais do Time Machine
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub name: String,
    /// Hora local, `AAAA-MM-DDTHH:MM:SS`.
    pub date: Option<String>,
}

/// `com.apple.TimeMachine.2026-10-29-220903.local` vira `2026-10-29T22:09:03`.
fn snapshot_date(name: &str) -> Option<String> {
    let part = name.strip_prefix("com.apple.TimeMachine.")?.split('.').next()?;
    let b = part.as_bytes();
    let shape = b.len() == 17 && b[4] == b'-' && b[7] == b'-' && b[10] == b'-';
    (shape && b.iter().enumerate().all(|(i, c)| matches!(i, 4 | 7 | 10) || c.is_ascii_digit()))
        .then(|| format!("{}T{}:{}:{}", &part[..10], &part[11..13], &part[13..15], &part[15..17]))
}

/// Saída de `tmutil listlocalsnapshots /` (e de `thinlocalsnapshots`): um nome por linha, depois do cabeçalho.
pub fn parse_snapshots(out: &str) -> Vec<Snapshot> {
    out.lines()
        .map(str::trim)
        .filter(|l| l.starts_with("com.apple.") && !l.contains(char::is_whitespace))
        .map(|l| Snapshot { name: l.to_string(), date: snapshot_date(l) })
        .collect()
}

pub fn list_snapshots(r: &dyn Runner) -> Result<Vec<Snapshot>, String> {
    let o = run(r, TMUTIL, &[a("listlocalsnapshots"), a("/")], T_QUICK)
        .filter(CmdOut::ok)
        .ok_or("Não foi possível listar os snapshots locais.")?;
    Ok(parse_snapshots(&o.stdout))
}

/// `tmutil thinlocalsnapshots / <bytes> 4`: funciona sem root (testado). Apaga os snapshots locais, que o
/// Time Machine volta a criar sozinho; não há como restaurar os removidos.
pub fn thin_snapshots(r: &dyn Runner) -> Result<Vec<Snapshot>, String> {
    let o = run(r, TMUTIL, &[a("thinlocalsnapshots"), a("/"), a("999999999999"), a("4")], T_THIN)
        .filter(CmdOut::ok)
        .ok_or("O tmutil não conseguiu afinar os snapshots locais.")?;
    Ok(parse_snapshots(&o.stdout))
}

// ---------------------------------------------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Pressure {
    Normal,
    Warning,
    Critical,
    Unknown,
}

impl Pressure {
    /// `kern.memorystatus_vm_pressure_level`: 1 normal, 2 atenção, 4 crítica.
    pub fn from_level(level: i32) -> Self {
        match level {
            1 => Self::Normal,
            2 => Self::Warning,
            4 => Self::Critical,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub total: u64,
    /// App + dedicada + comprimida, como o Monitor de Atividade.
    pub used: u64,
    pub app: u64,
    pub wired: u64,
    pub compressed: u64,
    pub available: u64,
    pub pressure: Pressure,
}

/// Contagens de páginas do `host_statistics64`.
#[derive(Debug, Clone, Copy, Default)]
pub struct VmPages {
    pub internal: u64,
    pub purgeable: u64,
    pub wired: u64,
    pub compressed: u64,
}

pub fn memory_from(total: u64, page: u64, v: VmPages, pressure: Pressure) -> Memory {
    let app = v.internal.saturating_sub(v.purgeable) * page;
    let wired = v.wired * page;
    let compressed = v.compressed * page;
    let used = (app + wired + compressed).min(total);
    Memory { total, used, app, wired, compressed, available: total - used, pressure }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Swap {
    pub total: u64,
    pub used: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cpu {
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub cores: u32,
    /// Uso instantâneo (0 a 100) entre duas leituras; `None` na primeira.
    pub usage: Option<f64>,
}

/// Ticks acumulados de CPU (`host_statistics`, `HOST_CPU_LOAD_INFO`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuTicks {
    pub user: u32,
    pub system: u32,
    pub idle: u32,
    pub nice: u32,
}

impl CpuTicks {
    /// Porcentagem ocupada entre `prev` e `self`. Os contadores são de 32 bits e dão a volta.
    pub fn usage_since(&self, prev: &CpuTicks) -> Option<f64> {
        let d = |n: u32, p: u32| u64::from(n.wrapping_sub(p));
        let busy = d(self.user, prev.user) + d(self.system, prev.system) + d(self.nice, prev.nice);
        let total = busy + d(self.idle, prev.idle);
        (total > 0).then(|| (busy as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BatteryState {
    Charging,
    Discharging,
    Charged,
    /// Na tomada, sem carregar (por exemplo, carga otimizada).
    Idle,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub percent: u8,
    pub on_ac: bool,
    pub state: BatteryState,
    pub remaining_min: Option<u32>,
    pub cycles: Option<u32>,
    pub health_pct: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub name: String,
    pub rss: u64,
    pub count: u32,
}

/// `pmset -g batt`; `None` em Macs sem bateria.
pub fn parse_pmset_batt(out: &str) -> Option<Battery> {
    let on_ac = out.lines().next().is_some_and(|l| l.contains("AC Power"));
    let line = out.lines().find(|l| l.contains('%') && l.contains(';'))?;
    let mut parts = line.split(';');
    let head = parts.next()?;
    let pct_end = head.find('%')?;
    let digits: String =
        head[..pct_end].chars().rev().take_while(char::is_ascii_digit).collect::<Vec<_>>().into_iter().rev().collect();
    let percent = digits.parse::<u16>().ok()?.min(100) as u8;
    let state_txt = parts.next().unwrap_or("").trim().to_lowercase();
    let rest = parts.next().unwrap_or("");
    let state = match state_txt.as_str() {
        "charging" | "finishing charge" => BatteryState::Charging,
        "discharging" => BatteryState::Discharging,
        "charged" => BatteryState::Charged,
        _ => BatteryState::Idle,
    };
    let remaining_min = rest.split_whitespace().find_map(|t| {
        let (h, m) = t.split_once(':')?;
        Some(h.parse::<u32>().ok()? * 60 + m.parse::<u32>().ok().filter(|m| *m < 60)?)
    });
    Some(Battery { percent, on_ac, state, remaining_min, cycles: None, health_pct: None })
}

/// `ioreg -rn AppleSmartBattery`: (ciclos, saúde em %). Só as linhas de nível superior (` = ` com espaços).
pub fn parse_ioreg_battery(out: &str) -> (Option<u32>, Option<u8>) {
    let num = |key: &str| -> Option<u64> {
        out.lines().find_map(|l| l.trim().strip_prefix(key)?.strip_prefix(" = ")?.trim().parse().ok())
    };
    let cycles = num("\"CycleCount\"").and_then(|c| u32::try_from(c).ok());
    let design = num("\"DesignCapacity\"").filter(|d| *d > 0);
    let current = num("\"NominalChargeCapacity\"").or_else(|| num("\"AppleRawMaxCapacity\""));
    let health = design.zip(current).map(|(d, c)| (c * 100 / d).min(100) as u8);
    (cycles, health)
}

/// `ps -Ao pid,rss,comm`: (pid, RSS em KB, caminho do executável). O caminho pode ter espaços.
pub fn parse_ps(out: &str) -> Vec<(u32, u64, String)> {
    out.lines()
        .skip(1)
        .filter_map(|l| {
            let (pid, rest) = l.trim_start().split_once(char::is_whitespace)?;
            let (rss, comm) = rest.trim_start().split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, rss.parse().ok()?, comm.trim().to_string()))
        })
        .collect()
}

/// Nome do app (ou do executável) dono do processo, sem o caminho.
fn proc_name(comm: &str) -> String {
    if let Some(stem) = outer_app(Path::new(comm)).as_deref().and_then(Path::file_stem) {
        return stem.to_string_lossy().into_owned();
    }
    Path::new(comm).file_name().map_or_else(|| comm.to_string(), |n| n.to_string_lossy().into_owned())
}

/// Soma a memória residente por app (um Chrome com 30 processos vira uma linha) e devolve os `n` maiores.
pub fn top_consumers(rows: &[(u32, u64, String)], n: usize) -> Vec<Proc> {
    let mut by: HashMap<String, Proc> = HashMap::new();
    for (_, rss_kb, comm) in rows {
        let name = proc_name(comm);
        let e = by.entry(name.clone()).or_insert(Proc { name, rss: 0, count: 0 });
        e.rss += rss_kb * 1024;
        e.count += 1;
    }
    let mut v: Vec<Proc> = by.into_values().collect();
    v.sort_by(|x, y| y.rss.cmp(&x.rss).then_with(|| x.name.cmp(&y.name)));
    v.truncate(n);
    v
}

pub fn sample_top(r: &dyn Runner, n: usize) -> Vec<Proc> {
    run(r, PS, &[a("-Ao"), a("pid,rss,comm")], T_QUICK)
        .filter(CmdOut::ok)
        .map(|o| top_consumers(&parse_ps(&o.stdout), n))
        .unwrap_or_default()
}

pub fn sample_battery(r: &dyn Runner) -> Option<Battery> {
    run(r, PMSET, &[a("-g"), a("batt")], T_QUICK).filter(CmdOut::ok).and_then(|o| parse_pmset_batt(&o.stdout))
}

/// Ciclos e saúde mudam devagar: leitura opcional, pedida raramente.
pub fn sample_battery_wear(r: &dyn Runner) -> (Option<u32>, Option<u8>) {
    run(r, IOREG, &[a("-rn"), a("AppleSmartBattery")], T_QUICK)
        .filter(CmdOut::ok)
        .map_or((None, None), |o| parse_ioreg_battery(&o.stdout))
}

/// Amostra barata do que o kernel entrega sem subprocesso (sysctl e mach): memória, swap, carga e uptime.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fast {
    pub memory: Option<Memory>,
    pub swap: Option<Swap>,
    pub cpu: Cpu,
    pub uptime_secs: Option<u64>,
}

#[cfg(target_os = "macos")]
mod native {
    use super::{CpuTicks, Pressure, Swap, VmPages};
    use std::ffi::CStr;
    use std::sync::OnceLock;

    fn sysctl<T: Copy>(name: &CStr) -> Option<T> {
        let mut v = std::mem::MaybeUninit::<T>::zeroed();
        let mut len = size_of::<T>();
        // SAFETY: `v` tem `len` bytes; o kernel escreve no máximo `len` e atualiza `len`. `T` é dado puro (POD).
        let rc = unsafe { libc::sysctlbyname(name.as_ptr(), v.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
        // SAFETY: zerado na criação e, se o tamanho confere, preenchido pelo kernel.
        (rc == 0 && len == size_of::<T>()).then(|| unsafe { v.assume_init() })
    }

    #[allow(deprecated, reason = "libc recomenda mach2; novas dependências estão fora do escopo")]
    fn host() -> libc::mach_port_t {
        static HOST: OnceLock<libc::mach_port_t> = OnceLock::new();
        // SAFETY: sem argumentos; a porta é guardada para não acumular referências a cada leitura.
        *HOST.get_or_init(|| unsafe { libc::mach_host_self() })
    }

    pub fn total_memory() -> Option<u64> {
        sysctl::<u64>(c"hw.memsize")
    }

    pub fn pressure() -> Pressure {
        sysctl::<i32>(c"kern.memorystatus_vm_pressure_level").map_or(Pressure::Unknown, Pressure::from_level)
    }

    pub fn page_size() -> u64 {
        // SAFETY: consulta simples.
        let p = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        u64::try_from(p).ok().filter(|p| *p > 0).unwrap_or(16384)
    }

    pub fn vm_pages() -> Option<VmPages> {
        // SAFETY: `s` é preenchido pelo kernel dentro de `count` inteiros (tamanho da struct).
        let s = unsafe {
            let mut s: libc::vm_statistics64 = std::mem::zeroed();
            let mut count = libc::HOST_VM_INFO64_COUNT;
            let rc = libc::host_statistics64(host(), libc::HOST_VM_INFO64, (&raw mut s).cast(), &mut count);
            if rc != 0 {
                return None;
            }
            s
        };
        // A struct é `packed`: os campos são copiados por valor, nunca referenciados.
        Some(VmPages {
            internal: u64::from(s.internal_page_count),
            purgeable: u64::from(s.purgeable_count),
            wired: u64::from(s.wire_count),
            compressed: u64::from(s.compressor_page_count),
        })
    }

    pub fn swap() -> Option<Swap> {
        let s = sysctl::<libc::xsw_usage>(c"vm.swapusage")?;
        Some(Swap { total: s.xsu_total, used: s.xsu_used })
    }

    pub fn boot_secs() -> Option<u64> {
        let tv = sysctl::<libc::timeval>(c"kern.boottime")?;
        u64::try_from(tv.tv_sec).ok()
    }

    pub fn cpu_ticks() -> Option<CpuTicks> {
        // SAFETY: `info` tem `HOST_CPU_LOAD_INFO_COUNT` inteiros, que é o que o kernel escreve.
        let info = unsafe {
            let mut info: libc::host_cpu_load_info = std::mem::zeroed();
            let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
            let rc = libc::host_statistics(host(), libc::HOST_CPU_LOAD_INFO, (&raw mut info).cast(), &mut count);
            if rc != 0 {
                return None;
            }
            info
        };
        let t = info.cpu_ticks;
        Some(CpuTicks {
            user: t[libc::CPU_STATE_USER as usize],
            system: t[libc::CPU_STATE_SYSTEM as usize],
            idle: t[libc::CPU_STATE_IDLE as usize],
            nice: t[libc::CPU_STATE_NICE as usize],
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::{CpuTicks, Pressure, Swap, VmPages};
    pub fn total_memory() -> Option<u64> {
        None
    }
    pub fn pressure() -> Pressure {
        Pressure::Unknown
    }
    pub fn page_size() -> u64 {
        4096
    }
    pub fn vm_pages() -> Option<VmPages> {
        None
    }
    pub fn swap() -> Option<Swap> {
        None
    }
    pub fn boot_secs() -> Option<u64> {
        None
    }
    pub fn cpu_ticks() -> Option<CpuTicks> {
        None
    }
}

pub fn cpu_ticks() -> Option<CpuTicks> {
    native::cpu_ticks()
}

fn core_count() -> u32 {
    // SAFETY: consulta simples.
    let n = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
    u32::try_from(n).ok().filter(|n| *n > 0).unwrap_or(1)
}

/// Memória, swap, carga e uptime, sem subprocesso: custa microssegundos.
pub fn sample_fast() -> Fast {
    let memory = native::total_memory()
        .zip(native::vm_pages())
        .map(|(total, v)| memory_from(total, native::page_size(), v, native::pressure()));
    let mut load = [0f64; 3];
    // SAFETY: `load` tem 3 posições, como pedido.
    let got = unsafe { libc::getloadavg(load.as_mut_ptr(), 3) };
    if got < 3 {
        load = [0.0; 3];
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    Fast {
        memory,
        swap: native::swap(),
        cpu: Cpu { load1: load[0], load5: load[1], load15: load[2], cores: core_count(), usage: None },
        uptime_secs: native::boot_secs().map(|b| now.saturating_sub(b)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    /// Executor falso: registra as chamadas e responde por uma função.
    type Call = (String, Vec<String>);
    type Reply = Box<dyn Fn(&str, &[String]) -> CmdOut + Sync>;

    struct Fake {
        calls: Mutex<Vec<Call>>,
        reply: Reply,
    }

    impl Fake {
        fn new(reply: impl Fn(&str, &[String]) -> CmdOut + Sync + 'static) -> Self {
            Self { calls: Mutex::new(Vec::new()), reply: Box::new(reply) }
        }
        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Runner for Fake {
        fn run(&self, program: &str, args: &[OsString], _t: Duration) -> io::Result<CmdOut> {
            let args: Vec<String> = args.iter().map(|x| x.to_string_lossy().into_owned()).collect();
            let out = (self.reply)(program, &args);
            self.calls.lock().unwrap().push((program.to_string(), args));
            Ok(out)
        }
    }

    fn ok(stdout: &str) -> CmdOut {
        CmdOut { code: Some(0), stdout: stdout.into(), ..Default::default() }
    }
    fn fail(stderr: &str) -> CmdOut {
        CmdOut { code: Some(1), stderr: stderr.into(), ..Default::default() }
    }

    #[test]
    fn label_validation() {
        for good in ["com.google.keystone.agent", "a", "A_b-c.1"] {
            assert!(valid_label(good), "{good}");
        }
        for bad in ["", "-x", "a b", "a/b", "a;b", "a\"b", "../x", "a\nb", "ação"] {
            assert!(!valid_label(bad), "{bad:?}");
        }
        assert!(!valid_label(&"a".repeat(201)));
    }

    #[test]
    fn print_disabled_both_formats() {
        let out = "disabled services = {\n\t\"com.docker.helper\" => enabled\n\t\"com.apple.Siri.agent\" => disabled\n\t\"x.old\" => true\n\t\"x.old2\" => false\n}\n";
        let m = parse_print_disabled(out);
        assert_eq!(m.len(), 4);
        assert!(!m["com.docker.helper"]);
        assert!(m["com.apple.Siri.agent"]);
        assert!(m["x.old"]);
        assert!(!m["x.old2"]);
    }

    #[test]
    fn codesign_dv_parsing() {
        let dev = "Executable=/A/B\nIdentifier=com.a.b\nAuthority=Developer ID Application: Google LLC (EQHXZ8M8AV)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=EQHXZ8M8AV\n";
        assert_eq!(parse_codesign_dv(dev), (Some("Developer ID Application: Google LLC (EQHXZ8M8AV)".into()), false));
        let adhoc = "Signature=adhoc\nTeamIdentifier=not set\n";
        assert_eq!(parse_codesign_dv(adhoc), (None, true));
        let team_only = "TeamIdentifier=ABCDE12345\n";
        assert_eq!(parse_codesign_dv(team_only), (Some("ABCDE12345".into()), false));
    }

    #[test]
    fn signature_statuses() {
        let dir = tempfile::tempdir().unwrap();
        let prog = dir.path().join("prog");
        fs::write(&prog, b"x").unwrap();
        let verify_fail = |msg: &'static str| Fake::new(move |_, _| fail(msg));
        let r = verify_fail("prog: code object is not signed at all\n");
        assert_eq!(check_signature(&r, &prog).status, Signature::Unsigned);
        let r = verify_fail("prog: Permission denied\n");
        assert_eq!(check_signature(&r, &prog).status, Signature::Unknown);
        let r = verify_fail("prog: a sealed resource is missing or invalid\n");
        assert_eq!(check_signature(&r, &prog).status, Signature::Invalid);
        let r = Fake::new(|_, args| {
            if args[0] == "--verify" {
                ok("")
            } else {
                CmdOut { code: Some(0), stderr: "Authority=Software Signing\n".into(), ..Default::default() }
            }
        });
        let s = check_signature(&r, &prog);
        assert_eq!((s.status, s.signer.as_deref()), (Signature::Valid, Some("Software Signing")));
        let r = Fake::new(|_, args| {
            if args[0] == "--verify" {
                ok("")
            } else {
                CmdOut { code: Some(0), stderr: "Signature=adhoc\n".into(), ..Default::default() }
            }
        });
        assert_eq!(check_signature(&r, &prog).status, Signature::AdHoc);
        let r = Fake::new(|_, _| CmdOut { timed_out: true, ..Default::default() });
        assert_eq!(check_signature(&r, &prog).status, Signature::Unknown);
        let r = Fake::new(|_, _| ok(""));
        assert_eq!(check_signature(&r, &dir.path().join("gone")).status, Signature::Missing);
        assert!(r.calls().is_empty(), "programa ausente não chama o codesign");
    }

    fn write_agent(dir: &Path, file: &str, label: &str, program: &str, extra: &str) -> PathBuf {
        let p = dir.join(file);
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>{program}</string></array>{extra}</dict></plist>"
        );
        fs::write(&p, xml).unwrap();
        p
    }

    fn make_app(root: &Path, name: &str, id: &str) -> PathBuf {
        let app = root.join(format!("{name}.app"));
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::write(app.join("Contents/MacOS/bin"), b"x").unwrap();
        fs::write(
            app.join("Contents/Info.plist"),
            format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{id}</string><key>CFBundleName</key><string>{name}</string></dict></plist>"),
        )
        .unwrap();
        app
    }

    #[test]
    fn plist_parsing_and_owner() {
        let dir = tempfile::tempdir().unwrap();
        let app = make_app(dir.path(), "Foo Bar", "com.foo.bar");
        let prog = app.join("Contents/MacOS/bin");
        let p = write_agent(
            dir.path(),
            "com.foo.bar.plist",
            "com.foo.bar.agent",
            prog.to_str().unwrap(),
            "<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        );
        let parsed = parse_plist_file(&p, Scope::User);
        assert!(parsed.readable && parsed.run_at_load && parsed.keep_alive);
        assert_eq!(parsed.label, "com.foo.bar.agent");
        assert_eq!(parsed.program.as_deref(), Some(prog.as_path()));
        let owner = owner_of(parsed.program.as_deref(), &parsed.args).unwrap();
        assert_eq!(
            (owner.name.as_str(), owner.bundle_id.as_deref(), owner.path.as_path()),
            ("Foo Bar", Some("com.foo.bar"), app.as_path())
        );
        // Sem .app no caminho: sem dono.
        assert_eq!(owner_of(Some(Path::new("/usr/bin/true")), &[]), None);
        // O dono pode vir de um argumento (/bin/sh -c ... /A.app/...).
        let o = owner_of(Some(Path::new("/bin/sh")), &["-c".into(), prog.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(o.name, "Foo Bar");
    }

    #[test]
    fn unreadable_plist_is_not_manageable() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("u");
        fs::create_dir_all(&user).unwrap();
        fs::write(user.join("broken.plist"), b"not a plist").unwrap();
        let dirs = AgentDirs {
            user: user.clone(),
            system_agents: dir.path().join("none1"),
            system_daemons: dir.path().join("none2"),
        };
        let r = Fake::new(|_, _| fail(""));
        let agents = scan_agents(&dirs, 501, "br.com.limpae", &r, &AtomicBool::new(false));
        assert_eq!(agents.len(), 1);
        assert!(!agents[0].manageable);
        assert_eq!(agents[0].note.as_deref(), Some(NOTE_UNREADABLE));
        assert_eq!(agents[0].signature.status, Signature::NoProgram);
        assert!(agents[0].state.is_none());
    }

    #[test]
    fn scan_classifies_user_and_system_agents() {
        let dir = tempfile::tempdir().unwrap();
        let (user, sysa, sysd) = (dir.path().join("u"), dir.path().join("sa"), dir.path().join("sd"));
        for d in [&user, &sysa, &sysd] {
            fs::create_dir_all(d).unwrap();
        }
        let app = make_app(dir.path(), "Foo", "com.foo");
        let prog = app.join("Contents/MacOS/bin");
        write_agent(
            &user,
            "com.foo.agent.plist",
            "com.foo.agent",
            prog.to_str().unwrap(),
            "<key>RunAtLoad</key><true/>",
        );
        write_agent(&user, "gone.plist", "com.gone.agent", "/nonexistent/prog", "");
        write_agent(&user, "apple.plist", "com.apple.thing", "/usr/bin/true", "");
        write_agent(&user, "own.plist", "br.com.limpae.helper", "/usr/bin/true", "");
        write_agent(&user, "off.plist", "com.off.agent", "/usr/bin/true", "");
        write_agent(&sysa, "com.sys.agent.plist", "com.sys.agent", "/usr/bin/true", "");
        write_agent(&sysd, "com.sys.daemon.plist", "com.sys.daemon", "/usr/bin/true", "");
        let dirs = AgentDirs { user, system_agents: sysa, system_daemons: sysd };
        let r = Fake::new(|prog, args| match (prog, args[0].as_str()) {
            (LAUNCHCTL, "print-disabled") => ok("disabled services = {\n\t\"com.off.agent\" => disabled\n}\n"),
            (LAUNCHCTL, "print") => {
                if args[1].ends_with("/com.foo.agent") {
                    ok("")
                } else {
                    fail("")
                }
            }
            (CODESIGN, "--verify") => ok(""),
            _ => fail(""),
        });
        let agents = scan_agents(&dirs, 501, "br.com.limpae", &r, &AtomicBool::new(false));
        let by = |l: &str| agents.iter().find(|a| a.label == l).unwrap();
        let foo = by("com.foo.agent");
        assert!(foo.manageable && foo.run_at_load);
        assert_eq!(foo.state, Some(AgentState::Active));
        assert_eq!(foo.owner.as_ref().unwrap().name, "Foo");
        assert!(!foo.flagged());
        let gone = by("com.gone.agent");
        assert_eq!(gone.signature.status, Signature::Missing);
        assert!(gone.flagged() && gone.manageable);
        assert_eq!(gone.state, Some(AgentState::Inactive));
        assert_eq!(by("com.off.agent").state, Some(AgentState::Disabled));
        assert!(!by("com.apple.thing").manageable);
        assert_eq!(by("br.com.limpae.helper").note.as_deref(), Some(NOTE_OWN));
        for l in ["com.sys.agent", "com.sys.daemon"] {
            let s = by(l);
            assert!(!s.manageable && s.state.is_none());
            assert_eq!(s.note.as_deref(), Some(NOTE_SYSTEM));
        }
        assert_eq!(by("com.sys.daemon").scope, Scope::SystemDaemon);
        // Itens do usuário vêm antes dos do sistema.
        let first_system = agents.iter().position(|a| a.scope != Scope::User).unwrap();
        assert!(agents[..first_system].iter().all(|a| a.scope == Scope::User));
        // Nenhuma chamada que altere o launchd durante a análise.
        assert!(r.calls().iter().all(|(p, a)| p != LAUNCHCTL || matches!(a[0].as_str(), "print" | "print-disabled")));
    }

    #[test]
    fn user_agent_label_revalidates() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("LaunchAgents");
        fs::create_dir_all(&user).unwrap();
        let good = write_agent(&user, "a.plist", "com.ok.agent", "/usr/bin/true", "");
        assert_eq!(user_agent_label(&user, &good, "br.com.limpae").as_deref(), Ok("com.ok.agent"));
        let apple = write_agent(&user, "b.plist", "com.apple.x", "/usr/bin/true", "");
        assert!(user_agent_label(&user, &apple, "br.com.limpae").is_err());
        let bad = write_agent(&user, "c.plist", "bad label;rm", "/usr/bin/true", "");
        assert!(user_agent_label(&user, &bad, "br.com.limpae").is_err());
        let own = write_agent(&user, "d.plist", "br.com.limpae.x", "/usr/bin/true", "");
        assert!(user_agent_label(&user, &own, "br.com.limpae").is_err());
        // Fora da pasta de agentes do usuário.
        let outside = write_agent(dir.path(), "e.plist", "com.out.agent", "/usr/bin/true", "");
        assert!(user_agent_label(&user, &outside, "br.com.limpae").is_err());
        // Link simbólico para um plist válido: recusado.
        let link = user.join("link.plist");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(user_agent_label(&user, &link, "br.com.limpae").is_err());
        assert!(user_agent_label(&user, &user.join("gone.plist"), "br.com.limpae").is_err());
    }

    #[test]
    fn disable_runs_disable_then_bootout() {
        let loaded = std::sync::atomic::AtomicBool::new(true);
        let r = Fake::new(move |_, args| match args[0].as_str() {
            "bootout" => {
                loaded.store(false, Ordering::SeqCst);
                ok("")
            }
            "print" => {
                if loaded.load(Ordering::SeqCst) {
                    ok("")
                } else {
                    fail("")
                }
            }
            _ => ok(""),
        });
        let st = set_agent_enabled(&r, 501, "com.foo.agent", Path::new("/p.plist"), false).unwrap();
        assert_eq!(st, AgentState::Disabled);
        let verbs: Vec<_> = r.calls().iter().map(|(_, a)| a[0].clone()).collect();
        assert_eq!(verbs[..2], ["disable", "bootout"]);
        assert_eq!(r.calls()[0].1[1], "gui/501/com.foo.agent");
        assert!(r.calls().iter().all(|(p, _)| p == LAUNCHCTL));
    }

    #[test]
    fn disable_reports_when_agent_stays_loaded() {
        let r = Fake::new(|_, _| ok(""));
        let e = set_agent_enabled(&r, 501, "com.foo.agent", Path::new("/p.plist"), false).unwrap_err();
        assert!(e.contains("não pôde ser parado"), "{e}");
        let r = Fake::new(|_, args| if args[0] == "disable" { fail("denied") } else { ok("") });
        assert!(set_agent_enabled(&r, 501, "com.foo.agent", Path::new("/p.plist"), false).is_err());
        assert_eq!(r.calls().len(), 1, "se o disable falha, nada mais roda");
    }

    #[test]
    fn enable_runs_enable_then_bootstrap() {
        let loaded = std::sync::atomic::AtomicBool::new(false);
        let r = Fake::new(move |_, args| match args[0].as_str() {
            "bootstrap" => {
                loaded.store(true, Ordering::SeqCst);
                ok("")
            }
            "print" => {
                if loaded.load(Ordering::SeqCst) {
                    ok("")
                } else {
                    fail("")
                }
            }
            _ => ok(""),
        });
        let st = set_agent_enabled(&r, 501, "com.foo.agent", Path::new("/Users/u/Library/LaunchAgents/a.plist"), true)
            .unwrap();
        assert_eq!(st, AgentState::Active);
        let calls = r.calls();
        let boot = calls.iter().find(|(_, a)| a[0] == "bootstrap").unwrap();
        assert_eq!(boot.1, ["bootstrap", "gui/501", "/Users/u/Library/LaunchAgents/a.plist"]);
        assert_eq!(calls[0].1, ["enable", "gui/501/com.foo.agent"]);
        // Bootstrap que não pega: o agente fica habilitado, porém inativo; sem erro.
        let r = Fake::new(|_, args| {
            if args[0] == "print" || args[0] == "bootstrap" { fail("5: Input/output error") } else { ok("") }
        });
        assert_eq!(set_agent_enabled(&r, 501, "com.foo.agent", Path::new("/p.plist"), true), Ok(AgentState::Inactive));
    }

    #[test]
    fn invalid_label_never_reaches_launchctl() {
        let r = Fake::new(|_, _| ok(""));
        assert!(set_agent_enabled(&r, 501, "../x;y", Path::new("/p.plist"), false).is_err());
        assert!(!bootout(&r, 501, "a b"));
        assert!(!is_loaded(&r, 501, ""));
        assert!(r.calls().is_empty());
    }

    #[test]
    fn login_items_parsing() {
        let out = "Bitwarden\u{1f}/Applications/Bitwarden.app\u{1e}\nGoogle Drive\u{1f}/Applications/Google Drive.app\u{1e}\nSem caminho\u{1f}missing value\u{1e}\n";
        let items = parse_login_items(out);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0], LoginItem { name: "Bitwarden".into(), path: Some("/Applications/Bitwarden.app".into()) });
        assert_eq!(items[1].name, "Google Drive");
        assert_eq!(items[2].path, None);
        assert!(parse_login_items("").is_empty());
        assert!(parse_login_items("lixo sem separadores").is_empty());
    }

    #[test]
    fn login_list_detects_missing_automation() {
        let r =
            Fake::new(|_, _| fail("execution error: Not authorized to send Apple events to System Events. (-1743)"));
        assert_eq!(list_login_items(&r), Err(LoginError::NeedsAutomation));
        let r = Fake::new(|_, _| fail("some other failure"));
        assert!(matches!(list_login_items(&r), Err(LoginError::Failed(_))));
        let r = Fake::new(|_, _| CmdOut { timed_out: true, ..Default::default() });
        assert!(matches!(list_login_items(&r), Err(LoginError::Failed(_))));
        let r = Fake::new(|_, _| ok("A\u{1f}/A.app\u{1e}"));
        assert_eq!(list_login_items(&r).unwrap().len(), 1);
        // O script de listagem é fixo.
        let args = r.calls()[0].1.clone();
        assert_eq!(args.iter().filter(|x| *x == "-e").count(), LIST_SCRIPT.len());
        assert!(!args.contains(&"--".to_string()));
    }

    #[test]
    fn login_removal_passes_name_as_argv_only() {
        let name = "Evil\" & (do shell script \"id\") & \"";
        let listing = format!("{name}\u{1f}/Applications/X.app\u{1e}");
        let item = LoginItem { name: name.into(), path: Some("/Applications/X.app".into()) };
        let r = Fake::new(
            move |_, args| if args.iter().any(|x| x.contains("delete login item")) { ok("") } else { ok(&listing) },
        );
        remove_login_item(&r, &item).unwrap();
        let calls = r.calls();
        let del = &calls[1].1;
        // O nome aparece uma única vez, como argumento depois de `--`; nunca dentro de um `-e`.
        let dashdash = del.iter().position(|x| x == "--").unwrap();
        assert_eq!(del[dashdash + 1], name);
        assert_eq!(dashdash + 2, del.len());
        for (i, x) in del.iter().enumerate() {
            if i > 0 && del[i - 1] == "-e" {
                assert!(!x.contains("Evil") && !x.contains("do shell script"), "script contaminado: {x}");
            }
        }
        assert!(del.iter().any(|x| x == "tell application \"System Events\" to delete login item (item 1 of argv)"));
        assert_eq!(del[0], "-e");
    }

    #[test]
    fn login_removal_refuses_ambiguous_or_changed_items() {
        let two = "Dup\u{1f}/A.app\u{1e}Dup\u{1f}/B.app\u{1e}";
        let r = Fake::new(move |_, _| ok(two));
        let item = LoginItem { name: "Dup".into(), path: Some("/A.app".into()) };
        assert!(remove_login_item(&r, &item).unwrap_err().contains("mais de um"));
        assert_eq!(r.calls().len(), 1, "só listou");
        let one = "Dup\u{1f}/B.app\u{1e}";
        let r = Fake::new(move |_, _| ok(one));
        assert!(remove_login_item(&r, &item).unwrap_err().contains("mudou"));
        let r = Fake::new(|_, _| ok(""));
        assert!(remove_login_item(&r, &item).unwrap_err().contains("não existe mais"));
    }

    #[test]
    fn snapshots_parsing() {
        let out = "Snapshots for disk /:\ncom.apple.TimeMachine.2026-10-29-220903.local\ncom.apple.TimeMachine.2026-10-28-101500.local\n";
        let s = parse_snapshots(out);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].date.as_deref(), Some("2026-10-29T22:09:03"));
        assert_eq!(s[1].name, "com.apple.TimeMachine.2026-10-28-101500.local");
        assert!(parse_snapshots("Snapshots for disk /:\n").is_empty());
        assert!(parse_snapshots("Thinned local snapshots:\n").is_empty());
        let odd = parse_snapshots("com.apple.os.update-ABCDEF\n");
        assert_eq!((odd.len(), odd[0].date.clone()), (1, None));
    }

    #[test]
    fn thin_uses_the_documented_arguments() {
        let r = Fake::new(|_, _| ok("Thinned local snapshots:\ncom.apple.TimeMachine.2026-10-29-220903.local\n"));
        let thinned = thin_snapshots(&r).unwrap();
        assert_eq!(thinned.len(), 1);
        assert_eq!(
            r.calls()[0],
            (TMUTIL.to_string(), vec!["thinlocalsnapshots".into(), "/".into(), "999999999999".into(), "4".into()])
        );
        let r = Fake::new(|_, _| fail("Must be root"));
        assert!(thin_snapshots(&r).is_err());
        assert!(list_snapshots(&r).is_err());
    }

    #[test]
    fn pmset_parsing() {
        let discharging = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=6815843)\t87%; discharging; 5:12 remaining present: true\n";
        let b = parse_pmset_batt(discharging).unwrap();
        assert_eq!((b.percent, b.on_ac, b.state, b.remaining_min), (87, false, BatteryState::Discharging, Some(312)));
        let charged = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=6815843)\t100%; charged; 0:00 remaining present: true\n";
        let b = parse_pmset_batt(charged).unwrap();
        assert_eq!((b.percent, b.on_ac, b.state, b.remaining_min), (100, true, BatteryState::Charged, Some(0)));
        let charging =
            "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t43%; charging; 1:02 remaining present: true\n";
        let b = parse_pmset_batt(charging).unwrap();
        assert_eq!((b.state, b.remaining_min), (BatteryState::Charging, Some(62)));
        let none = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t9%; discharging; (no estimate) present: true\n";
        let b = parse_pmset_batt(none).unwrap();
        assert_eq!((b.percent, b.remaining_min), (9, None));
        let hold =
            "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; AC attached; not charging present: true\n";
        assert_eq!(parse_pmset_batt(hold).unwrap().state, BatteryState::Idle);
        assert!(parse_pmset_batt("Now drawing from 'AC Power'\n").is_none());
        assert!(parse_pmset_batt("").is_none());
    }

    #[test]
    fn ioreg_parsing_uses_top_level_lines_only() {
        let out = "    | |   \"BatteryData\" = {\"DesignCapacity\"=1,\"CycleCount\"=7}\n      \"NominalChargeCapacity\" = 4902\n      \"MaxCapacity\" = 100\n      \"DesignCapacity\" = 6075\n      \"CycleCount\" = 588\n      \"AppleRawMaxCapacity\" = 4752\n";
        assert_eq!(parse_ioreg_battery(out), (Some(588), Some(80)));
        let intel = "      \"AppleRawMaxCapacity\" = 5000\n      \"DesignCapacity\" = 5000\n      \"CycleCount\" = 3\n";
        assert_eq!(parse_ioreg_battery(intel), (Some(3), Some(100)));
        assert_eq!(parse_ioreg_battery(""), (None, None));
    }

    #[test]
    fn ps_parsing_and_aggregation() {
        let out = "  PID    RSS COMM\n    1  22288 /sbin/launchd\n  500 900000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n  501 300000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper\n  600 500000 /Applications/Slack.app/Contents/MacOS/Slack\n  700   9000 /usr/libexec/logd\n  bad line\n";
        let rows = parse_ps(out);
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[1], (500, 900000, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into()));
        let top = top_consumers(&rows, 3);
        assert_eq!(top.len(), 3);
        assert_eq!((top[0].name.as_str(), top[0].count, top[0].rss), ("Google Chrome", 2, 1_200_000 * 1024));
        assert_eq!(top[1].name, "Slack");
        assert_eq!(top[2].name, "launchd");
        assert!(top_consumers(&[], 5).is_empty());
    }

    #[test]
    fn memory_math_matches_activity_monitor() {
        let page = 16384;
        let v = VmPages { internal: 300_000, purgeable: 6_000, wired: 137_000, compressed: 166_000 };
        let m = memory_from(17_179_869_184, page, v, Pressure::Normal);
        assert_eq!(m.app, 294_000 * page);
        assert_eq!(m.used, m.app + m.wired + m.compressed);
        assert_eq!(m.available, m.total - m.used);
        // Nunca passa do total, mesmo com contagens absurdas.
        let m = memory_from(1000, 1, VmPages { internal: 5000, ..Default::default() }, Pressure::Critical);
        assert_eq!((m.used, m.available), (1000, 0));
        assert_eq!(Pressure::from_level(1), Pressure::Normal);
        assert_eq!(Pressure::from_level(2), Pressure::Warning);
        assert_eq!(Pressure::from_level(4), Pressure::Critical);
        assert_eq!(Pressure::from_level(0), Pressure::Unknown);
    }

    #[test]
    fn cpu_usage_between_ticks() {
        let a = CpuTicks { user: 100, system: 100, idle: 800, nice: 0 };
        let b = CpuTicks { user: 150, system: 130, idle: 920, nice: 0 };
        let u = b.usage_since(&a).unwrap();
        assert!((u - 40.0).abs() < 1e-9, "{u}");
        assert_eq!(a.usage_since(&a), None);
        // Contador de 32 bits que deu a volta.
        let wrap_prev = CpuTicks { user: u32::MAX - 9, system: 0, idle: 0, nice: 0 };
        let wrap_now = CpuTicks { user: 10, system: 0, idle: 20, nice: 0 };
        let u = wrap_now.usage_since(&wrap_prev).unwrap();
        assert!((u - 50.0).abs() < 1e-9, "{u}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fast_sample_reads_this_machine() {
        let t = Instant::now();
        let f = sample_fast();
        let took = t.elapsed();
        let m = f.memory.expect("memória");
        assert!(m.total > 1 << 30 && m.used > 0 && m.used <= m.total);
        assert!(f.cpu.cores >= 1 && f.cpu.load1 >= 0.0);
        assert!(f.uptime_secs.is_some_and(|u| u > 0));
        assert!(f.swap.is_some());
        assert!(cpu_ticks().is_some());
        assert!(took < Duration::from_millis(200), "amostra rápida demorou {took:?}");
    }

    /// Leitura real, somente leitura (launchctl print, codesign, osascript de listagem, tmutil list, ps, pmset):
    /// `cargo test -p limpa-core real_machine -- --ignored --nocapture`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "lê o Mac real; rodar manualmente"]
    fn real_machine_report() {
        let home = std::env::home_dir().unwrap();
        let dirs = AgentDirs::for_home(&home);
        let t = Instant::now();
        let agents = scan_agents(&dirs, current_uid(), "br.com.limpae", &SystemRunner, &AtomicBool::new(false));
        println!("agentes: {} em {:?}", agents.len(), t.elapsed());
        for g in &agents {
            println!(
                "  {:?} {} | dono={:?} | prog={:?} | sig={:?} {:?} | estado={:?} | alt={} | RaL={} KA={}",
                g.scope,
                g.label,
                g.owner.as_ref().map(|o| &o.name),
                g.program,
                g.signature.status,
                g.signature.signer,
                g.state,
                g.manageable,
                g.run_at_load,
                g.keep_alive
            );
        }
        let t = Instant::now();
        println!("login: {:?} em {:?}", list_login_items(&SystemRunner), t.elapsed());
        let t = Instant::now();
        println!("snapshots: {:?} em {:?}", list_snapshots(&SystemRunner), t.elapsed());
        let t = Instant::now();
        println!("top: {:?} em {:?}", sample_top(&SystemRunner, 5), t.elapsed());
        let t = Instant::now();
        println!("bateria: {:?} em {:?}", sample_battery(&SystemRunner), t.elapsed());
        println!("desgaste: {:?}", sample_battery_wear(&SystemRunner));
        let before = cpu_ticks().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let t = Instant::now();
        let mut f = sample_fast();
        let tick = t.elapsed();
        f.cpu.usage = cpu_ticks().unwrap().usage_since(&before);
        println!("fast ({tick:?}): {f:#?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_runner_captures_and_times_out() {
        let o = SystemRunner.run("/bin/echo", &[a("oi")], Duration::from_secs(5)).unwrap();
        assert!(o.ok());
        assert_eq!(o.stdout.trim(), "oi");
        let o = SystemRunner.run("/bin/sh", &[a("-c"), a("echo err >&2; exit 3")], Duration::from_secs(5)).unwrap();
        assert_eq!((o.code, o.stderr.trim()), (Some(3), "err"));
        let t = Instant::now();
        let o = SystemRunner.run("/bin/sleep", &[a("30")], Duration::from_millis(150)).unwrap();
        assert!(o.timed_out && o.code.is_none());
        assert!(t.elapsed() < Duration::from_secs(5));
        assert!(SystemRunner.run("/nonexistent/bin", &[], Duration::from_secs(1)).is_err());
    }
}
