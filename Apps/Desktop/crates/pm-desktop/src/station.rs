//! The camera on the operator's own Wi-Fi (`docs/desktop-expo-port.md` §1.D): putting it
//! there over Bluetooth, finding it on this PC's networks, and putting it back.
//!
//! Ported from `opc-monitor/src/station.rs`. The order of the exchange and the reading of
//! every reply are the camera crate's and the core's (`Provisioning`, `JoinPolicy`); this
//! is the Bluetooth plumbing around them and the LAN search. The network password goes to
//! the camera only: it is never logged and never stored (`SavedStation` has no field for
//! it). Every function here blocks; the Tauri commands call them off the main thread.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

use opc_camera::station::{
    join_decision, role_decision, setter_accepts, station_join, station_mode, station_video_mode,
    station_wifi_work_mode, JoinPolicy, Provisioning, StationInput, StationState, StationStep,
};
use opc_camera::{
    lan, pair_approval_ack, pair_set_pin, BleTransport, Command, DumlFrame, NotificationAssembler,
};
use pm_controller::homewifi::{
    self, allows_missing_role_query, networks_from_ip_addr, networks_from_ipconfig,
    ssid_from_netsh, wants_video_mode,
};
use pm_controller::link::log_line;
use pm_controller::platform::background_command;

fn log(message: impl std::fmt::Display) {
    log_line("station", message);
}

// ---- This machine's networks ------------------------------------------------

/// The IPv4 networks this machine sits on, address and mask.
pub fn local_networks() -> Vec<(Ipv4Addr, Ipv4Addr)> {
    if cfg!(target_os = "windows") {
        background_command("ipconfig")
            .output()
            .map(|output| networks_from_ipconfig(&String::from_utf8_lossy(&output.stdout)))
            .unwrap_or_default()
    } else {
        background_command("ip")
            .args(["-o", "-4", "addr"])
            .output()
            .map(|output| networks_from_ip_addr(&String::from_utf8_lossy(&output.stdout)))
            .unwrap_or_default()
    }
}

/// The Wi-Fi this machine is on, to offer as the network the camera should join (D-1).
pub fn current_ssid() -> Option<String> {
    if cfg!(target_os = "windows") {
        background_command("netsh")
            .args(["wlan", "show", "interfaces"])
            .output()
            .ok()
            .and_then(|output| ssid_from_netsh(&String::from_utf8_lossy(&output.stdout)))
    } else if cfg!(target_os = "macos") {
        None
    } else {
        background_command("iwgetid")
            .arg("-r")
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|ssid| !ssid.is_empty())
    }
}

// ---- The search (D-2) -------------------------------------------------------

const PROBE_TIMEOUT: Duration = Duration::from_millis(600);
const PROBE_PARALLEL: usize = 32;
const PROBE_MOST: usize = 8;
const VERIFY_TIMEOUT: Duration = Duration::from_secs(6);

/// What the operator is told when the search comes back empty.
pub const NOT_FOUND: &str = "The camera joined, but this PC could not find it on the network. \
    Check that both are on the same Wi-Fi and that the router does not isolate its clients, \
    then try again.";

/// Where the camera with this identity answers: its last address first, then every
/// host on this machine's networks that has the poke port open. A subnet larger than
/// /22 is refused by `lan::subnet_hosts`.
pub fn find_camera(identity: &[u8], last: Option<Ipv4Addr>) -> Option<SocketAddr> {
    if let Some(address) = last {
        let candidate = SocketAddr::from((address, lan::DATALINK_PORT));
        log(format_args!("trying the last address {candidate}"));
        if lan::identity_matches(candidate, identity, VERIFY_TIMEOUT) {
            return Some(candidate);
        }
    }
    let networks = local_networks();
    if networks.is_empty() {
        log("no IPv4 network to search");
    }
    for (address, mask) in networks {
        let Some(hosts) = lan::subnet_hosts(address, mask) else {
            log(format_args!(
                "{address}/{mask} is not a subnet the search walks"
            ));
            continue;
        };
        log(format_args!(
            "searching {} hosts around {address}",
            hosts.len()
        ));
        let hits = lan::probe_hosts(
            &hosts,
            lan::POKE_PORT,
            PROBE_TIMEOUT,
            PROBE_PARALLEL,
            PROBE_MOST,
        );
        for hit in hits {
            let candidate = SocketAddr::from((hit, lan::DATALINK_PORT));
            if lan::identity_matches(candidate, identity, VERIFY_TIMEOUT) {
                log(format_args!("camera found at {candidate}"));
                return Some(candidate);
            }
            log(format_args!(
                "{candidate} answers the poke but is not this camera"
            ));
        }
    }
    None
}

/// Finds the remembered station camera and remembers where it answered (D-3).
pub fn find_saved() -> Result<(SocketAddr, Option<i32>), String> {
    let saved = homewifi::load_station().ok_or("That camera is no longer remembered.")?;
    log("looking for the camera on the saved home network");
    match find_camera(&saved.identity, saved.address) {
        Some(address) => {
            let mut remembered = saved.clone();
            if let std::net::IpAddr::V4(v4) = address.ip() {
                remembered.address = Some(v4);
            }
            if let Err(error) = homewifi::save_station(&remembered) {
                log(format_args!("could not remember the address: {error}"));
            }
            Ok((address, saved.model_id))
        }
        None => Err(format!(
            "Couldn't find the camera on {}. Check it is on and on the same Wi-Fi as this PC.",
            saved.ssid
        )),
    }
}

// ---- Bluetooth --------------------------------------------------------------

/// What the provisioning tells the screen and asks of it.
pub trait Progress {
    fn step(&mut self, label: &str);
    fn awaiting_approval(&mut self);
    /// True when the operator has left the screen.
    fn cancelled(&mut self) -> bool;
}

pub(crate) struct Exchange<'a, T: BleTransport> {
    pub(crate) transport: &'a mut T,
    assembler: NotificationAssembler,
    seq: u16,
    last_keepalive: Instant,
}

impl<'a, T: BleTransport> Exchange<'a, T> {
    pub(crate) fn new(transport: &'a mut T) -> Self {
        Self {
            transport,
            assembler: NotificationAssembler::new(),
            seq: 0x8100,
            last_keepalive: Instant::now(),
        }
    }

    fn next_seq(&mut self) -> u16 {
        self.seq = self.seq.wrapping_add(1);
        self.seq
    }

    fn write(&mut self, frame: &[u8]) -> Result<(), String> {
        self.transport
            .write_frame(frame)
            .map_err(|error| format!("Bluetooth write failed: {error}"))
    }

    /// Every complete frame that has arrived.
    fn frames(&mut self) -> Vec<DumlFrame> {
        let mut frames = Vec::new();
        for raw in self.transport.take_notifications() {
            frames.extend(self.assembler.append(&raw));
        }
        frames
    }

    /// The camera drops a Bluetooth session it does not hear from.
    fn keepalive(&mut self) {
        if self.last_keepalive.elapsed() >= Duration::from_secs(1) {
            self.last_keepalive = Instant::now();
            let seq = self.next_seq();
            if let Ok(frame) = Command::SessionKeepalive.encode(seq) {
                let _ = self.transport.write_frame(&frame);
            }
        }
    }

    /// Sends `frame` and waits for the reply to `cmd_set/cmd_id`, answering approval
    /// requests on the way. None on timeout.
    fn exchange(
        &mut self,
        frame: &[u8],
        cmd_set: u8,
        cmd_id: u8,
        timeout: Duration,
        progress: &mut dyn Progress,
    ) -> Result<Option<DumlFrame>, String> {
        self.write(frame)?;
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if progress.cancelled() {
                return Err(CANCELLED.to_string());
            }
            for reply in self.frames() {
                if (reply.cmd_set, reply.cmd_id) == (0x07, 0x46) && reply.flags & 0x80 == 0 {
                    let ack = pair_approval_ack(reply.seq).map_err(|e| e.to_string())?;
                    self.write(&ack)?;
                    continue;
                }
                if (reply.cmd_set, reply.cmd_id) == (cmd_set, cmd_id) && reply.flags & 0x80 != 0 {
                    return Ok(Some(reply));
                }
            }
            self.keepalive();
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(None)
    }

    /// Wake, PIN, and the operator's approval on the body when the camera asks for it.
    fn open_session(&mut self, progress: &mut dyn Progress) -> Result<(), String> {
        progress.step("Opening the Bluetooth session…");
        let seq = self.next_seq();
        let wake = Command::SessionWake
            .encode(seq)
            .map_err(|e| e.to_string())?;
        self.write(&wake)?;
        let pin = pair_set_pin("0000", Some("osmo")).map_err(|e| e.to_string())?;
        self.write(&pin)?;
        let deadline = Instant::now() + Duration::from_secs(90);
        let mut asked_for_approval = false;
        while Instant::now() < deadline {
            if progress.cancelled() {
                return Err(CANCELLED.to_string());
            }
            for reply in self.frames() {
                match (reply.cmd_set, reply.cmd_id) {
                    (0x07, 0x45) => match reply.payload.get(1) {
                        Some(0x01) => return Ok(()),
                        Some(0x02) => {
                            if !asked_for_approval {
                                asked_for_approval = true;
                                progress.awaiting_approval();
                            }
                        }
                        _ => return Err("The camera refused the pairing request.".to_string()),
                    },
                    (0x07, 0x46) => {
                        let ack = pair_approval_ack(reply.seq).map_err(|e| e.to_string())?;
                        self.write(&ack)?;
                        return Ok(());
                    }
                    _ => {}
                }
            }
            self.keepalive();
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("Pairing timed out. Hold the camera closer and try again.".to_string())
    }
}

/// What a cancelled exchange returns; the screen says nothing about it.
pub const CANCELLED: &str = "cancelled";

/// The identity the camera reported and whether it confirmed the join. `Ok((_, false))`
/// means the join went unanswered and the LAN search has to say.
pub fn provision<T: BleTransport>(
    transport: &mut T,
    address: &str,
    ssid: &str,
    password: &str,
    model_id: Option<i32>,
    progress: &mut dyn Progress,
) -> Result<(Vec<u8>, bool), String> {
    transport
        .connect(address)
        .map_err(|error| format!("Connect failed: {error}"))?;
    let result = provision_connected(transport, ssid, password, model_id, progress);
    let _ = transport.disconnect();
    result
}

fn provision_connected<T: BleTransport>(
    transport: &mut T,
    ssid: &str,
    password: &str,
    model_id: Option<i32>,
    progress: &mut dyn Progress,
) -> Result<(Vec<u8>, bool), String> {
    let mut link = Exchange::new(transport);
    link.open_session(progress)?;
    let policy = JoinPolicy::from_core();
    let mut machine = Provisioning::new(
        policy,
        wants_video_mode(model_id),
        allows_missing_role_query(model_id),
    );
    let started = Instant::now();
    let mut shown = "";
    loop {
        if progress.cancelled() {
            return Err(CANCELLED.to_string());
        }
        match machine.state() {
            StationState::Done {
                identity,
                confirmed,
            } => {
                log(format_args!("provisioned confirmed={confirmed}"));
                return Ok((identity.clone(), *confirmed));
            }
            StationState::Failed(message) => {
                log(format_args!("provisioning failed: {message}"));
                return Err(message.clone());
            }
            StationState::Working(label) => {
                if *label != shown {
                    shown = label;
                    progress.step(label);
                }
            }
        }
        let now = started.elapsed().as_secs_f64();
        let Some(step) = machine.next(now) else {
            link.keepalive();
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        let timeout = Duration::from_secs_f64(machine.reply_timeout(&step));
        let seq = link.next_seq();
        // The step's name only: `Join` carries no credentials in its Debug form.
        log(format_args!("step {step:?}"));
        let input = match &step {
            StationStep::Identity => {
                let frame = Command::GetWifiSsid
                    .encode(seq)
                    .map_err(|e| e.to_string())?;
                match link.exchange(&frame, 0x07, 0x07, timeout, progress)? {
                    Some(reply) => StationInput::Identity(reply.payload),
                    None => StationInput::Timeout,
                }
            }
            StationStep::VideoMode => {
                let frame = station_video_mode(seq).map_err(|e| e.to_string())?;
                link.write(&frame)?;
                StationInput::VideoModeSent
            }
            StationStep::QueryRole => {
                let frame = station_wifi_work_mode(seq).map_err(|e| e.to_string())?;
                match link.exchange(&frame, 0x07, 0x39, timeout, progress)? {
                    Some(reply) => StationInput::Role(role_decision(
                        &reply.payload,
                        machine.allow_missing_query(),
                    )),
                    None => StationInput::Timeout,
                }
            }
            StationStep::SetStation => {
                let frame = station_mode(true, seq).map_err(|e| e.to_string())?;
                match link.exchange(&frame, 0x07, 0x48, timeout, progress)? {
                    Some(reply) => StationInput::SetterAccepted(setter_accepts(
                        &reply.payload,
                        machine.missing_query(),
                    )),
                    None => StationInput::Timeout,
                }
            }
            StationStep::VerifyRole => {
                let frame = station_wifi_work_mode(seq).map_err(|e| e.to_string())?;
                match link.exchange(&frame, 0x07, 0x39, timeout, progress)? {
                    Some(reply) => StationInput::RoleReadback(match reply.payload.as_slice() {
                        [0, 1] => Some(true),
                        [0, 0] => Some(false),
                        _ => None,
                    }),
                    None => StationInput::Timeout,
                }
            }
            StationStep::Join { attempt } => {
                let frame = station_join(ssid, password, seq).map_err(|_| {
                    "The network name or password is not something the camera can take.".to_string()
                })?;
                match link.exchange(&frame, 0x07, 0x47, timeout, progress)? {
                    Some(reply) => {
                        // Only the fixed-size result is logged, never the request.
                        let shape: Vec<String> = reply
                            .payload
                            .iter()
                            .take(4)
                            .map(|b| format!("{b:02x}"))
                            .collect();
                        log(format_args!(
                            "join attempt {attempt} result {}",
                            shape.join(" ")
                        ));
                        StationInput::Join(join_decision(&reply.payload, *attempt))
                    }
                    None => StationInput::Timeout,
                }
            }
        };
        let now = started.elapsed().as_secs_f64();
        machine.receive(now, &step, input);
    }
}

/// Puts the camera back on its own access point (D-4) and forgets the saved station.
pub fn reset<T: BleTransport>(
    transport: &mut T,
    address: &str,
    progress: &mut dyn Progress,
) -> Result<(), String> {
    transport
        .connect(address)
        .map_err(|error| format!("Connect failed: {error}"))?;
    let result = (|| {
        let mut link = Exchange::new(transport);
        link.open_session(progress)?;
        progress.step("Returning the camera to its own Wi-Fi…");
        let seq = link.next_seq();
        let frame = station_mode(false, seq).map_err(|e| e.to_string())?;
        match link.exchange(&frame, 0x07, 0x48, Duration::from_secs(12), progress)? {
            Some(reply) if setter_accepts(&reply.payload, true) => Ok(()),
            Some(_) => Err("The camera did not accept going back to its own Wi-Fi.".to_string()),
            None => Err("The camera did not answer. Bring it closer and try again.".to_string()),
        }
    })();
    let _ = transport.disconnect();
    if result.is_ok() {
        homewifi::forget(&homewifi::station_path());
        log("camera back on its own Wi-Fi; the home network is forgotten");
    }
    result
}
