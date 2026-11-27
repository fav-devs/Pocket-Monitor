//! The viewfinder as a camera for other apps (§1.W, the Output settings).
//!
//! `opc-vcam` keeps the backends (v4l2loopback, the Windows Media Foundation source over
//! `\\.\pipe\PocketMonitorVCam`, the macOS extension, the MJPEG stream on
//! `127.0.0.1:<port>`) and the latest-wins worker. This module owns the setting (saved
//! in `desktop-prefs.txt` as `vcam`, `vcam_clean`, `vcam_port`), the camera's life, the
//! platform component (probed at start and after each action, installs and removes on
//! their own thread so UAC never stalls anything), and `vcam://status` once a second.
//!
//! Frames come from the render thread ([`after_present`]), at most 30 a second, from
//! the viewfinder and the player but never the library grid, through
//! `FeedRenderer::render_async`: 1280 × 720 targets of their own and a fenced readback
//! that hands back the previous frame, so the window's targets are never rebuilt and
//! the device is never waited on (D4, P21). The hand-off to the camera happens on
//! `pm-vcam`, off the render thread.

use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opc_decode::Picture;
use opc_render::{FeedRenderer, GradeOptions, Rgba};

use opc_vcam::{ComponentReport, ComponentState, VirtualCamera};
use pm_controller::link::log_line;
use pm_controller::prefs;
use pm_controller::vcam as decide;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::media::MediaService;

/// Frames the camera takes at most, per second.
const MOST_FPS: f64 = 30.0;

/// The Output setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Settings {
    mode: u8,
    clean: bool,
    port: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentPayload {
    pub platform: String,
    pub state: &'static str,
    pub label: &'static str,
    pub detail: String,
    pub can_install: bool,
    pub can_remove: bool,
}

/// `vcam://status` and the answer to `vcam_get`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VcamPayload {
    /// `off`, `device` or `stream`.
    pub mode: &'static str,
    pub clean: bool,
    pub port: u16,
    pub stream_url: String,
    /// "Camera · /dev/video10 · 1280×720 · 3,201 frames", the error, or "Off".
    pub output: String,
    pub component: ComponentPayload,
}

fn component_payload(report: &ComponentReport) -> ComponentPayload {
    ComponentPayload {
        platform: report.platform.clone(),
        state: match report.state {
            ComponentState::Installed => "installed",
            ComponentState::NotInstalled => "not-installed",
            ComponentState::Unsupported => "unsupported",
            ComponentState::Busy => "busy",
            ComponentState::Unknown => "unknown",
        },
        label: report.state.label(),
        detail: report.detail.clone(),
        can_install: report.can_install,
        can_remove: report.can_remove,
    }
}

/// The latest finished frame, waiting for `pm-vcam`.
#[derive(Default)]
struct Slot {
    frame: Option<Rgba>,
    stop: bool,
}

struct State {
    settings: Settings,
    camera: Option<VirtualCamera>,
    component: ComponentReport,
    job: bool,
    last_payload: Option<VcamPayload>,
}

/// The service in Tauri state.
pub struct VcamService {
    app: AppHandle,
    state: Arc<Mutex<State>>,
    slot: Arc<(Mutex<Slot>, Condvar)>,
    /// When the render thread last submitted a frame.
    tap: Mutex<Option<Instant>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for VcamService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VcamService").finish_non_exhaustive()
    }
}

fn saved_settings() -> Settings {
    let saved = prefs::load(&prefs::path())
        .map(|s| s.prefs)
        .unwrap_or_default();
    Settings {
        mode: saved.vcam,
        clean: saved.vcam_clean,
        port: saved.vcam_port,
    }
}

/// Writes the three Output lines back, keeping every other line as the file has it.
fn save_settings(settings: Settings) {
    let path = prefs::path();
    let mut saved = prefs::load(&path).unwrap_or_default();
    saved.prefs.vcam = settings.mode;
    saved.prefs.vcam_clean = settings.clean;
    saved.prefs.vcam_port = settings.port;
    if let Err(error) = prefs::save(&path, &saved) {
        log_line(
            "vcam",
            format_args!("could not save the Output setting: {error}"),
        );
    }
}

impl VcamService {
    pub fn new(app: AppHandle) -> Self {
        let state = Arc::new(Mutex::new(State {
            settings: saved_settings(),
            camera: None,
            component: ComponentReport::default(),
            job: false,
            last_payload: None,
        }));
        let slot = Arc::new((Mutex::new(Slot::default()), Condvar::new()));
        let thread = {
            let (app, state, slot) = (app.clone(), state.clone(), slot.clone());
            std::thread::Builder::new()
                .name("pm-vcam".to_string())
                .spawn(move || run(&app, &state, &slot))
                .ok()
        };
        let service = Self {
            app,
            state,
            slot,
            tap: Mutex::new(None),
            thread: Mutex::new(thread),
        };
        service.reconcile();
        service.component_job(opc_vcam::install::probe, None);
        service
    }

    pub fn payload(&self) -> Option<VcamPayload> {
        self.state.lock().ok().map(|state| payload(&state))
    }

    /// Starts, stops or swaps the camera to match the setting.
    fn reconcile(&self) {
        if let Ok(mut state) = self.state.lock() {
            reconcile(&mut state);
        }
    }

    /// `vcam_set`. Picking Camera device without the component says so.
    pub fn set(
        &self,
        mode: Option<&str>,
        clean: Option<bool>,
        port: Option<u16>,
    ) -> Result<VcamPayload, String> {
        let (payload, warn) = {
            let mut state = self.state.lock().map_err(|e| e.to_string())?;
            let mut settings = state.settings;
            if let Some(mode) = mode {
                settings.mode = decide::mode_from_name(mode)
                    .ok_or_else(|| format!("No such output: {mode}"))?;
            }
            if let Some(clean) = clean {
                settings.clean = clean;
            }
            if let Some(port) = port.filter(|port| *port != 0) {
                settings.port = port;
            }
            let warn = settings.mode == 1
                && state.settings.mode != 1
                && state.component.state != ComponentState::Installed;
            if settings != state.settings {
                state.settings = settings;
                save_settings(settings);
                reconcile(&mut state);
            }
            (payload(&state), warn)
        };
        if warn {
            notice(
                &self.app,
                "CAMERA COMPONENT NOT INSTALLED · SETTINGS › OUTPUT",
            );
        }
        let _ = self.app.emit("vcam://status", payload.clone());
        Ok(payload)
    }

    /// Runs a probe, install or remove off every UI thread; one at a time.
    pub fn component_job(&self, job: fn() -> ComponentReport, busy: Option<&'static str>) -> bool {
        {
            let Ok(mut state) = self.state.lock() else {
                return false;
            };
            if state.job {
                return false;
            }
            state.job = true;
            if let Some(what) = busy {
                state.component = state.component.busy(what);
                let _ = self
                    .app
                    .emit("component://report", component_payload(&state.component));
            }
        }
        let (app, state) = (self.app.clone(), self.state.clone());
        let spawned = std::thread::Builder::new()
            .name("pm-component".to_string())
            .spawn(move || {
                let report = job();
                let installed = report.state == ComponentState::Installed;
                let outcome = {
                    let Ok(mut state) = state.lock() else { return };
                    state.job = false;
                    state.component = report;
                    // The camera restarts so it sees what changed.
                    if let Some(camera) = state.camera.take() {
                        camera.stop();
                    }
                    reconcile(&mut state);
                    let _ = app.emit("component://report", component_payload(&state.component));
                    (state.settings.mode == 1 && installed, payload(&state))
                };
                if busy.is_some() && outcome.0 {
                    notice(&app, "CAMERA COMPONENT INSTALLED · CAMERA ON");
                }
                let _ = app.emit("vcam://status", outcome.1);
            })
            .is_ok();
        if !spawned {
            if let Ok(mut state) = self.state.lock() {
                state.job = false;
            }
        }
        spawned
    }

    fn running(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.camera.is_some())
    }

    fn clean(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.settings.clean)
            .unwrap_or(true)
    }

    pub fn shutdown(&self) {
        let (slot, wake) = &*self.slot;
        if let Ok(mut slot) = slot.lock() {
            slot.stop = true;
        }
        wake.notify_all();
        if let Some(thread) = self.thread.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = thread.join();
        }
        if let Ok(mut state) = self.state.lock() {
            if let Some(camera) = state.camera.take() {
                camera.stop();
            }
        }
    }
}

fn reconcile(state: &mut State) {
    let wanted = decide::backend(state.settings.mode, state.settings.port);
    let running = state.camera.as_ref().map(VirtualCamera::backend).cloned();
    if wanted != running {
        if let Some(camera) = state.camera.take() {
            camera.stop();
        }
        state.camera = wanted.map(VirtualCamera::start);
        log_line(
            "vcam",
            format_args!("output {}", decide::mode_name(state.settings.mode)),
        );
    }
}

fn payload(state: &State) -> VcamPayload {
    let output = state
        .camera
        .as_ref()
        .map_or_else(|| "Off".to_string(), |camera| camera.status().line());
    VcamPayload {
        mode: decide::mode_name(state.settings.mode),
        clean: state.settings.clean,
        port: state.settings.port,
        stream_url: decide::stream_url(state.settings.port),
        output,
        component: component_payload(&state.component),
    }
}

fn notice(app: &AppHandle, message: &str) {
    let _ = app.emit(
        "camera://event",
        crate::camera::SessionEvent::Notice {
            message: message.to_string(),
            tone: "info",
        },
    );
}

/// The render thread, after a picture (not the black placeholder) reached the screen.
/// Cheap when nothing is asked: one lock and a clock read.
pub fn after_present(
    app: &AppHandle,
    renderer: &mut FeedRenderer,
    picture: &Picture<'_>,
    grade: GradeOptions,
) {
    let Some(vcam) = app.try_state::<VcamService>() else {
        return;
    };
    if !vcam.running() {
        return;
    }
    // Fed from the viewfinder and the player, never the library grid.
    if app
        .try_state::<MediaService>()
        .is_some_and(|media| media.library_showing())
    {
        return;
    }
    let due = vcam
        .tap
        .lock()
        .is_ok_and(|tap| tap.is_none_or(|at| at.elapsed().as_secs_f64() >= 1.0 / MOST_FPS));
    if !due {
        return;
    }
    let clean = vcam.clean();
    let options = decide::grade(grade, clean);
    let look = clean.then(|| renderer.look().clean());
    match renderer.render_async(picture, (opc_vcam::WIDTH, opc_vcam::HEIGHT), options, look) {
        Ok(finished) => {
            if let Ok(mut tap) = vcam.tap.lock() {
                *tap = Some(Instant::now());
            }
            if let Some(frame) = finished {
                let (inside, wake) = &*vcam.slot;
                if let Ok(mut inside) = inside.lock() {
                    inside.frame = Some(frame);
                }
                wake.notify_one();
            }
        }
        Err(error) => log_line("vcam", format_args!("render failed: {error}")),
    }
}

/// `pm-vcam`: hands frames to the camera and refreshes the readout once a second.
fn run(app: &AppHandle, state: &Mutex<State>, slot: &(Mutex<Slot>, Condvar)) {
    let (inside, wake) = slot;
    let mut last_status = Instant::now();
    loop {
        let frame = {
            let Ok(mut guard) = inside.lock() else { return };
            if guard.frame.is_none() && !guard.stop {
                let Ok((next, _)) = wake.wait_timeout(guard, Duration::from_millis(250)) else {
                    return;
                };
                guard = next;
            }
            if guard.stop {
                return;
            }
            guard.frame.take()
        };
        if let Some(frame) = frame {
            if let Ok(state) = state.lock() {
                if let Some(camera) = state.camera.as_ref() {
                    camera.offer(opc_vcam::Frame {
                        width: frame.width,
                        height: frame.height,
                        rgba: frame.pixels,
                    });
                }
            }
        }
        if last_status.elapsed() >= Duration::from_secs(1) {
            last_status = Instant::now();
            if let Ok(mut state) = state.lock() {
                let now = payload(&state);
                if state.last_payload.as_ref() != Some(&now) {
                    state.last_payload = Some(now.clone());
                    let _ = app.emit("vcam://status", now);
                }
            }
        }
    }
}

// ───────────── Commands ─────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamChange {
    pub mode: Option<String>,
    pub clean: Option<bool>,
    pub port: Option<u16>,
}

#[tauri::command]
pub fn vcam_get(vcam: tauri::State<'_, VcamService>) -> Result<VcamPayload, String> {
    vcam.payload()
        .ok_or_else(|| "The virtual camera is not available.".to_string())
}

#[tauri::command]
pub fn vcam_set(
    vcam: tauri::State<'_, VcamService>,
    change: VcamChange,
) -> Result<VcamPayload, String> {
    vcam.set(change.mode.as_deref(), change.clean, change.port)
}

#[tauri::command]
pub fn vcam_component_probe(vcam: tauri::State<'_, VcamService>) -> bool {
    vcam.component_job(opc_vcam::install::probe, None)
}

#[tauri::command]
pub fn vcam_component_install(vcam: tauri::State<'_, VcamService>) -> bool {
    vcam.component_job(opc_vcam::install::install, Some("Installing…"))
}

#[tauri::command]
pub fn vcam_component_remove(vcam: tauri::State<'_, VcamService>) -> bool {
    vcam.component_job(opc_vcam::install::remove, Some("Removing…"))
}

/// Opens a URL in the operator's browser (the stream page, the OBS recipe).
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only web addresses open from here.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || opc_vcam::install::open_url(&url))
        .await
        .map_err(|error| error.to_string())?
}
