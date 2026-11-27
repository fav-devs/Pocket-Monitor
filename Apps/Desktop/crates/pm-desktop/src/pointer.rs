//! `picture_pointer` and the tracking calls (§1.K).
//!
//! The web sends each pointer event on the picture in picture-normalised coordinates *as
//! seen* (0…1 across the fitted picture from `picture://fit`; outside it on a letterbox
//! bar), with the pointer's id. The input thread's `Tracker` decides: one pointer owns a
//! drag, a drag ≥ 2 % becomes a box (FRAME TOO SMALL under the core's minimum), a click
//! focuses, a cancel abandons. The result comes back on `tracking://box`.

use pm_controller::tracking::PointerPhase;

use crate::input::{post, InputConfig, InputMsg};

/// One pointer event. `mirror` is the picture's mirror as the web shows it.
#[tauri::command]
pub fn picture_pointer(phase: PointerPhase, x: f64, y: f64, id: Option<u64>, mirror: Option<bool>) {
    if let Some(mirror) = mirror {
        post(InputMsg::Configure(InputConfig {
            mirror: Some(mirror),
            ..InputConfig::default()
        }));
    }
    post(InputMsg::Pointer {
        phase,
        id: id.unwrap_or(1),
        u: x,
        v: y,
    });
}

/// Tap to focus at a picture point as seen (the phones' `focusAt`).
#[tauri::command]
pub fn focus_at(x: f64, y: f64, mirror: Option<bool>) {
    if let Some(mirror) = mirror {
        post(InputMsg::Configure(InputConfig {
            mirror: Some(mirror),
            ..InputConfig::default()
        }));
    }
    post(InputMsg::FocusAt(x, y));
}

/// `X`: stop tracking (sends the clear only when a box is out).
#[tauri::command]
pub fn track_clear() {
    post(InputMsg::TrackClear);
}
