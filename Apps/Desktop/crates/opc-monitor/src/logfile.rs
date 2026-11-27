//! Where the app's diagnostic log lives. The rule is `pm-controller`'s, shared with the
//! Tauri app ([`pm_controller::platform::log_path`], D3): beside the executable for a
//! portable copy or a developer build, and per user (`<data folder>/logs`) for an
//! installed copy or whenever the executable's folder cannot be written, so a copy under
//! Program Files still leaves a log behind.

use std::path::PathBuf;

/// The log file every part of the viewfinder appends to; `None` when there is nowhere
/// to write one.
pub fn path() -> Option<PathBuf> {
    pm_controller::platform::log_path()
}
