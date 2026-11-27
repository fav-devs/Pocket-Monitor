//! Watching a phone's shared feed (§1.E): find the phones sharing on this Wi-Fi, join
//! one, and run the whole viewfinder on its picture.
//!
//! `opc-relay` keeps the mDNS browser (`_opc-mon._tcp`), the transport and the join
//! state machine (the core's retry ladder, deadlines and delivery-delay guard, E4);
//! `pm_controller::phone` keeps the join thread and the command proxy moved from
//! `opc-monitor`. Here:
//!
//! - `relay_browse {on}` runs a `pm-relay-browse` thread that polls every 500 ms and
//!   emits `relay://hosts` when the list changes (E1).
//! - `relay_join` closes any camera link, opens the phone link, and a `pm-relay` thread
//!   decodes its HEVC through the same `LiveDecoder` into the same picture hub, so LUTs,
//!   assists, scopes and the virtual camera work as on a direct link (E2). The phone's
//!   state message is folded into the mobile `CameraState` and emitted as
//!   `camera://state` with `transport: "watcher"`, so the live screen reads it as is;
//!   `relay://info` carries the phone's own readouts and the control lease.
//! - `relay_command` takes the live screen's `CameraCommand`s on a phone feed: resolved
//!   as for the camera, then mapped onto the relay wire. Only record, tap-focus, ISO,
//!   shutter, WB, colour and zoom go; the first one asks for the lease; the rest is
//!   refused with the operator copy (E3).

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opc_camera::Status;
use opc_relay::discovery::{Browser, DiscoveredHost};
use opc_relay::ProtocolInfo;
use pm_controller::command::{self, CameraCommand};
use pm_controller::decode::{Decoded, LiveDecoder};
use pm_controller::effects::ColorAxis;
use pm_controller::link::log_line;
use pm_controller::phone::{
    self, FromPhone, PhoneControl, PhoneInfo, PhoneLink, PhoneTarget, Proxy,
};
use pm_controller::state::{self, camera_state, Commanded, ConnectionState, StateThrottle};
use pm_controller::zoom;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::camera::{CameraService, SessionEvent};
use crate::picture::PictureHub;

/// No port: the phone is found by name on this Wi-Fi, which gives its port.
const DEFAULT_PORT: u16 = 0;

/// One sharing phone, for `relay://hosts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPayload {
    pub name: String,
    pub camera: String,
    pub addresses: Vec<String>,
    pub port: u16,
}

impl From<&DiscoveredHost> for HostPayload {
    fn from(host: &DiscoveredHost) -> Self {
        Self {
            name: host.name.clone(),
            camera: host.camera.clone(),
            addresses: host.addresses.iter().map(IpAddr::to_string).collect(),
            port: host.port,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostsPayload {
    pub hosts: Vec<HostPayload>,
    pub browsing: bool,
    pub error: Option<String>,
}

/// `relay://info`: the phone and the lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    /// `idle`, `connecting`, `live`, `reconnecting`, `failed`.
    pub phase: String,
    pub detail: String,
    pub host: String,
    pub camera: String,
    pub format: String,
    pub color: String,
    pub live_fps: String,
    /// `not-offered`, `available`, `requested`, `held`, `held-by`.
    pub control: String,
    /// Who holds it when someone else does.
    pub holder: String,
    /// "Held by this viewfinder", the old Link tab's line.
    pub control_label: String,
    pub recording: bool,
}

fn control_name(control: &PhoneControl) -> (&'static str, String) {
    match control {
        PhoneControl::NotOffered => ("not-offered", String::new()),
        PhoneControl::Available => ("available", String::new()),
        PhoneControl::Requested => ("requested", String::new()),
        PhoneControl::Held => ("held", String::new()),
        PhoneControl::HeldBy(name) => ("held-by", name.clone()),
    }
}

fn apply_info(target: &mut RelayInfo, info: &PhoneInfo) {
    target.host = info.host.clone();
    target.camera = info.camera.clone();
    target.format = info.format.clone();
    target.color = info.color.clone();
    target.live_fps = info.live_fps.clone();
    let (control, holder) = control_name(&info.control);
    target.control = control.to_string();
    target.holder = holder;
    target.control_label = info.control.label();
}

struct Browse {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

enum ToSession {
    Command(opc_relay::Command),
    Control(bool),
    Stop,
}

struct Session {
    tx: std::sync::mpsc::Sender<ToSession>,
    thread: Option<JoinHandle<()>>,
}

/// What the IPC handlers read without asking the session thread.
#[derive(Debug, Clone, Default)]
struct Snapshot {
    status: Status,
    control: PhoneControl,
}

/// The service in Tauri state.
pub struct RelayService {
    app: AppHandle,
    browse: Mutex<Option<Browse>>,
    hosts: Arc<Mutex<HostsPayload>>,
    session: Mutex<Option<Session>>,
    info: Arc<Mutex<RelayInfo>>,
    snapshot: Arc<Mutex<Snapshot>>,
}

impl std::fmt::Debug for RelayService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayService").finish_non_exhaustive()
    }
}

fn notice(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit(
        "camera://event",
        SessionEvent::Notice {
            message: message.into(),
            tone: "info",
        },
    );
}

impl RelayService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            browse: Mutex::new(None),
            hosts: Arc::new(Mutex::new(HostsPayload::default())),
            session: Mutex::new(None),
            info: Arc::new(Mutex::new(RelayInfo {
                phase: "idle".to_string(),
                ..RelayInfo::default()
            })),
            snapshot: Arc::new(Mutex::new(Snapshot::default())),
        }
    }

    pub fn hosts(&self) -> HostsPayload {
        self.hosts.lock().map(|h| h.clone()).unwrap_or_default()
    }

    pub fn info(&self) -> RelayInfo {
        self.info.lock().map(|i| i.clone()).unwrap_or_default()
    }

    /// Starts or stops looking for sharing phones.
    pub fn browse(&self, on: bool) {
        let Ok(mut slot) = self.browse.lock() else {
            return;
        };
        if !on {
            if let Some(mut browse) = slot.take() {
                browse.stop.store(true, Ordering::Relaxed);
                if let Some(thread) = browse.thread.take() {
                    let _ = thread.join();
                }
            }
            if let Ok(mut hosts) = self.hosts.lock() {
                hosts.browsing = false;
            }
            return;
        }
        if slot.is_some() {
            let _ = self.app.emit("relay://hosts", self.hosts());
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let (app, hosts, flag) = (self.app.clone(), self.hosts.clone(), stop.clone());
        let thread = std::thread::Builder::new()
            .name("pm-relay-browse".to_string())
            .spawn(move || browse_loop(&app, &hosts, &flag))
            .ok();
        *slot = Some(Browse { stop, thread });
    }

    /// Joins a phone. Any camera link is closed first: one feed at a time.
    pub fn join(&self, target: PhoneTarget) {
        self.leave();
        self.browse(false);
        if let Some(camera) = self.app.try_state::<CameraService>() {
            camera.disconnect();
        }
        if let Some(hub) = self.app.try_state::<Arc<PictureHub>>() {
            hub.clear();
        }
        if let Ok(mut info) = self.info.lock() {
            *info = RelayInfo {
                phase: "connecting".to_string(),
                detail: format!("Looking for {}…", target.name),
                host: target.name.clone(),
                control: "not-offered".to_string(),
                ..RelayInfo::default()
            };
        }
        if let Ok(mut snapshot) = self.snapshot.lock() {
            *snapshot = Snapshot::default();
        }
        let _ = self.app.emit("relay://info", self.info());
        log_line("relay", format_args!("join {}", target.name));
        let (tx, rx) = std::sync::mpsc::channel();
        let (app, info, snapshot) = (self.app.clone(), self.info.clone(), self.snapshot.clone());
        let thread = std::thread::Builder::new()
            .name("pm-relay".to_string())
            .spawn(move || session_loop(&app, PhoneLink::open(target), &rx, &info, &snapshot))
            .ok();
        if let Ok(mut slot) = self.session.lock() {
            *slot = Some(Session { tx, thread });
        }
    }

    /// Leaves the phone.
    pub fn leave(&self) {
        let session = self.session.lock().ok().and_then(|mut slot| slot.take());
        let Some(mut session) = session else {
            return;
        };
        let _ = session.tx.send(ToSession::Stop);
        if let Some(thread) = session.thread.take() {
            let _ = thread.join();
        }
        if let Ok(mut info) = self.info.lock() {
            *info = RelayInfo {
                phase: "idle".to_string(),
                ..RelayInfo::default()
            };
        }
        if let Some(hub) = self.app.try_state::<Arc<PictureHub>>() {
            hub.clear();
        }
        let _ = self.app.emit("relay://info", self.info());
        let _ = self.app.emit(
            "camera://state",
            build(
                &Status::default(),
                ConnectionState {
                    phase: "disconnected",
                    ..ConnectionState::default()
                },
                None,
            ),
        );
    }

    /// A phone feed is up (the library, the gimbal and the format need a direct link).
    pub fn watching(&self) -> bool {
        self.session.lock().is_ok_and(|slot| slot.is_some())
    }

    /// The Link tab's Request / Release.
    pub fn control(&self, want: bool) -> Result<(), String> {
        let slot = self.session.lock().map_err(|e| e.to_string())?;
        let session = slot
            .as_ref()
            .ok_or_else(|| "NOT WATCHING A PHONE".to_string())?;
        let _ = session.tx.send(ToSession::Control(want));
        notice(
            &self.app,
            if want {
                "CONTROL REQUESTED · GRANT IT ON THE PHONE"
            } else {
                "CONTROL RELEASED"
            },
        );
        Ok(())
    }

    /// A live-screen command on a phone feed: resolved as for the camera, then proxied.
    pub fn command(&self, call: &CameraCommand) -> Result<(), String> {
        let snapshot = self
            .snapshot
            .lock()
            .map(|s| s.clone())
            .map_err(|e| e.to_string())?;
        let slot = self.session.lock().map_err(|e| e.to_string())?;
        let session = slot
            .as_ref()
            .ok_or_else(|| "NOT WATCHING A PHONE".to_string())?;
        let policy = zoom::policy();
        let plan = command::plan(
            call,
            command::Context {
                status: &snapshot.status,
                model_id: None,
                tracking: false,
                zoom: policy.as_ref(),
            },
        )
        .map_err(|refused| refused.to_string())?;
        let recording = snapshot.status.is_recording;
        let mut sends = Vec::new();
        for command in plan
            .now
            .iter()
            .chain(plan.later.iter().flat_map(|(_, c)| c.iter()))
        {
            match phone::proxy(command, recording) {
                Proxy::Quiet => {}
                Proxy::Unavailable(label) => return Err(phone::unavailable_notice(label)),
                Proxy::Send(relay) => sends.push(relay),
            }
        }
        if sends.is_empty() {
            return Ok(());
        }
        match &snapshot.control {
            PhoneControl::Held => {
                for relay in sends {
                    let _ = session.tx.send(ToSession::Command(relay));
                }
                Ok(())
            }
            PhoneControl::Available => {
                let _ = session.tx.send(ToSession::Control(true));
                Err("CONTROL REQUESTED · GRANT IT ON THE PHONE".to_string())
            }
            PhoneControl::Requested => Err("WAITING FOR THE PHONE TO GRANT CONTROL".to_string()),
            PhoneControl::HeldBy(name) => Err(format!("{} HOLDS CONTROL", name.to_uppercase())),
            PhoneControl::NotOffered => Err("THE PHONE IS NOT OFFERING CONTROL".to_string()),
        }
    }

    pub fn shutdown(&self) {
        self.browse(false);
        self.leave();
    }
}

fn browse_loop(app: &AppHandle, hosts: &Mutex<HostsPayload>, stop: &AtomicBool) {
    let publish = |next: HostsPayload| {
        let changed = hosts.lock().is_ok_and(|mut slot| {
            let changed = *slot != next;
            *slot = next.clone();
            changed
        });
        if changed {
            let _ = app.emit("relay://hosts", next);
        }
    };
    let info = match ProtocolInfo::load() {
        Ok(info) => info,
        Err(error) => {
            publish(HostsPayload {
                error: Some(format!(
                    "This build cannot read the relay contract: {error}"
                )),
                ..HostsPayload::default()
            });
            return;
        }
    };
    let mut browser = match Browser::start(&info) {
        Ok(browser) => browser,
        Err(error) => {
            publish(HostsPayload {
                error: Some(format!("Could not look for shared feeds: {error}")),
                ..HostsPayload::default()
            });
            return;
        }
    };
    publish(HostsPayload {
        browsing: true,
        ..HostsPayload::default()
    });
    while !stop.load(Ordering::Relaxed) {
        let mut found = browser.poll(Duration::from_millis(500));
        found.sort_by(|a, b| a.name.cmp(&b.name));
        publish(HostsPayload {
            hosts: found.iter().map(HostPayload::from).collect(),
            browsing: true,
            error: None,
        });
    }
}

fn build(
    status: &Status,
    mut connection: ConnectionState,
    hub: Option<&PictureHub>,
) -> state::CameraState {
    connection.transport = "watcher";
    if let Some(hub) = hub {
        if let Ok(stats) = hub.stats.lock() {
            connection.video_fps = stats.presented_fps;
            connection.last_frame_age_ms = stats.last_frame_age_ms;
            if stats.width > 0 {
                connection.stream_width = Some(stats.width);
                connection.stream_height = Some(stats.height);
            }
        }
    }
    let policy = zoom::policy();
    camera_state(
        status,
        None,
        connection,
        Commanded::default(),
        policy.as_ref(),
    )
}

/// The phone thread's events in, pictures and state out.
fn session_loop(
    app: &AppHandle,
    link: PhoneLink,
    rx: &std::sync::mpsc::Receiver<ToSession>,
    info: &Mutex<RelayInfo>,
    snapshot: &Mutex<Snapshot>,
) {
    let hub = app
        .try_state::<Arc<PictureHub>>()
        .map(|hub| hub.inner().clone());
    let started = Instant::now();
    let now = || started.elapsed().as_secs_f64();
    let mut live = LiveDecoder::new();
    let mut throttle = StateThrottle::default();
    let mut has_picture = false;
    let mut joined = false;
    let mut axis = ColorAxis::default();
    let mut connection = ConnectionState {
        phase: "datalink",
        detail: Some("Phone relay".to_string()),
        transport: "watcher",
        ..ConnectionState::default()
    };
    let mut status = Status::default();
    let mut second = Instant::now();
    let mut bytes = 0usize;
    loop {
        loop {
            match rx.try_recv() {
                Ok(ToSession::Stop) | Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
                Ok(ToSession::Command(command)) => link.send(command),
                Ok(ToSession::Control(want)) => link.control(want),
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
            }
        }
        let events = link.drain();
        let idle = events.is_empty();
        let mut changed = false;
        let mut info_changed = false;
        for event in events {
            match event {
                FromPhone::Waiting(text) => {
                    connection.phase = if joined { "recovering" } else { "datalink" };
                    connection.detail = Some(text.clone());
                    if let Ok(mut info) = info.lock() {
                        info.phase = if joined { "reconnecting" } else { "connecting" }.to_string();
                        info.detail = text;
                    }
                    changed = true;
                    info_changed = true;
                }
                FromPhone::Joined(phone_info) => {
                    joined = true;
                    connection.phase = "live-start";
                    connection.detail = Some(format!("Phone relay · {}", phone_info.host));
                    if let Ok(mut info) = info.lock() {
                        apply_info(&mut info, &phone_info);
                        info.detail.clear();
                    }
                    if let Ok(mut s) = snapshot.lock() {
                        s.control = phone_info.control.clone();
                    }
                    changed = true;
                    info_changed = true;
                }
                FromPhone::Info(phone_info) => {
                    let granted = snapshot.lock().is_ok_and(|mut s| {
                        let granted = phone_info.control == PhoneControl::Held
                            && s.control != PhoneControl::Held;
                        s.control = phone_info.control.clone();
                        granted
                    });
                    if let Ok(mut info) = info.lock() {
                        apply_info(&mut info, &phone_info);
                    }
                    if granted {
                        notice(app, "THE PHONE GRANTED CONTROL");
                    }
                    info_changed = true;
                }
                FromPhone::Picture(unit) => {
                    bytes += unit.len();
                    live.push(unit);
                }
                FromPhone::Status(next) => {
                    let next_axis = ColorAxis::from_status(&next);
                    if next_axis != axis {
                        axis = next_axis;
                        if let Some(hub) = &hub {
                            hub.axis(axis);
                        }
                    }
                    if next.is_recording != status.is_recording {
                        let _ = app.emit(
                            "camera://event",
                            if next.is_recording {
                                SessionEvent::RecordingStarted
                            } else {
                                SessionEvent::RecordingStopped
                            },
                        );
                        if let Ok(mut info) = info.lock() {
                            info.recording = next.is_recording;
                        }
                        info_changed = true;
                    }
                    status = *next;
                    if let Ok(mut s) = snapshot.lock() {
                        s.status = status.clone();
                    }
                    changed = true;
                }
                FromPhone::Lost(reason) => {
                    connection.phase = "failed";
                    connection.error = Some(reason.clone());
                    if let Ok(mut info) = info.lock() {
                        info.phase = "failed".to_string();
                        info.detail = reason;
                    }
                    has_picture = false;
                    changed = true;
                    info_changed = true;
                }
            }
        }
        if live.pending() > 0 {
            let mut produced = 0u32;
            let outcome = live.decode(has_picture, |decoded| {
                produced += 1;
                if let Some(hub) = &hub {
                    hub.push(decoded);
                }
            });
            if produced > 0 {
                has_picture = true;
            }
            if let Decoded::CreateFailed(error) | Decoded::Ran(Some(error)) = outcome {
                log_line("relay", format_args!("decoder failed: {error}"));
                connection.phase = "failed";
                connection.error = Some(format!("decoder failed: {error}"));
                changed = true;
            }
        }
        if has_picture && matches!(connection.phase, "live-start" | "recovering" | "datalink") {
            connection.phase = "live";
            connection.detail = None;
            connection.error = None;
            if let Ok(mut info) = info.lock() {
                info.phase = "live".to_string();
                info.detail.clear();
            }
            changed = true;
            info_changed = true;
        }
        if second.elapsed() >= Duration::from_secs(1) {
            connection.video_kbps =
                (bytes as f64 * 8.0 / 1000.0 / second.elapsed().as_secs_f64()) as f32;
            connection.stream_codec = live.codec().map(|codec| match codec {
                opc_decode::Codec::H264 => "avc",
                opc_decode::Codec::Hevc => "hevc",
            });
            bytes = 0;
            second = Instant::now();
            changed = true;
        }
        if info_changed {
            if let Ok(info) = info.lock() {
                let _ = app.emit("relay://info", info.clone());
            }
        }
        let at = now();
        let emit = if changed {
            throttle.offer(state::Immediate::of(&status, &connection), at)
        } else {
            throttle.due(at)
        };
        if emit {
            let _ = app.emit(
                "camera://state",
                build(&status, connection.clone(), hub.as_deref()),
            );
        }
        if idle {
            std::thread::sleep(Duration::from_millis(4));
        }
    }
}

// ───────────── Commands (§3.5 `relay_*`) ─────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinTarget {
    pub name: String,
    #[serde(default)]
    pub passcode: String,
    /// From `relay://hosts`; empty finds the phone by name on this Wi-Fi first.
    #[serde(default)]
    pub addresses: Vec<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

#[tauri::command]
pub fn relay_browse(relay: tauri::State<'_, RelayService>, on: Option<bool>) -> HostsPayload {
    relay.browse(on.unwrap_or(true));
    relay.hosts()
}

#[tauri::command]
pub fn relay_info(relay: tauri::State<'_, RelayService>) -> RelayInfo {
    relay.info()
}

/// Joins: the camera link is closed first, which joins threads, so off the main thread.
#[tauri::command]
pub async fn relay_join(app: AppHandle, target: JoinTarget) -> Result<(), String> {
    if target.name.trim().is_empty() {
        return Err("Pick a shared feed to watch.".to_string());
    }
    let addresses: Vec<IpAddr> = target
        .addresses
        .iter()
        .filter_map(|address| address.parse().ok())
        .collect();
    let phone = PhoneTarget {
        name: target.name.trim().to_string(),
        port: target.port.unwrap_or(DEFAULT_PORT),
        addresses,
        passcode: target.passcode,
    };
    tauri::async_runtime::spawn_blocking(move || app.state::<RelayService>().join(phone))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn relay_leave(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<RelayService>().leave())
        .await
        .map_err(|error| error.to_string())
}

/// The Link tab's Request (`want: true`) / Release.
#[tauri::command]
pub fn relay_control(relay: tauri::State<'_, RelayService>, want: bool) -> Result<(), String> {
    relay.control(want)
}

/// A `CameraController` call on a phone feed. A refusal comes back as operator copy.
#[tauri::command]
pub fn relay_command(
    relay: tauri::State<'_, RelayService>,
    command: CameraCommand,
) -> Result<(), String> {
    relay.command(&command)
}
