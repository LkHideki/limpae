use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use limpa_core::Guard;
use limpa_core::apps::AppInfo;
use limpa_core::lens::{LensTree, Root};
use limpa_core::log::ActionLog;
use limpa_core::settings::Settings;
use limpa_core::undo::TrashJournal;

use crate::registry::Registry;

/// Disk Map: the scannable roots last offered to the UI and the tree of the last finished scan.
#[derive(Default)]
pub struct LensState {
    pub roots: Vec<Root>,
    pub tree: Option<Arc<LensTree>>,
}

pub struct AppState {
    pub home: PathBuf,
    pub guard: Guard,
    pub log: ActionLog,
    /// Trash moves that can be undone.
    pub journal: TrashJournal,
    pub registry: Mutex<Registry>,
    pub apps: Mutex<HashMap<u64, AppInfo>>,
    /// App id to PNG data URL (`None` = app has no renderable icon). Cleared whenever the app list is replaced.
    pub icons: Mutex<HashMap<u64, Option<String>>>,
    /// Cancel flags of the scans running right now.
    pub active: Mutex<Vec<Arc<AtomicBool>>>,
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    pub lens: Mutex<LensState>,
}

impl AppState {
    pub fn new() -> Result<Self, String> {
        let home = std::env::home_dir().ok_or("Não foi possível localizar a pasta pessoal do usuário.")?;
        Ok(Self::with_home(home))
    }

    pub fn with_home(home: PathBuf) -> Self {
        let settings_path = Settings::path_in(&home);
        Self {
            settings: Mutex::new(Settings::load_migrating(&home)),
            settings_path,
            guard: Guard::new(&home),
            log: ActionLog::in_home_migrating(&home),
            journal: {
                let j = TrashJournal::in_home(&home);
                j.prune();
                j
            },
            home,
            registry: Mutex::default(),
            apps: Mutex::default(),
            icons: Mutex::default(),
            active: Mutex::default(),
            lens: Mutex::default(),
        }
    }
}

/// Locks, ignoring poisoning: every guarded structure is left consistent between statements, and one panicked
/// worker must not turn every later command into an error.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
