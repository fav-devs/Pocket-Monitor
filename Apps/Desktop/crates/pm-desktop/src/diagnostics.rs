//! Diagnostics and the log (`docs/desktop-expo-port.md` Y1, Y2).
//!
//! The log is `pocket-monitor.log`: beside the executable for a portable copy or a
//! developer build, under `%LOCALAPPDATA%\OpenPocketCine\logs` for an installed one
//! (D3: `C:\Program Files` is not writable, so the old installed build lost its log).
//! Each launch keeps the previous session's log as `pocket-monitor.previous.log`.
//! Line formats are the old ones, which the benchmark parses (§4).

use std::path::PathBuf;

use pm_controller::link::log_line;
use pm_controller::platform;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::camera::CameraService;

/// Where the files are, for the settings rows and the report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    pub log: Option<String>,
    pub logs_folder: Option<String>,
    pub data_folder: String,
    pub lut_folder: String,
}

fn paths() -> Paths {
    let shown = |path: PathBuf| path.display().to_string();
    Paths {
        log: platform::log_path().map(shown),
        logs_folder: platform::log_dir().map(shown),
        data_folder: shown(platform::data_dir()),
        lut_folder: shown(pm_controller::luts::custom_folder()),
    }
}

#[tauri::command]
pub fn diagnostics_paths() -> Paths {
    paths()
}

/// The last `lines` lines of this session's log (default 200).
#[tauri::command]
pub async fn log_tail(lines: Option<usize>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = platform::log_path().ok_or("This build has nowhere to log.")?;
        let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
        Ok(platform::tail_lines(&text, lines.unwrap_or(200).min(5000)))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Writes `diagnostics-<unix>.txt` beside the LUT folder (Y2): the app and platform, the
/// camera state the backend holds, the web's own report when it sends one, and the tail
/// of the log. Returns the file's path. No credentials: neither the state nor the log
/// carries any.
#[tauri::command]
pub async fn diagnostics_write(app: AppHandle, report: Option<String>) -> Result<String, String> {
    let state = app
        .try_state::<CameraService>()
        .map(|camera| serde_json::to_string_pretty(&camera.state()).unwrap_or_default())
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let folder = platform::data_dir();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let path = folder.join(format!("diagnostics-{stamp}.txt"));
        let where_ = paths();
        let log = platform::log_path()
            .and_then(|log| std::fs::read_to_string(log).ok())
            .map(|text| platform::tail_lines(&text, 400))
            .unwrap_or_default();
        let text = format!(
            "Pocket Monitor {version} (desktop, {os}/{arch})\n\
             log {log_path}\n\
             data {data}\n\n\
             == camera state ==\n{state}\n\n\
             == web report ==\n{report}\n\n\
             == log tail ==\n{log}\n",
            version = env!("CARGO_PKG_VERSION"),
            os = std::env::consts::OS,
            arch = std::env::consts::ARCH,
            log_path = where_.log.unwrap_or_else(|| "none".into()),
            data = where_.data_folder,
            report = report.unwrap_or_default(),
        );
        std::fs::create_dir_all(&folder)
            .and_then(|()| std::fs::write(&path, text))
            .map_err(|error| format!("Could not write diagnostics: {error}"))?;
        log_line("pm-desktop", format_args!("wrote {}", path.display()));
        Ok(path.display().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Which folder `open_folder` may show. Never an arbitrary path from the web.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Folder {
    Logs,
    Data,
    Luts,
}

#[tauri::command]
pub fn open_folder(which: Folder) -> Result<(), String> {
    let path = match which {
        Folder::Logs => platform::log_dir().ok_or("This build has nowhere to log.")?,
        Folder::Data => platform::data_dir(),
        Folder::Luts => pm_controller::luts::custom_folder(),
    };
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    platform::open_folder(&path).map_err(|error| error.to_string())
}
