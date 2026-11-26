//! The desktop's remembered settings over IPC (`docs/desktop-expo-port.md` X1–X3):
//! `desktop-prefs.txt` and `desktop-app-v1.txt`, the old viewfinder's files read and
//! written in place, plus the one-time seed of the web's own stores from them.

use std::sync::Mutex;

use pm_controller::appsettings::{self, AppSettings};
use pm_controller::prefs::{self, Saved};

/// One writer at a time: the web can send two changes in one frame.
static WRITE: Mutex<()> = Mutex::new(());

/// The desktop-only settings (`countdownSeconds`, `ramp`, `timecode`, `showPad`, `vcam`,
/// …) as camelCase JSON.
#[tauri::command]
pub fn prefs_get() -> serde_json::Value {
    let saved = prefs::load(&prefs::path()).unwrap_or_default();
    prefs::prefs_json(&saved.prefs)
}

/// Lays a camelCase patch over the settings, saves, and returns the result. A value out
/// of range is clamped or ignored, as the file's reader does.
#[tauri::command]
pub fn prefs_set(patch: serde_json::Value) -> Result<serde_json::Value, String> {
    let _guard = WRITE.lock().map_err(|_| "settings are busy".to_string())?;
    let path = prefs::path();
    let mut saved: Saved = prefs::load(&path).unwrap_or_default();
    saved.prefs = prefs::apply_prefs_patch(&saved.prefs, &patch);
    prefs::save(&path, &saved).map_err(|error| format!("could not save the settings: {error}"))?;
    Ok(prefs::prefs_json(&saved.prefs))
}

/// The home screen's settings (A2): webcam gestures and *Open my camera straight away*.
#[tauri::command]
pub fn app_settings_get() -> AppSettings {
    appsettings::load()
}

#[tauri::command]
pub fn app_settings_set(settings: AppSettings) -> Result<AppSettings, String> {
    let _guard = WRITE.lock().map_err(|_| "settings are busy".to_string())?;
    appsettings::save_to(&appsettings::path(), &settings)
        .map_err(|error| format!("could not save the settings: {error}"))?;
    Ok(settings)
}

/// The old viewfinder's assists and stick feel for the web stores, once per PC; null when
/// nothing is owed. The web calls `prefs_web_seeded` after applying it.
#[tauri::command]
pub fn prefs_web_seed() -> Option<serde_json::Value> {
    prefs::pending_web_seed(&prefs::path())
}

#[tauri::command]
pub fn prefs_web_seeded() -> Result<(), String> {
    prefs::mark_web_seeded(&prefs::path()).map_err(|error| error.to_string())
}
