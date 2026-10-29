use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::Serialize;

use crate::model::{Item, Progress};

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub path: PathBuf,
    pub name: String,
    pub bundle_id: String,
    pub version: Option<String>,
    pub size: u64,
    pub running: bool,
}

pub fn list_apps(_roots: &[PathBuf], _running: &HashSet<String>, _own_bundle_id: &str, _p: &Progress) -> Vec<AppInfo> {
    todo!("INC-3")
}

pub fn find_leftovers(_home: &Path, _app: &AppInfo, _cancel: &AtomicBool) -> Vec<Item> {
    todo!("INC-3")
}
