use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::guard::Guard;
use crate::log::ActionLog;
use crate::model::{Group, Item};

pub trait Remover: Sync {
    fn trash(&self, path: &Path) -> io::Result<()>;
    fn delete(&self, path: &Path) -> io::Result<()>;
}

pub struct SystemRemover;

#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    pub path: PathBuf,
    pub ok: bool,
    pub freed: u64,
    pub error: Option<String>,
}

impl Remover for SystemRemover {
    fn trash(&self, _path: &Path) -> io::Result<()> {
        todo!("INC-4")
    }
    fn delete(&self, _path: &Path) -> io::Result<()> {
        todo!("INC-4")
    }
}

pub fn remove_items(_items: &[Item], _guard: &Guard, _r: &dyn Remover, _log: &ActionLog) -> Vec<Outcome> {
    todo!("INC-4")
}

/// Direct children of ~/.Trash as `EmptyTrashEntry` items.
pub fn trash_entries(_home: &Path) -> Group {
    todo!("INC-4")
}
