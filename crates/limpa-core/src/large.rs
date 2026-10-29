use std::path::Path;

use crate::model::{Group, Progress};

/// Large user files under home, grouped by kind: `video`, `archive`,
/// `disk_image`, `audio`, `other`.
pub fn scan_large(_home: &Path, _min_bytes: u64, _p: &Progress) -> Vec<Group> {
    todo!("INC-2")
}
