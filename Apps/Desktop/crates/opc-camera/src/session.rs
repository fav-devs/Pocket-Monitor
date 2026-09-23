//! The UDP datalink.
//!
//! Owns the socket and the clock; borrows every decision. [`Sequencer`] says what is
//! due, [`AckPump`] says what an acknowledgement carries, and the core says what the
//! bytes are. The one thing this file decides on its own is the sequence bookkeeping,
//! which is transcribed from the iOS driver: the DUML frame sequence advances by one per
//! command, the transport sequence by eight, and the command counter by one.

use std::io::{self, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::time::{Duration, Instant};

use crate::command;
use crate::command::CommandContext;
use crate::depacketizer::Depacketizer;
use crate::health::FeedHealth;
use crate::mailbox::SetOutcome;
use crate::packed::DumlFrame;
use crate::sequence::{Outgoing, Phase, Sequencer};
use crate::status::{Status, StatusDecoder};
use crate::transport::{self, AckPump, PktType};
use crate::watchdog::{Recovery, Watchdog};
use crate::{softap, CameraError, Command};

const READ_BUFFER: usize = 4096;
/// Bound a busy status/video burst so continuous inbound traffic cannot starve the
/// 40 Hz pktType-0x04 window ACK.
const MAX_DATAGRAMS_PER_POLL: usize = 8;
/// The camera ignores `0x09/0xa8` when it follows subscriptions in the same burst.
const SUBSCRIBE_SETTLE: f64 = 0.150;
/// Match the portable first-picture policy: give a reported Pocket 3 format a moment
/// to settle before restoring it, then ask for live view on the same UDP flow.
const FIRST_PICTURE_FORMAT_SETTLE: f64 = 0.8;
const FIRST_PICTURE_POKE_AFTER: f64 = 2.0;
const FIRST_PICTURE_UNKNOWN_FORMAT_GRACE: f64 = 8.0;
/// Telemetry can continue after an app session expires, but the camera stops its
/// encoder. The mobile shells refresh app presence once a second.
const APP_PRESENCE_INTERVAL: f64 = 1.0;
const TCP_POKE_PORT: u16 = 7001;
const TCP_POKE_TIMEOUT: Duration = Duration::from_secs(2);

/// What happened while polling.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    /// The camera answered the session open.
    Opened,
    /// A complete HEVC access unit.
    Picture(Vec<u8>),
    /// The first raw video datagram reached this UDP session. This is deliberately
    /// distinct from `Picture`: a depacketizer may correctly wait for additional
    /// fragments before it can emit a decodable access unit.
    VideoStarted,
    /// Pocket 3 needed a temporary format change to start its first live encoder.
    FirstPictureFormatPoke { original: (u8, u8), kick: (u8, u8) },
    /// A command reply or a piece of telemetry.
    Frame(DumlFrame),
    /// What became of a live-control SET.
    Set(SetOutcome),
    /// The camera said something the HUD shows.
    StatusChanged,
    /// The camera never answered the handshake.
    Unreachable,
    /// The feed stalled and the watchdog acted. `RebuildDecoder` and `FullRejoin` are
    /// the shell's to carry out; the other two are handled here.
    Recovering(Recovery),
}

/// One-second transport facts for an operator log. They deliberately contain cursors
/// and rates, never camera credentials or payload bytes.
#[derive(Debug, Clone, Copy)]
pub struct SessionDiagnostics {
    pub acks: u32,
    pub max_ack_gap: f64,
    pub video_packets: u32,
    pub access_units: u32,
    pub status_packets: u32,
    pub video_cursor: u16,
    pub acked_data_cursor: u16,
    pub extra_cursor: u16,
    pub last_video_age: f64,
}

#[derive(Debug)]
pub enum SessionError {
    Io(io::Error),
    Camera(CameraError),
    /// The local port chosen is one the datalink must not bind.
    ForbiddenLocalPort(u16),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Camera(error) => write!(f, "{error}"),
            Self::ForbiddenLocalPort(port) => write!(
                f,
                "local port {port} must not be bound — the camera's own port accepts \
                 telemetry and drops every video packet"
            ),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<io::Error> for SessionError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<CameraError> for SessionError {
    fn from(error: CameraError) -> Self {
        Self::Camera(error)
    }
}

/// One camera datalink.
#[derive(Debug)]
pub struct CameraSession {
    socket: UdpSocket,
    /// Pocket cameras arm UDP live view after this TCP `SetPairingPIN("osmo")` write.
    /// It stays open across UDP rebuilds; closing it makes the camera RST the live flow.
    _tcp_poke: Option<TcpStream>,
    tcp_poke_status: String,
    remote: SocketAddr,
    session_id: u16,
    base_seq: u16,
    /// The DUML frame sequence. One per command.
    duml_seq: u16,
    /// The transport sequence. Eight per command.
    udp_seq: u16,
    command_counter: u8,
    sequencer: Sequencer,
    pump: AckPump,
    depacketizer: Depacketizer,
    health: FeedHealth,
    watchdog: Watchdog,
    /// A pending enable after the subscription writes have reached the camera.
    enable_not_before: Option<f64>,
    status: StatusDecoder,
    model_id: Option<i32>,
    /// A Pocket 3 format poke is one shot per connection, never while recording.
    first_picture_format_poked: bool,
    format_restore: Option<((u8, u8), f64)>,
    format_enable_at: Option<f64>,
    last_live_enable: Option<f64>,
    last_app_presence: Option<f64>,
    last_ack_at: Option<f64>,
    diagnostic_acks: u32,
    diagnostic_max_ack_gap: f64,
    diagnostic_video_packets: u32,
    diagnostic_access_units: u32,
    diagnostic_status_packets: u32,
    started: Instant,
    buffer: Vec<u8>,
}

impl CameraSession {
    /// Opens a datalink to the camera at its usual address.
    ///
    /// `session_id` and `base_seq` should be fresh per connect; a fixed base sequence
    /// can wedge the camera.
    pub fn connect(session_id: u16, base_seq: u16) -> Result<Self, SessionError> {
        let host: Ipv4Addr = softap::host()
            .parse()
            .unwrap_or(Ipv4Addr::new(192, 168, 2, 1));
        let remote = SocketAddr::new(IpAddr::V4(host), softap::remote_port());
        Self::connect_to(remote, session_id, base_seq)
    }

    /// Opens a datalink to an explicit address. The tests point this at a fake camera.
    pub fn connect_to(
        remote: SocketAddr,
        session_id: u16,
        base_seq: u16,
    ) -> Result<Self, SessionError> {
        let (tcp_poke, tcp_poke_status) = Self::open_tcp_poke(remote);
        let socket = Self::open_socket(remote)?;

        let started = Instant::now();
        Ok(Self {
            socket,
            _tcp_poke: tcp_poke,
            tcp_poke_status,
            remote,
            session_id,
            base_seq,
            duml_seq: 0,
            udp_seq: base_seq,
            command_counter: 0,
            sequencer: new_sequencer(0.0),
            pump: AckPump::new(base_seq),
            depacketizer: Depacketizer::new(),
            health: FeedHealth::new(),
            watchdog: Watchdog::new(),
            enable_not_before: None,
            status: StatusDecoder::new(None),
            model_id: None,
            first_picture_format_poked: false,
            format_restore: None,
            format_enable_at: None,
            last_live_enable: None,
            last_app_presence: None,
            last_ack_at: None,
            diagnostic_acks: 0,
            diagnostic_max_ack_gap: 0.0,
            diagnostic_video_packets: 0,
            diagnostic_access_units: 0,
            diagnostic_status_packets: 0,
            started,
            buffer: vec![0; READ_BUFFER],
        })
    }

    /// The Pocket's TCP 7001 control channel is a setup poke, not a video transport.
    /// Keep a successful connection for the entire session, but retain UDP-only fallback
    /// for models and test peers which do not expose that port.
    fn open_tcp_poke(remote: SocketAddr) -> (Option<TcpStream>, String) {
        let SocketAddr::V4(address) = remote else {
            return (None, "skipped (non-IPv4 peer)".to_string());
        };
        if *address.ip() != Ipv4Addr::new(192, 168, 2, 1) || address.port() != 9004 {
            return (None, "skipped (non-standard camera peer)".to_string());
        }
        let target = SocketAddr::new(IpAddr::V4(*address.ip()), TCP_POKE_PORT);
        let mut stream = match TcpStream::connect_timeout(&target, TCP_POKE_TIMEOUT) {
            Ok(stream) => stream,
            Err(error) => return (None, format!("failed to connect: {error}")),
        };
        let frame = match transport::pair_set_pin("osmo", None) {
            Ok(frame) => frame,
            Err(error) => return (None, format!("could not encode SetPairingPIN: {error}")),
        };
        if let Err(error) = stream.write_all(&frame).and_then(|_| stream.flush()) {
            return (None, format!("could not write SetPairingPIN: {error}"));
        }
        let _ = stream.set_nodelay(true);
        (Some(stream), "ready (SetPairingPIN osmo sent)".to_string())
    }

    /// Opens the camera flow on a new ephemeral client port. The camera's :9004 is
    /// remote-only; keeping a wedged Windows socket through recovery leaves video on
    /// the old five-tuple even while telemetry appears healthy.
    fn open_socket(remote: SocketAddr) -> Result<UdpSocket, SessionError> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
        let local = socket.local_addr()?.port();
        if !softap::may_bind_local_port(0) {
            return Err(SessionError::ForbiddenLocalPort(local));
        }
        // Do not use a short synchronous receive timeout here. Windows rounds those
        // to its scheduler quantum, which made a nominal 40 Hz ACK pump reach the
        // Pocket at only 31 Hz. `poll` drains what is ready and immediately gives the
        // sequencer another clock tick; the desktop worker yields when idle.
        socket.set_nonblocking(true)?;
        socket.connect(remote)?;
        Ok(socket)
    }

    /// Recreates the local half of the UDP flow while Wi-Fi remains associated.
    fn reopen_datalink(&mut self, now: f64) -> Result<(), SessionError> {
        self.socket = Self::open_socket(self.remote)?;
        self.duml_seq = 0;
        self.udp_seq = self.base_seq;
        self.command_counter = 0;
        self.sequencer = new_sequencer(now);
        self.pump = AckPump::new(self.base_seq);
        self.depacketizer.reset();
        self.enable_not_before = None;
        self.last_app_presence = None;
        self.health.note_datalink_rebuilt(now);
        Ok(())
    }

    /// The port this datalink is actually sending from.
    pub fn local_port(&self) -> u16 {
        self.socket
            .local_addr()
            .map(|address| address.port())
            .unwrap_or(0)
    }

    pub fn remote(&self) -> SocketAddr {
        self.remote
    }

    pub fn tcp_poke_status(&self) -> &str {
        &self.tcp_poke_status
    }

    pub fn phase(&self) -> Phase {
        self.sequencer.phase()
    }

    /// How many access units were abandoned incomplete.
    pub fn dropped_access_units(&self) -> i32 {
        self.depacketizer.dropped()
    }

    /// What the camera last said about itself.
    pub fn status(&self) -> Status {
        self.status.status()
    }

    /// Tells the status decoder which body this is, so it reads the model-specific
    /// encodings — colour modes differ between a Pocket 4, a Pocket 3 and a Nano.
    pub fn set_model(&mut self, model_id: i32) {
        self.model_id = Some(model_id);
        self.status = StatusDecoder::new(Some(model_id));
    }

    /// Which rung of the recover ladder the watchdog is resting on.
    pub fn recovery_stage(&self) -> String {
        self.watchdog.stage()
    }

    /// Returns and resets the last reporting interval's transport facts.
    pub fn take_diagnostics(&mut self) -> SessionDiagnostics {
        let now = self.now();
        let windows = self.pump.windows();
        let snapshot = self
            .health
            .snapshot(now, matches!(self.phase(), Phase::Waiting | Phase::Live));
        let diagnostics = SessionDiagnostics {
            acks: self.diagnostic_acks,
            max_ack_gap: self.diagnostic_max_ack_gap,
            video_packets: self.diagnostic_video_packets,
            access_units: self.diagnostic_access_units,
            status_packets: self.diagnostic_status_packets,
            video_cursor: windows.video,
            acked_data_cursor: windows.acked_data,
            extra_cursor: windows.extra,
            last_video_age: snapshot.last_video_packet_age,
        };
        self.diagnostic_acks = 0;
        self.diagnostic_max_ack_gap = 0.0;
        self.diagnostic_video_packets = 0;
        self.diagnostic_access_units = 0;
        self.diagnostic_status_packets = 0;
        diagnostics
    }

    /// Tells the session whether the machine is still on the camera's network. A socket
    /// that is off-path looks exactly like a camera that stopped answering.
    pub fn set_path_ready(&mut self, ready: bool) {
        self.health.set_path_ready(ready);
    }

    /// The operator is somewhere a repair would tear down (the library, a playback).
    /// The watchdog holds its ladder until they are back on the live picture.
    pub fn set_repair_blocked(&mut self, blocked: bool) {
        self.health.set_repair_blocked(blocked);
    }

    /// The shell reports whether its decoder is wedged; the watchdog escalates on it.
    pub fn set_decoder_failed(&mut self, failed: bool) {
        self.health.set_decoder_failed(failed);
    }

    /// A picture actually reached the screen, which is not the same as one arriving.
    pub fn note_presented(&mut self) {
        let now = self.now();
        self.health.note_decoded_frame(now);
    }

    /// Queues an operator command for the next tick. Live-control SETs go through the
    /// mailbox: latest wins per opcode, one on the wire at a time, retransmitted once
    /// and settled the way the phones do it.
    pub fn send(&mut self, command: Command) {
        match command
            .opcode_key()
            .filter(|key| command::is_live_control(*key))
        {
            Some(key) => {
                let now = self.now();
                self.sequencer
                    .fire_set(key, command, !command.is_slider(), now);
            }
            None => self.sequencer.enqueue(command),
        }
    }

    /// Monotonic seconds since the datalink opened.
    fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    /// Reads what has arrived, then sends what is due.
    ///
    /// Call this in a loop. It blocks for at most the read timeout, so a caller that
    /// does nothing else still keeps the pump on cadence.
    pub fn poll(&mut self) -> Result<Vec<SessionEvent>, SessionError> {
        let mut events = Vec::new();
        self.drain(&mut events)?;

        let now = self.now();
        for outcome in self.sequencer.take_set_outcomes() {
            events.push(SessionEvent::Set(outcome));
        }
        for due in self.sequencer.tick(now) {
            if due == Outgoing::EnableLiveView && self.enable_not_before.is_some_and(|at| now < at)
            {
                continue;
            }
            self.dispatch(due)?;
        }
        if self.enable_not_before.is_some_and(|at| now >= at) {
            self.enable_not_before = None;
            self.dispatch(Outgoing::EnableLiveView)?;
        }
        self.drive_app_presence_keepalive(now)?;
        if self.sequencer.phase() == Phase::Unreachable {
            events.push(SessionEvent::Unreachable);
        }
        self.recover(now, &mut events)?;
        Ok(events)
    }

    /// Asks the watchdog whether the feed has stalled, and acts on its answer.
    fn recover(&mut self, now: f64, events: &mut Vec<SessionEvent>) -> Result<(), SessionError> {
        if self.drive_first_picture_format_poke(now, events)? {
            return Ok(());
        }
        let live = matches!(self.sequencer.phase(), Phase::Waiting | Phase::Live);
        let snapshot = self.health.snapshot(now, live);
        let Some(action) = self.watchdog.tick(&snapshot) else {
            return Ok(());
        };

        match action {
            Recovery::ResendEnable => {
                // Deliberately not through the sequencer: that one enables once per
                // session by design, and repeats belong here.
                // Pocket 3 can keep status pushes alive after its DM368 live lease
                // has expired. Reassert the registration that owns that lease before
                // the watchdog's sole repeat enable. This is recovery-only; the
                // ordinary live path still registers and enables exactly once.
                self.refresh_live_registration(now)?;
                self.send_direct(Command::LiveViewEnable)?;
                self.health.note_enable(now);
                self.last_live_enable = Some(now);
            }
            Recovery::ReopenDatalink | Recovery::FullRejoin => {
                // The desktop shell already owns a live SoftAP connection. Until its
                // BLE reconnect runner exists, a full rejoin must at least reopen UDP
                // instead of leaving the last frame frozen forever.
                self.reopen_datalink(now)?;
            }
            // A wedged decoder is the shell's to carry out.
            Recovery::RebuildDecoder => {}
        }
        events.push(SessionEvent::Recovering(action));
        Ok(())
    }

    /// Match iOS and Android's `keepalive`: a window ACK holds the send window,
    /// while app presence holds the camera's live-encoder lease.
    fn drive_app_presence_keepalive(&mut self, now: f64) -> Result<(), SessionError> {
        if !matches!(self.sequencer.phase(), Phase::Waiting | Phase::Live)
            || self
                .last_app_presence
                .is_some_and(|sent| now - sent < APP_PRESENCE_INTERVAL)
        {
            return Ok(());
        }
        self.send_direct(Command::AppPresence)?;
        self.send_ack()?;
        self.last_app_presence = Some(now);
        Ok(())
    }

    /// The smallest safe live-session refresh: device identity plus app presence,
    /// each followed by its own window ACK just as in the phone registration spine.
    /// Gimbal initialisation is intentionally not repeated while an operator may be
    /// moving it.
    fn refresh_live_registration(&mut self, now: f64) -> Result<(), SessionError> {
        self.send_direct(Command::AppDeviceInfo)?;
        self.send_ack()?;
        self.send_direct(Command::AppPresence)?;
        self.send_ack()?;
        self.last_app_presence = Some(now);
        Ok(())
    }

    /// Pocket 3 can expose a healthy HUD and still leave its first live encoder idle.
    /// The mobile shells restart it once by changing to another legal resolution and
    /// back. Keep this bounded and never alter a recording.
    fn drive_first_picture_format_poke(
        &mut self,
        now: f64,
        events: &mut Vec<SessionEvent>,
    ) -> Result<bool, SessionError> {
        if self.model_id != Some(0x20)
            || self.health.saw_picture()
            || self.status.status().is_recording
        {
            return Ok(false);
        }
        if let Some((original, at)) = self.format_restore {
            if now < at {
                return Ok(true);
            }
            self.send_direct(Command::SetVideoFormat {
                resolution: original.0,
                frame_rate: original.1,
            })?;
            self.format_restore = None;
            self.format_enable_at = Some(now + FIRST_PICTURE_FORMAT_SETTLE);
            return Ok(true);
        }
        if let Some(at) = self.format_enable_at {
            if now < at {
                return Ok(true);
            }
            self.format_enable_at = None;
            self.send_direct(Command::LiveViewEnable)?;
            self.health.note_enable(now);
            self.last_live_enable = Some(now);
            return Ok(false);
        }
        if self.first_picture_format_poked {
            return Ok(false);
        }
        let Some(enabled_at) = self.last_live_enable else {
            return Ok(false);
        };
        let since_enable = now - enabled_at;
        let status = self.status.status();
        let known = status.video_resolution.is_some()
            || status.video_frame_rate.is_some()
            || !status.available_formats.is_empty();
        if since_enable < FIRST_PICTURE_POKE_AFTER
            || (!known && since_enable < FIRST_PICTURE_UNKNOWN_FORMAT_GRACE)
        {
            return Ok(false);
        }
        let original = (
            status.video_resolution.unwrap_or(0x10),
            status.video_frame_rate.unwrap_or(0x03),
        );
        let kick = status
            .available_formats
            .iter()
            .copied()
            .find(|format| format.1 == original.1 && format.0 != original.0)
            .or_else(|| {
                status
                    .available_formats
                    .iter()
                    .copied()
                    .find(|format| format.0 != original.0)
            })
            .unwrap_or((if original.0 == 0x10 { 0x0A } else { 0x10 }, original.1));
        self.send_direct(Command::SetVideoFormat {
            resolution: kick.0,
            frame_rate: kick.1,
        })?;
        self.first_picture_format_poked = true;
        self.format_restore = Some((original, now + FIRST_PICTURE_FORMAT_SETTLE));
        events.push(SessionEvent::FirstPictureFormatPoke { original, kick });
        Ok(true)
    }

    fn send_direct(&mut self, command: Command) -> Result<(), SessionError> {
        let datagram = self.command_datagram(command)?;
        self.socket.send(&datagram)?;
        Ok(())
    }

    fn drain(&mut self, events: &mut Vec<SessionEvent>) -> Result<(), SessionError> {
        for _ in 0..MAX_DATAGRAMS_PER_POLL {
            let mut scratch = std::mem::take(&mut self.buffer);
            let read = self.socket.recv(&mut scratch);
            let outcome = match read {
                Ok(count) => {
                    let datagram = scratch[..count].to_vec();
                    self.buffer = scratch;
                    Some(datagram)
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    self.buffer = scratch;
                    None
                }
                // Windows can report WSA_IO_PENDING (997) or WSAEINVAL (10022) from a
                // timed synchronous UDP receive while the camera changes its stream.
                // Neither invalidates the socket; treat both as an empty poll so the
                // watchdog can reopen the datalink if needed.
                Err(error) if matches!(error.raw_os_error(), Some(997 | 10022)) => {
                    self.buffer = scratch;
                    None
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                    self.buffer = scratch;
                    continue;
                }
                Err(error) => {
                    self.buffer = scratch;
                    return Err(error.into());
                }
            };
            let Some(datagram) = outcome else {
                return Ok(());
            };
            self.receive(&datagram, events)?;
        }
        Ok(())
    }

    fn receive(
        &mut self,
        datagram: &[u8],
        events: &mut Vec<SessionEvent>,
    ) -> Result<(), SessionError> {
        // Every datagram feeds the cursors, whatever else it means.
        self.pump.observe(datagram);

        let now = self.now();
        if transport::is_handshake(datagram) {
            let opening = self.sequencer.phase() == Phase::Handshaking;
            self.sequencer.note_handshake_reply(now);
            if opening {
                // Match the phone spine: establish app presence and gimbal state before
                // subscribing. Some bodies acknowledge telemetry without opening video
                // until this registration burst has arrived.
                self.send_registration()?;
                // Ask for the pushes the HUD needs before anything else is queued: the
                // camera only sends its available-value lists to a subscriber.
                self.send_subscriptions()?;
                // The phones read the focus-track mode, the audio channel and vocal
                // boost on connect; none of them has a push.
                self.send_direct(Command::FocusTrackGet)?;
                self.send_direct(Command::ParamGet(0x0020))?;
                self.send_direct(Command::ParamGet(0x004C))?;
                self.enable_not_before = Some(now + SUBSCRIBE_SETTLE);
                events.push(SessionEvent::Opened);
            }
            return Ok(());
        }

        match PktType::of(datagram) {
            Some(PktType::Video) => {
                self.diagnostic_video_packets = self.diagnostic_video_packets.saturating_add(1);
                self.sequencer.note_picture();
                let first_video_packet = !self.health.saw_picture();
                self.health.note_video_packet(now);
                if first_video_packet {
                    events.push(SessionEvent::VideoStarted);
                }
                // The whole datagram, header included: the core reads the packet type at
                // byte 6 and the fragment index at bytes 16 to 18, and the encoded body
                // only starts at byte 20.
                if let Some(unit) = self.depacketizer.feed(datagram) {
                    self.diagnostic_access_units = self.diagnostic_access_units.saturating_add(1);
                    self.health.note_access_unit(now);
                    events.push(SessionEvent::Picture(unit));
                }
            }
            Some(PktType::Telemetry | PktType::AckedData | PktType::Command) => {
                self.diagnostic_status_packets = self.diagnostic_status_packets.saturating_add(1);
                self.health.note_status(now);
                let mut changed = false;
                for frame in transport::scan_frames(datagram)? {
                    // `0x00/0x99` carries a subscription push — timecode and the lists
                    // of values this body actually offers — and is read differently.
                    changed |= if (frame.cmd_set, frame.cmd_id) == (0x00, 0x99) {
                        self.status.apply_push(&frame.payload)
                    } else {
                        self.status.apply(&frame)
                    };
                    if let Some(key) = command::opcode_key(frame.cmd_set, frame.cmd_id) {
                        self.sequencer.reply(key, frame.seq, now);
                    }
                    events.push(SessionEvent::Frame(frame));
                }
                for outcome in self.sequencer.take_set_outcomes() {
                    events.push(SessionEvent::Set(outcome));
                }
                if changed {
                    events.push(SessionEvent::StatusChanged);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Subscribes to the status streams the HUD reads.
    fn send_registration(&mut self) -> Result<(), SessionError> {
        // Mobile's observed spine is device info, app presence, gimbal init, each
        // immediately window-ACKed. Pocket 3 otherwise gives HUD telemetry but can
        // withhold pktType-0x02 forever.
        for command in [
            Command::AppDeviceInfo,
            Command::AppPresence,
            Command::GimbalInit,
        ] {
            let datagram = self.command_datagram(command)?;
            self.socket.send(&datagram)?;
            self.send_ack()?;
        }
        self.last_app_presence = Some(self.now());
        Ok(())
    }

    /// Subscribes to the status streams the HUD reads.
    fn send_subscriptions(&mut self) -> Result<(), SessionError> {
        for (index, key) in subscribe_keys().into_iter().enumerate() {
            let payload = transport::subscribe(&key, index as u32 + 1, self.duml_seq)?;
            self.duml_seq = self.duml_seq.wrapping_add(1);
            self.command_counter = self.command_counter.wrapping_add(1);

            let routing = transport::routing_header(self.udp_seq, self.command_counter, false)?;
            let mut datagram = transport::transport_header(
                PktType::Command,
                routing.len() + payload.len(),
                self.session_id,
                self.udp_seq,
            )?;
            self.udp_seq = self.udp_seq.wrapping_add(8);
            datagram.extend_from_slice(&routing);
            datagram.extend_from_slice(&payload);
            self.socket.send(&datagram)?;
        }
        self.send_ack()?;
        Ok(())
    }

    /// Registration is a short burst; each write gets an immediate window ACK, matching
    /// the phone driver, before the regular 40 Hz pump takes over.
    fn send_ack(&mut self) -> Result<(), SessionError> {
        self.note_ack_sent(self.now());
        let datagram = self.pump.datagram(self.session_id)?;
        self.socket.send(&datagram)?;
        Ok(())
    }

    fn note_ack_sent(&mut self, now: f64) {
        if let Some(previous) = self.last_ack_at {
            self.diagnostic_max_ack_gap = self.diagnostic_max_ack_gap.max(now - previous);
        }
        self.last_ack_at = Some(now);
        self.diagnostic_acks = self.diagnostic_acks.saturating_add(1);
    }

    fn dispatch(&mut self, due: Outgoing) -> Result<(), SessionError> {
        let datagram = match due {
            Outgoing::Handshake => {
                transport::handshake(self.session_id, self.udp_seq, self.base_seq)?
            }
            Outgoing::Ack => {
                self.note_ack_sent(self.now());
                self.pump.datagram(self.session_id)?
            }
            Outgoing::EnableLiveView => {
                let now = self.now();
                self.health.note_enable(now);
                self.last_live_enable = Some(now);
                self.command_datagram(Command::LiveViewEnable)?
            }
            Outgoing::Command(command) => {
                let now = self.now();
                match command {
                    Command::ZoomFactor(_) | Command::ZoomLens(_) | Command::ZoomSlew(_) => {
                        self.health.note_zoom(now);
                    }
                    Command::FocusTrackSet(_) => self.health.note_focus_track(now),
                    Command::GimbalStick { .. } => self.health.note_gimbal_throw(now),
                    _ => self.health.note_camera_set(now),
                }
                let seq = self.duml_seq;
                let datagram = self.command_datagram(command)?;
                if let Some(key) = command
                    .opcode_key()
                    .filter(|key| command::is_live_control(*key))
                {
                    self.sequencer.note_transmitted(key, seq);
                }
                datagram
            }
        };
        self.socket.send(&datagram)?;
        Ok(())
    }

    /// Wraps a command in its routing and transport headers, advancing all three
    /// counters the way the iOS driver does.
    fn command_datagram(&mut self, command: Command) -> Result<Vec<u8>, SessionError> {
        let context = CommandContext {
            model_id: self.model_id.unwrap_or(-1),
            shooting_mode: self.status.status().shooting_mode.unwrap_or(-1),
        };
        let frame = command.encode_in(self.duml_seq, context)?;
        self.duml_seq = self.duml_seq.wrapping_add(1);
        self.command_counter = self.command_counter.wrapping_add(1);

        let routing = transport::routing_header(self.udp_seq, self.command_counter, false)?;
        let mut datagram = transport::transport_header(
            PktType::Command,
            routing.len() + frame.len(),
            self.session_id,
            self.udp_seq,
        )?;
        self.udp_seq = self.udp_seq.wrapping_add(8);

        datagram.extend_from_slice(&routing);
        datagram.extend_from_slice(&frame);
        Ok(datagram)
    }
}

/// The subscription names the core says the HUD needs.
fn subscribe_keys() -> Vec<String> {
    // Safety: probing with a null destination only reports the size.
    let needed = unsafe { opc_core_sys::opc_status_subscribe_keys(std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Vec::new();
    }
    let mut bytes = vec![0u8; needed as usize];
    // Safety: `bytes` has exactly the capacity the core asked for.
    let written =
        unsafe { opc_core_sys::opc_status_subscribe_keys(bytes.as_mut_ptr(), bytes.len()) };
    if written != needed {
        return Vec::new();
    }
    String::from_utf8_lossy(&bytes)
        .split('\n')
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .collect()
}

/// The sequencer with the core's mailbox behind it when the core is linked, and the
/// plain queue when it is not.
#[cfg(opc_core_linked)]
fn new_sequencer(now: f64) -> Sequencer {
    match crate::mailbox::CoreMailbox::new() {
        Some(mailbox) => Sequencer::with_policy(now, Box::new(mailbox)),
        None => Sequencer::new(now),
    }
}

#[cfg(not(opc_core_linked))]
fn new_sequencer(now: f64) -> Sequencer {
    Sequencer::new(now)
}
