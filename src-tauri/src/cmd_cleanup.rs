//! Commands of the Cleanup Manager. Like every command, they take registry ids, never paths.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::commands::blocking;
use crate::registry::ERR_UNKNOWN_ITEM;
use crate::state::{AppState, lock};

type Shared = Arc<AppState>;

/// Path of a scanned item (or listed app) that still exists on disk.
fn registered_path(st: &AppState, id: u64) -> Result<PathBuf, String> {
    let from_registry = lock(&st.registry).get(&[id]).0.pop().map(|(_, it)| it.path);
    let path = match from_registry {
        Some(p) => p,
        None => lock(&st.apps).get(&id).map(|a| a.path.clone()).ok_or(ERR_UNKNOWN_ITEM)?,
    };
    if std::fs::symlink_metadata(&path).is_err() {
        return Err("O item não existe mais no disco.".into());
    }
    Ok(path)
}

/// Toggles the Quick Look panel for an item, like Space in Finder: the panel closes if it already shows the item.
/// Returns whether the panel is showing afterwards. The registry id is resolved here; the UI never sends a path.
#[tauri::command]
pub async fn quick_look(app: AppHandle, state: State<'_, Shared>, id: u64) -> Result<bool, String> {
    let st = Arc::clone(state.inner());
    blocking(move || {
        let path = registered_path(&st, id)?;
        crate::quicklook::preview(&app, path)
    })
    .await
}

/// Closes the Quick Look panel if it is open (Esc in the UI).
#[tauri::command]
pub fn quick_look_close(app: AppHandle) {
    crate::quicklook::close(&app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use limpa_core::{Group, Item, Policy};

    use crate::registry::Task;

    #[test]
    fn unknown_ids_are_refused() {
        let st = AppState::with_home(PathBuf::from("/nonexistent-home"));
        assert_eq!(registered_path(&st, 999).unwrap_err(), ERR_UNKNOWN_ITEM);
    }

    #[test]
    fn resolves_registry_ids_to_existing_paths_only() {
        let file = std::env::temp_dir().join(format!("limpae-ql-{}.txt", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        let st = AppState::with_home(PathBuf::from("/nonexistent-home"));
        let item = Item::new(file.clone(), 1, Policy::MoveToTrash);
        let group = Group { id: "g".into(), title: "g".into(), description: String::new(), items: vec![item] };
        let dto = lock(&st.registry).replace(Task::Large, vec![group]);
        let id = dto[0].items[0].id;
        assert_eq!(registered_path(&st, id).unwrap(), file);
        std::fs::remove_file(&file).unwrap();
        assert!(registered_path(&st, id).is_err());
    }
}
