//! The camera service: the link, the decode thread, and `camera://state`.
//!
//! `Link` (pm-controller, the old viewfinder's camera thread) keeps the UDP socket, the
//! 40 Hz ACK pump, the SET mailbox and the watchdog on its own OS thread. The session
//! thread here owns the `Link`'s event side: it decodes access units as they arrive
//! (moved off the window loop, P11) and hands pictures to the render thread, folds status
//! into the mobile `CameraState`, and emits it at ≤ 5 Hz with immediate fields at once.
//!
//! Commands never touch the socket from a Tauri handler: `camera_command` resolves the
//! call against the body's lists and queues the result on the link's channel, exactly as
//! the old window did (P4).

use std::net::SocketAddr;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opc_camera::{Recovery, SetOutcome, Status};
use pm_controller::command::{self, CameraCommand, Plan, Refused};
use pm_controller::decode::{fresh_session, Decoded, LiveDecoder};
use pm_controller::effects::ColorAxis;
use pm_controller::gimbal::GimbalMode;
use pm_controller::link::{diagnostic, FromCamera, Link, LinkCommander};
use pm_controller::prefs::{self, Prefs};
use pm_controller::state::{
    self, camera_state, CameraState, Commanded, ConnectionState, StateThrottle,
};
use pm_controller::zoom;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::input::Input;
use crate::picture::PictureHub;

/// The camera's own address on its SoftAP.
pub const SOFTAP_CAMERA: &str = "192.168.2.1:9004";

/// Where to connect: an address and a model, from the web or the command line.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// `host` or `host:port`; the SoftAP address when absent.
    #[serde(default)]
    pub host: Option<String>,
    /// The body's model id (`0x20` Pocket 3, `0x21`/`0x22` Pocket 4, `0x19` Nano).
    #[serde(default)]
    pub model: Option<i32>,
}

impl Target {
    fn address(&self) -> Result<Option<SocketAddr>, String> {
        let Some(host) = self.host.as_deref().filter(|host| !host.is_empty()) else {
            return Ok(None);
        };
        let text = if host.contains(':') {
            host.to_string()
        } else {
            format!("{host}:9004")
        };
        text.parse()
            .map(Some)
            .map_err(|_| format!("That isn't an address: {host}"))
    }
}

/// `camera://event`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SessionEvent {
    Notice { message: String, tone: &'static str },
    RecordingStarted,
    RecordingStopped,
}

enum Control {
    Stop,
}

struct Session {
    control: Sender<Control>,
    thread: Option<JoinHandle<()>>,
}

/// What the IPC handlers read without asking the session thread.
#[derive(Debug, Clone, Default)]
struct Snapshot {
    status: Status,
    model_id: Option<i32>,
    connection: ConnectionState,
    commanded: Commanded,
}

/// The service in Tauri state.
pub struct CameraService {
    app: AppHandle,
    commander: Arc<Mutex<Option<LinkCommander>>>,
    snapshot: Arc<Mutex<Snapshot>>,
    session: Mutex<Option<Session>>,
    last_target: Mutex<Target>,
    picture: Arc<PictureHub>,
    pub input: Input,
}

impl std::fmt::Debug for CameraService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CameraService").finish_non_exhaustive()
    }
}

fn notice(app: &AppHandle, message: impl Into<String>, tone: &'static str) {
    let _ = app.emit(
        "camera://event",
        SessionEvent::Notice {
            message: message.into(),
            tone,
        },
    );
}

impl CameraService {
    pub fn new(
        app: AppHandle,
        commander: Arc<Mutex<Option<LinkCommander>>>,
        picture: Arc<PictureHub>,
    ) -> Self {
        let prefs = prefs::load(&prefs::path())
            .map(|saved| saved.prefs)
            .unwrap_or_default();
        Self {
            input: Input::start(commander.clone(), prefs.stick_sensitivity, prefs.ramp_tau()),
            app,
            commander,
            snapshot: Arc::new(Mutex::new(Snapshot::default())),
            session: Mutex::new(None),
            last_target: Mutex::new(Target::default()),
            picture,
        }
    }

    /// The state as it stands, for a web view that (re)attaches: a reload never
    /// reconnects (R11).
    pub fn state(&self) -> CameraState {
        let snapshot = self.snapshot.lock().map(|s| s.clone()).unwrap_or_default();
        build(&snapshot, &self.picture)
    }

    /// Opens a fresh link. One link at a time: an open one is closed first.
    pub fn connect(&self, target: Target) -> Result<(), String> {
        let remote = target.address()?;
        self.disconnect();
        if let Ok(mut last) = self.last_target.lock() {
            *last = target.clone();
        }
        let (session_id, base_seq) = fresh_session();
        let link = Link::open(remote, session_id, base_seq, target.model);
        if let Ok(mut slot) = self.commander.lock() {
            *slot = Some(link.commander());
        }
        if let Ok(mut snapshot) = self.snapshot.lock() {
            *snapshot = Snapshot {
                model_id: target.model,
                connection: ConnectionState {
                    phase: "datalink",
                    detail: Some(format!(
                        "Wi-Fi datalink · {}",
                        remote.map_or_else(|| "camera default".to_string(), |a| a.to_string())
                    )),
                    transport: if remote.is_some_and(|a| a.to_string() != SOFTAP_CAMERA) {
                        "station"
                    } else {
                        "softap"
                    },
                    ..ConnectionState::default()
                },
                ..Snapshot::default()
            };
        }
        self.picture.clear();
        let (control, control_rx) = channel();
        let app = self.app.clone();
        let snapshot = self.snapshot.clone();
        let picture = self.picture.clone();
        let commander = link.commander();
        let thread = std::thread::Builder::new()
            .name("pm-session".to_string())
            .spawn(move || run(link, commander, &control_rx, &app, &snapshot, &picture))
            .map_err(|error| error.to_string())?;
        if let Ok(mut slot) = self.session.lock() {
            *slot = Some(Session {
                control,
                thread: Some(thread),
            });
        }
        let _ = self.app.emit("camera://state", self.state());
        Ok(())
    }

    /// Closes the link: the gimbal rests first, while the channel is still open.
    pub fn disconnect(&self) {
        self.input.rest("disconnect");
        let session = self.session.lock().ok().and_then(|mut slot| slot.take());
        if let Some(mut session) = session {
            // Let the rest reach the camera thread before the link goes.
            std::thread::sleep(Duration::from_millis(20));
            let _ = session.control.send(Control::Stop);
            if let Some(thread) = session.thread.take() {
                let _ = thread.join();
            }
        }
        if let Ok(mut slot) = self.commander.lock() {
            *slot = None;
        }
        if let Ok(mut snapshot) = self.snapshot.lock() {
            snapshot.connection = ConnectionState {
                phase: "disconnected",
                ..ConnectionState::default()
            };
        }
        self.picture.clear();
        let _ = self.app.emit("camera://state", self.state());
    }

    /// Tears the datalink down and opens a fresh one, as the Link tab's Reconnect does.
    pub fn reconnect(&self) -> Result<(), String> {
        let target = self
            .last_target
            .lock()
            .map(|t| t.clone())
            .unwrap_or_default();
        self.connect(target)?;
        notice(&self.app, "RECONNECTING", "info");
        Ok(())
    }

    /// Resolves a controller call and queues it on the camera thread.
    pub fn command(&self, call: &CameraCommand) -> Result<(), Refused> {
        let snapshot = self
            .snapshot
            .lock()
            .map(|s| s.clone())
            .map_err(|_| Refused("NO CAMERA".to_string()))?;
        if self.commander.lock().map_or(true, |slot| slot.is_none()) {
            return Err(Refused("NO CAMERA CONNECTED".to_string()));
        }
        let policy = zoom::policy();
        let plan = command::plan(
            call,
            command::Context {
                status: &snapshot.status,
                model_id: snapshot.model_id,
                tracking: false,
                zoom: policy.as_ref(),
            },
        )?;
        self.carry_out(plan);
        Ok(())
    }

    fn carry_out(&self, plan: Plan) {
        if let Ok(slot) = self.commander.lock() {
            if let Some(commander) = slot.as_ref() {
                for command in plan.now {
                    commander.send(command);
                }
            }
        }
        if let Some((delay, commands)) = plan.later {
            self.input.later(delay, commands);
        }
        if plan.gimbal_mode.is_some() || plan.gimbal_speed.is_some() {
            if let Ok(mut snapshot) = self.snapshot.lock() {
                if let Some(mode) = plan.gimbal_mode {
                    snapshot.commanded.tilt_locked = mode == GimbalMode::TiltLocked;
                }
                if let Some(speed) = plan.gimbal_speed {
                    snapshot.commanded.gimbal_speed = Some(speed);
                }
            }
        }
    }

    pub fn shutdown(&self) {
        self.disconnect();
        self.input.stop();
    }
}

fn build(snapshot: &Snapshot, picture: &PictureHub) -> CameraState {
    let mut connection = snapshot.connection.clone();
    if let Ok(stats) = picture.stats.lock() {
        connection.video_fps = stats.presented_fps;
        connection.last_frame_age_ms = stats.last_frame_age_ms;
        if stats.width > 0 {
            connection.stream_width = Some(stats.width);
            connection.stream_height = Some(stats.height);
        }
    }
    let policy = zoom::policy();
    camera_state(
        &snapshot.status,
        snapshot.model_id,
        connection,
        snapshot.commanded,
        policy.as_ref(),
    )
}

/// The session thread: camera events in, pictures and state out.
fn run(
    link: Link,
    commander: LinkCommander,
    control: &Receiver<Control>,
    app: &AppHandle,
    snapshot: &Mutex<Snapshot>,
    picture: &PictureHub,
) {
    let started = Instant::now();
    let now = || started.elapsed().as_secs_f64();
    let mut live = LiveDecoder::new();
    let mut throttle = StateThrottle::default();
    let mut has_picture = false;
    let mut prefs_sent = false;
    let mut axis = ColorAxis::default();
    let mut bytes_this_second = 0usize;
    let mut second = Instant::now();
    let prefs: Prefs = prefs::load(&prefs::path())
        .map(|saved| saved.prefs)
        .unwrap_or_default();

    loop {
        match control.try_recv() {
            Ok(Control::Stop) | Err(TryRecvError::Disconnected) => return,
            Err(TryRecvError::Empty) => {}
        }
        let wait = throttle
            .wait(now())
            .map_or(Duration::from_millis(20), |seconds| {
                Duration::from_secs_f64(seconds.min(0.02))
            });
        let first = match link.recv_timeout(wait) {
            Ok(event) => Some(event),
            Err(true) => {
                set_phase(
                    snapshot,
                    "failed",
                    Some("the camera thread stopped".to_string()),
                );
                emit_state(app, snapshot, picture);
                return;
            }
            Err(false) => None,
        };
        let events: Vec<FromCamera> = first.into_iter().chain(link.drain()).collect();
        let mut changed = false;
        for event in events {
            changed = true;
            match event {
                FromCamera::Opened => {
                    set_phase(snapshot, "live-start", Some("Waiting for live view".into()))
                }
                FromCamera::Picture(bytes) => {
                    bytes_this_second += bytes.len();
                    live.push(bytes);
                    changed = false;
                }
                FromCamera::Status(status) => {
                    let next_axis = ColorAxis::from_status(&status);
                    if next_axis != axis {
                        axis = next_axis;
                        picture.axis(axis);
                    }
                    if let Ok(mut s) = snapshot.lock() {
                        let was = s.status.is_recording;
                        if was != status.is_recording {
                            let _ = app.emit(
                                "camera://event",
                                if status.is_recording {
                                    SessionEvent::RecordingStarted
                                } else {
                                    SessionEvent::RecordingStopped
                                },
                            );
                        }
                        s.status = *status;
                    }
                }
                FromCamera::Recovering(recovery) => {
                    set_phase(snapshot, "recovering", Some(format!("{recovery:?}")));
                    if matches!(recovery, Recovery::RebuildDecoder) {
                        match live.rebuild() {
                            Ok(()) => {
                                commander.note_decoder_failed(false);
                                has_picture = false;
                                picture.clear();
                            }
                            Err(error) => {
                                commander.note_decoder_failed(true);
                                set_failed(snapshot, format!("decoder unavailable: {error}"));
                            }
                        }
                    }
                }
                FromCamera::Lost(reason) => {
                    // The link thread keeps reopening by itself; "… — reconnecting" is
                    // recovery, anything else a failure.
                    if reason.ends_with("reconnecting") {
                        set_phase(snapshot, "recovering", Some(reason));
                    } else {
                        set_failed(snapshot, reason);
                    }
                    has_picture = false;
                    prefs_sent = false;
                }
                // Tracking replies and media frames: not wired in phase 1.
                FromCamera::Frame(_) => changed = false,
                FromCamera::Set(SetOutcome::Unanswered { .. }) => {
                    notice(app, "NO ANSWER FROM THE CAMERA", "warning");
                    changed = false;
                }
                FromCamera::Set(_) => changed = false,
            }
        }

        if live.pending() > 0 {
            let mut produced = 0u32;
            let outcome = live.decode(has_picture, |decoded| {
                produced += 1;
                picture.push(decoded);
            });
            if produced > 0 {
                has_picture = true;
            }
            match outcome {
                Decoded::Waiting => {}
                Decoded::CreateFailed(error) | Decoded::Ran(Some(error)) => {
                    eprintln!("decoder failed: {error}");
                    diagnostic(format_args!("decoder failed: {error}"));
                    commander.note_decoder_failed(true);
                    set_failed(snapshot, format!("decoder failed: {error}"));
                    changed = true;
                }
                Decoded::Ran(None) => {}
            }
        }
        if has_picture {
            let phase = snapshot
                .lock()
                .map(|s| s.connection.phase)
                .unwrap_or("idle");
            if matches!(phase, "live-start" | "recovering" | "datalink") {
                set_phase(snapshot, "live", None);
                changed = true;
                if !prefs_sent {
                    // The body does not report its field of view or gimbal speed, so the
                    // operator's picks go out once per link (I6).
                    prefs_sent = true;
                    commander.send(opc_camera::Command::SetFov(prefs.fov));
                    commander.send(opc_camera::Command::GimbalSpeed(prefs.gimbal_speed));
                }
            }
        }

        if second.elapsed() >= Duration::from_secs(1) {
            if let Ok(mut s) = snapshot.lock() {
                s.connection.video_kbps =
                    (bytes_this_second as f64 * 8.0 / 1000.0 / second.elapsed().as_secs_f64())
                        as f32;
                s.connection.stream_codec = live.codec().map(|codec| match codec {
                    opc_decode::Codec::H264 => "avc",
                    opc_decode::Codec::Hevc => "hevc",
                });
            }
            bytes_this_second = 0;
            second = Instant::now();
            changed = true;
        }

        let at = now();
        let emit = if changed {
            let immediate = snapshot
                .lock()
                .map(|s| state::Immediate::of(&s.status, &s.connection));
            match immediate {
                Ok(immediate) => throttle.offer(immediate, at),
                Err(_) => false,
            }
        } else {
            throttle.due(at)
        };
        if emit {
            emit_state(app, snapshot, picture);
        }
    }
}

fn set_phase(snapshot: &Mutex<Snapshot>, phase: &'static str, detail: Option<String>) {
    if let Ok(mut s) = snapshot.lock() {
        s.connection.phase = phase;
        s.connection.detail = detail;
        if phase != "failed" {
            s.connection.error = None;
        }
    }
}

fn set_failed(snapshot: &Mutex<Snapshot>, error: String) {
    if let Ok(mut s) = snapshot.lock() {
        s.connection.phase = "failed";
        s.connection.error = Some(error);
    }
}

fn emit_state(app: &AppHandle, snapshot: &Mutex<Snapshot>, picture: &PictureHub) {
    let Ok(s) = snapshot.lock().map(|s| s.clone()) else {
        return;
    };
    let _ = app.emit("camera://state", build(&s, picture));
}
