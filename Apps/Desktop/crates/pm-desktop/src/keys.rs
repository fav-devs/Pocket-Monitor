//! `control_key`: every viewfinder key (§1.R), routed by `pm_controller::keys`.
//!
//! Camera keys go to the input thread, which keeps the desktop semantics (Space starts,
//! R stops, `+`/`-` step the body's stops, the arrows are a held stick fed by the web's
//! 100 ms heartbeat, 1–6 recall presets, T arms the countdown). `V` goes through the
//! camera service so the commanded gimbal mode stays true in `camera://state`. `F11`
//! toggles fullscreen here (D1), and `J` switches gestures here (`gestures::toggle`).
//! Everything else comes back to the web as the [`UiAction`] to carry out (a sheet, an
//! assist, the chrome, the library, a still, `Y`'s hand view, Esc).
//! The handler only routes and queues; it never waits.

use pm_controller::command::CameraCommand;
use pm_controller::keys::{self, Route, UiAction};
use tauri::{AppHandle, Manager};

use crate::camera::CameraService;
use crate::input::{post, InputMsg};

/// A key event from the web: `key` is `KeyboardEvent.key`; `repeat` is the keyboard's
/// auto-repeat or the web's heartbeat for held arrows. Returns the web's part, if any.
#[tauri::command]
pub fn control_key(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
    down: bool,
    repeat: Option<bool>,
) -> Option<UiAction> {
    let repeat = repeat.unwrap_or(false);
    let parsed = keys::parse(&key)?;
    match keys::route(parsed)? {
        Route::Input(key) => {
            post(InputMsg::Key { key, down, repeat });
            None
        }
        Route::GimbalCycle => {
            if down && !repeat {
                if let Some(camera) = app.try_state::<CameraService>() {
                    let mode = keys::next_gimbal_mode(camera.state().gimbal.mode);
                    let _ = camera.command(&CameraCommand::GimbalSetMode {
                        mode: mode.to_string(),
                    });
                }
            }
            None
        }
        Route::Ui(action) => {
            if !down || repeat {
                return None;
            }
            if action == UiAction::Fullscreen {
                let wanted = !window.is_fullscreen().unwrap_or(false);
                let _ = window.set_fullscreen(wanted);
            }
            if action == UiAction::ToggleGestures {
                // Saved and applied off the main thread; `gestures://state` follows.
                crate::gestures::toggle();
            }
            Some(action)
        }
    }
}

/// The key list, for the web's key hints and the shortcuts screen.
#[tauri::command]
pub fn control_keys() -> Vec<(&'static str, &'static str)> {
    keys::KEY_HELP.to_vec()
}
