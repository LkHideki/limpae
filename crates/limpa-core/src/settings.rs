use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::Group;

/// Which modules a Sweep scan runs. All on by default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SmartCareScope {
    pub junk: bool,
    pub trash: bool,
    pub protection: bool,
    pub performance: bool,
    pub apps: bool,
    pub files: bool,
}

impl Default for SmartCareScope {
    fn default() -> Self {
        Self { junk: true, trash: true, protection: true, performance: true, apps: true, files: true }
    }
}

/// User preferences, persisted as JSON. Unknown or missing fields fall back to defaults so older files keep
/// loading after upgrades.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Paths hidden from every scan (an ignored folder hides everything inside it).
    pub ignored: Vec<PathBuf>,
    pub smart_care: SmartCareScope,
    /// Show the menu bar extra.
    pub menu_bar: bool,
    /// Notify when the Trash grows past this many GB (None = off).
    pub notify_trash_gb: Option<u32>,
    /// Notify when free space drops below this many GB (None = off).
    pub notify_low_disk_gb: Option<u32>,
    /// Play sounds for the main actions (scan started/finished, cleanup done).
    pub sounds: bool,
    /// Default for user files, apps and leftovers: delete permanently instead of moving to the Trash. Each
    /// confirmation still lets the user choose.
    pub permanent_delete: bool,
    /// Unix seconds of the last finished Sweep run (None = never). Only `mark_smart_care` sets it.
    pub last_smart_care: Option<u64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ignored: Vec::new(),
            smart_care: SmartCareScope::default(),
            menu_bar: false,
            notify_trash_gb: None,
            notify_low_disk_gb: None,
            sounds: true,
            permanent_delete: false,
            last_smart_care: None,
        }
    }
}

impl Settings {
    /// ~/Library/Application Support/br.com.limpaemeo/settings.json
    pub fn path_in(home: &Path) -> PathBuf {
        home.join("Library/Application Support/br.com.limpaemeo/settings.json")
    }

    /// Missing or unreadable settings are not an error: the app starts with defaults.
    pub fn load(path: &Path) -> Self {
        fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// Atomic write (temp file + rename) so a crash never leaves a truncated file.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
        fs::rename(tmp, path)
    }

    pub fn is_ignored(&self, path: &Path) -> bool {
        self.ignored.iter().any(|i| path.starts_with(i))
    }

    pub fn ignore(&mut self, path: PathBuf) {
        if !self.is_ignored(&path) {
            self.ignored.retain(|i| !i.starts_with(&path));
            self.ignored.push(path);
            self.ignored.sort();
        }
    }

    pub fn unignore(&mut self, path: &Path) -> bool {
        let before = self.ignored.len();
        self.ignored.retain(|i| i != path);
        self.ignored.len() != before
    }

    /// Drops ignored items, then groups left empty.
    pub fn filter(&self, groups: Vec<Group>) -> Vec<Group> {
        groups
            .into_iter()
            .map(|mut g| {
                g.items.retain(|i| !self.is_ignored(&i.path));
                g
            })
            .filter(|g| !g.items.is_empty())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Item, Policy};

    #[test]
    fn missing_or_corrupt_file_loads_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.json");
        assert_eq!(Settings::load(&p), Settings::default());
        fs::write(&p, b"{not json").unwrap();
        assert_eq!(Settings::load(&p), Settings::default());
        assert!(Settings::default().smart_care.junk);
    }

    #[test]
    fn roundtrip_and_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = Settings::path_in(dir.path());
        let mut s = Settings::default();
        s.ignore(PathBuf::from("/a/b"));
        s.notify_trash_gb = Some(2);
        s.last_smart_care = Some(1_700_000_000);
        s.save(&p).unwrap();
        assert_eq!(Settings::load(&p), s);
        fs::write(&p, br#"{"menuBar": true}"#).unwrap();
        let partial = Settings::load(&p);
        assert!(partial.menu_bar && partial.smart_care.files && partial.sounds && partial.ignored.is_empty());
        assert_eq!(partial.last_smart_care, None);
        fs::write(&p, br#"{"lastSmartCare": 1700000000}"#).unwrap();
        assert_eq!(Settings::load(&p).last_smart_care, Some(1_700_000_000));
    }

    #[test]
    fn ignore_covers_descendants_and_collapses() {
        let mut s = Settings::default();
        s.ignore(PathBuf::from("/x/y/z"));
        s.ignore(PathBuf::from("/x/y"));
        assert_eq!(s.ignored, vec![PathBuf::from("/x/y")]);
        assert!(s.is_ignored(Path::new("/x/y/z/w")));
        assert!(!s.is_ignored(Path::new("/x/yy")));
        assert!(s.unignore(Path::new("/x/y")));
        assert!(!s.is_ignored(Path::new("/x/y/z")));
    }

    #[test]
    fn filter_drops_ignored_items_and_empty_groups() {
        let mut s = Settings::default();
        s.ignore(PathBuf::from("/c/a"));
        let item = |p: &str| Item {
            path: PathBuf::from(p),
            name: p.into(),
            size: 1,
            selected: true,
            note: None,
            modified: None,
            accessed: None,
            policy: Policy::MoveToTrash,
            ident: None,
        };
        let groups = vec![
            Group { id: "g1".into(), title: String::new(), description: String::new(), items: vec![item("/c/a")] },
            Group { id: "g2".into(), title: String::new(), description: String::new(), items: vec![item("/c/b")] },
        ];
        let out = s.filter(groups);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "g2");
    }
}
