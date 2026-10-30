//! Commands of the Applications module beyond the plain uninstaller: overview scan (updates, unused apps, orphan
//! leftovers, installers), per-app metadata and opening an update. The UI only ever passes ids; update URLs live on
//! the backend and are validated before `open` sees them.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use limpa_core::apps::AppInfo;
use limpa_core::apps_extra::{
    UNUSED_DAYS, Update, check_updates, find_installers, find_orphans, last_used_all, launch_services_knows, store_of,
    unused_from, vendor_of,
};
use limpa_core::running::running_keys;
use limpa_core::{Group, Progress};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::{OWN_BUNDLE_ID, blocking, load_apps, open, run_scan, store};
use crate::dto::ScanResult;
use crate::registry::Task;
use crate::state::{AppState, lock};

type Shared = Arc<AppState>;

const ERR_NO_UPDATE: &str = "Nenhuma atualização conhecida para este app. Analise de novo.";
const ERR_BAD_URL: &str = "O endereço da atualização não é seguro.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDto {
    pub app_id: u64,
    pub current: String,
    pub latest: String,
    pub notes_url: Option<String>,
    pub download_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewDto {
    pub updates: Vec<UpdateDto>,
    pub unused: Vec<u64>,
    pub leftovers: ScanResult,
    pub installers: ScanResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMetaDto {
    pub app_id: u64,
    pub last_used: Option<i64>,
    pub store: &'static str,
    pub vendor: String,
}

/// Updates found by the last overview, keyed by app id. The URL opened by `open_update` comes from here, never
/// from the UI.
fn updates() -> &'static Mutex<HashMap<u64, Update>> {
    static U: OnceLock<Mutex<HashMap<u64, Update>>> = OnceLock::new();
    U.get_or_init(Mutex::default)
}

/// Metadata per app id. Ids are never reused, so an entry can't go stale (it only outlives an uninstalled app).
fn metas() -> &'static Mutex<HashMap<u64, AppMetaDto>> {
    static M: OnceLock<Mutex<HashMap<u64, AppMetaDto>>> = OnceLock::new();
    M.get_or_init(Mutex::default)
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn snapshot(st: &AppState) -> Vec<(u64, AppInfo)> {
    let mut v: Vec<_> = lock(&st.apps).iter().map(|(id, a)| (*id, a.clone())).collect();
    v.sort_by_key(|(id, _)| *id);
    v
}

fn meta_for(id: u64, app: &AppInfo, last_used: Option<i64>) -> AppMetaDto {
    AppMetaDto { app_id: id, last_used, store: store_of(app), vendor: vendor_of(&app.bundle_id) }
}

/// Metadata for `apps`, querying Spotlight only for ids not seen before.
fn collect_meta(apps: &[(u64, AppInfo)]) -> Vec<AppMetaDto> {
    let missing: Vec<&(u64, AppInfo)> = {
        let cache = lock(metas());
        apps.iter().filter(|(id, _)| !cache.contains_key(id)).collect()
    };
    if !missing.is_empty() {
        let infos: Vec<AppInfo> = missing.iter().map(|(_, a)| a.clone()).collect();
        let lasts = last_used_all(&infos);
        let mut cache = lock(metas());
        for ((id, app), last) in missing.iter().map(|m| (&m.0, &m.1)).zip(lasts) {
            cache.insert(*id, meta_for(*id, app, last));
        }
    }
    let cache = lock(metas());
    apps.iter().filter_map(|(id, _)| cache.get(id).cloned()).collect()
}

fn store_groups(st: &AppState, task: &'static str, groups: Vec<Group>, p: &Progress) -> Result<ScanResult, String> {
    store(st, Task::Other(task), groups, p)
}

/// Runs the four read-only pieces in parallel: appcast check, last-use dates, orphan leftovers, installers.
#[tauri::command]
pub async fn apps_overview(app: AppHandle, state: State<'_, Shared>) -> Result<OverviewDto, String> {
    run_scan(app, &state, "apps_overview", |st, p| {
        let mut apps = snapshot(st);
        if apps.is_empty() {
            load_apps(st, p)?;
            apps = snapshot(st);
        }
        let infos: Vec<AppInfo> = apps.iter().map(|(_, a)| a.clone()).collect();
        let installed: Vec<String> = infos.iter().map(|a| a.bundle_id.clone()).collect();
        let running = running_keys();

        let (found, lasts, orphans, installers) = std::thread::scope(|s| {
            let u = s.spawn(|| check_updates(&infos, p.cancel_flag()));
            let l = s.spawn(|| last_used_all(&infos));
            let o = s.spawn(|| find_orphans(&st.home, &installed, OWN_BUNDLE_ID, &running, &launch_services_knows, p));
            let i = s.spawn(|| find_installers(&st.home, p.cancel_flag()));
            (
                u.join().unwrap_or_default(),
                l.join().unwrap_or_default(),
                o.join().unwrap_or_default(),
                i.join().unwrap_or_default(),
            )
        });
        if p.cancelled() {
            return Err("Varredura cancelada.".into());
        }

        // Fresh dates for every app in this scan; the metadata cache is refreshed from the same query.
        {
            let mut cache = lock(metas());
            for ((id, app), last) in apps.iter().zip(&lasts) {
                cache.insert(*id, meta_for(*id, app, *last));
            }
        }
        let unused: Vec<u64> =
            unused_from(&infos, &lasts, now_secs(), UNUSED_DAYS).into_iter().map(|i| apps[i].0).collect();

        let mut record = HashMap::new();
        let mut dto = Vec::new();
        for (idx, upd) in found {
            let id = apps[idx].0;
            dto.push(UpdateDto {
                app_id: id,
                current: upd.current.clone(),
                latest: upd.latest.clone(),
                notes_url: upd.notes_url.clone(),
                download_url: upd.download_url.clone(),
            });
            record.insert(id, upd);
        }
        *lock(updates()) = record;

        Ok(OverviewDto {
            updates: dto,
            unused,
            leftovers: store_groups(st, "orphans", orphans, p)?,
            installers: store_groups(st, "installers", installers, p)?,
        })
    })
    .await
}

/// Last use, store and vendor of every listed app.
#[tauri::command]
pub async fn app_meta(state: State<'_, Shared>) -> Result<Vec<AppMetaDto>, String> {
    let st = Arc::clone(state.inner());
    blocking(move || Ok(collect_meta(&snapshot(&st)))).await
}

/// The URL to open for an update: the download link, else the release notes. Https only.
fn update_url(u: &Update) -> Result<&str, &'static str> {
    let url = u.download_url.as_deref().or(u.notes_url.as_deref()).ok_or(ERR_NO_UPDATE)?;
    let ok = url.len() >= 9
        && url[..8].eq_ignore_ascii_case("https://")
        && !url.chars().any(|c| c.is_control() || c.is_whitespace());
    if ok { Ok(url) } else { Err(ERR_BAD_URL) }
}

/// Opens the update page/download of `app_id` in the default browser. Read-only: nothing is installed.
#[tauri::command]
pub async fn open_update(app_id: u64) -> Result<(), String> {
    blocking(move || {
        let upd = lock(updates()).get(&app_id).cloned().ok_or(ERR_NO_UPDATE)?;
        let url = update_url(&upd)?;
        open(&[OsStr::new(url)])
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn upd(download: Option<&str>, notes: Option<&str>) -> Update {
        Update {
            current: "1".into(),
            latest: "2".into(),
            notes_url: notes.map(str::to_owned),
            download_url: download.map(str::to_owned),
        }
    }

    #[test]
    fn update_url_prefers_download_and_requires_https() {
        let u = upd(Some("https://a.com/x.zip"), Some("https://a.com/n"));
        assert_eq!(update_url(&u), Ok("https://a.com/x.zip"));
        assert_eq!(update_url(&upd(None, Some("HTTPS://a.com/n"))), Ok("HTTPS://a.com/n"));
        assert_eq!(update_url(&upd(None, None)), Err(ERR_NO_UPDATE));
        assert_eq!(update_url(&upd(Some("http://a.com/x"), None)), Err(ERR_BAD_URL));
        assert_eq!(update_url(&upd(Some("file:///etc/passwd"), None)), Err(ERR_BAD_URL));
        assert_eq!(update_url(&upd(Some("-a Calculator"), None)), Err(ERR_BAD_URL));
        assert_eq!(update_url(&upd(Some("https://"), None)), Err(ERR_BAD_URL));
        assert_eq!(update_url(&upd(Some("https://a.com/ x"), None)), Err(ERR_BAD_URL));
    }

    #[test]
    fn dto_wire_keys() {
        let v = serde_json::to_value(UpdateDto {
            app_id: 4,
            current: "1".into(),
            latest: "2".into(),
            notes_url: None,
            download_url: Some("https://a.com".into()),
        })
        .unwrap();
        assert_eq!(
            v,
            json!({"appId": 4, "current": "1", "latest": "2", "notesUrl": null, "downloadUrl": "https://a.com"})
        );
        let m =
            serde_json::to_value(AppMetaDto { app_id: 1, last_used: Some(5), store: "Outros", vendor: "Acme".into() })
                .unwrap();
        assert_eq!(m, json!({"appId": 1, "lastUsed": 5, "store": "Outros", "vendor": "Acme"}));
        let o = serde_json::to_value(OverviewDto {
            updates: vec![],
            unused: vec![3],
            leftovers: ScanResult::new(vec![], false),
            installers: ScanResult::new(vec![], false),
        })
        .unwrap();
        let mut keys: Vec<_> = o.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["installers", "leftovers", "unused", "updates"]);
    }

    #[test]
    fn meta_derives_store_and_vendor() {
        let app = AppInfo {
            path: PathBuf::from("/Applications/Setapp/Foo.app"),
            name: "Foo".into(),
            bundle_id: "com.google.Foo".into(),
            version: None,
            size: 1,
            running: false,
        };
        let m = meta_for(9, &app, Some(100));
        assert_eq!((m.store, m.vendor.as_str(), m.last_used), ("Setapp", "Google", Some(100)));
    }

    /// Read-only run of every overview piece against this Mac. Set `LIMPA_REAL_OUT` to also write the report to a file.
    #[test]
    #[ignore = "reads this Mac's apps, Library, Downloads and the network"]
    fn real_machine_overview() {
        use limpa_core::Progress;
        use limpa_core::apps::list_apps;
        use limpa_core::running::running_bundle_ids;
        use std::fmt::Write;
        use std::time::Instant;

        let home = std::env::home_dir().unwrap();
        let p = Progress::silent();
        let mut out = String::new();
        let t = Instant::now();
        let roots = [PathBuf::from("/Applications"), home.join("Applications")];
        let infos = list_apps(&roots, &running_bundle_ids(), OWN_BUNDLE_ID, &p);
        writeln!(out, "apps: {} ({:?})", infos.len(), t.elapsed()).unwrap();

        let installed: Vec<String> = infos.iter().map(|a| a.bundle_id.clone()).collect();
        std::thread::scope(|s| {
            let u = s.spawn(|| {
                let t = Instant::now();
                (check_updates(&infos, p.cancel_flag()), t.elapsed())
            });
            let l = s.spawn(|| {
                let t = Instant::now();
                (last_used_all(&infos), t.elapsed())
            });
            let o = s.spawn(|| {
                let t = Instant::now();
                let g = find_orphans(&home, &installed, OWN_BUNDLE_ID, &running_keys(), &launch_services_knows, &p);
                (g, t.elapsed())
            });
            let i = s.spawn(|| {
                let t = Instant::now();
                (find_installers(&home, p.cancel_flag()), t.elapsed())
            });
            let (found, tu) = u.join().unwrap();
            writeln!(out, "updates: {} ({tu:?})", found.len()).unwrap();
            for (idx, up) in &found {
                writeln!(
                    out,
                    "  {} {} -> {} notes={:?} dl={:?}",
                    infos[*idx].name, up.current, up.latest, up.notes_url, up.download_url
                )
                .unwrap();
            }
            let feeds = infos.iter().filter(|a| limpa_core::apps_extra::feed_of(a).is_some()).count();
            writeln!(out, "apps with a Sparkle feed: {feeds}").unwrap();
            let (lasts, tl) = l.join().unwrap();
            let now = now_secs();
            let un = unused_from(&infos, &lasts, now, UNUSED_DAYS);
            writeln!(
                out,
                "last_used known: {}/{} ({tl:?}); unused: {}",
                lasts.iter().flatten().count(),
                infos.len(),
                un.len()
            )
            .unwrap();
            for i in un {
                writeln!(out, "  unused: {} ({} days)", infos[i].name, (now - lasts[i].unwrap()) / 86_400).unwrap();
            }
            for (a, last) in infos.iter().zip(&lasts).take(8) {
                writeln!(
                    out,
                    "  sample: {} store={} vendor={} last={:?}",
                    a.name,
                    store_of(a),
                    vendor_of(&a.bundle_id),
                    last
                )
                .unwrap();
            }
            let (groups, to) = o.join().unwrap();
            writeln!(out, "orphan groups ({to:?}):").unwrap();
            for g in &groups {
                writeln!(out, " {} [{}] total {}", g.id, g.items.len(), g.total()).unwrap();
                for it in &g.items {
                    writeln!(
                        out,
                        "   {} {} {} {}",
                        if it.selected { "SELECTED" } else { "unselected" },
                        it.size,
                        it.path.display(),
                        it.note.as_deref().unwrap_or("")
                    )
                    .unwrap();
                }
            }
            let (inst, ti) = i.join().unwrap();
            writeln!(out, "installers ({ti:?}):").unwrap();
            for g in &inst {
                for it in &g.items {
                    writeln!(out, "   {} {}", it.size, it.path.display()).unwrap();
                }
            }
        });
        println!("{out}");
        if let Ok(path) = std::env::var("LIMPA_REAL_OUT") {
            std::fs::write(path, &out).unwrap();
        }
    }
}
