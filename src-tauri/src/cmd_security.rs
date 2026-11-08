//! Security: security check (read-only), app permissions (TCC) and privacy.
//! The UI only sends ids: never paths, URLs or bundle ids. No setting is changed silently.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use limpa_core::fda::has_full_disk_access;
use limpa_core::running::{app_icon_png, running_bundle_ids};
use limpa_core::security::posture::{self, Check};
use limpa_core::security::privacy;
use limpa_core::security::tcc::{self, Auth, Entry, ReadError};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::{Shared, assemble, blocking, dedup, open, run_removal_with, run_scan};
use crate::dto::{GroupDto, OutcomeDto, RemoveResult};
use crate::registry::TASK_PRIVACY;
use crate::state::{AppState, lock};
use limpa_core::remove::RemoveOptions;

const ICON_PX: u32 = 64;
const ERR_CANCELLED: &str = "Varredura cancelada.";
const ERR_NO_FIX: &str = "Esta verificação não tem um painel nos Ajustes do Sistema.";
const ERR_UNKNOWN_PERMISSION: &str = "permissão desconhecida; atualize a lista";

/// Permission rows delivered on the last read: id -> (service, bundle id). The ids come from the registry's global
/// counter, so they never repeat; the UI only sends back the id.
static TCC_ROWS: Mutex<Option<RowMap>> = Mutex::new(None);

// ---------- Security check ----------

#[tauri::command]
pub async fn security_checks() -> Result<Vec<Check>, String> {
    blocking(|| Ok(posture::run_checks())).await
}

/// Opens the System Settings pane tied to the check. The URL is a server-side constant.
#[tauri::command]
pub async fn open_security_fix(check_id: String) -> Result<(), String> {
    let url = posture::fix_url(&check_id).ok_or(ERR_NO_FIX)?;
    blocking(move || open(&[OsStr::new(url)])).await
}

// ---------- App permissions ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TccRowDto {
    pub id: u64,
    pub name: String,
    /// Display only; revocation uses the id.
    pub bundle_id: String,
    pub installed: bool,
    pub icon: Option<String>,
    pub granted: bool,
    pub limited: bool,
    pub modified: Option<i64>,
    pub system: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TccGroupDto {
    pub service: &'static str,
    pub title: &'static str,
    pub rows: Vec<TccRowDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TccResult {
    pub needs_fda: bool,
    pub groups: Vec<TccGroupDto>,
    /// Distinct apps with camera or microphone allowed.
    pub camera_mic_apps: usize,
    /// Distinct apps with some permission allowed.
    pub apps: usize,
}

impl TccResult {
    fn needs_fda() -> Self {
        Self { needs_fda: true, groups: Vec::new(), camera_mic_apps: 0, apps: 0 }
    }
}

struct AppMeta {
    name: String,
    installed: bool,
    icon: Option<String>,
}

fn app_meta(bundle_id: &str) -> AppMeta {
    match tcc::resolve_app(bundle_id) {
        Some((name, path)) => {
            let icon =
                app_icon_png(&path, ICON_PX).map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png)));
            AppMeta { name, installed: true, icon }
        }
        // Removed app that is still in the database: show the identifier.
        None => AppMeta { name: bundle_id.to_owned(), installed: false, icon: None },
    }
}

type RowMap = HashMap<u64, (&'static str, String)>;

/// Groups by service (in `SERVICES` order), allowed first, then by name. Allocates the ids and returns the
/// id -> (service, bundle id) map that `tcc_revoke` uses.
fn build_groups(
    entries: Vec<Entry>,
    meta: &mut dyn FnMut(&str) -> AppMeta,
    alloc: &mut dyn FnMut() -> u64,
) -> (TccResult, RowMap) {
    let mut cache: HashMap<String, Arc<AppMeta>> = HashMap::new();
    let mut map = RowMap::new();
    let mut groups = Vec::new();
    let mut cam_mic = HashSet::new();
    let mut any = HashSet::new();
    for (service, title) in tcc::SERVICES {
        let mut rows: Vec<TccRowDto> = Vec::new();
        for e in entries.iter().filter(|e| e.service == *service) {
            let m = Arc::clone(cache.entry(e.client.clone()).or_insert_with(|| Arc::new(meta(&e.client))));
            if e.auth.granted() {
                any.insert(e.client.clone());
                if matches!(*service, "Camera" | "Microphone") {
                    cam_mic.insert(e.client.clone());
                }
            }
            let id = alloc();
            map.insert(id, (*service, e.client.clone()));
            rows.push(TccRowDto {
                id,
                name: m.name.clone(),
                bundle_id: e.client.clone(),
                installed: m.installed,
                icon: m.icon.clone(),
                granted: e.auth.granted(),
                limited: e.auth == Auth::Limited,
                modified: e.modified,
                system: e.system,
            });
        }
        if rows.is_empty() {
            continue;
        }
        rows.sort_by_cached_key(|r| (!r.granted, r.name.to_lowercase()));
        groups.push(TccGroupDto { service, title, rows });
    }
    (TccResult { needs_fda: false, groups, camera_mic_apps: cam_mic.len(), apps: any.len() }, map)
}

#[tauri::command]
pub async fn tcc_permissions(state: State<'_, Shared>) -> Result<TccResult, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let entries = match tcc::read_all(&st.home) {
            Ok(e) => e,
            Err(ReadError::NeedsFda) => {
                *lock(&TCC_ROWS) = Some(HashMap::new());
                return Ok(TccResult::needs_fda());
            }
            Err(ReadError::Failed(why)) => return Err(format!("Não foi possível ler as permissões dos apps: {why}")),
        };
        let (result, map) = build_groups(entries, &mut |b| app_meta(b), &mut || lock(&st.registry).alloc_id());
        *lock(&TCC_ROWS) = Some(map);
        Ok(result)
    })
    .await
}

/// Revokes the permissions `ids` with `revoke(service, bundle id)`. Both values come from the last read's map,
/// never from the UI. Each attempt is recorded in the action log.
fn revoke_ids(
    st: &AppState,
    rows: &Mutex<Option<RowMap>>,
    ids: &[u64],
    revoke: &dyn Fn(&str, &str) -> Result<(), String>,
) -> RemoveResult {
    let mut by_id = HashMap::new();
    for id in dedup(ids) {
        let known = lock(rows).as_ref().and_then(|m| m.get(&id).cloned());
        let Some((service, bundle)) = known else {
            by_id.insert(id, OutcomeDto::failed(id, ERR_UNKNOWN_PERMISSION));
            continue;
        };
        let res = revoke(service, &bundle);
        st.log.record("revogar", Path::new(&format!("{service}:{bundle}")), res.is_ok(), 0);
        match res {
            Ok(()) => {
                if let Some(m) = lock(rows).as_mut() {
                    m.remove(&id);
                }
                by_id.insert(id, OutcomeDto::done(id, 0));
            }
            Err(e) => {
                by_id.insert(id, OutcomeDto::failed(id, e));
            }
        }
    }
    assemble(&dedup(ids), by_id)
}

#[tauri::command]
pub async fn tcc_revoke(state: State<'_, Shared>, ids: Vec<u64>) -> Result<RemoveResult, String> {
    let st = Arc::clone(state.inner());
    blocking(move || Ok(revoke_ids(&st, &TCC_ROWS, &ids, &tcc::revoke))).await
}

// ---------- Privacy ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDto {
    pub id: &'static str,
    pub name: &'static str,
    pub present: bool,
    pub running: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyResult {
    pub groups: Vec<GroupDto>,
    pub total: u64,
    pub browsers: Vec<BrowserDto>,
    pub needs_fda: bool,
}

#[tauri::command]
pub async fn privacy_scan(app: AppHandle, state: State<'_, Shared>) -> Result<PrivacyResult, String> {
    run_scan(app, &state, "privacy", |st, p| {
        let running = running_bundle_ids();
        let groups = privacy::scan(&st.home, &running, p);
        if p.cancelled() {
            return Err(ERR_CANCELLED.into());
        }
        let groups = lock(&st.settings).filter(groups);
        let groups = lock(&st.registry).replace(TASK_PRIVACY, groups);
        let browsers = privacy::browser_states(&st.home, &running)
            .into_iter()
            .map(|b| BrowserDto { id: b.id, name: b.name, present: b.present, running: b.running })
            .collect();
        let total = groups.iter().map(|g| g.total).sum();
        Ok(PrivacyResult { groups, total, browsers, needs_fda: !has_full_disk_access(&st.home) })
    })
    .await
}

fn browser_open_error(name: &str) -> String {
    format!("o {name} está aberto; feche-o e tente de novo")
}

/// Removes privacy items (Trash, through the same guarded path as `remove`). Only accepts ids from the last privacy
/// scan and refuses those of a browser that became open again since the scan.
fn remove_privacy(st: &AppState, ids: &[u64], running_ids: &HashSet<String>, opts: RemoveOptions) -> RemoveResult {
    let mut resolved = lock(&st.registry).resolve_task(TASK_PRIVACY, ids);
    let mut by_id: HashMap<u64, OutcomeDto> = HashMap::new();
    let (busy, free): (Vec<_>, Vec<_>) = resolved.items.into_iter().partition(|(_, it)| {
        privacy::browser_for_path(&st.home, &it.path).is_some_and(|b| privacy::is_running(&st.home, b, running_ids))
    });
    resolved.items = free;
    for (id, it) in busy {
        let name = privacy::browser_for_path(&st.home, &it.path).map_or("navegador", |b| b.name);
        by_id.insert(id, OutcomeDto::failed(id, browser_open_error(name)));
    }
    by_id.extend(run_removal_with(st, &resolved.items, opts));
    by_id.extend(resolved.rejected.into_iter().map(|(id, why)| (id, OutcomeDto::failed(id, why))));
    assemble(&dedup(ids), by_id)
}

#[tauri::command]
pub async fn privacy_remove(
    state: State<'_, Shared>,
    ids: Vec<u64>,
    permanent: Option<bool>,
) -> Result<RemoveResult, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let stop = std::sync::atomic::AtomicBool::new(false);
        let opts = RemoveOptions { permanent: permanent.unwrap_or(false), cancel: Some(&stop), undo: None };
        Ok(remove_privacy(&st, &ids, &running_bundle_ids(), opts))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Task;
    use limpa_core::security::tcc::Entry;
    use limpa_core::{Group, Progress};
    use std::path::PathBuf;

    fn entry(service: &'static str, client: &str, auth: Auth) -> Entry {
        Entry { service, client: client.into(), auth, modified: Some(1), system: false }
    }

    fn meta_of(bundle: &str) -> AppMeta {
        AppMeta { name: bundle.rsplit('.').next().unwrap().to_owned(), installed: bundle != "gone.app", icon: None }
    }

    fn build(entries: Vec<Entry>) -> (TccResult, RowMap) {
        let mut next = 100;
        build_groups(entries, &mut |b| meta_of(b), &mut || {
            next += 1;
            next
        })
    }

    #[test]
    fn groups_follow_service_order_and_count_distinct_apps() {
        let (r, map) = build(vec![
            entry("Microphone", "us.zoom.xos", Auth::Allowed),
            entry("Camera", "us.zoom.xos", Auth::Allowed),
            entry("Camera", "com.b.Beta", Auth::Denied),
            entry("Camera", "com.a.alpha", Auth::Allowed),
            entry("Photos", "gone.app", Auth::Limited),
            entry("Microphone", "com.c.cc", Auth::Denied),
        ]);
        let order: Vec<_> = r.groups.iter().map(|g| g.service).collect();
        assert_eq!(order, ["Camera", "Microphone", "Photos"]);
        let cam: Vec<_> = r.groups[0].rows.iter().map(|x| (x.name.as_str(), x.granted)).collect();
        assert_eq!(cam, [("alpha", true), ("xos", true), ("Beta", false)], "liberados primeiro, depois por nome");
        assert_eq!(r.camera_mic_apps, 2, "zoom conta uma vez; negados não contam");
        assert_eq!(r.apps, 3);
        assert!(r.groups[2].rows[0].limited && !r.groups[2].rows[0].installed);
        assert_eq!(map.len(), 6);
        let ids: HashSet<_> = r.groups.iter().flat_map(|g| g.rows.iter().map(|x| x.id)).collect();
        assert_eq!(ids.len(), 6, "ids únicos");
        assert!(map.values().all(|(s, b)| tcc::service_title(s).is_some() && tcc::valid_bundle_id(b)));
    }

    #[test]
    fn dto_keys_are_camel_case() {
        let (r, _) = build(vec![entry("Camera", "a.b", Auth::Allowed)]);
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("needsFda").is_some() && v.get("cameraMicApps").is_some());
        assert!(v["groups"][0]["rows"][0].get("bundleId").is_some());
        assert_eq!(serde_json::to_value(TccResult::needs_fda()).unwrap()["needsFda"], true);
    }

    /// Unique temporary folder, deleted when it goes out of scope.
    struct Tmp(PathBuf);

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn state() -> (Tmp, AppState) {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("limpae-sec-{}-{n}", std::process::id()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let home = std::fs::canonicalize(&home).unwrap();
        (Tmp(root), AppState::with_home(home))
    }

    #[test]
    fn revoke_uses_server_side_rows_and_logs() {
        let (_tmp, st) = state();
        let rows = Mutex::new(Some(HashMap::from([
            (1, ("Camera", "us.zoom.xos".to_string())),
            (2, ("Microphone", "com.fail.app".to_string())),
        ])));
        let calls = Mutex::new(Vec::new());
        let revoke = |s: &str, b: &str| {
            calls.lock().unwrap().push((s.to_owned(), b.to_owned()));
            if b == "com.fail.app" { Err("recusado".to_string()) } else { Ok(()) }
        };
        let res = revoke_ids(&st, &rows, &[1, 2, 2, 99], &revoke);
        let got: Vec<_> = res.outcomes.iter().map(|o| (o.id, o.ok)).collect();
        assert_eq!(got, [(1, true), (2, false), (99, false)]);
        assert_eq!(res.outcomes[2].error.as_deref(), Some(ERR_UNKNOWN_PERMISSION));
        assert_eq!(
            *calls.lock().unwrap(),
            [("Camera".to_string(), "us.zoom.xos".to_string()), ("Microphone".to_string(), "com.fail.app".to_string())]
        );
        assert!(!lock(&rows).as_ref().unwrap().contains_key(&1), "id revogado é esquecido");
        assert!(lock(&rows).as_ref().unwrap().contains_key(&2));
        let log = std::fs::read_to_string(st.log.path()).unwrap();
        assert!(log.contains("\trevogar\tok\t0\tCamera:us.zoom.xos"), "{log}");
        assert!(log.contains("\trevogar\terro\t0\tMicrophone:com.fail.app"), "{log}");
        assert!(revoke_ids(&st, &Mutex::new(None), &[1], &revoke).outcomes[0].error.is_some(), "sem leitura prévia");
    }

    fn browser_state_with_history() -> (Tmp, AppState, u64, PathBuf) {
        let (tmp, st) = state();
        let hist = st.home.join("Library/Application Support/Google/Chrome/Default/History");
        std::fs::create_dir_all(hist.parent().unwrap()).unwrap();
        std::fs::write(&hist, b"x").unwrap();
        let groups = privacy::scan(&st.home, &HashSet::new(), &Progress::silent());
        let dto = lock(&st.registry).replace(TASK_PRIVACY, groups);
        let id = dto.iter().find(|g| g.id == "chrome:history").unwrap().items[0].id;
        (tmp, st, id, hist)
    }

    #[test]
    fn removal_is_refused_when_the_browser_is_running_again() {
        let (_tmp, st, id, hist) = browser_state_with_history();
        let running: HashSet<String> = ["com.google.chrome".to_string()].into();
        let res = remove_privacy(&st, &[id], &running, RemoveOptions::default());
        assert!(!res.outcomes[0].ok);
        assert!(
            res.outcomes[0].error.as_deref().unwrap().contains("Google Chrome está aberto"),
            "{:?}",
            res.outcomes[0]
        );
        assert!(hist.exists(), "o arquivo do navegador aberto não foi tocado");
        assert!(lock(&st.registry).get(&[id]).1.is_empty(), "o item continua registrado para uma nova tentativa");
    }

    #[test]
    fn removal_only_accepts_privacy_ids() {
        let (_tmp, st) = state();
        let f = st.home.join("Documents/a.txt");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, b"x").unwrap();
        let g = Group {
            id: "g".into(),
            title: "g".into(),
            description: String::new(),
            items: vec![limpa_core::Item::new(f.clone(), 1, limpa_core::Policy::MoveToTrash)],
        };
        let id = lock(&st.registry).replace(Task::Large, vec![g])[0].items[0].id;
        let res = remove_privacy(&st, &[id, 424_242], &HashSet::new(), RemoveOptions::default());
        assert!(res.outcomes.iter().all(|o| !o.ok));
        assert!(f.exists());
    }

    #[test]
    fn fix_command_rejects_unknown_checks() {
        assert!(posture::fix_url("sip").is_none());
        assert!(posture::fix_url("../../etc").is_none());
    }
}
