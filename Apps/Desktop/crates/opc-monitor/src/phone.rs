//! The viewfinder on a phone's shared feed.
//!
//! An iPhone running OpenPocketCine can share its camera session: it holds the datalink,
//! decodes once, re-encodes, and serves watchers on the camera's Wi-Fi. This is the
//! viewfinder as one of those watchers. The picture comes in as HEVC access units and
//! goes down the same decoder, renderer, assists and virtual camera as a direct link;
//! the phone's state message stands in for the camera's status; and the few controls the
//! relay wire carries go out as relay commands once the phone has granted control.
//!
//! What the wire does not carry — the gimbal, the format, tracking, the library — is
//! refused here with a note, never sent into the void.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opc_camera::{Command, Status};
use opc_relay::discovery::Browser;
use opc_relay::session::{
    JoinTarget, Outgoing, Status as JoinStatus, WatcherObserver, WatcherOptions, WatcherSession,
};
use opc_relay::{Command as RelayCommand, ControlToken, FrameMeta, Hello, ProtocolInfo, State};

use crate::sheets::{PhoneControl, PhoneInfo};

/// The phone to watch, as the connection screen or the command line named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneTarget {
    /// The host name it advertises, e.g. "Studio iPhone".
    pub name: String,
    /// Where it answers; empty means find it by name on this Wi-Fi first.
    pub addresses: Vec<IpAddr>,
    pub port: u16,
    pub passcode: String,
}

/// How long to look for a host named on the command line before giving up.
const RESOLVE_WINDOW: Duration = Duration::from_secs(10);

/// What the phone thread tells the window.
#[derive(Debug)]
pub enum FromPhone {
    /// Connecting, or trying again: the text says which.
    Waiting(String),
    /// The phone accepted us; here is who it is.
    Joined(PhoneInfo),
    /// Something the Link tab shows changed: readouts or the control lease.
    Info(PhoneInfo),
    /// One HEVC access unit, parameter sets inline on keyframes.
    Picture(Vec<u8>),
    /// The phone's state message, as a camera status.
    Status(Box<Status>),
    /// The phone is gone for good, or would not have us.
    Lost(String),
}

/// What the window tells the phone thread.
#[derive(Debug)]
enum ToPhone {
    Send(RelayCommand),
    Control(bool),
    Stop,
}

/// A running join to a phone.
#[derive(Debug)]
pub struct PhoneLink {
    to: Sender<ToPhone>,
    from: Receiver<FromPhone>,
    worker: Option<JoinHandle<()>>,
}

impl PhoneLink {
    /// Joins the phone on its own thread.
    pub fn open(target: PhoneTarget) -> Self {
        let (to, to_rx) = channel();
        let (from_tx, from) = channel();
        let worker = std::thread::Builder::new()
            .name("opc-phone".to_string())
            .spawn(move || run(target, &to_rx, &from_tx))
            .ok();
        Self { to, from, worker }
    }

    /// Queues a relay command. Sent only while the phone has granted control.
    pub fn send(&self, command: RelayCommand) {
        let _ = self.to.send(ToPhone::Send(command));
    }

    /// Asks the phone for control, or gives it back.
    pub fn control(&self, want: bool) {
        let _ = self.to.send(ToPhone::Control(want));
    }

    /// Everything waiting from the phone.
    pub fn drain(&self) -> Vec<FromPhone> {
        self.from.try_iter().collect()
    }
}

impl Drop for PhoneLink {
    fn drop(&mut self) {
        let _ = self.to.send(ToPhone::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run(target: PhoneTarget, to: &Receiver<ToPhone>, from: &Sender<FromPhone>) {
    let info = match ProtocolInfo::load() {
        Ok(info) => info,
        Err(error) => {
            let _ = from.send(FromPhone::Lost(format!(
                "this build cannot read the relay contract: {error}"
            )));
            return;
        }
    };
    let _ = from.send(FromPhone::Waiting(format!("Looking for {}…", target.name)));
    let join = match resolve(&info, &target) {
        Ok(join) => join,
        Err(error) => {
            let _ = from.send(FromPhone::Lost(error));
            return;
        }
    };
    let options = WatcherOptions {
        device_name: device_name(),
        watcher_id: watcher_id(),
        passcode: target.passcode.clone(),
        connect_timeout: Duration::from_secs(5),
    };
    let mut session = WatcherSession::new(info, join, options);
    let mut bridge = Bridge {
        to,
        from,
        info: PhoneInfo {
            host: target.name.clone(),
            ..PhoneInfo::default()
        },
        status: Status::default(),
        outbox: VecDeque::new(),
        stopped: false,
    };
    if let Err(error) = session.run(&mut bridge) {
        let _ = from.send(FromPhone::Lost(error.to_string()));
        return;
    }
    match session.status() {
        JoinStatus::NeedsPasscode => {
            let _ = from.send(FromPhone::Lost(
                "the phone wants a passcode — enter it on the connection screen".to_string(),
            ));
        }
        JoinStatus::Failed(message) => {
            let _ = from.send(FromPhone::Lost(message.clone()));
        }
        _ => {}
    }
}

/// The host as a join target: as given, or found by name on this Wi-Fi.
fn resolve(info: &ProtocolInfo, target: &PhoneTarget) -> Result<JoinTarget, String> {
    if !target.addresses.is_empty() {
        return Ok(JoinTarget {
            name: target.name.clone(),
            addresses: target.addresses.clone(),
            port: target.port,
        });
    }
    let mut browser = Browser::start(info).map_err(|error| error.to_string())?;
    let deadline = Instant::now() + RESOLVE_WINDOW;
    while Instant::now() < deadline {
        if let Some(host) = browser
            .poll(Duration::from_millis(500))
            .into_iter()
            .find(|host| host.name.eq_ignore_ascii_case(&target.name))
        {
            return Ok(JoinTarget {
                name: host.name,
                addresses: host.addresses,
                port: host.port,
            });
        }
    }
    Err(format!(
        "no phone called \"{}\" is sharing on this Wi-Fi",
        target.name
    ))
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Desktop".to_string())
}

/// A stable id per install, so a drop-and-return keeps the control lease. Kept beside
/// the preferences; a fresh one is minted when there is none.
fn watcher_id() -> String {
    let path = crate::prefs::path().with_file_name("watcher-id");
    if let Ok(saved) = std::fs::read_to_string(&path) {
        let saved = saved.trim();
        if !saved.is_empty() {
            return saved.to_string();
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let minted = format!("desktop-{nanos:x}");
    if let Some(folder) = path.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    let _ = std::fs::write(&path, &minted);
    minted
}

/// The observer on the session thread: forwards to the window, hands over its queue.
struct Bridge<'a> {
    to: &'a Receiver<ToPhone>,
    from: &'a Sender<FromPhone>,
    info: PhoneInfo,
    status: Status,
    outbox: VecDeque<Outgoing>,
    stopped: bool,
}

impl WatcherObserver for Bridge<'_> {
    fn status_changed(&mut self, status: &JoinStatus) {
        let event = match status {
            JoinStatus::Connecting => FromPhone::Waiting("Connecting to the phone…".to_string()),
            JoinStatus::Reconnecting(attempt) => {
                self.info.control = PhoneControl::NotOffered;
                FromPhone::Waiting(format!("Reconnecting to the phone ({attempt})…"))
            }
            JoinStatus::Live | JoinStatus::NeedsPasscode | JoinStatus::Failed(_) => return,
        };
        let _ = self.from.send(event);
    }

    fn accepted(&mut self, hello: &Hello) {
        self.info.host = hello.host_name.clone();
        self.info.camera = hello.camera_name.clone();
        let _ = self.from.send(FromPhone::Joined(self.info.clone()));
    }

    fn state_changed(&mut self, state: &State) {
        self.status = status_from(state, &self.status);
        let _ = self
            .from
            .send(FromPhone::Status(Box::new(self.status.clone())));
        if !state.camera_name.is_empty() {
            self.info.camera = state.camera_name.clone();
        }
        self.info.format = state.format.clone();
        self.info.color = state.color.clone();
        self.info.live_fps = state.live_fps.clone();
        self.info.control = control_after_state(&self.info.control, state.allows_control_requests);
        let _ = self.from.send(FromPhone::Info(self.info.clone()));
    }

    fn token_changed(&mut self, token: &ControlToken) {
        self.info.control = control_from_token(token, self.info.control == PhoneControl::Requested);
        let _ = self.from.send(FromPhone::Info(self.info.clone()));
    }

    fn picture(&mut self, _meta: &FrameMeta, _parameter_sets: &[Vec<u8>], access_unit: &[u8]) {
        let _ = self.from.send(FromPhone::Picture(access_unit.to_vec()));
    }

    fn should_continue(&mut self) -> bool {
        loop {
            match self.to.try_recv() {
                Ok(ToPhone::Send(command)) => self.outbox.push_back(Outgoing::Command(command)),
                Ok(ToPhone::Control(true)) => {
                    if self.info.control == PhoneControl::Available {
                        self.info.control = PhoneControl::Requested;
                        let _ = self.from.send(FromPhone::Info(self.info.clone()));
                    }
                    self.outbox.push_back(Outgoing::RequestControl);
                }
                Ok(ToPhone::Control(false)) => self.outbox.push_back(Outgoing::ReleaseControl),
                Ok(ToPhone::Stop) | Err(TryRecvError::Disconnected) => self.stopped = true,
                Err(TryRecvError::Empty) => break,
            }
        }
        !self.stopped
    }

    fn outgoing(&mut self) -> Option<Outgoing> {
        self.outbox.pop_front()
    }
}

/// The lease as the token describes it. The phone names itself "Host" while it keeps
/// control, which is the lease being free to ask for, not another watcher holding it.
pub fn control_from_token(token: &ControlToken, was_requested: bool) -> PhoneControl {
    let holder = token.holder_name.trim();
    if token.holder_is_recipient {
        PhoneControl::Held
    } else if !holder.is_empty() && !holder.eq_ignore_ascii_case("Host") {
        PhoneControl::HeldBy(holder.to_string())
    } else if was_requested {
        PhoneControl::Requested
    } else {
        PhoneControl::Available
    }
}

/// Whether the phone still offers control, without losing a lease we hold.
pub fn control_after_state(current: &PhoneControl, allows: bool) -> PhoneControl {
    match (current, allows) {
        (PhoneControl::Held | PhoneControl::HeldBy(_) | PhoneControl::Requested, true) => {
            current.clone()
        }
        (_, true) => PhoneControl::Available,
        (PhoneControl::Held, false) => PhoneControl::Held,
        (_, false) => PhoneControl::NotOffered,
    }
}

/// The phone's state message as the camera status the shell reads. Fields the wire does
/// not carry keep their last value.
pub fn status_from(state: &State, previous: &Status) -> Status {
    let mut status = previous.clone();
    status.is_recording = state.is_recording;
    status.battery_percent = (state.battery_percent >= 0).then_some(state.battery_percent);
    status.iso = leading_number(&state.iso);
    status.shutter_denominator = state
        .shutter
        .trim()
        .strip_prefix("1/")
        .and_then(leading_number);
    status.available_iso = state
        .iso_indices
        .iter()
        .filter_map(|index| u8::try_from(*index).ok())
        .collect();
    status.available_shutter = state.shutter_denominators.clone();
    status.zoom_hundredths = zoom_hundredths(&state.zoom);
    status
}

/// The first run of digits in a label: "ISO 800" is 800, "1/50" is 1.
fn leading_number(text: &str) -> Option<i32> {
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// "2.5×" or "2.5x" is 250; anything without a number is unknown.
fn zoom_hundredths(label: &str) -> Option<i32> {
    let number: String = label
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let factor: f64 = number.parse().ok()?;
    Some((factor * 100.0).round() as i32)
}

/// What becomes of a camera command on the relay wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Proxy {
    /// The wire carries it, as this.
    Send(RelayCommand),
    /// The session's own housekeeping; the phone does that. Dropped without a word.
    Quiet,
    /// An operator's ask the wire cannot carry; the label names the feature.
    Unavailable(&'static str),
}

/// Maps a camera command to the wire. `recording` is what the phone last said, so a
/// record start while rolling does not toggle the take off.
pub fn proxy(command: &Command, recording: bool) -> Proxy {
    use Proxy::{Quiet, Send, Unavailable};
    match *command {
        Command::RecordStart => {
            if recording {
                Quiet
            } else {
                Send(RelayCommand::ToggleRecording)
            }
        }
        Command::RecordStop => {
            if recording {
                Send(RelayCommand::ToggleRecording)
            } else {
                Quiet
            }
        }
        Command::SetIsoIndex(index) => Send(RelayCommand::SetIso(i32::from(index))),
        Command::SetShutter(denominator) => Send(RelayCommand::SetShutterDenominator(denominator)),
        Command::SetWhiteBalanceAuto { tint } => Send(RelayCommand::SetWhiteBalance {
            mode: 0,
            kelvin: 0,
            tint,
        }),
        Command::SetWhiteBalanceCustom { kelvin, tint } => Send(RelayCommand::SetWhiteBalance {
            mode: 1,
            kelvin,
            tint,
        }),
        Command::SetColorMode { mode, .. } => Send(RelayCommand::SetColor(i32::from(mode))),
        Command::ZoomFactor(factor) | Command::ZoomJump(factor) => {
            Send(RelayCommand::SetZoom((factor * 100.0).round() as i32))
        }
        Command::TapFocusPoint { x, y } => Send(RelayCommand::TapFocus {
            camera_x: (f64::from(x) * 1000.0).round() as i32,
            camera_y: (f64::from(y) * 1000.0).round() as i32,
            coordinate_width: 1000,
            coordinate_height: 1000,
        }),
        Command::SessionWake
        | Command::SessionKeepalive
        | Command::GimbalInit
        | Command::AppDeviceInfo
        | Command::AppPresence
        | Command::LiveViewEnable
        | Command::NanoLiveGate { .. }
        | Command::GimbalParamsGet
        | Command::GimbalTimedStop
        | Command::TrackPoll
        | Command::FocusTrackGet
        | Command::TapFocusPrepare
        | Command::TapFocusHint
        | Command::TapFocusCommit { .. }
        | Command::AudioDspGet
        | Command::ZoomStop
        | Command::ParamGet(_)
        | Command::GetWifiSsid
        | Command::GetWifiPassword
        | Command::MediaList { .. }
        | Command::MediaListTrigger
        | Command::EnterPlayback
        | Command::ExitPlayback
        | Command::PlaybackSpecial(_) => Quiet,
        Command::ShootPhoto => Unavailable("PHOTO"),
        Command::SetShootingMode(_) => Unavailable("SHOOTING MODE"),
        Command::ZoomLens(_) | Command::ZoomSlew(_) => Unavailable("ZOOM SLEW"),
        Command::GimbalRecenter
        | Command::GimbalFlip
        | Command::GimbalFollow
        | Command::GimbalFpv
        | Command::GimbalStick { .. }
        | Command::GimbalSpeed(_)
        | Command::GimbalTiltLock(_) => Unavailable("GIMBAL"),
        Command::GimbalTimedTarget { .. } => Unavailable("MOTION CONTROL"),
        Command::TrackSet { .. } | Command::TrackClear => Unavailable("TRACKING"),
        Command::FocusTrackSet(_) => Unavailable("FOCUS TRACKING"),
        Command::AudioWind { .. }
        | Command::AudioDirectional { .. }
        | Command::SetAudioChannel(_)
        | Command::SetVocalBoost(_) => Unavailable("AUDIO"),
        Command::SetIsoLimit(_) => Unavailable("ISO LIMIT"),
        Command::SetEv(_) => Unavailable("EV"),
        Command::SetFocusMode(_) => Unavailable("FOCUS MODE"),
        Command::SetVideoFormat { .. } => Unavailable("FORMAT"),
        Command::SetFov(_) => Unavailable("FIELD OF VIEW"),
        Command::SetExpoMode(_) => Unavailable("EXPOSURE MODE"),
        Command::MediaDelete { .. } | Command::MediaFavorite { .. } => Unavailable("LIBRARY"),
    }
}

/// The top-bar line for a feature the wire cannot carry.
pub fn unavailable_notice(label: &str) -> String {
    format!("{label} NEEDS A DIRECT CAMERA LINK")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_start_and_stop_become_one_toggle_each_way() {
        assert_eq!(
            proxy(&Command::RecordStart, false),
            Proxy::Send(RelayCommand::ToggleRecording)
        );
        assert_eq!(proxy(&Command::RecordStart, true), Proxy::Quiet);
        assert_eq!(
            proxy(&Command::RecordStop, true),
            Proxy::Send(RelayCommand::ToggleRecording)
        );
        assert_eq!(proxy(&Command::RecordStop, false), Proxy::Quiet);
    }

    #[test]
    fn exposure_zoom_and_focus_map_onto_the_wire() {
        assert_eq!(
            proxy(&Command::SetIsoIndex(7), false),
            Proxy::Send(RelayCommand::SetIso(7))
        );
        assert_eq!(
            proxy(&Command::SetShutter(50), false),
            Proxy::Send(RelayCommand::SetShutterDenominator(50))
        );
        assert_eq!(
            proxy(
                &Command::SetWhiteBalanceCustom {
                    kelvin: 5600,
                    tint: 0
                },
                false
            ),
            Proxy::Send(RelayCommand::SetWhiteBalance {
                mode: 1,
                kelvin: 5600,
                tint: 0
            })
        );
        assert_eq!(
            proxy(&Command::ZoomJump(2.5), false),
            Proxy::Send(RelayCommand::SetZoom(250))
        );
        assert_eq!(
            proxy(&Command::TapFocusPoint { x: 0.25, y: 0.5 }, false),
            Proxy::Send(RelayCommand::TapFocus {
                camera_x: 250,
                camera_y: 500,
                coordinate_width: 1000,
                coordinate_height: 1000
            })
        );
    }

    #[test]
    fn housekeeping_is_quiet_and_operator_asks_are_named() {
        assert_eq!(proxy(&Command::SessionKeepalive, false), Proxy::Quiet);
        assert_eq!(proxy(&Command::TrackPoll, false), Proxy::Quiet);
        assert_eq!(
            proxy(&Command::GimbalRecenter, false),
            Proxy::Unavailable("GIMBAL")
        );
        assert_eq!(
            proxy(
                &Command::SetVideoFormat {
                    resolution: 0,
                    frame_rate: 0
                },
                false
            ),
            Proxy::Unavailable("FORMAT")
        );
        assert_eq!(
            unavailable_notice("FORMAT"),
            "FORMAT NEEDS A DIRECT CAMERA LINK"
        );
    }

    #[test]
    fn the_state_message_reads_as_a_status() {
        let state = State {
            is_recording: true,
            battery_percent: 63,
            iso: "ISO 800".to_string(),
            shutter: "1/50".to_string(),
            zoom: "2.5×".to_string(),
            iso_indices: vec![3, 4, 5],
            shutter_denominators: vec![25, 50, 100],
            ..State::default()
        };
        let status = status_from(&state, &Status::default());
        assert!(status.is_recording);
        assert_eq!(status.battery_percent, Some(63));
        assert_eq!(status.iso, Some(800));
        assert_eq!(status.shutter_denominator, Some(50));
        assert_eq!(status.zoom_hundredths, Some(250));
        assert_eq!(status.available_iso, [3, 4, 5]);
        assert_eq!(status.available_shutter, [25, 50, 100]);
        let unknown = status_from(
            &State {
                battery_percent: -1,
                ..State::default()
            },
            &status,
        );
        assert_eq!(unknown.battery_percent, None);
        assert_eq!(unknown.iso, None, "an empty label is unknown, not zero");
    }

    #[test]
    fn the_lease_follows_the_token_and_the_offer() {
        let held = ControlToken {
            holder_name: "Desktop".to_string(),
            holder_is_recipient: true,
        };
        assert_eq!(control_from_token(&held, false), PhoneControl::Held);
        let theirs = ControlToken {
            holder_name: "Studio iPhone".to_string(),
            holder_is_recipient: false,
        };
        assert_eq!(
            control_from_token(&theirs, true),
            PhoneControl::HeldBy("Studio iPhone".to_string())
        );
        let nobody = ControlToken::default();
        assert_eq!(control_from_token(&nobody, true), PhoneControl::Requested);
        assert_eq!(control_from_token(&nobody, false), PhoneControl::Available);
        assert_eq!(
            control_after_state(&PhoneControl::Held, false),
            PhoneControl::Held,
            "turning requests off does not take a granted lease"
        );
        assert_eq!(
            control_after_state(&PhoneControl::Available, false),
            PhoneControl::NotOffered
        );
        assert_eq!(
            control_after_state(&PhoneControl::NotOffered, true),
            PhoneControl::Available
        );
    }
}
