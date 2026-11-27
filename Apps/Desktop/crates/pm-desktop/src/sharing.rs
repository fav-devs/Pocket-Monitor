//! Sharing this PC's live camera preview with watchers (`docs/desktop-expo-port.md` §1.E,
//! the old viewfinder's *Share this feed*, main af91c5b).
//!
//! The host is `opc_relay::host::Host` (view-only, up to four watchers, advertised as
//! `_pocket-mon._tcp` and the legacy `_opc-mon._tcp`). It is fed from the `pm-session`
//! thread, where the camera's access units already arrive, before they go to the decoder:
//! nothing is added to the render thread, and while sharing is off a unit costs one
//! relaxed atomic load. The rules are `pm_controller::sharing`'s.
//!
//! Commands: `sharing_set {on}`, `sharing_state`. Event: `sharing://status`; a stop the
//! operator did not ask for is also a `camera://event` notice.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use pm_controller::link::log_line;
use pm_controller::sharing::{self, Feed, SharingStatus};
use tauri::{AppHandle, Emitter, Manager};

use crate::camera::{CameraService, SessionEvent};
use crate::relay::RelayService;

#[cfg(opc_core_linked)]
type Host = opc_relay::host::Host;

/// Without the Swift core there is no relay video encoder, so there is no host.
#[cfg(not(opc_core_linked))]
#[derive(Debug)]
struct Host;

#[cfg(not(opc_core_linked))]
impl Host {
    fn start(_camera: SocketAddr) -> std::io::Result<Self> {
        Err(std::io::Error::other("this build has no camera core"))
    }

    fn offer(&self, _bytes: &[u8], _recording: bool) -> bool {
        false
    }

    fn error(&self) -> Option<String> {
        None
    }

    fn watchers(&self) -> usize {
        0
    }
}

#[derive(Debug, Default)]
struct Inner {
    host: Option<Host>,
    /// Where the open link reaches the camera (`FromCamera::Opened`).
    camera: Option<SocketAddr>,
    recording: bool,
    hevc: bool,
    status: SharingStatus,
}

/// The service in Tauri state.
#[derive(Debug, Default)]
pub struct SharingService {
    /// A host is running: the session thread's fast path.
    on: AtomicBool,
    /// The library, the player or the resume loop has the camera in playback.
    media_active: AtomicBool,
    inner: Mutex<Inner>,
}

impl SharingService {
    pub fn status(&self) -> SharingStatus {
        self.inner
            .lock()
            .map(|inner| inner.status.clone())
            .unwrap_or_default()
    }

    /// The operator's switch. Turning it on checks the old rules first and answers with
    /// what the readout should say.
    fn set(&self, app: &AppHandle, on: bool) -> SharingStatus {
        if !on {
            self.stop(app, sharing::OFF, false);
            return self.status();
        }
        let live = app
            .try_state::<CameraService>()
            .is_some_and(|camera| camera.state().connection.phase == "live");
        let watching_phone = app
            .try_state::<RelayService>()
            .is_some_and(|relay| relay.watching());
        let started = {
            let Ok(mut inner) = self.inner.lock() else {
                return SharingStatus::default();
            };
            if inner.host.is_some() {
                return inner.status.clone();
            }
            let feed = Feed {
                watching_phone,
                media_active: self.media_active.load(Ordering::Relaxed),
                live,
                hevc: inner.hevc,
                camera: inner.camera,
            };
            match sharing::may_start(&feed) {
                Ok(camera) => match Host::start(camera) {
                    Ok(host) => {
                        inner.host = Some(host);
                        inner.status = SharingStatus::running(0);
                        self.on.store(true, Ordering::Relaxed);
                        log_line("sharing", "sharing the camera preview");
                        Ok(())
                    }
                    Err(error) => Err(sharing::could_not_start(error)),
                },
                Err(reason) => Err(reason.to_string()),
            }
        };
        match started {
            Ok(()) => emit(app, &self.status()),
            // A refused start is the readout's line, not a notice.
            Err(reason) => self.stop(app, &reason, false),
        }
        self.status()
    }

    /// Drops the host (watchers see the feed end) and says why. `stopped`: the share
    /// stopped by itself, which the live view shows as a notice.
    fn stop(&self, app: &AppHandle, reason: &str, stopped: bool) {
        let was_running = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            let was_running = inner.host.take().is_some();
            self.on.store(false, Ordering::Relaxed);
            inner.status = SharingStatus::idle(reason, stopped && was_running);
            was_running
        };
        if was_running {
            log_line("sharing", format_args!("stopped: {reason}"));
        }
        let status = self.status();
        if let Some(message) = sharing::notice(&status) {
            let _ = app.emit(
                "camera://event",
                SessionEvent::Notice {
                    message,
                    tone: "warning",
                },
            );
        }
        emit(app, &status);
    }

    /// Stops a running share for `reason`; nothing happens when none runs.
    fn stop_running(&self, app: &AppHandle, reason: &str) {
        if self.on.load(Ordering::Relaxed) {
            self.stop(app, reason, true);
        }
    }

    pub fn shutdown(&self) {
        self.on.store(false, Ordering::Relaxed);
        if let Ok(mut inner) = self.inner.lock() {
            inner.host = None;
        }
    }
}

fn emit(app: &AppHandle, status: &SharingStatus) {
    let _ = app.emit("sharing://status", status);
}

fn with(app: &AppHandle, job: impl FnOnce(&SharingService)) {
    if let Some(service) = app.try_state::<SharingService>() {
        job(&service);
    }
}

// ── hooks the session thread and the library call ───────────────────────────────

/// The link opened at `address` (`FromCamera::Opened`). A running share is on the old
/// link's interface, so it stops.
pub fn tap_opened(app: &AppHandle, address: SocketAddr) {
    with(app, |service| {
        service.stop_running(app, sharing::RECONNECTED);
        if let Ok(mut inner) = service.inner.lock() {
            inner.camera = Some(address);
        }
    });
}

/// The link went away (`FromCamera::Lost`, or the app closed it).
pub fn tap_lost(app: &AppHandle) {
    with(app, |service| {
        service.stop_running(app, sharing::DISCONNECTED);
        if let Ok(mut inner) = service.inner.lock() {
            inner.camera = None;
            inner.hevc = false;
        }
    });
}

/// The operator's Reconnect: the new link's `Opened` would say the same, but the old link
/// is closed first and would say "disconnected".
pub fn tap_reconnecting(app: &AppHandle) {
    with(app, |service| {
        service.stop_running(app, sharing::RECONNECTED)
    });
}

/// The decoder's codec latch (`LiveDecoder::codec`), when it changes.
pub fn tap_codec(app: &AppHandle, codec: Option<opc_decode::Codec>) {
    with(app, |service| {
        if let Ok(mut inner) = service.inner.lock() {
            inner.hevc = codec == Some(opc_decode::Codec::Hevc);
        }
    });
}

/// A status report from the body: the recording flag rides on every shared frame, and
/// playback on the camera stops the share.
pub fn tap_status(app: &AppHandle, recording: bool, in_playback: bool) {
    with(app, |service| {
        if let Ok(mut inner) = service.inner.lock() {
            inner.recording = recording;
        }
        if let Some(reason) = sharing::status_stops(in_playback) {
            service.stop_running(app, reason);
        }
    });
}

/// The library, the player or the resume loop took the camera into playback, or left it.
pub fn tap_media(app: &AppHandle, active: bool) {
    with(app, |service| {
        service.media_active.store(active, Ordering::Relaxed);
        if active {
            service.stop_running(app, sharing::PLAYBACK);
        }
    });
}

/// One access unit from the camera, before it goes to the decoder. Off: one atomic load.
pub fn tap_picture(app: &AppHandle, bytes: &[u8]) {
    let Some(service) = app.try_state::<SharingService>() else {
        return;
    };
    if !service.on.load(Ordering::Relaxed) {
        return;
    }
    let media_active = service.media_active.load(Ordering::Relaxed);
    let h264 = pm_controller::decode::codec_of(bytes) == Some(opc_decode::Codec::H264);
    if let Some(reason) = sharing::picture_stops(media_active, h264) {
        service.stop(app, reason, true);
        return;
    }
    let refused = {
        let Ok(inner) = service.inner.lock() else {
            return;
        };
        match inner.host.as_ref() {
            Some(host) if !host.offer(bytes, inner.recording) => Some(host.error()),
            _ => None,
        }
    };
    if let Some(error) = refused {
        service.stop(app, &sharing::refused(error), true);
    }
}

/// Once per session-loop pass: a host that failed by itself, and the watcher count.
pub fn tap_tick(app: &AppHandle) {
    let Some(service) = app.try_state::<SharingService>() else {
        return;
    };
    if !service.on.load(Ordering::Relaxed) {
        return;
    }
    let (failed, changed) = {
        let Ok(mut inner) = service.inner.lock() else {
            return;
        };
        let Some(host) = inner.host.as_ref() else {
            return;
        };
        let failed = host.error();
        let watchers = host.watchers();
        let changed = failed.is_none() && watchers != inner.status.watchers;
        if changed {
            inner.status = SharingStatus::running(watchers);
        }
        (failed, changed)
    };
    if let Some(error) = failed {
        service.stop(app, &sharing::stopped_by(error), true);
    } else if changed {
        emit(app, &service.status());
    }
}

// ── commands ─────────────────────────────────────────────────────────────────────

/// *Share this feed* on or off. Answers with the readout: running, or why not.
#[tauri::command]
pub async fn sharing_set(app: AppHandle, on: bool) -> Result<SharingStatus, String> {
    // Starting binds a socket and spawns the host thread: off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        app.try_state::<SharingService>()
            .map(|service| service.set(&app, on))
            .unwrap_or_default()
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sharing_state(sharing: tauri::State<'_, SharingService>) -> SharingStatus {
    sharing.status()
}
