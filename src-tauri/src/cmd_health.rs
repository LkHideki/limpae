//! Mac health (Health module) and the cheap system snapshot shared with the menu bar. No command here takes a
//! path or removes anything.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use limpa_core::disk::disk_info;
use limpa_core::fda::has_full_disk_access;
use limpa_core::health::{self, Health, Inputs, MemoryPressure};
use limpa_core::log::Activity;
use limpa_core::size::alloc_size;
use serde::Serialize;
use tauri::State;

use crate::commands::blocking;
use crate::state::{AppState, lock};

type Shared = Arc<AppState>;

/// The Trash walk is the only non-trivial cost of a snapshot, so the menu bar reuses it this long.
pub(crate) const TRASH_TTL: Duration = Duration::from_secs(300);
/// Gatekeeper, SIP and FileVault change rarely and cost three process spawns.
const SECURITY_TTL: Duration = Duration::from_secs(1800);
const SECURITY_TIMEOUT: Duration = Duration::from_secs(2);

type Security = (Option<bool>, Option<bool>, Option<bool>);

static TRASH: Mutex<Option<(Instant, u64)>> = Mutex::new(None);
static SECURITY: Mutex<Option<(Instant, Security)>> = Mutex::new(None);

fn locked<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Size of `~/.Trash`. A cached value younger than `max_age` is reused; `None` walks the folder now and
/// `Some(Duration::MAX)` never walks (returns whatever was cached, however old).
pub(crate) fn trash_bytes(home: &Path, max_age: Option<Duration>) -> Option<u64> {
    let cached = *locked(&TRASH);
    if let (Some((at, bytes)), Some(max)) = (cached, max_age)
        && at.elapsed() <= max
    {
        return Some(bytes);
    }
    if max_age == Some(Duration::MAX) {
        return cached.map(|(_, b)| b);
    }
    let bytes = alloc_size(&home.join(".Trash"), &AtomicBool::new(false));
    *locked(&TRASH) = Some((Instant::now(), bytes));
    Some(bytes)
}

/// Cached Gatekeeper/SIP/FileVault state; probes (blocking up to a couple of seconds) only when `probe` is set
/// and the cache is stale. Unknown stays `None`.
fn security(probe: bool) -> Security {
    let cached = *locked(&SECURITY);
    if let Some((at, s)) = cached
        && (!probe || at.elapsed() <= SECURITY_TTL)
    {
        return s;
    }
    if !probe {
        return (None, None, None);
    }
    let s = health::probe_security(SECURITY_TIMEOUT);
    *locked(&SECURITY) = Some((Instant::now(), s));
    s
}

/// How much work a snapshot may do.
#[derive(Clone, Copy)]
pub(crate) struct Effort {
    /// See [`trash_bytes`].
    pub trash_max_age: Option<Duration>,
    /// Run the Gatekeeper/SIP/FileVault tools if their cache is stale.
    pub probe_security: bool,
}

impl Effort {
    /// The Activity screen: current Trash, fresh security state.
    pub(crate) const FULL: Self = Self { trash_max_age: None, probe_security: true };
    /// Menu bar timer: reuse the Trash walk for 5 minutes.
    pub(crate) const TIMER: Self = Self { trash_max_age: Some(TRASH_TTL), probe_security: true };
    /// Menu bar, right before the menu opens: statfs and sysctl only.
    pub(crate) const INSTANT: Self = Self { trash_max_age: Some(Duration::MAX), probe_security: false };
}

pub(crate) fn inputs(st: &AppState, effort: Effort) -> Inputs {
    let disk = disk_info(&st.home).ok();
    let fda = has_full_disk_access(&st.home);
    let (gatekeeper, sip, filevault) = security(effort.probe_security);
    let last = lock(&st.settings).last_smart_care;
    Inputs {
        disk_total: disk.map_or(0, |d| d.total),
        disk_free: disk.map_or(0, |d| d.free),
        trash_bytes: if fda { trash_bytes(&st.home, effort.trash_max_age) } else { None },
        fda,
        days_since_smart_care: health::days_since(last, unix_now()),
        uptime_days: health::uptime_days(),
        memory: health::memory_pressure(),
        gatekeeper,
        sip,
        filevault,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthDto {
    #[serde(flatten)]
    pub health: Health,
    /// Friendly family name ("MacBook Pro").
    pub model: String,
    pub disk_total: u64,
    pub disk_free: u64,
    pub trash_bytes: Option<u64>,
    pub fda: bool,
    pub uptime_days: Option<f64>,
    pub memory: Option<MemoryPressure>,
    pub last_smart_care: Option<u64>,
}

fn build_health(st: &AppState, effort: Effort) -> HealthDto {
    let i = inputs(st, effort);
    HealthDto {
        health: health::score(&i),
        model: health::friendly_model(&health::hw_model().unwrap_or_default()),
        disk_total: i.disk_total,
        disk_free: i.disk_free,
        trash_bytes: i.trash_bytes,
        fda: i.fda,
        uptime_days: i.uptime_days,
        memory: i.memory,
        last_smart_care: lock(&st.settings).last_smart_care,
    }
}

#[tauri::command]
pub async fn health(state: State<'_, Shared>) -> Result<HealthDto, String> {
    let st = Arc::clone(state.inner());
    blocking(move || Ok(build_health(&st, Effort::FULL))).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDto {
    #[serde(flatten)]
    pub activity: Activity,
    pub last_smart_care: Option<u64>,
}

#[tauri::command]
pub async fn activity(state: State<'_, Shared>) -> Result<ActivityDto, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        Ok(ActivityDto { activity: st.log.activity(), last_smart_care: lock(&st.settings).last_smart_care })
    })
    .await
}

/// The Sweep view calls this when a run finishes; it feeds the health score shown in Health.
#[tauri::command]
pub fn mark_smart_care(state: State<'_, Shared>) -> Result<(), String> {
    let mut s = lock(&state.settings);
    s.last_smart_care = Some(unix_now());
    s.save(&state.settings_path).map_err(|e| format!("Não foi possível salvar os ajustes: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_home(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("limpae-health-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(p.join(".Trash")).unwrap();
        p
    }

    #[test]
    fn trash_walk_is_cached_and_instant_mode_never_walks() {
        let home = temp_home("trash");
        *locked(&TRASH) = None;
        assert_eq!(trash_bytes(&home, Some(Duration::MAX)), None, "no cache, no walk");
        std::fs::write(home.join(".Trash/a"), vec![1u8; 200_000]).unwrap();
        let first = trash_bytes(&home, None).unwrap();
        assert!(first >= 200_000, "{first}");
        std::fs::write(home.join(".Trash/b"), vec![1u8; 400_000]).unwrap();
        assert_eq!(trash_bytes(&home, Some(TRASH_TTL)), Some(first), "fresh cache reused");
        assert_eq!(trash_bytes(&home, Some(Duration::MAX)), Some(first));
        assert!(trash_bytes(&home, None).unwrap() > first, "forced walk sees the new file");
        std::fs::remove_dir_all(home).unwrap();
        *locked(&TRASH) = None;
    }

    #[test]
    fn mark_smart_care_feeds_the_health_inputs() {
        let home = temp_home("smart");
        let st = AppState::with_home(home.clone());
        assert_eq!(inputs(&st, Effort::INSTANT).days_since_smart_care, None);
        lock(&st.settings).last_smart_care = Some(unix_now() - 3 * 86_400 - 5);
        assert_eq!(inputs(&st, Effort::INSTANT).days_since_smart_care, Some(3));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn dto_flattens_health_and_serializes_camel_case() {
        let home = temp_home("dto");
        let st = AppState::with_home(home.clone());
        let v = serde_json::to_value(build_health(&st, Effort::INSTANT)).unwrap();
        for k in ["level", "score", "factors", "model", "diskTotal", "diskFree", "fda", "lastSmartCare"] {
            assert!(v.get(k).is_some(), "missing {k}: {v}");
        }
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn activity_dto_has_the_stats_and_last_smart_care() {
        let home = temp_home("act");
        let st = AppState::with_home(home.clone());
        st.log.record("apagar", Path::new("/x"), true, 1234);
        let dto = ActivityDto { activity: st.log.activity(), last_smart_care: None };
        let v = serde_json::to_value(dto).unwrap();
        assert_eq!(v["totalFreed"], 1234);
        assert!(v["lastSmartCare"].is_null());
        assert_eq!(v["days"].as_array().unwrap().len(), 30);
        std::fs::remove_dir_all(home).unwrap();
    }
}
