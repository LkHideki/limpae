use std::collections::HashSet;
use std::path::Path;

use crate::model::{Group, Progress};

/// Regenerable junk under the user's home. Groups: `user_caches`,
/// `user_logs`, `xcode`, `dev_caches`.
pub fn scan_junk(_home: &Path, _running: &HashSet<String>, _p: &Progress) -> Vec<Group> {
    todo!("INC-2")
}
