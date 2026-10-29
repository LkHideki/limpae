//! Scanning and removal engine for Limpaemeo.
//!
//! Safety model: scans only produce [`Item`]s; nothing is removed unless an
//! item passes [`Guard::check`] again at removal time, against the [`Policy`]
//! that the scan assigned to it.

pub mod apps;
pub mod disk;
pub mod fda;
pub mod guard;
pub mod junk;
pub mod large;
pub mod log;
pub mod model;
pub mod remove;
pub mod running;
pub mod size;

pub use guard::{Guard, GuardError};
pub use model::{Group, Item, Policy, Progress};
