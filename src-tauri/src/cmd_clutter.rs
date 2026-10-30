//! Files commands: duplicates, similar images, downloads by app, Large & Old at any location.
//! `location` is an index into the list returned by `clutter_locations`, resolved here; the UI never names a path.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use limpa_core::clutter;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::{Shared, blocking, run_scan, store};
use crate::dto::ScanResult;
use crate::registry::{ERR_UNKNOWN_ITEM, Task};
use crate::state::lock;

/// Minimum allocated size for the duplicates scan.
const DUP_MIN_BYTES: u64 = 100_000;
const THUMB_PX: u32 = 160;
const ERR_LOCATION: &str = "Local desconhecido. Atualize a lista de locais.";

/// Roots handed out by the last `clutter_locations` call; indexes in later calls refer to this snapshot.
static LOCATIONS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationDto {
    pub index: usize,
    pub name: String,
    pub free: u64,
    pub total: u64,
    /// The home folder (always index 0); the rest are mounted volumes.
    pub home: bool,
}

fn root_at(roots: &[PathBuf], index: usize) -> Result<PathBuf, String> {
    roots.get(index).cloned().ok_or_else(|| ERR_LOCATION.to_string())
}

/// Root for `index`, re-validated: it must still be a directory (a volume may have been ejected).
fn resolve(st: &crate::state::AppState, index: usize) -> Result<PathBuf, String> {
    let mut roots = lock(&LOCATIONS);
    if roots.is_empty() {
        *roots = clutter::volumes_in(&st.home, Path::new("/Volumes")).into_iter().map(|v| v.1).collect();
    }
    let root = root_at(&roots, index)?;
    if !std::fs::metadata(&root).is_ok_and(|m| m.is_dir()) {
        return Err("O local escolhido não está mais disponível.".into());
    }
    Ok(root)
}

#[tauri::command]
pub async fn clutter_locations(state: State<'_, Shared>) -> Result<Vec<LocationDto>, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let vols = clutter::volumes_in(&st.home, Path::new("/Volumes"));
        *lock(&LOCATIONS) = vols.iter().map(|v| v.1.clone()).collect();
        Ok(vols
            .into_iter()
            .enumerate()
            .map(|(index, (name, _, free, total))| LocationDto { index, name, free, total, home: index == 0 })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn scan_duplicates(app: AppHandle, state: State<'_, Shared>, location: usize) -> Result<ScanResult, String> {
    run_scan(app, &state, "duplicates", move |st, p| {
        let root = resolve(st, location)?;
        let groups = clutter::duplicates(&root, DUP_MIN_BYTES, p);
        store(st, Task::Other("duplicates"), groups, p)
    })
    .await
}

/// Duplicates inside `~/Downloads` only (the Sweep "Meus Arquivos" tile). Same registry task as
/// `scan_duplicates`, so "Revisar" opens My Files on the Duplicates category with these results. Review-only:
/// the UI never pre-selects user files, and Run never touches them.
#[tauri::command]
pub async fn scan_download_dups(app: AppHandle, state: State<'_, Shared>) -> Result<ScanResult, String> {
    run_scan(app, &state, "duplicates", move |st, p| {
        let root = st.home.join("Downloads");
        let groups = if std::fs::metadata(&root).is_ok_and(|m| m.is_dir()) {
            clutter::duplicates(&root, DUP_MIN_BYTES, p)
        } else {
            Vec::new()
        };
        store(st, Task::Other("duplicates"), groups, p)
    })
    .await
}

#[tauri::command]
pub async fn scan_similar(app: AppHandle, state: State<'_, Shared>, location: usize) -> Result<ScanResult, String> {
    run_scan(app, &state, "similar", move |st, p| {
        let root = resolve(st, location)?;
        let groups = clutter::similar_images(&root, p);
        store(st, Task::Other("similar"), groups, p)
    })
    .await
}

#[tauri::command]
pub async fn scan_downloads(app: AppHandle, state: State<'_, Shared>) -> Result<ScanResult, String> {
    run_scan(app, &state, "downloads", |st, p| {
        let groups = clutter::downloads(&st.home, p);
        store(st, Task::Other("downloads"), groups, p)
    })
    .await
}

/// Large & Old for any location (kept apart from `scan_large`, which Sweep owns).
#[tauri::command]
pub async fn scan_large_at(
    app: AppHandle,
    state: State<'_, Shared>,
    location: usize,
    min_mb: u64,
) -> Result<ScanResult, String> {
    // Decimal megabytes, matching `scan_large`.
    let min_bytes = min_mb.clamp(10, 100_000) * 1_000_000;
    run_scan(app, &state, "large", move |st, p| {
        let root = resolve(st, location)?;
        let groups = clutter::large_old(&root, min_bytes, p);
        store(st, Task::Other("large_at"), groups, p)
    })
    .await
}

/// PNG data URL (at most 160 px) of a scanned image, `None` when it can't be decoded or isn't an image.
#[tauri::command]
pub async fn thumb(state: State<'_, Shared>, id: u64) -> Result<Option<String>, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let path = lock(&st.registry).get(&[id]).0.pop().map(|(_, it)| it.path).ok_or(ERR_UNKNOWN_ITEM)?;
        if !clutter::is_image_path(&path) {
            return Ok(None);
        }
        Ok(clutter::thumbnail_png(&path, THUMB_PX).map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png))))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    #[test]
    fn root_at_rejects_unknown_index() {
        let roots = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        assert_eq!(root_at(&roots, 1), Ok(PathBuf::from("/b")));
        assert_eq!(root_at(&roots, 2), Err(ERR_LOCATION.to_string()));
        assert_eq!(root_at(&[], 0), Err(ERR_LOCATION.to_string()));
    }

    #[test]
    fn location_dto_keys() {
        let v =
            serde_json::to_value(LocationDto { index: 0, name: "Pasta pessoal".into(), free: 1, total: 2, home: true })
                .unwrap();
        assert_eq!(v, serde_json::json!({"index": 0, "name": "Pasta pessoal", "free": 1, "total": 2, "home": true}));
    }

    #[test]
    fn resolve_refuses_missing_roots() {
        let dir = std::env::temp_dir().join(format!("limpae-clutter-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let st = AppState::with_home(dir.clone());
        *lock(&LOCATIONS) = vec![dir.clone(), dir.join("gone")];
        assert_eq!(resolve(&st, 0).unwrap(), dir);
        assert!(resolve(&st, 1).is_err());
        assert_eq!(resolve(&st, 9), Err(ERR_LOCATION.to_string()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
