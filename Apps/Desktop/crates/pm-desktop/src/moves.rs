//! IPC for the live controls the input thread owns: zoom (§1.J), the record countdown
//! (H2), the all-axes lock (I5), programmed moves and gimbal presets (§1.Q), and the
//! operator's feel (`input_configure`). Each handler posts to the input thread and
//! returns; the two that answer with a pose wait for it off the main thread.

use std::sync::mpsc::channel;
use std::time::Duration;

use pm_controller::input::Pose;
use pm_controller::zoom::ZoomWrite;

use crate::input::{post, InputConfig, InputMsg, MoveOp};

/// A zoom from the web. `mode: "slider"` is the dial (coalesced, pipelined at 20 Hz by
/// the mailbox, not retransmitted); anything else is a jump to a stop (urgent,
/// retransmitted). Clamped to the body's stops; out of D-Log2 it hops the colour first
/// and waits for the body (J2); rolling in D-Log2 it is refused with a notice.
#[tauri::command]
pub fn zoom_write(factor: f64, mode: Option<String>) {
    if !factor.is_finite() {
        return;
    }
    let write = match mode.as_deref() {
        Some("slider") => ZoomWrite::Slider(factor),
        _ => ZoomWrite::Jump(factor),
    };
    post(InputMsg::Zoom(write));
}

/// Continuous zoom (`zoomBy`): −1 out … 1 in, 0 stops. Send on change only; Rust writes
/// the dial at the phones' rate.
#[tauri::command]
pub fn zoom_rate(rate: f64) {
    post(InputMsg::ZoomRate(rate));
}

/// One of the body's stops in (`1`) or out (`-1`).
#[tauri::command]
pub fn zoom_step(direction: i32) {
    post(InputMsg::ZoomStep(direction));
}

/// `T`, or record with the countdown on: arms the countdown (3, 5 or 10 s), or cancels
/// it. It fires on the input thread.
#[tauri::command]
pub fn record_countdown() {
    post(InputMsg::Countdown);
}

/// The all-axes hold latch: rests the gimbal and ignores the stick until let go.
#[tauri::command]
pub fn gimbal_lock_all(on: bool) {
    post(InputMsg::LockAll(on));
}

#[tauri::command]
pub fn input_configure(config: InputConfig) {
    post(InputMsg::Configure(config));
}

/// A web view that (re)attached: send `input://state`, `tracking://box` and
/// `gamepad://state` again.
#[tauri::command]
pub fn input_resend() {
    post(InputMsg::Resend);
}

async fn answered(
    make: impl FnOnce(std::sync::mpsc::Sender<Result<Pose, String>>) -> MoveOp,
) -> Result<Pose, String> {
    let (tx, rx) = channel();
    post(InputMsg::Move(make(tx)));
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_millis(500))
            .map_err(|_| "THE GIMBAL DID NOT ANSWER".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

fn point_slot(name: &str) -> Result<char, String> {
    match name.to_ascii_lowercase().as_str() {
        "a" => Ok('a'),
        "b" => Ok('b'),
        "c" => Ok('c'),
        _ => Err("NO SUCH POINT".to_string()),
    }
}

/// **Set here**: A, B or C from the live pose.
#[tauri::command]
pub async fn moves_set_point(slot: String) -> Result<Pose, String> {
    let point = point_slot(&slot)?;
    answered(move |tx| MoveOp::SetPoint(point, tx)).await
}

#[tauri::command]
pub fn moves_clear_point(slot: String) {
    if let Ok(point) = point_slot(&slot) {
        post(InputMsg::Move(MoveOp::ClearPoint(point)));
    }
}

/// Leg durations `[A→B, B→C]` and the smoothness at B.
#[tauri::command]
pub fn moves_configure(leg_seconds: Option<[f64; 2]>, smoothness: Option<f64>) {
    post(InputMsg::Move(MoveOp::Configure(leg_seconds, smoothness)));
}

/// **Start**: 3-2-1, then the approach, the hold and the timed legs.
#[tauri::command]
pub fn moves_start() {
    post(InputMsg::Move(MoveOp::Start));
}

#[tauri::command]
pub fn moves_stop() {
    post(InputMsg::Move(MoveOp::Stop));
}

#[tauri::command]
pub fn moves_pause() {
    post(InputMsg::Move(MoveOp::Pause));
}

#[tauri::command]
pub fn moves_resume() {
    post(InputMsg::Move(MoveOp::Resume));
}

/// **Save here** into preset `slot` (0…5).
#[tauri::command]
pub async fn preset_save(slot: usize) -> Result<Pose, String> {
    answered(move |tx| MoveOp::PresetSave(slot, tx)).await
}

/// **Go**: one timed move, or two steps when the route needs it.
#[tauri::command]
pub fn preset_go(slot: usize) {
    post(InputMsg::Move(MoveOp::PresetGo(slot)));
}

#[tauri::command]
pub fn preset_clear(slot: usize) {
    post(InputMsg::Move(MoveOp::PresetClear(slot)));
}

/// How long a recall takes (0.5, 1, 2, 4, 8 or 15 s on the sheet).
#[tauri::command]
pub fn preset_seconds(seconds: f64) {
    post(InputMsg::Move(MoveOp::PresetSeconds(seconds)));
}
