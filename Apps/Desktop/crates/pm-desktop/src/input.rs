//! The 100 Hz input thread (`docs/desktop-expo-port.md` §3.3 rule 3, P7).
//!
//! It owns [`LiveInput`] — every time-critical live control that hung off the Slint
//! shell's `tick` and `poll_pad`: the gimbal stick stream from the keys, the on-screen
//! pad and the game controller (200 ms keepalive, 25 Hz ramp, immediate rest on
//! release, rest after 250 ms of heartbeat silence), hold-to-zoom at the dial's 20 Hz,
//! the tracking poll (0.5 s) and push silence (0.35 s), the tap-focus ACK wait (0.4 s),
//! the record countdown, the programmed-move engine with its 40 ms late abort, and the
//! preset two-step follow-up. It also polls the game controller (gilrs, [`crate::gamepad`]),
//! takes webcam gestures ([`crate::gestures`]), reads the hand models' results on the
//! camera's own picture ([`crate::vision`], `pm_controller::vision::FeedReader`: poses,
//! sweeps, both hands' pinch-and-drag, the face to track), and hears the double clap
//! ([`crate::mic`]), all while gestures are on and the live picture is on screen.
//!
//! The web posts intents over IPC ([`crate::keys`], [`crate::pointer`], [`crate::moves`])
//! and the camera's session thread forwards what the body says ([`observe`]); this thread
//! decides what reaches the wire and when. Nothing here waits on the web view or the
//! window; commands go onto the camera thread's channel. It emits, each only on change:
//! `input://state` (countdown, program, presets, lock; ≤ 15 Hz), `tracking://box`
//! (≤ 15 Hz), `gamepad://state` (≤ 60 Hz), `vision://hands` while the hand view is on
//! (≤ 15 Hz), and notices on `camera://event`.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opc_camera::{Command, DumlFrame, SetOutcome, Status};
use opc_ui::Key;
use pm_controller::appsettings::{AppSettings, GestureSource};
use pm_controller::gesture::Gesture;
use pm_controller::gimbal::{DriveSource, StickSend, INPUT_TICK_SECONDS};
use pm_controller::handnet::Update;
use pm_controller::input::{LiveInput, Pose};
use pm_controller::link::{log_line, FromCamera, LinkCommander};
use pm_controller::pad::PadButton;
use pm_controller::prefs;
use pm_controller::presets;
use pm_controller::tracking::PointerPhase;
use pm_controller::vision::{FeedReader, HandOverlay, Tuning};
use pm_controller::zoom::ZoomWrite;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

/// `tracking://box` and `input://state` at most this often.
const VIEW_INTERVAL: f64 = 1.0 / 15.0;
/// `gamepad://state` at most this often.
const PAD_INTERVAL: f64 = 1.0 / 60.0;

/// `input_configure`: the operator's feel for the live controls, sent by the web when a
/// preference changes. Absent fields keep what the thread has.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputConfig {
    /// The phones' 1…5 joystick sensitivity.
    pub stick_sensitivity: Option<u8>,
    /// The gimbal ramp: 0 off, 1 soft, 2 medium (desktop prefs `ramp`).
    pub ramp: Option<u8>,
    /// The `T` countdown, seconds.
    pub countdown_seconds: Option<u32>,
    /// The controller drives the camera (prefs `gamepad`, and the viewfinder is up).
    pub gamepad: Option<bool>,
    /// Direction lock on the controller stick.
    pub direction_lock: Option<bool>,
    /// The picture is mirrored (pointers are undone onto the sensor).
    pub mirror: Option<bool>,
}

/// A programmed-move or preset call from the web.
#[derive(Debug, Clone)]
pub enum MoveOp {
    SetPoint(char, Sender<Result<Pose, String>>),
    ClearPoint(char),
    Configure(Option<[f64; 2]>, Option<f64>),
    Start,
    Stop,
    Pause,
    Resume,
    PresetSave(usize, Sender<Result<Pose, String>>),
    PresetGo(usize),
    PresetClear(usize),
    PresetSeconds(f64),
}

pub(crate) enum InputMsg {
    Drive {
        x: f64,
        y: f64,
        source: DriveSource,
    },
    Release(Option<DriveSource>),
    /// Cancel, focus loss, window close: no ease.
    Rest(&'static str),
    Later {
        delay: f64,
        commands: Vec<Command>,
    },
    Attach(AppHandle),
    Status(Box<Status>),
    Frame(DumlFrame),
    Set(SetOutcome),
    Opened,
    Lost,
    Key {
        key: Key,
        down: bool,
        repeat: bool,
    },
    Pointer {
        phase: PointerPhase,
        id: u64,
        u: f64,
        v: f64,
    },
    FocusAt(f64, f64),
    TrackClear,
    Zoom(ZoomWrite),
    ZoomRate(f64),
    ZoomStep(i32),
    Countdown,
    LockAll(bool),
    Configure(InputConfig),
    Move(MoveOp),
    Gesture(Gesture),
    /// The gesture settings changed (`gestures::apply`): the map, the source, hand
    /// control, the stick hand, face tracking by itself.
    AppSettings(Box<AppSettings>),
    /// `Y`: the hand view is showing; `vision://hands` goes out while it is.
    HandView(bool),
    /// Re-emit everything (a reloaded web view re-attaching).
    Resend,
    Stop,
}

static BUS: OnceLock<Mutex<Sender<InputMsg>>> = OnceLock::new();

/// Posts to the input thread from anywhere (IPC handlers, the session thread, the
/// gesture reader). Never blocks.
pub(crate) fn post(message: InputMsg) {
    if let Some(bus) = BUS.get() {
        if let Ok(sender) = bus.lock() {
            let _ = sender.send(message);
        }
    }
}

/// The session thread's hook: what the body said, for the live controls. Only what they
/// read is copied (status, tracking frames, SET outcomes, link up and down).
pub fn observe(event: &FromCamera) {
    match event {
        FromCamera::Status(status) => post(InputMsg::Status(status.clone())),
        FromCamera::Frame(frame)
            if frame.cmd_set == 0x02 && matches!(frame.cmd_id, 0xA5 | 0x89) =>
        {
            post(InputMsg::Frame(frame.clone()));
        }
        FromCamera::Set(outcome) => post(InputMsg::Set(outcome.clone())),
        FromCamera::Opened(_) => post(InputMsg::Opened),
        FromCamera::Lost(_) => post(InputMsg::Lost),
        _ => {}
    }
}

/// Gives the thread the app, so it can emit and read the connected model. Called once
/// from `setup`; also starts webcam gestures when the operator asked for them (T5).
pub fn attach(app: &AppHandle) {
    post(InputMsg::Attach(app.clone()));
    crate::gestures::start_if_wanted(app);
}

/// A handle on the input thread.
#[derive(Debug)]
pub struct Input {
    tx: Sender<InputMsg>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Input {
    pub fn start(commander: Arc<Mutex<Option<LinkCommander>>>, sensitivity: u8, tau: f64) -> Self {
        let (tx, rx) = channel::<InputMsg>();
        match BUS.get() {
            Some(bus) => {
                if let Ok(mut sender) = bus.lock() {
                    *sender = tx.clone();
                }
            }
            None => {
                let _ = BUS.set(Mutex::new(tx.clone()));
            }
        }
        let thread = std::thread::Builder::new()
            .name("pm-input".to_string())
            .spawn(move || run(&rx, &commander, sensitivity, tau))
            .ok();
        Self {
            tx,
            thread: Mutex::new(thread),
        }
    }

    pub fn drive(&self, x: f64, y: f64, source: DriveSource) {
        let _ = self.tx.send(InputMsg::Drive { x, y, source });
    }

    pub fn release(&self, source: Option<DriveSource>) {
        let _ = self.tx.send(InputMsg::Release(source));
    }

    pub fn rest(&self, why: &'static str) {
        let _ = self.tx.send(InputMsg::Rest(why));
    }

    pub fn later(&self, delay: f64, commands: Vec<Command>) {
        let _ = self.tx.send(InputMsg::Later { delay, commands });
    }

    pub fn stop(&self) {
        crate::gestures::stop();
        let _ = self.tx.send(InputMsg::Stop);
        if let Some(thread) = self.thread.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = thread.join();
        }
    }
}

/// The body's model id from the camera service, for zoom stops and tap focus.
fn connected_model(app: &AppHandle) -> Option<i32> {
    let camera = app.try_state::<crate::camera::CameraService>()?;
    let identity = camera.state().identity?;
    match identity.model {
        "osmo-pocket-3" => Some(0x20),
        "osmo-pocket-4" => Some(0x21),
        "osmo-pocket-4-pro" => Some(0x22),
        "osmo-nano" => Some(0x19),
        _ => None,
    }
}

/// Emits a value when it differs from the last one sent, at most every `interval`.
struct Changed {
    last: Option<serde_json::Value>,
    at: f64,
    interval: f64,
}

impl Changed {
    fn new(interval: f64) -> Self {
        Self {
            last: None,
            at: f64::NEG_INFINITY,
            interval,
        }
    }

    fn offer(&mut self, value: serde_json::Value, now: f64) -> Option<serde_json::Value> {
        if now - self.at < self.interval || self.last.as_ref() == Some(&value) {
            return None;
        }
        self.at = now;
        self.last = Some(value.clone());
        Some(value)
    }

    fn forget(&mut self) {
        self.last = None;
        self.at = f64::NEG_INFINITY;
    }

    /// Whether an offer now could go out: build the value only then.
    fn due(&self, now: f64) -> bool {
        now - self.at >= self.interval
    }
}

fn reply(
    sender: &Sender<Result<Pose, String>>,
    result: Result<pm_controller::moves::Waypoint, &str>,
) {
    let _ = sender.send(result.map(Pose::from).map_err(str::to_string));
}

#[allow(clippy::too_many_lines)]
fn run(
    rx: &Receiver<InputMsg>,
    commander: &Mutex<Option<LinkCommander>>,
    sensitivity: u8,
    tau: f64,
) {
    let started = Instant::now();
    let now = || started.elapsed().as_secs_f64();
    let prefs_path = prefs::path();
    let prefs = prefs::load(&prefs_path)
        .map(|saved| saved.prefs)
        .unwrap_or_default();
    let mut live = LiveInput::new(&prefs).with_presets_at(presets::path_beside(&prefs_path));
    live.set_feel(sensitivity, tau);
    live.set_gesture_map(pm_controller::appsettings::load().gesture_map);
    let mut gestures = Gestures::new(pm_controller::appsettings::load());
    let mut ramp = prefs.ramp;
    let mut sensitivity = sensitivity;
    let mut app: Option<AppHandle> = None;
    let mut pad = crate::gamepad::Pad::new();
    let mut later: Vec<(f64, Vec<Command>)> = Vec::new();
    let mut summary = (now(), 0u32);
    let mut tracking_view = Changed::new(VIEW_INTERVAL);
    let mut input_view = Changed::new(VIEW_INTERVAL);
    let mut pad_view = Changed::new(PAD_INTERVAL);
    let mut hands_view = Changed::new(VIEW_INTERVAL);
    let mut next_tick = 0.0;

    let send = |commands: Vec<Command>| {
        if commands.is_empty() {
            return;
        }
        if let Ok(slot) = commander.lock() {
            if let Some(commander) = slot.as_ref() {
                for command in commands {
                    commander.send(command);
                }
            }
        }
    };

    loop {
        let wait = (next_tick - now()).clamp(0.0, INPUT_TICK_SECONDS);
        let first = match rx.recv_timeout(Duration::from_secs_f64(wait)) {
            Ok(message) => Some(message),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let messages: Vec<InputMsg> = first.into_iter().chain(rx.try_iter()).collect();
        let mut out: Vec<Command> = Vec::new();
        for message in messages {
            let at = now();
            match message {
                InputMsg::Stop => {
                    send(live.rest(at));
                    return;
                }
                InputMsg::Drive { x, y, source } => out.extend(live.drive(x, y, source, at)),
                InputMsg::Release(source) => out.extend(live.release(source, at)),
                InputMsg::Rest(why) => {
                    if !live.is_resting() {
                        log_line("input", format_args!("rest: {why}"));
                    }
                    out.extend(live.rest(at));
                }
                InputMsg::Later { delay, commands } => later.push((at + delay, commands)),
                InputMsg::Attach(handle) => {
                    live.set_model(connected_model(&handle));
                    app = Some(handle);
                }
                InputMsg::Status(status) => out.extend(live.set_status(*status, at)),
                InputMsg::Frame(frame) => {
                    live.frame(frame.cmd_set, frame.cmd_id, &frame.payload, at);
                }
                InputMsg::Set(outcome) => out.extend(live.note_set(&outcome)),
                InputMsg::Opened => {
                    live.link_lost();
                    if let Some(app) = app.as_ref() {
                        live.set_model(connected_model(app));
                    }
                }
                InputMsg::Lost => live.link_lost(),
                InputMsg::Key { key, down, repeat } => {
                    out.extend(if down {
                        live.key_down(key, repeat, at)
                    } else {
                        live.key_up(key, at)
                    });
                }
                InputMsg::Pointer { phase, id, u, v } => {
                    out.extend(live.pointer(phase, id, u, v, at));
                }
                InputMsg::FocusAt(u, v) => out.extend(live.focus_at(u, v, at)),
                InputMsg::TrackClear => out.extend(live.tracker.clear(at)),
                InputMsg::Zoom(write) => out.extend(live.zoom_write(write, at)),
                InputMsg::ZoomRate(rate) => live.zoom_rate(rate),
                InputMsg::ZoomStep(direction) => out.extend(live.zoom_step(direction, at)),
                InputMsg::Countdown => live.countdown_toggle(at),
                InputMsg::LockAll(on) => out.extend(live.lock_all_axes(on, at)),
                InputMsg::Configure(config) => {
                    if let Some(value) = config.stick_sensitivity {
                        sensitivity = value.clamp(1, 5);
                    }
                    if let Some(value) = config.ramp {
                        ramp = value.min(2);
                    }
                    if config.stick_sensitivity.is_some() || config.ramp.is_some() {
                        let feel = prefs::Prefs {
                            ramp,
                            ..prefs::Prefs::default()
                        };
                        live.set_feel(sensitivity, feel.ramp_tau());
                    }
                    if let Some(seconds) = config.countdown_seconds {
                        live.set_countdown_seconds(seconds);
                    }
                    if let Some(on) = config.gamepad {
                        out.extend(live.set_gamepad(on, at));
                    }
                    if let Some(on) = config.direction_lock {
                        live.set_direction_lock(on);
                    }
                    if let Some(on) = config.mirror {
                        live.tracker.set_mirror(on);
                    }
                }
                InputMsg::Move(op) => match op {
                    MoveOp::SetPoint(slot, answer) => reply(&answer, live.move_set_point(slot)),
                    MoveOp::ClearPoint(slot) => live.move_clear_point(slot),
                    MoveOp::Configure(legs, smoothness) => live.move_configure(legs, smoothness),
                    MoveOp::Start => out.extend(live.move_start(at)),
                    MoveOp::Stop => out.extend(live.move_stop()),
                    MoveOp::Pause => out.extend(live.move_pause()),
                    MoveOp::Resume => out.extend(live.move_resume(at)),
                    MoveOp::PresetSave(slot, answer) => reply(&answer, live.preset_save(slot)),
                    MoveOp::PresetGo(slot) => out.extend(live.preset_go(slot, at)),
                    MoveOp::PresetClear(slot) => live.preset_clear(slot),
                    MoveOp::PresetSeconds(seconds) => live.preset_seconds(seconds),
                },
                InputMsg::Gesture(gesture) => {
                    // Webcam gestures act on the live picture only, as on the viewfinder.
                    if gestures.settings.gestures && crate::vision::service().on_screen() {
                        out.extend(live.gesture(gesture, at));
                    }
                }
                InputMsg::AppSettings(settings) => {
                    live.set_gesture_map(settings.gesture_map);
                    out.extend(gestures.configure(*settings, &mut live, at));
                }
                InputMsg::HandView(on) => {
                    gestures.hand_view = on;
                    hands_view.forget();
                }
                InputMsg::Resend => {
                    tracking_view.forget();
                    input_view.forget();
                    pad_view.forget();
                    hands_view.forget();
                }
            }
        }

        let at = now();
        if at >= next_tick {
            next_tick = at + INPUT_TICK_SECONDS;
            let (commands, state) = pad.poll(&mut live, at);
            out.extend(commands);
            if let (Some(state), Some(app)) = (state, app.as_ref()) {
                if let Some(value) = pad_view.offer(state, at) {
                    let _ = app.emit("gamepad://state", value);
                }
            }
        }
        out.extend(gestures.look(&mut live, at));
        out.extend(live.tick(at));
        let mut index = 0;
        while index < later.len() {
            if later[index].0 <= at {
                out.extend(later.swap_remove(index).1);
            } else {
                index += 1;
            }
        }
        send(out);

        for sent in live.take_stick_log() {
            summary.1 += 1;
            log_rest(sent, at);
        }
        if at - summary.0 >= 1.0 {
            if summary.1 > 0 {
                let (x, y) = live.stick_sent();
                log_line(
                    "link",
                    format_args!(
                        "stick tx t={:.0} sends={} axes={x:.2},{y:.2} rest={}",
                        at * 1e6,
                        summary.1,
                        live.is_resting()
                    ),
                );
            }
            summary = (at, 0);
        }

        let notices = live.take_notices();
        let Some(app) = app.as_ref() else {
            continue;
        };
        for notice in notices {
            let _ = app.emit(
                "camera://event",
                serde_json::json!({ "type": "notice", "message": notice.text, "tone": notice.tone }),
            );
        }
        // The pad's Menu and the "Add marker" gesture: the web puts the marker on its take.
        for source in live.take_marker_requests() {
            let _ = app.emit("input://marker", serde_json::json!({ "source": source }));
        }
        if let Ok(value) = serde_json::to_value(live.tracker.view()) {
            if let Some(value) = tracking_view.offer(value, at) {
                let _ = app.emit("tracking://box", value);
            }
        }
        if let Ok(value) = serde_json::to_value(live.view(at)) {
            if let Some(value) = input_view.offer(value, at) {
                let _ = app.emit("input://state", value);
            }
        }
        if gestures.hand_view && hands_view.due(at) {
            if let Ok(value) = serde_json::to_value(gestures.overlay(at)) {
                if let Some(value) = hands_view.offer(value, at) {
                    let _ = app.emit("vision://hands", value);
                }
            }
        }
    }
}

/// Gestures on the input thread: the camera's picture read for hands and faces, and the
/// double clap. The webcam reader runs on its own thread (`gestures.rs`) and posts
/// [`InputMsg::Gesture`].
struct Gestures {
    settings: AppSettings,
    /// While the camera's picture is the source and gestures are on.
    reader: Option<FeedReader>,
    /// While gestures are on, whichever source.
    mic: Option<crate::mic::ClapMic>,
    hand_view: bool,
}

impl Gestures {
    fn new(settings: AppSettings) -> Self {
        // Nothing runs until `gestures::apply` says so (at launch, from the setting).
        Self {
            settings: AppSettings {
                gestures: false,
                ..settings
            },
            reader: None,
            mic: None,
            hand_view: false,
        }
    }

    /// The setting changed: start or stop what it asks for, live.
    fn configure(&mut self, settings: AppSettings, live: &mut LiveInput, at: f64) -> Vec<Command> {
        let mut out = Vec::new();
        let feed = settings.gestures && settings.gesture_source == GestureSource::CameraFeed;
        if feed && self.reader.is_none() {
            self.reader = Some(FeedReader::new());
        } else if !feed && self.reader.take().is_some() {
            // Whatever the hands held, they let go of.
            out.extend(live.hand_release(at));
            live.gesture_progress(None);
        }
        if !settings.hand_control && live.hand_driving() {
            out.extend(live.hand_release(at));
        }
        crate::vision::service().set_reading(feed);
        live.set_face_finder(feed);
        if settings.gestures {
            self.mic.get_or_insert_with(crate::mic::ClapMic::start);
        } else {
            // Dropping it releases the microphone.
            self.mic = None;
        }
        self.settings = settings;
        out
    }

    /// Every pass of the input loop: the hand models' results since the last pass, and
    /// the clap, carried out on the live controls.
    fn look(&mut self, live: &mut LiveInput, at: f64) -> Vec<Command> {
        let mut out = Vec::new();
        let on_screen = crate::vision::service().on_screen();
        if self.mic.as_ref().is_some_and(crate::mic::ClapMic::take) && on_screen {
            out.extend(live.clap(at));
        }
        let Some(reader) = self.reader.as_mut() else {
            return out;
        };
        let updates = crate::vision::service().updates();
        let fresh = updates
            .iter()
            .any(|update| matches!(update, Update::Seen { .. }));
        let tuning = Tuning {
            map: live.gesture_map(),
            stick_is_right: self.settings.stick_is_right,
            hand_control: self.settings.hand_control && on_screen,
            face_requested: live.take_face_request(),
            auto_face: self.settings.auto_face_track && on_screen,
            tracking: live.tracker.is_tracking(),
        };
        let looked = reader.read(updates, live.live_pose(), at, &tuning);
        crate::vision::service().set_want_faces(reader.wants_faces());
        for control in looked.controls {
            out.extend(live.hand_control(control, looked.dt, at));
        }
        if !on_screen {
            live.gesture_progress(None);
            return out;
        }
        for gesture in looked.gestures {
            out.extend(live.gesture(gesture, at));
        }
        if fresh {
            live.gesture_progress(looked.progress);
        }
        if let Some(rect) = looked.face {
            out.extend(live.track_face(rect, at));
        }
        if looked.no_face {
            live.no_face();
        }
        out
    }

    /// What the hand view draws now.
    fn overlay(&self, at: f64) -> HandOverlay {
        let stick = self.settings.stick_is_right;
        if !self.settings.gestures {
            return HandOverlay::new("off", "", None, &[], stick);
        }
        match (&self.reader, self.settings.gesture_source) {
            (Some(reader), _) => HandOverlay::new(
                "cameraFeed",
                reader.status(),
                reader.scene(),
                reader.faces(at),
                stick,
            ),
            (None, GestureSource::Webcam) => {
                let state = crate::gestures::state();
                let status = state
                    .problem
                    .or(state.device)
                    .unwrap_or_else(|| "starting the webcam".to_string());
                HandOverlay::new("webcam", &status, None, &[], stick)
            }
            (None, GestureSource::CameraFeed) => {
                HandOverlay::new("cameraFeed", "", None, &[], stick)
            }
        }
    }
}

/// §4.1: every rest goes into the log at once; the rest as the 1 Hz summary.
fn log_rest(sent: StickSend, at: f64) {
    if sent.rest {
        log_line(
            "link",
            format_args!("stick tx t={:.0} axes=0,0 rest=true", at * 1e6),
        );
    }
}

/// For the controller map: a gilrs button to the phones' map.
pub(crate) fn pad_button(button: gilrs::Button) -> Option<PadButton> {
    use gilrs::Button;
    Some(match button {
        Button::South => PadButton::A,
        Button::East => PadButton::B,
        Button::West => PadButton::X,
        Button::North => PadButton::Y,
        Button::LeftTrigger => PadButton::LeftShoulder,
        Button::RightTrigger => PadButton::RightShoulder,
        Button::DPadUp => PadButton::DpadUp,
        Button::DPadDown => PadButton::DpadDown,
        Button::DPadLeft => PadButton::DpadLeft,
        Button::DPadRight => PadButton::DpadRight,
        Button::Start => PadButton::Menu,
        _ => return None,
    })
}
