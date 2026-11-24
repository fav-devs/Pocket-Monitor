//! Where the app's diagnostic log lives: a folder the user can always write, so an
//! installed copy under Program Files still leaves a log behind.

use std::path::PathBuf;

/// `%LOCALAPPDATA%\OpenPocketCine\opc-monitor.log` (or the config folder elsewhere),
/// falling back to beside the executable.
pub fn path() -> Option<PathBuf> {
    let root = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    if let Some(root) = root {
        let folder = root.join("OpenPocketCine");
        if std::fs::create_dir_all(&folder).is_ok() {
            return Some(folder.join("opc-monitor.log"));
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("opc-monitor.log")))
}
