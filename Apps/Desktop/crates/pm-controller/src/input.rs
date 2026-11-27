//! The viewfinder's live controls without a window: keys, the gimbal stick from every
//! source, the game controller, zoom, tracking and tap focus, the record countdown,
//! programmed moves, gimbal presets, gestures (webcam or the camera's own picture), both
//! hands' pinch-and-drag control, face tracking by gesture and the double clap.
//!
//! These are the decisions the Slint shell (`opc-monitor/src/shell.rs`) made in `press`,
//! `release`, `controller_*`, `gesture`, `pointer_*`, `touch`, `move_*`, `preset_*` and
//! `tick`, moved here so the Tauri app's 100 Hz input thread can own them
//! (`docs/desktop-expo-port.md` §3.3 rule 3). Every call takes `now` in seconds and
//! returns the commands to put on the wire; nothing here touches a socket, a thread or a
//! window, so the shell's tests port as they were (`tests/input.rs`).
//!
//! What the web needs to draw comes out of [`LiveInput::view`] (countdown, program,
//! presets, the all-axes lock) and [`Tracker::view`] (the tracking box and reticle).

use std::path::PathBuf;

use opc_camera::{Command, SetOutcome, Status, TrackingPoll};
use opc_ui::{next_frame_rate, next_resolution, Action, Controls, Countdown, Key, Stick};
use serde::Serialize;

use crate::gesture::{Gesture, GestureAction, GestureMap};
use crate::gimbal::{zoom_trigger_step, DriveSource, GimbalDrive, StickSend};
use crate::hand::Control as HandControl;
use crate::moves::{can_send, MoveEngine, Program, Waypoint, MAX_DURATION, MIN_DURATION};
use crate::pad::{PadAction, PadButton, REST as PAD_REST};
use crate::prefs::Prefs;
use crate::presets::{self, Presets, RECALL_SECONDS};
use crate::tracking::{PointerPhase, Tracker};
use crate::zoom::{self, ZoomHop, ZoomNote, ZoomPolicy, ZoomRules, ZoomWrite};

/// Hold-to-zoom (triggers, `zoomBy`) writes the dial at most this often; the mailbox
/// pipelines the dial at 20 Hz, so faster would only be coalesced away.
pub const ZOOM_HOLD_INTERVAL: f64 = 0.05;
/// The programmed take's 3-2-1, as on the phones.
pub const MOVE_COUNTDOWN_SECONDS: f64 = 3.0;
/// The countdown lengths the Assist tab offers.
pub const COUNTDOWN_CHOICES: [u32; 3] = [3, 5, 10];
/// A pinching hand's stick throw is repeated this often between readings, inside the
/// drive's 250 ms heartbeat.
pub const HAND_BEAT: f64 = 0.1;
/// A hand stick not read again for this long is let go (the models stopped answering):
/// longer than the hand model's own 0.3 s grace for a hand out of view.
pub const HAND_STALE: f64 = 0.5;

/// A line for the operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub text: String,
    /// `info`, `warning`, `success`.
    pub tone: &'static str,
}

/// A pose for the web, in display degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Pose {
    pub yaw: f64,
    pub pitch: f64,
}

impl From<Waypoint> for Pose {
    fn from(point: Waypoint) -> Self {
        Self {
            yaw: point.yaw,
            pitch: point.pitch,
        }
    }
}

/// The mobile `MotionProgramState`, plus the desktop's top-bar readout.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramView {
    pub status: &'static str,
    pub a: Option<Pose>,
    pub b: Option<Pose>,
    pub c: Option<Pose>,
    pub leg_seconds: [f64; 2],
    pub smoothness: f64,
    pub progress: f64,
    pub error: Option<String>,
    /// "MOVE · STARTING IN 2", "MOVE · A→B 1.2 / 4.0 s", …; empty when idle.
    pub readout: String,
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetsView {
    pub slots: [Option<Pose>; presets::SLOTS],
    pub seconds: f64,
    pub choices: [f64; 6],
    /// The slot last recalled.
    pub cursor: Option<usize>,
}

/// A held gesture on its way to recording: the old viewfinder's
/// `HOLD TO START RECORDING [####------]` line.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GestureHold {
    /// "HOLD TO START RECORDING" or "HOLD TO STOP RECORDING".
    pub text: &'static str,
    /// 0…1 in tenths, as the bar fills.
    pub fraction: f64,
}

/// `input://state`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputView {
    /// Whole seconds left on the record countdown.
    pub countdown: Option<u32>,
    pub countdown_seconds: u32,
    pub locked_all_axes: bool,
    pub program: ProgramView,
    pub presets: PresetsView,
    pub gamepad_enabled: bool,
    /// A held gesture part-way to recording.
    pub gesture_hold: Option<GestureHold>,
}

/// The live controls.
#[derive(Debug)]
pub struct LiveInput {
    drive: GimbalDrive,
    stick: Stick,
    locked: bool,
    status: Status,
    model_id: i32,
    zoom: f64,
    zoom_rules: ZoomRules,
    zoom_hop: ZoomHop,
    zoom_policy: Box<dyn ZoomPolicy>,
    zoom_rate: f64,
    zoom_hold_at: Option<f64>,
    gamepad: bool,
    direction_lock: bool,
    pad_held: bool,
    pad_triggers: (f64, f64),
    pub tracker: Tracker,
    countdown: Option<Countdown>,
    countdown_seconds: u32,
    program: Program,
    engine: Option<MoveEngine>,
    move_countdown: Option<Countdown>,
    move_ticked_at: f64,
    move_reported: bool,
    attitude_seq: u32,
    attitude_at: f64,
    presets: Presets,
    preset_cursor: Option<usize>,
    preset_followup: Option<(Waypoint, f64, f64)>,
    presets_path: Option<PathBuf>,
    /// What each webcam gesture does (`desktop-app-v1.txt`, the home screen's map).
    gesture_map: GestureMap,
    /// The camera's picture is being read, so a face can be found for the face gesture.
    face_finder: bool,
    /// A gesture asked for the face to be tracked; the picture reader answers.
    face_request: bool,
    /// A pinching hand's throw and when it was last read.
    hand_stick: Option<(f64, f64, f64)>,
    hand_beat_at: f64,
    gesture_hold: Option<GestureHold>,
    notices: Vec<Notice>,
    stick_log: Vec<StickSend>,
    /// Markers asked for (the pad's Menu, a gesture) since the web last took them, by
    /// what asked. The web keeps markers and the take's clock.
    markers: Vec<&'static str>,
}

impl Default for LiveInput {
    fn default() -> Self {
        Self::new(&Prefs::default())
    }
}

impl LiveInput {
    pub fn new(prefs: &Prefs) -> Self {
        Self {
            drive: GimbalDrive::new(prefs.stick_sensitivity, prefs.ramp_tau()),
            stick: Stick::default(),
            locked: false,
            status: Status::default(),
            model_id: -1,
            zoom: 1.0,
            zoom_rules: ZoomRules::default(),
            zoom_hop: ZoomHop::default(),
            zoom_policy: zoom::policy(),
            zoom_rate: 0.0,
            zoom_hold_at: None,
            gamepad: prefs.gamepad,
            direction_lock: false,
            pad_held: false,
            pad_triggers: (0.0, 0.0),
            tracker: Tracker::default(),
            countdown: None,
            countdown_seconds: prefs.countdown_seconds.max(1),
            program: Program::default(),
            engine: None,
            move_countdown: None,
            move_ticked_at: 0.0,
            move_reported: true,
            attitude_seq: 0,
            attitude_at: f64::NEG_INFINITY,
            presets: Presets::default(),
            preset_cursor: None,
            preset_followup: None,
            presets_path: None,
            gesture_map: GestureMap::default(),
            face_finder: false,
            face_request: false,
            hand_stick: None,
            hand_beat_at: f64::NEG_INFINITY,
            gesture_hold: None,
            notices: Vec::new(),
            stick_log: Vec::new(),
            markers: Vec::new(),
        }
    }

    /// Reads the presets saved at `path` (`desktop-gimbal-presets-v1.txt`, X4) and keeps
    /// saving them there.
    pub fn with_presets_at(mut self, path: PathBuf) -> Self {
        if let Some(saved) = presets::load(&path) {
            self.presets = saved;
        }
        self.presets_path = Some(path);
        self
    }

    // ── Configuration ────────────────────────────────────────────────────────

    /// The phones' 1…5 sensitivity and the ramp's time constant (0 off).
    pub fn set_feel(&mut self, sensitivity: u8, tau: f64) {
        self.drive.set_feel(sensitivity, tau);
    }

    /// What each gesture does, from the app settings' map.
    pub fn set_gesture_map(&mut self, map: GestureMap) {
        self.gesture_map = map;
    }

    pub fn set_countdown_seconds(&mut self, seconds: u32) {
        self.countdown_seconds = seconds.clamp(1, 60);
    }

    /// The controller drives the camera only while this is on and the viewfinder is up.
    pub fn set_gamepad(&mut self, enabled: bool, now: f64) -> Vec<Command> {
        self.gamepad = enabled;
        if enabled {
            return Vec::new();
        }
        self.pad_triggers = (0.0, 0.0);
        self.zoom_hold_at = None;
        if self.pad_held {
            self.pad_held = false;
            return self.release(Some(DriveSource::Pad), now);
        }
        Vec::new()
    }

    /// Direction lock on the controller stick: only the dominant axis moves.
    pub fn set_direction_lock(&mut self, on: bool) {
        self.direction_lock = on;
    }

    pub fn set_model(&mut self, model_id: Option<i32>) {
        self.model_id = model_id.unwrap_or(-1);
        self.refresh_zoom();
    }

    pub fn model_id(&self) -> i32 {
        self.model_id
    }

    /// Operator lines queued since the last call.
    pub fn take_notices(&mut self) -> Vec<Notice> {
        let mut out = std::mem::take(&mut self.notices);
        out.extend(self.tracker.take_notices().into_iter().map(|text| Notice {
            text: text.to_string(),
            tone: "warning",
        }));
        out
    }

    /// Markers asked for since the last call (`gamepad`, `gesture`), for `input://marker`.
    pub fn take_marker_requests(&mut self) -> Vec<&'static str> {
        std::mem::take(&mut self.markers)
    }

    /// Every stick write since the last call, for the `stick tx` log line.
    pub fn take_stick_log(&mut self) -> Vec<StickSend> {
        std::mem::take(&mut self.stick_log)
    }

    fn notice(&mut self, text: impl Into<String>, tone: &'static str) {
        self.notices.push(Notice {
            text: text.into(),
            tone,
        });
    }

    fn stick(&mut self, send: Option<StickSend>) -> Vec<Command> {
        let Some(send) = send else {
            return Vec::new();
        };
        self.stick_log.push(send);
        vec![send.command]
    }

    // ── The camera's word ─────────────────────────────────────────────────────

    /// Takes the body's status: zoom follows the body, a new attitude push makes the
    /// pose fresh, and a zoom held for the D-Log2 hop goes once the hop is reported.
    pub fn set_status(&mut self, status: Status, now: f64) -> Vec<Command> {
        if let Some(hundredths) = status.zoom_hundredths {
            self.zoom = (f64::from(hundredths) / 100.0).clamp(1.0, 12.0);
        }
        if status.gimbal_attitude_seq != self.attitude_seq {
            self.attitude_seq = status.gimbal_attitude_seq;
            self.attitude_at = now;
        }
        self.status = status;
        self.refresh_zoom();
        let (released, note) = self.zoom_hop.status(self.status.color_mode, now);
        if let Some(note) = note {
            self.notice(note.text(), "warning");
        }
        released.into_iter().collect()
    }

    fn refresh_zoom(&mut self) {
        self.zoom_rules.refresh(
            self.zoom_policy.as_ref(),
            self.model_id,
            self.status.video_resolution,
            self.status.shooting_mode,
        );
    }

    pub fn status(&self) -> &Status {
        &self.status
    }

    /// The link went (or a new one opened): a box the body was following is not ours.
    pub fn link_lost(&mut self) {
        self.tracker.link_lost();
    }

    /// A reply frame; true when it was a tracking frame.
    pub fn frame(&mut self, cmd_set: u8, cmd_id: u8, payload: &[u8], now: f64) -> bool {
        self.tracker.frame(cmd_set, cmd_id, payload, now)
    }

    pub fn tracking_reply(&mut self, poll: TrackingPoll, now: f64) {
        self.tracker.reply(poll, now);
    }

    pub fn note_set(&mut self, outcome: &SetOutcome) -> Vec<Command> {
        self.tracker.note_set(outcome)
    }

    /// The body's live pose, when it has reported one.
    pub fn live_pose(&self) -> Option<Waypoint> {
        Waypoint::from_status(&self.status)
    }

    // ── Keys ──────────────────────────────────────────────────────────────────

    /// A key the input thread owns went down ([`crate::keys::Route::Input`]). `repeat`
    /// is the keyboard's auto-repeat, or the web's heartbeat for a held arrow: it keeps a
    /// held direction alive and never acts twice.
    pub fn key_down(&mut self, key: Key, repeat: bool, now: f64) -> Vec<Command> {
        if crate::keys::is_arrow(key) {
            if repeat {
                return self.key_heartbeat(now);
            }
            if self.locked {
                return Vec::new();
            }
            if self.stick.set(key, true) {
                // Manual control cancels the path, as on the phones.
                let mut out = self.move_stop();
                out.extend(self.stick_changed(now));
                return out;
            }
            return Vec::new();
        }
        if repeat {
            return Vec::new();
        }
        if let Key::Char(digit @ '1'..='6') = key {
            return self.preset_go(digit as usize - '1' as usize, now);
        }
        let Some(action) = Controls::new().press(key) else {
            return Vec::new();
        };
        self.act(action, now)
    }

    /// A key came up. Only the stick cares.
    pub fn key_up(&mut self, key: Key, now: f64) -> Vec<Command> {
        if self.stick.set(key, false) {
            return self.stick_changed(now);
        }
        Vec::new()
    }

    /// The web is still holding the arrows: keeps the 250 ms heartbeat fed.
    pub fn key_heartbeat(&mut self, now: f64) -> Vec<Command> {
        if self.stick.is_resting() || self.drive.source() != Some(DriveSource::Keys) {
            return Vec::new();
        }
        let (x, y) = self.stick.target();
        let sent = self.drive.drive(x, y, DriveSource::Keys, now);
        self.stick(sent)
    }

    fn stick_changed(&mut self, now: f64) -> Vec<Command> {
        let (x, y) = self.stick.target();
        let sent = if x == 0.0 && y == 0.0 {
            self.drive.release(Some(DriveSource::Keys), now)
        } else {
            self.drive.drive(x, y, DriveSource::Keys, now)
        };
        self.stick(sent)
    }

    fn act(&mut self, action: Action, now: f64) -> Vec<Command> {
        match action {
            Action::Send(command) => vec![command],
            Action::ZoomIn => {
                let target = self.zoom_rules.next(self.zoom);
                self.zoom_write(ZoomWrite::Jump(target), now)
            }
            Action::ZoomOut => {
                let target = self.zoom_rules.previous(self.zoom);
                self.zoom_write(ZoomWrite::Jump(target), now)
            }
            Action::ZoomWide => self.zoom_write(ZoomWrite::Jump(1.0), now),
            Action::ToggleTimer => {
                self.countdown_toggle(now);
                Vec::new()
            }
            Action::ClearTracking => self.tracker.clear(now),
            Action::CycleResolution | Action::CycleFrameRate => {
                let current = self
                    .status
                    .video_resolution
                    .zip(self.status.video_frame_rate);
                let stepped = if matches!(action, Action::CycleResolution) {
                    next_resolution(&self.status.available_formats, current)
                } else {
                    next_frame_rate(&self.status.available_formats, current)
                };
                // Nothing to step to sends nothing: no guess at what the body shoots.
                stepped
                    .map(|(resolution, frame_rate)| Command::SetVideoFormat {
                        resolution,
                        frame_rate,
                    })
                    .into_iter()
                    .collect()
            }
            // The web's own: sheets, assists, the chrome, stills, Esc.
            _ => Vec::new(),
        }
    }

    // ── The stick from the web (on-screen pad, touch) ─────────────────────────

    /// A throw in −1…1 (right and up positive) from the web, repeated as a heartbeat.
    pub fn drive(&mut self, x: f64, y: f64, source: DriveSource, now: f64) -> Vec<Command> {
        if self.locked {
            return Vec::new();
        }
        let mut out = Vec::new();
        if self.drive.is_resting() && (x.abs() > 0.02 || y.abs() > 0.02) {
            out.extend(self.move_stop());
        }
        let sent = self.drive.drive(x, y, source, now);
        out.extend(self.stick(sent));
        out
    }

    pub fn release(&mut self, source: Option<DriveSource>, now: f64) -> Vec<Command> {
        let sent = self.drive.release(source, now);
        self.stick(sent)
    }

    /// Rest at once, whoever was driving: focus loss, close, disconnect.
    pub fn rest(&mut self, now: f64) -> Vec<Command> {
        self.stick = Stick::default();
        self.hand_stick = None;
        self.pad_held = false;
        self.pad_triggers = (0.0, 0.0);
        self.zoom_rate = 0.0;
        self.zoom_hold_at = None;
        self.tracker.cancel_all();
        if self.drive.is_resting() {
            return Vec::new();
        }
        let sent = self.drive.rest_now(now);
        self.stick(Some(sent))
    }

    pub fn is_resting(&self) -> bool {
        self.drive.is_resting()
    }

    /// The throw last put on the wire.
    pub fn stick_sent(&self) -> (f64, f64) {
        self.drive.sent()
    }

    /// The all-axes hold latch: the stick is ignored until it is let go.
    pub fn lock_all_axes(&mut self, on: bool, now: f64) -> Vec<Command> {
        self.locked = on;
        if on {
            let mut out = self.rest(now);
            out.extend(self.move_stop());
            return out;
        }
        Vec::new()
    }

    pub fn locked_all_axes(&self) -> bool {
        self.locked
    }

    // ── The game controller ───────────────────────────────────────────────────

    /// The left stick and the triggers, polled at the input-thread rate.
    pub fn pad_axes(&mut self, x: f64, y: f64, left: f64, right: f64, now: f64) -> Vec<Command> {
        if !self.gamepad {
            return Vec::new();
        }
        self.pad_triggers = (left.clamp(0.0, 1.0), right.clamp(0.0, 1.0));
        let resting = x.abs() < PAD_REST && y.abs() < PAD_REST;
        if resting {
            if !self.pad_held {
                return Vec::new();
            }
            self.pad_held = false;
            return self.release(Some(DriveSource::Pad), now);
        }
        let (mut x, mut y) = (x, y);
        if self.direction_lock {
            if x.abs() >= y.abs() {
                y = 0.0;
            } else {
                x = 0.0;
            }
        }
        self.pad_held = true;
        self.drive(x, y, DriveSource::Pad, now)
    }

    /// A controller button on its way down, on the phones' map.
    pub fn pad_button(&mut self, button: PadButton, now: f64) -> Vec<Command> {
        if !self.gamepad {
            return Vec::new();
        }
        match button.action() {
            PadAction::Record => vec![self.record_command()],
            PadAction::Recenter => vec![Command::GimbalRecenter],
            PadAction::Flip => vec![Command::GimbalFlip],
            PadAction::Track => self.tracker.clear(now),
            PadAction::ZoomIn => self.act(Action::ZoomIn, now),
            PadAction::ZoomOut => self.act(Action::ZoomOut, now),
            PadAction::IsoUp => self.iso_step(1),
            PadAction::IsoDown => self.iso_step(-1),
            PadAction::ShutterOpen => self.shutter_step(1),
            PadAction::ShutterClose => self.shutter_step(-1),
            PadAction::Marker => {
                self.markers.push("gamepad");
                Vec::new()
            }
        }
    }

    /// The controller came or went: an unplug rests the stick and the zoom.
    pub fn pad_connected(&mut self, connected: bool, now: f64) -> Vec<Command> {
        if connected {
            return Vec::new();
        }
        self.pad_triggers = (0.0, 0.0);
        if self.pad_held {
            self.pad_held = false;
            return self.release(Some(DriveSource::Pad), now);
        }
        Vec::new()
    }

    /// What the record control does now: stop a take, start one, or in a stills mode
    /// take the picture, as the phones' shutter does.
    pub fn record_command(&self) -> Command {
        if self.status.is_recording {
            return Command::RecordStop;
        }
        let photo = self
            .status
            .shooting_mode
            .and_then(|code| u8::try_from(code).ok())
            .is_some_and(opc_camera::capture::mode_is_photo);
        if photo {
            Command::ShootPhoto
        } else {
            Command::RecordStart
        }
    }

    /// The next ISO index up or down the body's own list (or the wire's table).
    fn iso_step(&mut self, delta: i32) -> Vec<Command> {
        let status = &self.status;
        let color = status
            .color_mode
            .unwrap_or(opc_camera::capture::color::NORMAL);
        let list = opc_camera::capture::iso_indices(color, &status.available_iso);
        if list.is_empty() {
            return Vec::new();
        }
        let at = status
            .iso_index
            .and_then(|now| list.iter().position(|code| *code == now))
            .unwrap_or(0) as i32;
        let next = (at + delta).clamp(0, list.len() as i32 - 1) as usize;
        if next == at as usize && status.iso_index.is_some() {
            return Vec::new();
        }
        vec![Command::SetIsoIndex(list[next])]
    }

    /// The next shutter along the body's list: "open" is a longer exposure.
    fn shutter_step(&mut self, delta: i32) -> Vec<Command> {
        let status = &self.status;
        let mut list = opc_camera::capture::shutter_wheel(
            &status.available_shutter,
            status.shutter_denominator,
        );
        if list.is_empty() {
            return Vec::new();
        }
        list.sort_unstable_by(|a, b| b.cmp(a));
        let at = status
            .shutter_denominator
            .and_then(|now| list.iter().position(|denom| *denom == now))
            .unwrap_or(0) as i32;
        let next = (at + delta).clamp(0, list.len() as i32 - 1) as usize;
        if next == at as usize && status.shutter_denominator.is_some() {
            return Vec::new();
        }
        vec![Command::SetShutter(list[next])]
    }

    // ── Zoom ──────────────────────────────────────────────────────────────────

    /// A zoom, as the body allows it: clamped to its stops, hopped out of D-Log2 first,
    /// refused while rolling in D-Log2.
    pub fn zoom_write(&mut self, write: ZoomWrite, now: f64) -> Vec<Command> {
        // An unknown body has no stop list yet: keep the lens's whole range rather than
        // pinning every zoom to 1×.
        let clamp = |factor: f64| {
            if self.model_id < 0 && !self.zoom_rules.can_zoom() {
                factor.clamp(1.0, 12.0)
            } else {
                self.zoom_rules.clamp(factor)
            }
        };
        let write = match write {
            ZoomWrite::Slider(factor) => ZoomWrite::Slider(clamp(factor)),
            ZoomWrite::Jump(factor) => ZoomWrite::Jump(clamp(factor)),
        };
        let (commands, note) = self.zoom_hop.request(
            write,
            self.zoom_policy.as_ref(),
            self.status.color_mode,
            self.status.is_recording,
            self.model_id,
            now,
        );
        if let Some(note) = note {
            let tone = if note == ZoomNote::Restored {
                "info"
            } else {
                "warning"
            };
            self.notice(note.text(), tone);
        }
        if note != Some(ZoomNote::LockedWhileRecording) {
            self.zoom = write.factor();
        }
        commands
    }

    /// One stop in (`1`) or out (`-1`); in wraps from the top as the `+` key does.
    pub fn zoom_step(&mut self, direction: i32, now: f64) -> Vec<Command> {
        let action = if direction >= 0 {
            Action::ZoomIn
        } else {
            Action::ZoomOut
        };
        self.act(action, now)
    }

    /// Continuous zoom (the phones' `zoomBy`): −1 out … 1 in, 0 stops. The input thread
    /// turns it into dial writes at the phones' rate.
    pub fn zoom_rate(&mut self, rate: f64) {
        self.zoom_rate = if rate.is_finite() {
            rate.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        if self.zoom_rate == 0.0 && self.pad_triggers == (0.0, 0.0) {
            self.zoom_hold_at = None;
        }
    }

    pub fn zoom_stops(&self) -> &[f64] {
        self.zoom_rules.stops()
    }

    fn zoom_hold_tick(&mut self, now: f64) -> Vec<Command> {
        let (pad_left, pad_right) = if self.gamepad {
            self.pad_triggers
        } else {
            (0.0, 0.0)
        };
        let (left, right) = if pad_left >= PAD_REST || pad_right >= PAD_REST {
            (pad_left, pad_right)
        } else {
            ((-self.zoom_rate).max(0.0), self.zoom_rate.max(0.0))
        };
        if left < PAD_REST && right < PAD_REST {
            self.zoom_hold_at = None;
            return Vec::new();
        }
        let Some(at) = self.zoom_hold_at else {
            self.zoom_hold_at = Some(now);
            return Vec::new();
        };
        let dt = now - at;
        if dt < ZOOM_HOLD_INTERVAL {
            return Vec::new();
        }
        self.zoom_hold_at = Some(now);
        let max = if self.model_id < 0 && !self.zoom_rules.can_zoom() {
            12.0
        } else {
            self.zoom_rules.max()
        };
        let next = zoom_trigger_step(self.zoom, left, right, dt.min(0.1), max);
        if (next - self.zoom).abs() < 0.005 {
            return Vec::new();
        }
        self.zoom_write(ZoomWrite::Slider(next), now)
    }

    // ── The record countdown ──────────────────────────────────────────────────

    /// `T`, or the record control with the countdown on: arms it, or cancels it when
    /// it is already counting, which is what an operator reaches for when the shot is not
    /// ready.
    pub fn countdown_toggle(&mut self, now: f64) {
        self.countdown = match self.countdown {
            Some(_) => None,
            None => Some(Countdown::start(now, f64::from(self.countdown_seconds))),
        };
    }

    pub fn countdown(&self, now: f64) -> Option<u32> {
        self.countdown.map(|countdown| countdown.remaining(now))
    }

    // ── Programmed moves (Q1) ─────────────────────────────────────────────────

    /// **Set here**: point A, B or C from the body's live pose.
    pub fn move_set_point(&mut self, slot: char) -> Result<Waypoint, &'static str> {
        let Some(live) = self.live_pose() else {
            return Err("NO GIMBAL ATTITUDE YET");
        };
        if !live.is_reachable() {
            return Err("THE GIMBAL IS OUTSIDE ITS REACH");
        }
        match slot.to_ascii_lowercase() {
            'a' => self.program.a = Some(live),
            'b' => self.program.b = Some(live),
            'c' => self.program.c = Some(live),
            _ => return Err("NO SUCH POINT"),
        }
        Ok(live)
    }

    pub fn move_clear_point(&mut self, slot: char) {
        match slot.to_ascii_lowercase() {
            'a' => self.program.a = None,
            'b' => self.program.b = None,
            'c' => self.program.c = None,
            _ => {}
        }
    }

    /// Leg durations (snapped to the native tenths the engine requires, 0.5…120 s) and
    /// the smoothness at B (0…1).
    pub fn move_configure(&mut self, legs: Option<[f64; 2]>, smoothness: Option<f64>) {
        let leg = |seconds: f64| {
            if seconds.is_finite() {
                ((seconds * 10.0).round() / 10.0).clamp(MIN_DURATION, MAX_DURATION)
            } else {
                5.0
            }
        };
        if let Some([ab, bc]) = legs {
            self.program.duration_ab = leg(ab);
            self.program.duration_bc = leg(bc);
        }
        if let Some(smoothness) = smoothness.filter(|s| s.is_finite()) {
            self.program.smoothness = smoothness.clamp(0.0, 1.0);
        }
    }

    pub fn program(&self) -> &Program {
        &self.program
    }

    /// **Start**: a 3-2-1 like the phones, then the approach. Refused without A and B or
    /// a live pose.
    pub fn move_start(&mut self, now: f64) -> Vec<Command> {
        if self.program.a.is_none() || self.program.b.is_none() {
            self.notice("SET A AND B FIRST", "warning");
            return Vec::new();
        }
        if self.live_pose().is_none() {
            self.notice("NO GIMBAL ATTITUDE YET", "warning");
            return Vec::new();
        }
        let mut out = self.move_stop();
        self.move_countdown = Some(Countdown::start(now, MOVE_COUNTDOWN_SECONDS));
        out.extend(self.rest(now));
        out
    }

    /// **Stop**, or manual control: the native stop when a take is running.
    pub fn move_stop(&mut self) -> Vec<Command> {
        self.move_countdown = None;
        self.preset_followup = None;
        let mut out = Vec::new();
        if let Some(engine) = self.engine.as_mut() {
            if engine.is_running() {
                engine.cancel();
                out.push(Command::GimbalTimedStop);
            }
        }
        // An operator stop is not a failure: the program goes back to idle.
        self.engine = None;
        out
    }

    /// Pause: the motors stop and the remaining time freezes.
    pub fn move_pause(&mut self) -> Vec<Command> {
        match self.engine.as_mut().map(MoveEngine::pause) {
            Some(output) if output.stop => vec![Command::GimbalTimedStop],
            _ => Vec::new(),
        }
    }

    /// Resume from the body's settled pose, without a countdown.
    pub fn move_resume(&mut self, now: f64) -> Vec<Command> {
        let Some(live) = self.live_pose() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if let Some(engine) = self.engine.as_mut() {
            let output = engine.resume(live);
            if let Some((target, duration)) = output.target {
                out.push(target.timed_target(duration));
            }
            if output.stop {
                out.push(Command::GimbalTimedStop);
            }
            self.move_ticked_at = now;
        }
        out
    }

    pub fn move_running(&self) -> bool {
        self.engine.as_ref().is_some_and(MoveEngine::is_running) || self.move_countdown.is_some()
    }

    fn move_tick(&mut self, now: f64) -> Vec<Command> {
        let mut out = Vec::new();
        if let Some(countdown) = self.move_countdown {
            if !countdown.is_done(now) {
                return out;
            }
            self.move_countdown = None;
            let Some(live) = self.live_pose() else {
                self.notice("NO GIMBAL ATTITUDE YET", "warning");
                return out;
            };
            match MoveEngine::start(&self.program, live) {
                Ok(engine) => {
                    self.engine = Some(engine);
                    self.move_ticked_at = now;
                    self.move_reported = false;
                }
                Err(reason) => {
                    self.notice(reason, "warning");
                    return out;
                }
            }
        }
        let Some(engine) = self.engine.as_mut() else {
            return out;
        };
        if !engine.is_running() {
            if !self.move_reported {
                self.move_reported = true;
                if let Some(reason) = engine.failure().map(str::to_string) {
                    self.notice(format!("MOVE STOPPED · {reason}"), "warning");
                } else {
                    self.notice("MOVE · DONE", "success");
                }
            }
            return out;
        }
        let dt = now - self.move_ticked_at;
        if dt < 0.005 {
            return out;
        }
        self.move_ticked_at = now;
        let live = Waypoint::from_status(&self.status);
        let age = (now - self.attitude_at).max(0.0);
        // The 40 ms late rule is the engine's; this thread ticks at 100 Hz to keep it.
        let output = engine.tick(dt.min(0.12), live, age);
        if let Some((target, duration)) = output.target {
            out.push(target.timed_target(duration));
        }
        if output.stop {
            out.push(Command::GimbalTimedStop);
        }
        out
    }

    // ── Gimbal presets (Q2) ───────────────────────────────────────────────────

    pub fn presets(&self) -> &Presets {
        &self.presets
    }

    /// **Save here**: the live pose into a slot.
    pub fn preset_save(&mut self, slot: usize) -> Result<Waypoint, &'static str> {
        if slot >= presets::SLOTS {
            return Err("NO SUCH PRESET");
        }
        let Some(live) = self.live_pose().filter(Waypoint::is_reachable) else {
            return Err("NO GIMBAL ATTITUDE YET");
        };
        self.presets.slots[slot] = Some(live);
        self.persist_presets();
        self.notice(format!("PRESET {} SAVED", slot + 1), "success");
        Ok(live)
    }

    pub fn preset_clear(&mut self, slot: usize) {
        if let Some(entry) = self.presets.slots.get_mut(slot) {
            *entry = None;
            if self.preset_cursor == Some(slot) {
                self.preset_cursor = None;
            }
            self.persist_presets();
        }
    }

    /// How long a recall takes (0.5–25 s; the sheet offers 0.5/1/2/4/8/15).
    pub fn preset_seconds(&mut self, seconds: f64) {
        if seconds.is_finite() {
            self.presets.seconds = seconds.clamp(0.5, 25.0);
            self.persist_presets();
        }
    }

    fn persist_presets(&self) {
        if let Some(path) = &self.presets_path {
            if let Err(error) = presets::save(path, &self.presets) {
                eprintln!("could not save the gimbal presets: {error}");
            }
        }
    }

    /// Recalls a slot. A programmed take in progress is stopped first, as manual control
    /// stops it. Near poses go as one timed move; a pose half a turn or more away goes in
    /// two halves through the midpoint, so the firmware can never choose the route through
    /// the missing pan sector.
    pub fn preset_go(&mut self, slot: usize, now: f64) -> Vec<Command> {
        let Some(target) = self.presets.slots.get(slot).copied().flatten() else {
            self.notice("PRESET EMPTY", "info");
            return Vec::new();
        };
        let Some(live) = self.live_pose() else {
            self.notice("NO GIMBAL ATTITUDE YET", "warning");
            return Vec::new();
        };
        let mut out = self.move_stop();
        self.preset_followup = None;
        let seconds = self.presets.seconds;
        if can_send(&live, &target) {
            out.push(target.timed_target(seconds));
        } else if live.is_reachable() && target.is_reachable() {
            let middle = live.lerp(&target, 0.5);
            let half = (seconds / 2.0).max(0.3);
            if !(can_send(&live, &middle) && can_send(&middle, &target)) {
                self.notice("PRESET CANNOT BE REACHED", "warning");
                return out;
            }
            out.push(middle.timed_target(half));
            self.preset_followup = Some((target, half, now + half + 0.3));
        } else {
            self.notice("PRESET CANNOT BE REACHED", "warning");
            return out;
        }
        self.preset_cursor = Some(slot);
        self.notice(format!("PRESET {}", slot + 1), "info");
        out
    }

    fn preset_followup_tick(&mut self, now: f64) -> Vec<Command> {
        let Some((target, seconds, due)) = self.preset_followup else {
            return Vec::new();
        };
        if now < due {
            return Vec::new();
        }
        self.preset_followup = None;
        match self.live_pose() {
            Some(live) if can_send(&live, &target) => vec![target.timed_target(seconds)],
            _ => Vec::new(),
        }
    }

    // ── Webcam gestures (T4) ──────────────────────────────────────────────────

    /// A gesture does what the app settings' [`GestureMap`] says, as the old
    /// viewfinder's `Shell::gesture` does: recentre, flip, stop (the take's move,
    /// tracking and the body's timed move), record, or step through the saved presets.
    /// Face tracking lets go of tracking when there is some; otherwise, while the
    /// camera's picture is read ([`Self::set_face_finder`]), it asks the reader for the
    /// face ([`Self::take_face_request`], answered with [`Self::track_face`]), and says it
    /// needs the camera's picture when gestures come from the webcam.
    pub fn gesture(&mut self, gesture: Gesture, now: f64) -> Vec<Command> {
        match self.gesture_map.get(gesture) {
            GestureAction::Nothing => Vec::new(),
            GestureAction::Recenter => {
                self.notice("GESTURE: RECENTRE", "info");
                vec![Command::GimbalRecenter]
            }
            GestureAction::Flip => {
                self.notice("GESTURE: FLIP", "info");
                vec![Command::GimbalFlip]
            }
            GestureAction::Stop => {
                self.notice("GESTURE: STOP", "info");
                let mut out = self.move_stop();
                out.extend(self.tracker.clear(now));
                out.push(Command::GimbalTimedStop);
                out
            }
            GestureAction::Record => {
                self.notice("GESTURE: RECORD", "info");
                vec![self.record_command()]
            }
            GestureAction::Marker => {
                // The web's marker toast says what happened.
                self.markers.push("gesture");
                Vec::new()
            }
            GestureAction::FaceTrack => {
                if self.tracker.is_tracking() {
                    self.notice("FACE TRACKING OFF", "info");
                    self.tracker.clear(now)
                } else if self.face_finder {
                    self.face_request = true;
                    self.notice("LOOKING FOR YOUR FACE", "info");
                    Vec::new()
                } else {
                    self.notice("FACE TRACKING NEEDS THE CAMERA'S PICTURE", "info");
                    Vec::new()
                }
            }
            action @ (GestureAction::NextPreset | GestureAction::PreviousPreset) => {
                let filled: Vec<usize> = (0..presets::SLOTS)
                    .filter(|&i| self.presets.slots[i].is_some())
                    .collect();
                if filled.is_empty() {
                    self.notice("NO PRESETS SAVED", "info");
                    return Vec::new();
                }
                let forward = action == GestureAction::NextPreset;
                let next = match self.preset_cursor {
                    Some(at) if forward => filled.iter().copied().find(|&i| i > at),
                    Some(at) => filled.iter().rev().copied().find(|&i| i < at),
                    None => None,
                }
                .unwrap_or(if forward {
                    filled[0]
                } else {
                    filled[filled.len() - 1]
                });
                self.preset_go(next, now)
            }
        }
    }

    // ── The camera's picture read for hands and faces ─────────────────────────

    /// What each gesture does now.
    pub fn gesture_map(&self) -> GestureMap {
        self.gesture_map
    }

    /// Whether the camera's own picture is being read for hands and faces.
    pub fn set_face_finder(&mut self, on: bool) {
        self.face_finder = on;
        if !on {
            self.face_request = false;
            self.gesture_hold = None;
        }
    }

    /// True once after the face gesture asked for the face to be tracked.
    pub fn take_face_request(&mut self) -> bool {
        std::mem::take(&mut self.face_request)
    }

    /// How long a gesture has to be held: recording takes longer than the rest.
    pub fn gesture_hold_seconds(&self, gesture: Gesture) -> f64 {
        crate::vision::hold_seconds(&self.gesture_map, gesture)
    }

    /// A held pose part-way to firing (or none): shown while it is the one that
    /// records, between a tenth and the whole of its hold.
    pub fn gesture_progress(&mut self, progress: Option<(Gesture, f32)>) {
        self.gesture_hold = progress
            .filter(|(gesture, fraction)| {
                self.gesture_map.get(*gesture) == GestureAction::Record
                    && (0.1..1.0).contains(fraction)
            })
            .map(|(_, fraction)| GestureHold {
                text: if self.status.is_recording {
                    "HOLD TO STOP RECORDING"
                } else {
                    "HOLD TO START RECORDING"
                },
                fraction: (f64::from(fraction) * 10.0).floor() / 10.0,
            });
    }

    /// A pinching hand's control, `dt` seconds after the last reading: the stick hand
    /// drives the gimbal as a controller stick would, the zoom hand holds-to-zoom at the
    /// triggers' rate. The old viewfinder's `Shell::hand_control`.
    pub fn hand_control(&mut self, control: HandControl, dt: f64, now: f64) -> Vec<Command> {
        match control {
            HandControl::Stick { x, y } => {
                let (x, y) = (f64::from(x), f64::from(y));
                if x.abs() < PAD_REST && y.abs() < PAD_REST {
                    if self.hand_stick.take().is_none() {
                        return Vec::new();
                    }
                    return self.release(Some(DriveSource::Hand), now);
                }
                self.hand_stick = Some((x, y, now));
                self.hand_beat_at = now;
                self.drive(x, y, DriveSource::Hand, now)
            }
            HandControl::StickEnd => self.hand_release(now),
            HandControl::Zoom { rate } => {
                let (out, into) = (f64::from((-rate).max(0.0)), f64::from(rate.max(0.0)));
                if out < PAD_REST && into < PAD_REST {
                    return Vec::new();
                }
                let max = if self.model_id < 0 && !self.zoom_rules.can_zoom() {
                    12.0
                } else {
                    self.zoom_rules.max()
                };
                let next = zoom_trigger_step(self.zoom, out, into, dt.clamp(0.0, 0.1), max);
                if (next - self.zoom).abs() < 0.005 {
                    return Vec::new();
                }
                self.zoom_write(ZoomWrite::Slider(next), now)
            }
            HandControl::ZoomEnd => Vec::new(),
        }
    }

    /// Lets go of the hand's stick, if it was holding it.
    pub fn hand_release(&mut self, now: f64) -> Vec<Command> {
        if self.hand_stick.take().is_none() {
            return Vec::new();
        }
        self.release(Some(DriveSource::Hand), now)
    }

    /// Whether a pinching hand is driving the gimbal.
    pub fn hand_driving(&self) -> bool {
        self.hand_stick.is_some()
    }

    /// The hand's throw between readings: repeated inside the heartbeat while it is
    /// fresh, let go once the readings stop.
    fn hand_tick(&mut self, now: f64) -> Vec<Command> {
        let Some((x, y, heard)) = self.hand_stick else {
            return Vec::new();
        };
        if now - heard > HAND_STALE || self.drive.source() != Some(DriveSource::Hand) {
            return self.hand_release(now);
        }
        if now - self.hand_beat_at < HAND_BEAT {
            return Vec::new();
        }
        self.hand_beat_at = now;
        let sent = self.drive.drive(x, y, DriveSource::Hand, now);
        self.stick(sent)
    }

    /// A double clap: the gimbal goes back to centre.
    pub fn clap(&mut self, _now: f64) -> Vec<Command> {
        self.notice("CLAP: RECENTRE", "info");
        vec![Command::GimbalRecenter]
    }

    /// Tracks the face the picture reader found (`raw`: left, top, width, height of the
    /// decoded picture), as a drag of that box would.
    pub fn track_face(&mut self, raw: (f64, f64, f64, f64), now: f64) -> Vec<Command> {
        self.notice("FACE TRACKING", "info");
        let model = self.model_id;
        self.tracker.region(raw, model, now)
    }

    /// The face gesture found no face in time.
    pub fn no_face(&mut self) {
        self.notice("NO FACE FOUND", "info");
    }

    // ── Pointers ──────────────────────────────────────────────────────────────

    /// A pointer on the picture, in picture fractions as seen (see [`Tracker`]).
    pub fn pointer(
        &mut self,
        phase: PointerPhase,
        id: u64,
        u: f64,
        v: f64,
        now: f64,
    ) -> Vec<Command> {
        let model = self.model_id;
        self.tracker.pointer(phase, id, u, v, model, now)
    }

    /// A tap to focus at a point as seen, without a pointer stream.
    pub fn focus_at(&mut self, u: f64, v: f64, now: f64) -> Vec<Command> {
        let model = self.model_id;
        self.tracker.tap((u, v), model, now)
    }

    // ── The clock ─────────────────────────────────────────────────────────────

    /// The clock moved on: the stick keepalive, ramp and heartbeat rest; tracking polls
    /// and the tap's grace; the countdown; the move engine; the preset follow-up; hold
    /// to zoom.
    pub fn tick(&mut self, now: f64) -> Vec<Command> {
        let sent = self.drive.tick(now);
        if sent.is_some_and(|send| send.rest) && self.drive.source().is_none() {
            // A heartbeat rest lets go of everything the web was holding.
            self.stick = Stick::default();
            self.pad_held = false;
        }
        let mut out = self.stick(sent);
        out.extend(self.hand_tick(now));
        out.extend(self.tracker.tick(now));
        out.extend(self.move_tick(now));
        out.extend(self.preset_followup_tick(now));
        if self
            .countdown
            .is_some_and(|countdown| countdown.is_done(now))
        {
            self.countdown = None;
            out.push(Command::RecordStart);
        }
        out.extend(self.zoom_hold_tick(now));
        out
    }

    /// What the web draws besides the tracking box.
    pub fn view(&self, now: f64) -> InputView {
        let (status, progress, error, readout, paused) = match (&self.engine, self.move_countdown) {
            (_, Some(countdown)) => (
                "preparing",
                0.0,
                None,
                format!("MOVE · STARTING IN {}", countdown.remaining(now)),
                false,
            ),
            (Some(engine), None) => (
                engine.stage(),
                engine.progress(),
                engine.failure().map(str::to_string),
                engine.readout(),
                engine.is_paused(),
            ),
            (None, None) => ("idle", 0.0, None, String::new(), false),
        };
        let mut slots = [None; presets::SLOTS];
        for (slot, saved) in slots.iter_mut().zip(self.presets.slots.iter()) {
            *slot = saved.map(Pose::from);
        }
        InputView {
            countdown: self.countdown(now),
            countdown_seconds: self.countdown_seconds,
            locked_all_axes: self.locked,
            program: ProgramView {
                status,
                a: self.program.a.map(Pose::from),
                b: self.program.b.map(Pose::from),
                c: self.program.c.map(Pose::from),
                leg_seconds: [self.program.duration_ab, self.program.duration_bc],
                smoothness: self.program.smoothness,
                progress,
                error,
                readout,
                paused,
            },
            presets: PresetsView {
                slots,
                seconds: self.presets.seconds,
                choices: RECALL_SECONDS,
                cursor: self.preset_cursor,
            },
            gamepad_enabled: self.gamepad,
            gesture_hold: self.gesture_hold.clone(),
        }
    }
}
