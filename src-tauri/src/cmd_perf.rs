//! Performance commands: background agents, login items, live monitor and Time Machine snapshots.
//! The UI only passes ids. Agent labels, plist paths and login item names are kept here and re-read from disk at
//! action time; only user-level agents can be changed, everything under `/Library` is listed read-only.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use limpa_core::perf::{
    self, AgentDirs, AgentState, Battery, CpuTicks, Fast, LoginError, LoginItem, Proc, Scope, Signature, Snapshot,
    SystemRunner,
};
use limpa_core::running::app_icon_png;
use limpa_core::{Group, Item, Policy};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::{ERR_CANCELLED, OWN_BUNDLE_ID, Shared, assemble, blocking, dedup, run_removal_with, run_scan};
use crate::dto::{OutcomeDto, RemoveResult};
use crate::registry::Task;
use crate::state::{AppState, lock};

/// Agents the user may toggle or remove. Registered with `Policy::MoveToTrash` on the plist file.
const TASK_AGENTS: Task = Task::Other("agents");
const ICON_PX: u32 = 96;
const TOP_N: usize = 5;
const TOP_TTL: Duration = Duration::from_secs(5);
const BATTERY_TTL: Duration = Duration::from_secs(15);
const WEAR_TTL: Duration = Duration::from_secs(300);

/// Per-scan data that is not a registry item: login items and the app path behind each icon.
#[derive(Default)]
struct PerfStore {
    logins: HashMap<u64, LoginItem>,
    icon_src: HashMap<u64, PathBuf>,
    icons: HashMap<u64, Option<String>>,
}

static STORE: LazyLock<Mutex<PerfStore>> = LazyLock::new(Mutex::default);
/// Serializes launchd / System Events changes so two clicks never interleave their steps.
static ACTION: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerDto {
    pub name: String,
    pub bundle_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDto {
    pub id: u64,
    pub label: String,
    /// Plist file name.
    pub file: String,
    pub program: Option<String>,
    pub scope: Scope,
    pub manageable: bool,
    pub state: Option<AgentState>,
    pub run_at_load: bool,
    pub keep_alive: bool,
    pub signature: Signature,
    pub signer: Option<String>,
    pub owner: Option<OwnerDto>,
    /// Unsigned, invalid signature or missing program.
    pub flagged: bool,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginDto {
    pub id: u64,
    pub name: String,
    pub path: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    /// System Events refused (no Automation consent): the UI explains how to grant it.
    pub needs_automation: bool,
    pub error: Option<String>,
    pub items: Vec<LoginDto>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotsDto {
    pub items: Vec<Snapshot>,
    /// `tmutil thinlocalsnapshots` works without root (checked on macOS 26); the UI offers the action.
    pub can_thin: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorDto {
    #[serde(flatten)]
    pub fast: Fast,
    pub battery: Option<Battery>,
    pub top: Vec<Proc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfScan {
    pub agents: Vec<AgentDto>,
    pub login: LoginResult,
    pub snapshots: SnapshotsDto,
    pub monitor: MonitorDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleResult {
    pub id: u64,
    pub state: AgentState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinResult {
    pub removed: usize,
    pub snapshots: Vec<Snapshot>,
}

// ---------------------------------------------------------------------------------------------------------------
// Monitor: kernel numbers every tick; `ps`, `pmset` and `ioreg` refresh in the background on a slower clock
// ---------------------------------------------------------------------------------------------------------------

struct Slow {
    battery: Option<Battery>,
    wear: (Option<u32>, Option<u8>),
    top: Vec<Proc>,
    battery_at: Option<Instant>,
    wear_at: Option<Instant>,
    top_at: Option<Instant>,
    busy: bool,
}

static SLOW: Mutex<Slow> = Mutex::new(Slow {
    battery: None,
    wear: (None, None),
    top: Vec::new(),
    battery_at: None,
    wear_at: None,
    top_at: None,
    busy: false,
});
static PREV_TICKS: Mutex<Option<CpuTicks>> = Mutex::new(None);

fn stale(at: Option<Instant>, ttl: Duration) -> bool {
    at.is_none_or(|t| t.elapsed() >= ttl)
}

/// Clears `busy` when the refresh ends, panics included.
struct BusyGuard;

impl Drop for BusyGuard {
    fn drop(&mut self) {
        lock(&SLOW).busy = false;
    }
}

/// Refreshes whatever is past its TTL. Returns `false` when another refresh is already running.
fn refresh_slow() -> bool {
    let (top, battery, wear) = {
        let mut s = lock(&SLOW);
        if s.busy {
            return false;
        }
        let due = (stale(s.top_at, TOP_TTL), stale(s.battery_at, BATTERY_TTL), stale(s.wear_at, WEAR_TTL));
        if !(due.0 || due.1 || due.2) {
            return true;
        }
        s.busy = true;
        due
    };
    let _guard = BusyGuard;
    let r = &SystemRunner;
    let top = top.then(|| perf::sample_top(r, TOP_N));
    let battery = battery.then(|| perf::sample_battery(r));
    let has_battery = battery.as_ref().map_or_else(|| lock(&SLOW).battery.is_some(), Option::is_some);
    let wear = (wear && has_battery).then(|| perf::sample_battery_wear(r));
    let mut s = lock(&SLOW);
    if let Some(t) = top {
        s.top = t;
        s.top_at = Some(Instant::now());
    }
    if let Some(b) = battery {
        s.battery = b;
        s.battery_at = Some(Instant::now());
    }
    if let Some(w) = wear {
        s.wear = w;
        s.wear_at = Some(Instant::now());
    } else if !has_battery {
        s.wear_at = Some(Instant::now());
    }
    true
}

fn cpu_usage() -> Option<f64> {
    let now = perf::cpu_ticks()?;
    let prev = lock(&PREV_TICKS).replace(now)?;
    now.usage_since(&prev)
}

/// One monitor sample. Never runs a subprocess on the caller's thread unless `wait` (the first, warm-up call).
fn monitor(wait: bool) -> MonitorDto {
    let mut fast = perf::sample_fast();
    fast.cpu.usage = cpu_usage();
    let due = {
        let s = lock(&SLOW);
        !s.busy && (stale(s.top_at, TOP_TTL) || stale(s.battery_at, BATTERY_TTL) || stale(s.wear_at, WEAR_TTL))
    };
    if due {
        if wait {
            refresh_slow();
        } else {
            std::thread::spawn(refresh_slow);
        }
    }
    let s = lock(&SLOW);
    let battery = s.battery.clone().map(|b| Battery { cycles: s.wear.0, health_pct: s.wear.1, ..b });
    MonitorDto { fast, battery, top: s.top.clone() }
}

#[tauri::command]
pub async fn perf_monitor() -> Result<MonitorDto, String> {
    blocking(|| Ok(monitor(false))).await
}

// ---------------------------------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------------------------------

fn agent_dto(id: u64, a: &perf::Agent) -> AgentDto {
    AgentDto {
        id,
        label: a.label.clone(),
        file: a.plist.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        program: a.program.as_ref().map(|p| p.to_string_lossy().into_owned()),
        scope: a.scope,
        manageable: a.manageable,
        state: a.state,
        run_at_load: a.run_at_load,
        keep_alive: a.keep_alive,
        signature: a.signature.status,
        signer: a.signature.signer.clone(),
        owner: a.owner.as_ref().map(|o| OwnerDto { name: o.name.clone(), bundle_id: o.bundle_id.clone() }),
        flagged: a.flagged(),
        note: a.note.clone(),
    }
}

/// Registers the manageable (user) agents as trashable items under `TASK_AGENTS`; read-only ones only get an id.
fn register_agents(st: &AppState, agents: &[perf::Agent]) -> Vec<AgentDto> {
    let items: Vec<Item> = agents
        .iter()
        .filter(|a| a.manageable)
        .map(|a| {
            let size = std::fs::symlink_metadata(&a.plist).map_or(0, |m| m.len());
            Item::new(a.plist.clone(), size, Policy::MoveToTrash)
        })
        .collect();
    let group = Group {
        id: "agents".into(),
        title: "Agentes em segundo plano".into(),
        description: "Agentes de inicialização do usuário.".into(),
        items,
    };
    let mut reg = lock(&st.registry);
    let mut ids = reg.replace(TASK_AGENTS, vec![group]).into_iter().flat_map(|g| g.items).map(|i| i.id);
    let dtos: Vec<AgentDto> = agents
        .iter()
        .map(|a| {
            let registered = if a.manageable { ids.next() } else { None };
            agent_dto(registered.unwrap_or_else(|| reg.alloc_id()), a)
        })
        .collect();
    drop(reg);
    let mut store = lock(&STORE);
    store.icon_src.clear();
    store.icons.clear();
    for (dto, a) in dtos.iter().zip(agents) {
        if let Some(o) = &a.owner {
            store.icon_src.insert(dto.id, o.path.clone());
        }
    }
    dtos
}

fn register_logins(st: &AppState, result: Result<Vec<LoginItem>, LoginError>) -> LoginResult {
    let mut store = lock(&STORE);
    store.logins.clear();
    match result {
        Ok(items) => {
            let mut reg = lock(&st.registry);
            let dtos = items
                .into_iter()
                .map(|it| {
                    let id = reg.alloc_id();
                    let dto = LoginDto {
                        id,
                        name: it.name.clone(),
                        path: it.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
                    };
                    if let Some(p) = it.path.as_ref().filter(|p| p.extension().is_some_and(|e| e == "app")) {
                        store.icon_src.insert(id, p.clone());
                    }
                    store.logins.insert(id, it);
                    dto
                })
                .collect();
            LoginResult { needs_automation: false, error: None, items: dtos }
        }
        Err(LoginError::NeedsAutomation) => LoginResult { needs_automation: true, ..Default::default() },
        Err(LoginError::Failed(_)) => {
            LoginResult { error: Some("Não foi possível listar os itens de login.".into()), ..Default::default() }
        }
    }
}

#[tauri::command]
pub async fn perf_scan(app: AppHandle, state: State<'_, Shared>) -> Result<PerfScan, String> {
    run_scan(app, &state, "perf", |st, p| {
        let r = &SystemRunner;
        let dirs = AgentDirs::for_home(&st.home);
        p.report(&dirs.user, 0);
        // Agents (codesign per program), login items (osascript) and snapshots (tmutil) are independent waits.
        let (agents, logins, snaps) = std::thread::scope(|sc| {
            let logins = sc.spawn(|| perf::list_login_items(r));
            let snaps = sc.spawn(|| perf::list_snapshots(r));
            let agents = perf::scan_agents(&dirs, perf::current_uid(), OWN_BUNDLE_ID, r, p.cancel_flag());
            (agents, logins.join(), snaps.join())
        });
        if p.cancelled() {
            return Err(ERR_CANCELLED.into());
        }
        let logins = logins.unwrap_or_else(|_| Err(LoginError::Failed("falha interna".into())));
        let snaps = snaps.unwrap_or_else(|_| Err("Não foi possível listar os snapshots locais.".into()));
        let agents = register_agents(st, &agents);
        let login = register_logins(st, logins);
        let snapshots = match snaps {
            Ok(items) => SnapshotsDto { items, can_thin: true, error: None },
            Err(e) => SnapshotsDto { items: Vec::new(), can_thin: true, error: Some(e) },
        };
        Ok(PerfScan { agents, login, snapshots, monitor: monitor(true) })
    })
    .await
}

/// PNG data URL of the app behind an agent or login item (`None` when it has no renderable icon).
#[tauri::command]
pub async fn perf_icon(id: u64) -> Result<Option<String>, String> {
    blocking(move || {
        let Some(path) = lock(&STORE).icon_src.get(&id).cloned() else { return Ok(None) };
        if let Some(hit) = lock(&STORE).icons.get(&id) {
            return Ok(hit.clone());
        }
        let url = app_icon_png(&path, ICON_PX).map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png)));
        let mut store = lock(&STORE);
        // The scan may have been replaced while rendering; don't cache under an id that no longer exists.
        if store.icon_src.contains_key(&id) {
            store.icons.insert(id, url.clone());
        }
        Ok(url)
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------------------

/// The registered item for `id`, only if it belongs to the last agents scan.
fn agent_item(st: &AppState, id: u64) -> Result<Item, String> {
    let mut resolved = lock(&st.registry).resolve_task(TASK_AGENTS, &[id]);
    resolved
        .items
        .pop()
        .map(|(_, it)| it)
        .ok_or_else(|| "Agente não encontrado. Analise de novo para atualizar a lista.".to_string())
}

fn same_file(item: &Item) -> bool {
    let Some(ident) = item.ident else { return true };
    std::fs::symlink_metadata(&item.path).is_ok_and(|m| (m.dev(), m.ino()) == ident)
}

/// Everything that must still hold right before launchd is touched; returns the label read from the file now.
fn validate_agent(st: &AppState, item: &Item) -> Result<String, String> {
    let dirs = AgentDirs::for_home(&st.home);
    if !same_file(item) {
        return Err("o arquivo do agente mudou desde a análise".into());
    }
    perf::user_agent_label(&dirs.user, &item.path, OWN_BUNDLE_ID).map_err(str::to_string)
}

fn toggle(st: &AppState, id: u64, enable: bool) -> Result<ToggleResult, String> {
    let _serial = lock(&ACTION);
    let item = agent_item(st, id)?;
    let label = validate_agent(st, &item).map_err(|e| format!("Não foi possível alterar o agente: {e}."))?;
    let result = perf::set_agent_enabled(&SystemRunner, perf::current_uid(), &label, &item.path, enable);
    st.log.record(if enable { "agente-ativar" } else { "agente-desativar" }, &item.path, result.is_ok(), 0);
    result.map(|state| ToggleResult { id, state })
}

#[tauri::command]
pub async fn agent_toggle(state: State<'_, Shared>, id: u64, enable: bool) -> Result<ToggleResult, String> {
    let st = std::sync::Arc::clone(state.inner());
    blocking(move || toggle(&st, id, enable)).await
}

fn remove_agents(st: &AppState, ids: &[u64]) -> RemoveResult {
    let _serial = lock(&ACTION);
    let resolved = lock(&st.registry).resolve_task(TASK_AGENTS, ids);
    let mut by_id: HashMap<u64, OutcomeDto> = HashMap::new();
    let mut ready = Vec::new();
    for (id, item) in resolved.items {
        match validate_agent(st, &item) {
            Ok(label) => {
                // Stop it first so it does not keep running (or restart) after its plist is gone.
                let stopped = perf::bootout(&SystemRunner, perf::current_uid(), &label);
                st.log.record("agente-parar", &item.path, stopped, 0);
                ready.push((id, item));
            }
            Err(e) => {
                st.log.record("recusado", &item.path, false, 0);
                by_id.insert(id, OutcomeDto::failed(id, e));
            }
        }
    }
    by_id.extend(run_removal_with(st, &ready, limpa_core::remove::RemoveOptions::default()));
    by_id.extend(resolved.rejected.into_iter().map(|(id, why)| (id, OutcomeDto::failed(id, why))));
    assemble(&dedup(ids), by_id)
}

#[tauri::command]
pub async fn agent_remove(state: State<'_, Shared>, ids: Vec<u64>) -> Result<RemoveResult, String> {
    let st = std::sync::Arc::clone(state.inner());
    blocking(move || Ok(remove_agents(&st, &ids))).await
}

fn remove_logins(st: &AppState, ids: &[u64]) -> RemoveResult {
    let _serial = lock(&ACTION);
    let by_id = dedup(ids)
        .into_iter()
        .map(|id| {
            let Some(item) = lock(&STORE).logins.get(&id).cloned() else {
                return (id, OutcomeDto::failed(id, "item de login desconhecido; analise de novo"));
            };
            let result = perf::remove_login_item(&SystemRunner, &item);
            let logged = item.path.clone().unwrap_or_else(|| PathBuf::from(&item.name));
            st.log.record("item-de-login-remover", &logged, result.is_ok(), 0);
            match result {
                Ok(()) => {
                    lock(&STORE).logins.remove(&id);
                    (id, OutcomeDto::done(id, 0))
                }
                Err(e) => (id, OutcomeDto::failed(id, e)),
            }
        })
        .collect();
    assemble(&dedup(ids), by_id)
}

#[tauri::command]
pub async fn login_item_remove(state: State<'_, Shared>, ids: Vec<u64>) -> Result<RemoveResult, String> {
    let st = std::sync::Arc::clone(state.inner());
    blocking(move || Ok(remove_logins(&st, &ids))).await
}

#[tauri::command]
pub async fn tm_thin(state: State<'_, Shared>) -> Result<ThinResult, String> {
    let st = std::sync::Arc::clone(state.inner());
    blocking(move || {
        let _serial = lock(&ACTION);
        let result = perf::thin_snapshots(&SystemRunner);
        st.log.record("snapshots-afinar", Path::new("/"), result.is_ok(), 0);
        let removed = result?.len();
        let snapshots = perf::list_snapshots(&SystemRunner).unwrap_or_default();
        Ok(ThinResult { removed, snapshots })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    /// Scratch directory under the system temp dir, removed on drop (src-tauri has no `tempfile` dev-dependency).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!("limpae-perf-test-{}-{n}", std::process::id()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_plist(dir: &Path, name: &str, label: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        fs::write(
            &p,
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array></dict></plist>"
            ),
        )
        .unwrap();
        p
    }

    fn agent(plist: PathBuf, label: &str, manageable: bool) -> perf::Agent {
        perf::Agent {
            plist,
            label: label.into(),
            scope: if manageable { Scope::User } else { Scope::SystemDaemon },
            program: Some("/usr/bin/true".into()),
            run_at_load: true,
            keep_alive: false,
            owner: None,
            signature: perf::SignatureInfo { status: Signature::Valid, signer: Some("Software Signing".into()) },
            state: manageable.then_some(AgentState::Active),
            manageable,
            note: (!manageable).then(|| perf::NOTE_SYSTEM.to_string()),
        }
    }

    fn state_in(dir: &Path) -> AppState {
        AppState::with_home(dir.to_path_buf())
    }

    #[test]
    fn agent_dto_keys() {
        let a = agent("/Users/u/Library/LaunchAgents/com.x.plist".into(), "com.x", true);
        let v = serde_json::to_value(agent_dto(7, &a)).unwrap();
        assert_eq!(
            v,
            json!({
                "id": 7, "label": "com.x", "file": "com.x.plist", "program": "/usr/bin/true", "scope": "user",
                "manageable": true, "state": "active", "runAtLoad": true, "keepAlive": false,
                "signature": "valid", "signer": "Software Signing", "owner": null, "flagged": false, "note": null
            })
        );
        let sys =
            serde_json::to_value(agent_dto(8, &agent("/Library/LaunchDaemons/x.plist".into(), "x", false))).unwrap();
        assert_eq!(sys["scope"], "systemDaemon");
        assert!(sys["state"].is_null());
    }

    #[test]
    fn only_user_agents_get_registry_ids_and_only_they_resolve() {
        let dir = TempDir::new();
        let st = state_in(dir.path());
        let user_dir = dir.path().join("Library/LaunchAgents");
        let p = write_plist(&user_dir, "com.x.plist", "com.x");
        let agents = vec![agent(p, "com.x", true), agent("/Library/LaunchDaemons/y.plist".into(), "y", false)];
        let dtos = register_agents(&st, &agents);
        assert_eq!(dtos.len(), 2);
        assert_ne!(dtos[0].id, dtos[1].id);
        assert!(agent_item(&st, dtos[0].id).is_ok());
        // Read-only item: has an id (for its icon) but is not an agent the UI can act on.
        assert!(agent_item(&st, dtos[1].id).is_err());
        assert!(agent_item(&st, 999_999).is_err());
        // An id from another task never resolves as an agent.
        let other = lock(&st.registry).replace(
            Task::Junk,
            vec![Group {
                id: "j".into(),
                title: "j".into(),
                description: String::new(),
                items: vec![Item::new(user_dir.join("com.x.plist"), 1, Policy::MoveToTrash)],
            }],
        );
        assert!(agent_item(&st, other[0].items[0].id).is_err());
    }

    #[test]
    fn validation_rereads_the_label_and_detects_swaps() {
        let dir = TempDir::new();
        let st = state_in(dir.path());
        let user_dir = dir.path().join("Library/LaunchAgents");
        let p = write_plist(&user_dir, "com.x.plist", "com.x");
        let item = Item::new(p.clone(), 1, Policy::MoveToTrash);
        assert_eq!(validate_agent(&st, &item), Ok("com.x".to_string()));
        // The file now carries a hostile label: refused, never passed to launchctl.
        write_plist(&user_dir, "com.x.plist", "com.x; rm -rf ~");
        assert!(validate_agent(&st, &item).is_err());
        // Swapped for a different file (another inode): refused.
        write_plist(&user_dir, "com.x.plist", "com.x");
        let tracked = Item::new(p.clone(), 1, Policy::MoveToTrash);
        let other = write_plist(&user_dir, "other.plist", "com.other");
        fs::rename(&other, &p).unwrap();
        assert_eq!(validate_agent(&st, &tracked), Err("o arquivo do agente mudou desde a análise".to_string()));
        // Outside the user's LaunchAgents folder.
        let outside = write_plist(dir.path(), "a.plist", "com.out");
        assert!(validate_agent(&st, &Item::new(outside, 1, Policy::MoveToTrash)).is_err());
    }

    #[test]
    fn toggle_and_remove_refuse_unknown_ids_without_touching_launchd() {
        let dir = TempDir::new();
        let st = state_in(dir.path());
        assert!(toggle(&st, 12345, false).is_err());
        let r = remove_agents(&st, &[12345, 12345]);
        assert_eq!(r.outcomes.len(), 1);
        assert!(!r.outcomes[0].ok);
        let r = remove_logins(&st, &[777]);
        assert!(!r.outcomes[0].ok);
    }

    #[test]
    fn login_results_serialize_for_both_outcomes() {
        let dir = TempDir::new();
        let st = state_in(dir.path());
        let ok =
            register_logins(&st, Ok(vec![LoginItem { name: "A".into(), path: Some("/Applications/A.app".into()) }]));
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v["needsAutomation"], false);
        assert_eq!(v["items"][0]["name"], "A");
        assert_eq!(v["items"][0]["path"], "/Applications/A.app");
        let denied = register_logins(&st, Err(LoginError::NeedsAutomation));
        assert!(denied.needs_automation && denied.items.is_empty());
        assert!(lock(&STORE).logins.is_empty(), "a nova análise esquece os itens antigos");
        let failed = register_logins(&st, Err(LoginError::Failed("x".into())));
        assert!(failed.error.is_some() && !failed.needs_automation);
    }

    #[test]
    fn stale_ttl() {
        assert!(stale(None, Duration::from_secs(5)));
        assert!(!stale(Some(Instant::now()), Duration::from_secs(5)));
        assert!(stale(Some(Instant::now()), Duration::ZERO));
    }

    #[test]
    fn monitor_tick_is_cheap_and_has_the_wire_shape() {
        // Warm up the slow cache once, as the scan does.
        let first = monitor(true);
        let t = Instant::now();
        let m = monitor(false);
        let took = t.elapsed();
        eprintln!("monitor tick: {took:?}");
        let v = serde_json::to_value(&m).unwrap();
        for k in ["memory", "swap", "cpu", "uptimeSecs", "battery", "top"] {
            assert!(v.get(k).is_some(), "falta {k}");
        }
        assert!(v["memory"]["pressure"].is_string());
        assert!(v["cpu"]["cores"].as_u64().unwrap() >= 1);
        assert!(took < Duration::from_millis(50), "tick demorou {took:?}");
        let _ = first;
        // Second tick has a CPU usage figure (delta between two reads).
        assert!(v["cpu"]["usage"].is_null() || v["cpu"]["usage"].as_f64().is_some());
    }
}
