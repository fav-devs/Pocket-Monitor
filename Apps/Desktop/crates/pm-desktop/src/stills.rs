//! `still_capture` (F4, D11): the graded frame at the source raster — desqueezed when the
//! lens squeezed it, as the phones' snapshot is — written as a PNG into the operator's
//! Pictures folder (`Pictures\Pocket Monitor`), never the working directory.
//!
//! The render thread renders it on its still targets (the window's targets are not
//! touched) and hands the pixels back; the PNG is encoded here, on a blocking worker, so
//! the picture keeps presenting while it is written.

use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use opc_render::{write_png, Rgba};
use pm_controller::link::diagnostic;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::picture::PictureHub;

/// How long the render thread has to produce the frame.
const WAIT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Still {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// `Pictures/Pocket Monitor` under the user's profile; a per-user app-data folder when
/// there is no profile to find.
pub fn folder() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    if let Some(home) = home {
        return PathBuf::from(home).join("Pictures").join("Pocket Monitor");
    }
    pm_controller::luts::custom_folder()
        .parent()
        .map_or_else(|| PathBuf::from("."), PathBuf::from)
        .join("stills")
}

/// `PocketMonitor-YYYYMMDD-HHMMSS.png` in UTC.
fn file_name(now: SystemTime) -> String {
    let seconds = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let (days, rest) = ((seconds / 86_400) as i64, seconds % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "PocketMonitor-{year:04}{month:02}{day:02}-{:02}{:02}{:02}.png",
        rest / 3600,
        (rest / 60) % 60,
        rest % 60
    )
}

fn unique(folder: &std::path::Path, name: &str) -> PathBuf {
    let path = folder.join(name);
    if !path.exists() {
        return path;
    }
    let stem = name.trim_end_matches(".png");
    (2..)
        .map(|n| folder.join(format!("{stem}-{n}.png")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(path)
}

fn write(image: &Rgba) -> Result<Still, String> {
    let folder = folder();
    std::fs::create_dir_all(&folder).map_err(|error| format!("{}: {error}", folder.display()))?;
    let path = unique(&folder, &file_name(SystemTime::now()));
    write_png(&path, image)?;
    Ok(Still {
        path: path.display().to_string(),
        width: image.width,
        height: image.height,
    })
}

/// Takes the still. The answer carries the file it went to; the "Wrote …" notice goes out
/// on `camera://event` and `picture://still` is emitted too.
#[tauri::command]
pub async fn still_capture(app: AppHandle) -> Result<Still, String> {
    let (reply, frame) = mpsc::channel();
    app.state::<Arc<PictureHub>>().still(reply);
    let written = tauri::async_runtime::spawn_blocking(move || {
        let image = frame
            .recv_timeout(WAIT)
            .map_err(|_| "The picture did not answer in time.".to_string())??;
        write(&image)
    })
    .await
    .map_err(|error| error.to_string())?;
    // The old window's "Wrote …", as a notice the desktop session shows.
    let notice = |message: String, tone: &str| {
        let _ = app.emit(
            "camera://event",
            serde_json::json!({ "type": "notice", "message": message, "tone": tone }),
        );
    };
    match &written {
        Ok(still) => {
            diagnostic(format_args!("still: wrote {}", still.path));
            let name = std::path::Path::new(&still.path).file_name().map_or_else(
                || still.path.clone(),
                |name| name.to_string_lossy().into_owned(),
            );
            notice(format!("Wrote {name} to Pictures"), "success");
            let _ = app.emit("picture://still", still.clone());
        }
        Err(error) => {
            diagnostic(format_args!("still: {error}"));
            notice(format!("Could not take the still: {error}"), "warning");
        }
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_is_named_for_the_utc_time() {
        let at = UNIX_EPOCH + Duration::from_secs(1_764_115_200 + 3_723);
        assert_eq!(file_name(at), "PocketMonitor-20251126-010203.png");
    }
}
