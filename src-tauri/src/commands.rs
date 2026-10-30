//! Tauri commands. Every heavy call runs on the blocking pool; the UI only passes ids, never paths.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use limpa_core::apps::{find_leftovers, list_apps as core_list_apps};
use limpa_core::disk::disk_info;
use limpa_core::fda::has_full_disk_access;
use limpa_core::junk::scan_junk as core_scan_junk;
use limpa_core::large::scan_large as core_scan_large;
use limpa_core::remove::{SystemRemover, remove_items, trash_entries};
use limpa_core::running::{app_icon_png, cache_in_use, running_bundle_ids, running_keys};
use limpa_core::settings::Settings;
use limpa_core::trashes::external_trash_entries;
use limpa_core::{Group, Item, Policy, Progress};
use tauri::{AppHandle, Emitter, State};

use crate::dto::{AppDto, DiskOverview, OutcomeDto, ProgressEvent, RemoveResult, ScanResult};
use crate::registry::{ERR_UNKNOWN_ITEM, Task};
use crate::state::{AppState, lock};

type Shared = Arc<AppState>;

const OWN_BUNDLE_ID: &str = "br.com.limpaemeo";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const ERR_CANCELLED: &str = "Varredura cancelada.";
const ERR_APP_GONE: &str = "App não encontrado. Atualize a lista de apps.";
const ERR_APP_KEPT: &str = "mantido porque o app não pôde ser removido";
const ERR_APP_OPEN: &str = "o app dono deste cache está aberto; feche-o e tente de novo";
const NOTE_OTHER_COPY: &str = "Outra cópia deste app está instalada";

/// A `~/Library/Caches` entry, deleted permanently, whose owner app is running right now.
fn cache_of_running_app(item: &Item, keys: &std::collections::HashSet<String>) -> bool {
    matches!(&item.policy, Policy::DeleteJunk { root } if root.ends_with("Library/Caches"))
        && cache_in_use(&item.name, keys)
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "A operação foi interrompida de forma inesperada.".to_string())?
}

/// Registers a cancel flag in `AppState::active` for the lifetime of a scan; unregisters on drop, panics included.
struct ScanSession {
    state: Shared,
    flag: Arc<std::sync::atomic::AtomicBool>,
}

impl ScanSession {
    fn new(state: &Shared) -> Self {
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        lock(&state.active).push(Arc::clone(&flag));
        Self { state: Arc::clone(state), flag }
    }

    /// `Progress` that emits `scan-progress` at most every 100 ms.
    fn progress(&self, app: &AppHandle, task: &'static str) -> Progress {
        let app = app.clone();
        let last: Mutex<Option<Instant>> = Mutex::new(None);
        Progress::new(Arc::clone(&self.flag), move |path, bytes| {
            // Called from many scan threads; skipping when contended is fine, it is only a progress hint.
            let Ok(mut last) = last.try_lock() else { return };
            if last.is_some_and(|t| t.elapsed() < PROGRESS_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
            let _ = app.emit("scan-progress", ProgressEvent { task, path: path.to_string_lossy().into_owned(), bytes });
        })
    }
}

impl Drop for ScanSession {
    fn drop(&mut self) {
        lock(&self.state.active).retain(|f| !Arc::ptr_eq(f, &self.flag));
    }
}

/// Runs `f` on the blocking pool with a registered cancel flag and a throttled progress emitter.
async fn run_scan<T, F>(app: AppHandle, state: &State<'_, Shared>, task: &'static str, f: F) -> Result<T, String>
where
    F: FnOnce(&AppState, &Progress) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let st = Arc::clone(state.inner());
    blocking(move || {
        let session = ScanSession::new(&st);
        let progress = session.progress(&app, task);
        f(&st, &progress)
    })
    .await
}

fn store(st: &AppState, task: Task, groups: Vec<Group>, progress: &Progress) -> Result<ScanResult, String> {
    if progress.cancelled() {
        return Err(ERR_CANCELLED.into());
    }
    let groups = lock(&st.settings).filter(groups);
    let dto = lock(&st.registry).replace(task, groups);
    Ok(ScanResult::new(dto, !has_full_disk_access(&st.home)))
}

#[tauri::command]
pub async fn disk_overview(state: State<'_, Shared>) -> Result<DiskOverview, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let d = disk_info(&st.home).map_err(|e| format!("Não foi possível ler a capacidade do disco: {e}"))?;
        Ok(DiskOverview { total: d.total, free: d.free, used: d.used, fda: has_full_disk_access(&st.home) })
    })
    .await
}

#[tauri::command]
pub async fn scan_junk(app: AppHandle, state: State<'_, Shared>) -> Result<ScanResult, String> {
    run_scan(app, &state, "junk", |st, p| {
        let groups = core_scan_junk(&st.home, &running_keys(), p);
        store(st, Task::Junk, groups, p)
    })
    .await
}

#[tauri::command]
pub async fn scan_trash(app: AppHandle, state: State<'_, Shared>) -> Result<ScanResult, String> {
    run_scan(app, &state, "trash", |st, p| {
        let result = trash_entries(&st.home, p.cancel_flag());
        let external = external_trash_entries(p.cancel_flag());
        if p.cancelled() {
            return Err(ERR_CANCELLED.into());
        }
        let no_external = external.is_empty();
        // The user's own trash first, then one group per external volume.
        let store = |mut groups: Vec<Group>, needs_fda: bool| {
            groups.extend(external);
            let groups = lock(&st.settings).filter(groups);
            Ok(ScanResult::new(lock(&st.registry).replace(Task::Trash, groups), needs_fda))
        };
        match result {
            Ok(group) => store(vec![group], false),
            Err(e) if e.kind() == ErrorKind::NotFound => store(Vec::new(), false),
            // The external bins stay listed; the UI asks for Full Disk Access to also read ~/.Trash.
            Err(e) if e.kind() == ErrorKind::PermissionDenied || !has_full_disk_access(&st.home) => {
                if no_external {
                    lock(&st.registry).replace(Task::Trash, Vec::new());
                    Ok(ScanResult::needs_fda())
                } else {
                    store(Vec::new(), true)
                }
            }
            Err(e) => Err(format!("Não foi possível ler a Lixeira: {e}")),
        }
    })
    .await
}

#[tauri::command]
pub async fn scan_large(app: AppHandle, state: State<'_, Shared>, min_mb: u64) -> Result<ScanResult, String> {
    // Decimal megabytes, matching how Finder and the UI display sizes.
    let min_bytes = min_mb.clamp(10, 100_000) * 1_000_000;
    run_scan(app, &state, "large", move |st, p| {
        let groups = core_scan_large(&st.home, min_bytes, p);
        store(st, Task::Large, groups, p)
    })
    .await
}

#[tauri::command]
pub async fn list_apps(app: AppHandle, state: State<'_, Shared>) -> Result<Vec<AppDto>, String> {
    run_scan(app, &state, "apps", |st, p| {
        let roots = [PathBuf::from("/Applications"), st.home.join("Applications")];
        let apps = core_list_apps(&roots, &running_bundle_ids(), OWN_BUNDLE_ID, p);
        if p.cancelled() {
            return Err(ERR_CANCELLED.into());
        }
        let mut reg = lock(&st.registry);
        let with_ids: Vec<_> = apps.into_iter().map(|a| (reg.alloc_id(), a)).collect();
        drop(reg);
        let dto = with_ids.iter().map(|(id, a)| AppDto::new(*id, a)).collect();
        *lock(&st.apps) = with_ids.into_iter().collect();
        lock(&st.icons).clear();
        Ok(dto)
    })
    .await
}

#[tauri::command]
pub async fn app_icon(state: State<'_, Shared>, app_id: u64) -> Result<Option<String>, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        if let Some(hit) = lock(&st.icons).get(&app_id) {
            return Ok(hit.clone());
        }
        let Some(path) = lock(&st.apps).get(&app_id).map(|a| a.path.clone()) else {
            return Ok(None);
        };
        let url = app_icon_png(&path, 128).map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png)));
        // The list may have been replaced while rendering; don't cache under an id that no longer exists.
        if lock(&st.apps).contains_key(&app_id) {
            lock(&st.icons).insert(app_id, url.clone());
        }
        Ok(url)
    })
    .await
}

#[tauri::command]
pub async fn app_leftovers(app: AppHandle, state: State<'_, Shared>, app_id: u64) -> Result<ScanResult, String> {
    run_scan(app, &state, "leftovers", move |st, p| {
        let (info, other_copy) = {
            let apps = lock(&st.apps);
            let info = apps.get(&app_id).cloned().ok_or(ERR_APP_GONE)?;
            let other = apps.iter().any(|(id, a)| *id != app_id && a.bundle_id == info.bundle_id);
            (info, other)
        };
        let mut items = find_leftovers(&st.home, &info, p.cancel_flag());
        // Leftovers are shared by every copy with this bundle id; removing them would break the copy that stays.
        if other_copy {
            items = items.into_iter().map(|i| i.unselected(NOTE_OTHER_COPY)).collect();
        }
        let group = Group {
            id: "leftovers".into(),
            title: "Arquivos relacionados".into(),
            description: "Preferências, caches e dados de suporte deixados pelo app.".into(),
            items,
        };
        store(st, Task::Leftovers(app_id), vec![group], p)
    })
    .await
}

/// Removes `items` (id, item) through the guarded engine and forgets the ids that succeeded.
fn run_removal(st: &AppState, items: &[(u64, Item)]) -> HashMap<u64, OutcomeDto> {
    let plain: Vec<Item> = items.iter().map(|(_, it)| it.clone()).collect();
    let outcomes = remove_items(&plain, &st.guard, &SystemRemover, &st.log);
    let mut by_id = HashMap::new();
    let mut done = Vec::new();
    for ((id, _), o) in items.iter().zip(outcomes) {
        if o.ok {
            done.push(*id);
        }
        by_id.insert(*id, OutcomeDto { id: *id, ok: o.ok, freed: if o.ok { o.freed } else { 0 }, error: o.error });
    }
    lock(&st.registry).forget(&done);
    by_id
}

/// Builds the response in the caller's id order (duplicates collapsed); `freed` counts successes only.
fn assemble(order: &[u64], mut by_id: HashMap<u64, OutcomeDto>) -> RemoveResult {
    let outcomes: Vec<OutcomeDto> = order.iter().filter_map(|id| by_id.remove(id)).collect();
    let freed = outcomes.iter().filter(|o| o.ok).map(|o| o.freed).sum();
    RemoveResult { outcomes, freed }
}

fn dedup(ids: &[u64]) -> Vec<u64> {
    let mut seen = std::collections::HashSet::new();
    ids.iter().copied().filter(|id| seen.insert(*id)).collect()
}

#[tauri::command]
pub async fn remove(state: State<'_, Shared>, ids: Vec<u64>) -> Result<RemoveResult, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let mut resolved = lock(&st.registry).resolve_removal(&ids);
        // An app opened after the scan must not lose its cache while running.
        let keys = running_keys();
        let (busy, free): (Vec<_>, Vec<_>) =
            resolved.items.into_iter().partition(|(_, it)| cache_of_running_app(it, &keys));
        resolved.items = free;
        resolved.rejected.extend(busy.into_iter().map(|(id, _)| (id, ERR_APP_OPEN)));
        let mut by_id = run_removal(&st, &resolved.items);
        by_id.extend(resolved.rejected.into_iter().map(|(id, why)| (id, OutcomeDto::failed(id, why))));
        Ok(assemble(&dedup(&ids), by_id))
    })
    .await
}

#[tauri::command]
pub async fn uninstall(state: State<'_, Shared>, app_id: u64, leftover_ids: Vec<u64>) -> Result<RemoveResult, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let info = lock(&st.apps).get(&app_id).cloned().ok_or(ERR_APP_GONE)?;
        if running_bundle_ids().contains(&info.bundle_id) {
            return Err("Feche o app antes de desinstalar.".into());
        }
        let resolved = lock(&st.registry).resolve_leftovers(app_id, &leftover_ids);
        // The bundle goes first and alone: if it can't be moved (e.g. root-owned), its data must stay with it.
        let bundle = [(app_id, Item::new(info.path.clone(), info.size, Policy::MoveToTrash))];
        let mut by_id = run_removal(&st, &bundle);
        if by_id.get(&app_id).is_some_and(|o| o.ok) {
            lock(&st.apps).remove(&app_id);
            lock(&st.icons).remove(&app_id);
            by_id.extend(run_removal(&st, &resolved.items));
        } else {
            by_id.extend(resolved.items.iter().map(|(id, _)| (*id, OutcomeDto::failed(*id, ERR_APP_KEPT))));
        }
        by_id.extend(resolved.rejected.into_iter().map(|(id, why)| (id, OutcomeDto::failed(id, why))));
        let mut order = vec![app_id];
        order.extend(dedup(&leftover_ids).into_iter().filter(|id| *id != app_id));
        Ok(assemble(&order, by_id))
    })
    .await
}

#[tauri::command]
pub fn cancel_scan(state: State<'_, Shared>) {
    for flag in lock(&state.active).iter() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// `/usr/bin/open` with an argument vector (no shell involved).
fn open(args: &[&OsStr]) -> Result<(), String> {
    match Command::new("/usr/bin/open").args(args).status() {
        Ok(s) if s.success() => Ok(()),
        Ok(_) => Err("O macOS não conseguiu abrir o item.".into()),
        Err(e) => Err(format!("Não foi possível executar o comando de abertura: {e}")),
    }
}

fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

#[tauri::command]
pub async fn reveal(state: State<'_, Shared>, id: u64) -> Result<(), String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let from_registry = lock(&st.registry).get(&[id]).0.pop().map(|(_, it)| it.path);
        let path = match from_registry {
            Some(p) => p,
            None => lock(&st.apps).get(&id).map(|a| a.path.clone()).ok_or(ERR_UNKNOWN_ITEM)?,
        };
        if !exists(&path) {
            return Err("O item não existe mais no disco.".into());
        }
        open(&[OsStr::new("-R"), path.as_os_str()])
    })
    .await
}

#[tauri::command]
pub async fn reveal_log(state: State<'_, Shared>) -> Result<(), String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let log = st.log.path();
        if exists(log) {
            return open(&[OsStr::new("-R"), log.as_os_str()]);
        }
        match log.parent() {
            Some(dir) if exists(dir) => open(&[dir.as_os_str()]),
            _ => Err("Ainda não há registro de ações.".into()),
        }
    })
    .await
}

#[tauri::command]
pub async fn open_fda_settings() -> Result<(), String> {
    blocking(|| open(&[OsStr::new("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")])).await
}

#[tauri::command]
pub fn get_settings(state: State<'_, Shared>) -> Settings {
    lock(&state.settings).clone()
}

/// Replaces the preferences. The ignore list is not taken from the UI here (only `ignore_item` and `unignore`
/// change it), so a stale settings object can't silently drop ignored paths.
#[tauri::command]
pub fn set_settings(state: State<'_, Shared>, settings: Settings) -> Result<(), String> {
    let mut cur = lock(&state.settings);
    let ignored = std::mem::take(&mut cur.ignored);
    *cur = Settings { ignored, ..settings };
    cur.save(&state.settings_path).map_err(|e| format!("Não foi possível salvar os ajustes: {e}"))
}

/// Adds a scanned item (or app) to the ignore list and forgets its id; it disappears from future scans.
#[tauri::command]
pub fn ignore_item(state: State<'_, Shared>, id: u64) -> Result<(), String> {
    let from_registry = lock(&state.registry).get(&[id]).0.pop().map(|(_, it)| it.path);
    let path = match from_registry {
        Some(p) => p,
        None => lock(&state.apps).get(&id).map(|a| a.path.clone()).ok_or(ERR_UNKNOWN_ITEM)?,
    };
    let mut s = lock(&state.settings);
    s.ignore(path);
    s.save(&state.settings_path).map_err(|e| format!("Não foi possível salvar a lista de ignorados: {e}"))?;
    lock(&state.registry).forget(&[id]);
    Ok(())
}

#[tauri::command]
pub fn list_ignored(state: State<'_, Shared>) -> Vec<String> {
    lock(&state.settings).ignored.iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Removing an entry from the ignore list only makes the path visible to scans again; nothing on disk changes.
#[tauri::command]
pub fn unignore(state: State<'_, Shared>, path: String) -> Result<(), String> {
    let mut s = lock(&state.settings);
    if s.unignore(Path::new(&path)) {
        s.save(&state.settings_path).map_err(|e| format!("Não foi possível salvar a lista de ignorados: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(id: u64, freed: u64) -> (u64, OutcomeDto) {
        (id, OutcomeDto { id, ok: true, freed, error: None })
    }

    #[test]
    fn assemble_keeps_request_order_and_sums_successes() {
        let by_id: HashMap<_, _> = [ok(3, 10), (1, OutcomeDto::failed(1, "x")), ok(2, 5)].into();
        let r = assemble(&[1, 2, 3], by_id);
        assert_eq!(r.outcomes.iter().map(|o| o.id).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(r.freed, 15);
    }

    #[test]
    fn dedup_keeps_first_occurrence() {
        assert_eq!(dedup(&[3, 1, 3, 2, 1]), [3, 1, 2]);
    }

    #[test]
    fn cancel_flags_unregister_on_drop() {
        let st: Shared = Arc::new(AppState::with_home(PathBuf::from("/nonexistent-home")));
        let s = ScanSession::new(&st);
        assert_eq!(lock(&st.active).len(), 1);
        for f in lock(&st.active).iter() {
            f.store(true, Ordering::Relaxed);
        }
        assert!(s.flag.load(Ordering::Relaxed));
        drop(s);
        assert!(lock(&st.active).is_empty());
    }

    #[test]
    fn caches_of_running_apps_are_refused_at_removal() {
        let keys: std::collections::HashSet<String> = ["google".to_string(), "com.foo.app".to_string()].into();
        let caches = PathBuf::from("/Users/u/Library/Caches");
        let junk = |name: &str| {
            let mut it = Item::new(caches.join(name), 1, Policy::DeleteJunk { root: caches.clone() });
            it.name = name.into();
            it
        };
        assert!(cache_of_running_app(&junk("Google"), &keys));
        assert!(cache_of_running_app(&junk("com.foo.app.helper"), &keys));
        assert!(!cache_of_running_app(&junk("com.bar"), &keys));
        let logs = PathBuf::from("/Users/u/Library/Logs");
        let log_item = Item::new(logs.join("Google"), 1, Policy::DeleteJunk { root: logs });
        assert!(!cache_of_running_app(&log_item, &keys), "only caches are tied to running apps");
    }
}
