//! The camera on its own thread.
//!
//! The datalink has a 40 Hz pump to keep and a 5 ms read timeout to sit on; the window
//! has a swapchain to feed. Neither can wait for the other, so they are two threads with
//! two channels between them, and nothing shared but the messages.
//!
//! Moved here from the `opc-monitor` binary so the Tauri backend runs the very same
//! thread. [`Link::commander`] hands out a cloneable handle onto the command channel, so
//! the 100 Hz input thread and IPC handlers enqueue onto the camera thread exactly as the
//! window does: nothing but this thread ever writes the socket.

use std::fs::OpenOptions;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opc_camera::DumlFrame;
use opc_camera::{CameraSession, Command, Recovery, SessionEvent, SetOutcome, Status};

/// Appends a concise diagnostic to the log beside the Windows executable. The window
/// normally has no terminal, so decode outcomes must be available after it closes.
pub fn diagnostic(message: impl std::fmt::Display) {
    log_line("view", message);
}

/// Appends `<tag>: <message>` to the log ([`crate::platform::log_path`]) — the file and
/// line formats the benchmark in `docs/desktop-expo-port.md` §4 parses. Never pass
/// credentials or payloads.
pub fn log_line(tag: &str, message: impl std::fmt::Display) {
    // Beside the exe for a portable copy, per user for an installed one (D3).
    let Some(path) = crate::platform::log_path() else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{tag}: {message}");
    }
}

/// What the camera thread tells the window.
#[derive(Debug)]
pub enum FromCamera {
    /// The session opened.
    Opened,
    /// A complete access unit, ready for the decoder.
    Picture(Vec<u8>),
    /// The camera said something about itself.
    Status(Box<Status>),
    /// The feed stalled and the watchdog is working on it.
    Recovering(Recovery),
    /// The camera never answered, or the link died.
    Lost(String),
    /// A reply the media browser reads: catalogue chunks, delete and favourite
    /// answers, and the playback entry's acknowledgement.
    Frame(DumlFrame),
    /// What became of a live-control SET.
    Set(SetOutcome),
}

/// What the window tells the camera thread.
#[derive(Debug)]
enum ToCamera {
    Send(Command),
    /// A picture reached the screen. The watchdog counts presented frames, not arrived
    /// ones — a decoder quietly producing nothing looks like a healthy feed otherwise.
    Presented,
    /// The decoder is wedged, or has just been rebuilt.
    DecoderFailed(bool),
    /// The operator is in the library or a playback, where a repair would tear the
    /// screen down under them.
    RepairBlocked(bool),
    Stop,
}

/// A running camera link.
#[derive(Debug)]
pub struct Link {
    commands: Sender<ToCamera>,
    events: Receiver<FromCamera>,
    worker: Option<JoinHandle<()>>,
}

impl Link {
    /// Opens the datalink on its own thread and starts pumping.
    ///
    /// `session_id` and `base_seq` must be fresh per connect; a fixed base sequence can
    /// wedge the camera. `model_id` tells the status decoder which body this is, so it
    /// reads that body's own colour-mode encodings rather than another's.
    pub fn open(
        remote: Option<SocketAddr>,
        session_id: u16,
        base_seq: u16,
        model_id: Option<i32>,
    ) -> Self {
        let (commands, command_rx) = channel();
        let (event_tx, events) = channel();
        let worker = std::thread::Builder::new()
            .name("opc-camera".to_string())
            .spawn(move || {
                run(
                    remote,
                    session_id,
                    base_seq,
                    model_id,
                    &command_rx,
                    &event_tx,
                )
            })
            .ok();
        Self {
            commands,
            events,
            worker,
        }
    }

    /// Queues a command. A closed link drops it rather than failing the caller: the
    /// window has already been told the link is gone.
    pub fn send(&self, command: Command) {
        let _ = self.commands.send(ToCamera::Send(command));
    }

    pub fn note_presented(&self) {
        let _ = self.commands.send(ToCamera::Presented);
    }

    pub fn note_decoder_failed(&self, failed: bool) {
        let _ = self.commands.send(ToCamera::DecoderFailed(failed));
    }

    /// Holds the watchdog's ladder while the operator is away from the live picture.
    pub fn set_repair_blocked(&self, blocked: bool) {
        let _ = self.commands.send(ToCamera::RepairBlocked(blocked));
    }

    /// Everything waiting from the camera.
    pub fn drain(&self) -> Vec<FromCamera> {
        self.events.try_iter().collect()
    }

    /// The next thing from the camera, waiting at most `timeout`. `Err(true)` means the
    /// camera thread has gone.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<FromCamera, bool> {
        match self.events.recv_timeout(timeout) {
            Ok(event) => Ok(event),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(false),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(true),
        }
    }

    /// A handle other threads use to queue commands and presents onto this link.
    pub fn commander(&self) -> LinkCommander {
        LinkCommander {
            commands: self.commands.clone(),
        }
    }
}

/// A cloneable sender onto a [`Link`]'s command channel. It never touches the socket:
/// everything it sends is serialised on the camera thread behind the 40 Hz ACK pump.
/// Once the link is dropped, sends are silently discarded.
#[derive(Debug, Clone)]
pub struct LinkCommander {
    commands: Sender<ToCamera>,
}

impl LinkCommander {
    pub fn send(&self, command: Command) {
        let _ = self.commands.send(ToCamera::Send(command));
    }

    /// A picture reached the screen (the render thread's real present).
    pub fn note_presented(&self) {
        let _ = self.commands.send(ToCamera::Presented);
    }

    pub fn note_decoder_failed(&self, failed: bool) {
        let _ = self.commands.send(ToCamera::DecoderFailed(failed));
    }

    pub fn set_repair_blocked(&self, blocked: bool) {
        let _ = self.commands.send(ToCamera::RepairBlocked(blocked));
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        let _ = self.commands.send(ToCamera::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run(
    remote: Option<SocketAddr>,
    session_id: u16,
    base_seq: u16,
    model_id: Option<i32>,
    commands: &Receiver<ToCamera>,
    events: &Sender<FromCamera>,
) {
    // The window is normally launched without a terminal on Windows. Keep the network
    // state beside the executable, but never log BLE credentials or camera payloads.
    let mut log = crate::platform::log_path()
        .and_then(|path| OpenOptions::new().create(true).append(true).open(path).ok());
    macro_rules! link_log {
        ($($t:tt)*) => {
            if let Some(ref mut file) = log {
                let _ = writeln!(file, "link: {}", format_args!($($t)*));
            }
        };
    }

    link_log!(
        "starting UDP session remote={:?} model={model_id:?}",
        remote
    );
    let opened = match remote {
        Some(address) => CameraSession::connect_to(address, session_id, base_seq),
        None => CameraSession::connect(session_id, base_seq),
    };
    let mut session = match opened {
        Ok(session) => session,
        Err(error) => {
            link_log!("could not open UDP socket: {error}");
            let _ = events.send(FromCamera::Lost(error.to_string()));
            return;
        }
    };
    link_log!(
        "UDP socket bound local_port={} remote={} phase={:?} TCP-7001={}",
        session.local_port(),
        session.remote(),
        session.phase(),
        session.tcp_poke_status()
    );
    if let Some(model_id) = model_id {
        session.set_model(model_id);
    }
    let mut saw_picture = false;
    let mut logged_access_units = 0usize;
    let mut access_units_since_log = 0usize;
    let mut bytes_since_log = 0usize;
    let mut access_unit_rate_started = Instant::now();
    let mut diagnostics_started = Instant::now();

    'main: loop {
        loop {
            match commands.try_recv() {
                Ok(ToCamera::Send(command)) => session.send(command),
                Ok(ToCamera::Presented) => session.note_presented(),
                Ok(ToCamera::DecoderFailed(failed)) => session.set_decoder_failed(failed),
                Ok(ToCamera::RepairBlocked(blocked)) => session.set_repair_blocked(blocked),
                Ok(ToCamera::Stop) | Err(TryRecvError::Disconnected) => return,
                Err(TryRecvError::Empty) => break,
            }
        }

        let polled = match session.poll() {
            Ok(polled) => polled,
            Err(error) => {
                link_log!("UDP poll failed: {error}");
                match reconnect(
                    &error.to_string(),
                    remote,
                    session_id,
                    base_seq,
                    commands,
                    events,
                    &mut log,
                ) {
                    Some(fresh) => {
                        session = fresh;
                        if let Some(model_id) = model_id {
                            session.set_model(model_id);
                        }
                        saw_picture = false;
                        continue 'main;
                    }
                    None => return,
                }
            }
        };
        // With a nonblocking UDP socket, avoid monopolising a core while no complete
        // shell event is ready. The next iteration still ticks the 40 Hz window ACK
        // immediately, rather than waiting for Windows' coarse UDP timeout.
        if polled.is_empty() {
            std::thread::yield_now();
        }
        let diagnostics_elapsed = diagnostics_started.elapsed();
        if diagnostics_elapsed.as_secs_f64() >= 1.0 {
            let stats = session.take_diagnostics();
            link_log!(
                "transport: ack={:.1}/s max_gap={:.0}ms video={} au={} status={} cursors={:04x}/{:04x}/{:04x} last_video={:.1}s",
                stats.acks as f64 / diagnostics_elapsed.as_secs_f64(),
                stats.max_ack_gap * 1000.0,
                stats.video_packets,
                stats.access_units,
                stats.status_packets,
                stats.video_cursor,
                stats.acked_data_cursor,
                stats.extra_cursor,
                stats.last_video_age
            );
            diagnostics_started = Instant::now();
        }
        for event in polled {
            let message = match event {
                SessionEvent::Opened => {
                    link_log!("camera accepted session; phase={:?}", session.phase());
                    FromCamera::Opened
                }
                SessionEvent::Picture(bytes) => {
                    if !saw_picture {
                        link_log!("received first picture ({} bytes)", bytes.len());
                        saw_picture = true;
                    }
                    if logged_access_units < 3 {
                        let head = bytes
                            .iter()
                            .take(32)
                            .map(|byte| format!("{byte:02x}"))
                            .collect::<Vec<_>>()
                            .join(" ");
                        link_log!(
                            "access unit #{} bytes={} head={head}",
                            logged_access_units + 1,
                            bytes.len()
                        );
                        logged_access_units += 1;
                    }
                    access_units_since_log += 1;
                    bytes_since_log += bytes.len();
                    let elapsed = access_unit_rate_started.elapsed();
                    if elapsed.as_secs_f64() >= 1.0 {
                        link_log!(
                            "video rate: {:.1} access-units/s, {:.1} KiB/s",
                            access_units_since_log as f64 / elapsed.as_secs_f64(),
                            bytes_since_log as f64 / elapsed.as_secs_f64() / 1024.0
                        );
                        access_units_since_log = 0;
                        bytes_since_log = 0;
                        access_unit_rate_started = Instant::now();
                    }
                    FromCamera::Picture(bytes)
                }
                SessionEvent::VideoStarted => {
                    link_log!("received first raw video datagram; awaiting a complete access unit");
                    continue;
                }
                SessionEvent::FirstPictureFormatPoke { original, kick } => {
                    link_log!(
                        "Pocket 3 first-picture format poke {:02x}/{:02x} -> {:02x}/{:02x} -> restore",
                        original.0,
                        original.1,
                        kick.0,
                        kick.1
                    );
                    continue;
                }
                SessionEvent::StatusChanged => FromCamera::Status(Box::new(session.status())),
                SessionEvent::Recovering(recovery) => {
                    let stats = session.take_diagnostics();
                    link_log!(
                        "feed watchdog: {recovery:?} phase={:?} dropped_access_units={} stage={} ack={} max_gap={:.0}ms video={} au={} status={} cursors={:04x}/{:04x}/{:04x} last_video={:.1}s",
                        session.phase(),
                        session.dropped_access_units(),
                        session.recovery_stage(),
                        stats.acks,
                        stats.max_ack_gap * 1000.0,
                        stats.video_packets,
                        stats.access_units,
                        stats.status_packets,
                        stats.video_cursor,
                        stats.acked_data_cursor,
                        stats.extra_cursor,
                        stats.last_video_age
                    );
                    FromCamera::Recovering(recovery)
                }
                SessionEvent::Unreachable => {
                    link_log!("camera did not answer its UDP session handshake");
                    let reason = "the camera did not answer — is this machine on its Wi-Fi?";
                    match reconnect(
                        reason, remote, session_id, base_seq, commands, events, &mut log,
                    ) {
                        Some(fresh) => {
                            session = fresh;
                            if let Some(model_id) = model_id {
                                session.set_model(model_id);
                            }
                            saw_picture = false;
                            continue 'main;
                        }
                        None => return,
                    }
                }
                // Status replies are already folded into the status decoder; only the
                // media browser reads frames by hand.
                SessionEvent::Frame(frame) => {
                    if is_media_reply(&frame) {
                        FromCamera::Frame(frame)
                    } else {
                        continue;
                    }
                }
                SessionEvent::Set(outcome) => FromCamera::Set(outcome),
            };
            if events.send(message).is_err() {
                return;
            }
        }
    }
}

/// The link is gone: say so, then keep trying to open a fresh session every few
/// seconds until the camera answers or the window closes. None means stop.
fn reconnect(
    reason: &str,
    remote: Option<SocketAddr>,
    session_id: u16,
    base_seq: u16,
    commands: &Receiver<ToCamera>,
    events: &Sender<FromCamera>,
    log: &mut Option<std::fs::File>,
) -> Option<CameraSession> {
    if events
        .send(FromCamera::Lost(format!("{reason} — reconnecting")))
        .is_err()
    {
        return None;
    }
    let mut attempt = 0u32;
    loop {
        // Wait, but stay responsive to the window closing.
        for _ in 0..30 {
            loop {
                match commands.try_recv() {
                    Ok(ToCamera::Stop) | Err(TryRecvError::Disconnected) => return None,
                    Ok(_) => {}
                    Err(TryRecvError::Empty) => break,
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        attempt += 1;
        let opened = match remote {
            Some(address) => CameraSession::connect_to(address, session_id, base_seq),
            None => CameraSession::connect(session_id, base_seq),
        };
        match opened {
            Ok(session) => {
                if let Some(file) = log.as_mut() {
                    let _ = writeln!(file, "link: reconnect attempt {attempt}: session reopened");
                }
                return Some(session);
            }
            Err(error) => {
                if let Some(file) = log.as_mut() {
                    let _ = writeln!(file, "link: reconnect attempt {attempt} failed: {error}");
                }
            }
        }
    }
}

/// The replies the media browser drives on: catalogue chunks (`0x00/0x27`), delete
/// (`0x00/0x28`), favourite (`0x02/0xBF`) and the playback entry (`0x02/0x0C`).
fn is_media_reply(frame: &DumlFrame) -> bool {
    matches!(
        (frame.cmd_set, frame.cmd_id),
        (0x00, 0x27) | (0x00, 0x28) | (0x02, 0xBF) | (0x02, 0x0C)
    ) || is_tracking_reply(frame)
}

/// The `0x02/0xA5` poll answer the shell reads to keep or drop its tracking box, and
/// the `0x02/0x89` push that carries where the subject is while the body has it.
fn is_tracking_reply(frame: &DumlFrame) -> bool {
    matches!((frame.cmd_set, frame.cmd_id), (0x02, 0xA5) | (0x02, 0x89))
}
