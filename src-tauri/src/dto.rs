//! Wire types shared with the frontend. Field names are part of the UI contract: do not rename.

use limpa_core::Item;
use limpa_core::apps::AppInfo;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskOverview {
    pub total: u64,
    pub free: u64,
    pub used: u64,
    pub fda: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDto {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub selected: bool,
    pub note: Option<String>,
    pub modified: Option<i64>,
    /// Removal moves it to the Trash (recoverable) instead of deleting it; lets the UI word confirmations exactly.
    pub trash: bool,
    pub accessed: Option<i64>,
}

impl ItemDto {
    pub fn new(id: u64, item: &Item) -> Self {
        Self {
            id,
            name: item.name.clone(),
            path: item.path.to_string_lossy().into_owned(),
            size: item.size,
            selected: item.selected,
            note: item.note.clone(),
            modified: item.modified,
            trash: matches!(item.policy, limpa_core::Policy::MoveToTrash),
            accessed: item.accessed,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDto {
    pub id: String,
    pub title: String,
    pub description: String,
    pub total: u64,
    pub items: Vec<ItemDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub groups: Vec<GroupDto>,
    pub total: u64,
    pub needs_fda: bool,
}

impl ScanResult {
    pub fn new(groups: Vec<GroupDto>, needs_fda: bool) -> Self {
        let total = groups.iter().map(|g| g.total).sum();
        Self { groups, total, needs_fda }
    }

    pub fn needs_fda() -> Self {
        Self::new(Vec::new(), true)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDto {
    pub id: u64,
    pub name: String,
    pub bundle_id: String,
    pub version: Option<String>,
    pub size: u64,
    pub running: bool,
    pub path: String,
}

impl AppDto {
    pub fn new(id: u64, app: &AppInfo) -> Self {
        Self {
            id,
            name: app.name.clone(),
            bundle_id: app.bundle_id.clone(),
            version: app.version.clone(),
            size: app.size,
            running: app.running,
            path: app.path.to_string_lossy().into_owned(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeDto {
    pub id: u64,
    pub ok: bool,
    pub freed: u64,
    pub error: Option<String>,
}

impl OutcomeDto {
    pub fn failed(id: u64, error: impl Into<String>) -> Self {
        Self { id, ok: false, freed: 0, error: Some(error.into()) }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub outcomes: Vec<OutcomeDto>,
    pub freed: u64,
}

/// Payload of the `scan-progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub task: &'static str,
    pub path: String,
    pub bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use limpa_core::Policy;
    use serde_json::{Value, json};
    use std::path::PathBuf;

    fn keys(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    #[test]
    fn disk_overview_keys() {
        let v = serde_json::to_value(DiskOverview { total: 10, free: 4, used: 6, fda: true }).unwrap();
        assert_eq!(v, json!({"total": 10, "free": 4, "used": 6, "fda": true}));
    }

    #[test]
    fn scan_result_keys_and_total() {
        let item = Item::new(PathBuf::from("/nonexistent/x"), 7, Policy::MoveToTrash).unselected("nota");
        let group = GroupDto {
            id: "g".into(),
            title: "T".into(),
            description: "D".into(),
            total: 7,
            items: vec![ItemDto::new(3, &item)],
        };
        let v = serde_json::to_value(ScanResult::new(vec![group], false)).unwrap();
        assert_eq!(keys(&v), ["groups", "needsFda", "total"]);
        assert_eq!(v["total"], 7);
        assert_eq!(v["needsFda"], false);
        let g = &v["groups"][0];
        assert_eq!(keys(g), ["description", "id", "items", "title", "total"]);
        let i = &g["items"][0];
        assert_eq!(keys(i), ["accessed", "id", "modified", "name", "note", "path", "selected", "size", "trash"]);
        assert_eq!(i["trash"], matches!(item.policy, limpa_core::Policy::MoveToTrash));
        assert_eq!(i["id"], 3);
        assert_eq!(i["name"], "x");
        assert_eq!(i["path"], "/nonexistent/x");
        assert_eq!(i["selected"], false);
        assert_eq!(i["note"], "nota");
        assert!(i["modified"].is_null());
        assert!(i["accessed"].is_null());
    }

    #[test]
    fn needs_fda_result_is_empty() {
        let v = serde_json::to_value(ScanResult::needs_fda()).unwrap();
        assert_eq!(v, json!({"groups": [], "total": 0, "needsFda": true}));
    }

    #[test]
    fn app_dto_keys() {
        let app = AppInfo {
            path: PathBuf::from("/Applications/Foo.app"),
            name: "Foo".into(),
            bundle_id: "com.foo".into(),
            version: Some("1.2".into()),
            size: 99,
            running: true,
        };
        let v = serde_json::to_value(AppDto::new(5, &app)).unwrap();
        assert_eq!(
            v,
            json!({"id": 5, "name": "Foo", "bundleId": "com.foo", "version": "1.2", "size": 99,
                   "running": true, "path": "/Applications/Foo.app"})
        );
    }

    #[test]
    fn remove_result_keys() {
        let r = RemoveResult {
            outcomes: vec![OutcomeDto::failed(1, "x"), OutcomeDto { id: 2, ok: true, freed: 5, error: None }],
            freed: 5,
        };
        let v = serde_json::to_value(r).unwrap();
        assert_eq!(
            v,
            json!({"outcomes": [
                {"id": 1, "ok": false, "freed": 0, "error": "x"},
                {"id": 2, "ok": true, "freed": 5, "error": null}
            ], "freed": 5})
        );
    }

    #[test]
    fn progress_event_keys() {
        let v = serde_json::to_value(ProgressEvent { task: "junk", path: "/a".into(), bytes: 1 }).unwrap();
        assert_eq!(v, json!({"task": "junk", "path": "/a", "bytes": 1}));
    }
}
