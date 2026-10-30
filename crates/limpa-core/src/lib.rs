//! Scanning and removal engine for Limpae.
//!
//! Safety model: scans only produce [`Item`]s; nothing is removed unless an
//! item passes [`Guard::check`] again at removal time, against the [`Policy`]
//! that the scan assigned to it.

pub mod apps;
pub mod apps_extra;
pub mod cloud;
pub mod clutter;
pub mod disk;
pub mod fda;
pub mod guard;
pub mod health;
pub mod junk;
pub mod lang;
pub mod large;
pub mod lens;
pub mod log;
pub mod model;
pub mod perf;
pub mod remove;
pub mod running;
pub mod security;
pub mod settings;
pub mod size;
pub mod trashes;

pub use guard::{Guard, GuardError};
pub use model::{Group, Item, Policy, Progress};
