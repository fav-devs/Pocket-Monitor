//! The window.
//!
//! Deliberately thin. It turns winit events into `Key`s and pointer positions, hands
//! them to the [`Shell`](opc_monitor::shell::Shell), and carries out whatever intents come
//! back. Nothing here decides anything an operator would notice.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use opc_camera::Command;
use opc_camera::Recovery;
use opc_chrome::Screen;
use opc_decode::{Codec, Decoder, OwnedPicture};
use opc_monitor::phone::{self, FromPhone, PhoneLink, PhoneTarget, Proxy};
use opc_monitor::sheets::PhoneControl;
use opc_render::{write_png, FeedRenderer, Lut, Presented};
use opc_vcam::{ComponentReport, VirtualCamera};

use crate::media::MediaDriver;
use opc_monitor::luts;
use opc_monitor::{LutChoice, LutRequest, PadButton};
use opc_ui::{Key as UiKey, Phase};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Fullscreen, Window, WindowId};

use crate::link::{diagnostic, FromCamera, Link};
use opc_monitor::shell::{Intent, Shell, TouchPhase as Finger};

/// A backlog longer than this means the window stalled. Predicted pictures cannot be
/// thinned — they need the ones before them — so the only safe skip is to a keyframe.
const BACKLOG_LIMIT: usize = 30;
/// Decoded pictures that may wait to be shown before the oldest are skipped.
const READY_LIMIT: usize = 3;

/// How the viewfinder was asked to start.
#[derive(Debug, Default)]
pub struct Options {
    /// An explicit camera address, for a fake camera or an unusual network.
    pub remote: Option<std::net::SocketAddr>,
    pub lut: Option<Lut>,
    /// Which body this is, so the status decoder reads its own encodings.
    pub model_id: Option<i32>,
    pub still: PathBuf,
    /// A phone to watch instead of a camera to link.
    pub phone: Option<PhoneTarget>,
}

/// Where the picture comes from: the camera's own datalink, or a phone sharing its.
enum Feed {
    Camera(Link),
    Phone(PhoneLink),
}

struct Unit {
    keyframe: bool,
    bytes: Vec<u8>,
}

struct View {
    // Declared before `window` so the renderer, which borrows the window's handles, is
    // torn down first.
    renderer: Option<FeedRenderer>,
    window: Option<Window>,
    shell: Shell,
    link: Feed,
    decoder: Option<Decoder>,
    pending: Vec<Unit>,
    latest: Option<OwnedPicture>,
    /// Decoded pictures not yet shown, oldest first. One is shown per redraw so a burst
    /// of frames plays out in order instead of all but the newest being skipped.
    ready: std::collections::VecDeque<OwnedPicture>,
    /// Decoded, shown and discarded counts, logged once a second.
    pace: (u32, u32, u32, Instant),
    last_draw: Instant,
    /// What the window presents until the first decoded picture arrives. Without this,
    /// winit leaves the newly created surface white and hides the connection state.
    placeholder: OwnedPicture,
    /// The idle placeholder need not be submitted again until its chrome or surface changes.
    placeholder_presented: bool,
    /// Avoid flooding stderr with the same renderer failure every redraw.
    render_error: Option<String>,
    /// What the camera thread was last told about the operator being away from the
    /// live picture, so the watchdog holds its repairs while they browse.
    repair_blocked: bool,
    lut: Option<Lut>,
    /// The false-colour paint and weight lattices, while that assist is on.
    false_color: Option<(Lut, Lut)>,
    still: PathBuf,
    take_still: bool,
    pointer: (f64, f64),
    pointer_control: bool,
    started: Instant,
    /// When the plates last read the picture.
    last_scope_at: f64,
    /// A game controller, when the platform offers one.
    pad: Option<gilrs::Gilrs>,
    gestures: Option<crate::webcam::Webcam>,
    feed_gestures: Option<FeedGestures>,
    /// A webcam was asked for since gestures last pointed at it.
    webcam_tried: bool,
    /// Whether the chrome was showing, and which redraw, when the renderer last got it.
    overlay_key: (bool, u64),
    render_stats: (u32, Duration, Instant),
    last_pad_at: f64,
    /// Where the camera is, for a reconnect.
    remote: Option<std::net::SocketAddr>,
    /// The phone, for a reconnect, when the feed is a phone's.
    phone: Option<PhoneTarget>,
    model_id: Option<i32>,
    media: MediaDriver,
    /// A name for the cache folder: the body's model id, or "camera".
    camera_id: String,
    /// The viewfinder as a camera for other apps, while the operator has it on.
    vcam: Option<VirtualCamera>,
    /// When the camera last took a frame, and when its readout was last refreshed.
    last_vcam_at: f64,
    last_vcam_status_at: f64,
    /// A probe, install or remove of the platform camera component, running on its
    /// own thread; the answer lands in the Output tab.
    component_job: Option<std::sync::mpsc::Receiver<ComponentReport>>,
}

impl View {
    fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    fn carry_out(&mut self, intents: Vec<Intent>, event_loop: &ActiveEventLoop) {
        for intent in intents {
            match intent {
                Intent::Send(command) => self.send(command),
                Intent::Still => self.take_still = true,
                Intent::Quit => event_loop.exit(),
                Intent::ToggleFullscreen => {
                    if let Some(window) = self.window.as_ref() {
                        let wanted = window.fullscreen().is_none();
                        window.set_fullscreen(wanted.then_some(Fullscreen::Borderless(None)));
                    }
                }
                Intent::Media(action) => {
                    let now = self.now();
                    let camera_id = self.camera_id.clone();
                    for command in self.media.action(&mut self.shell, action, &camera_id, now) {
                        self.send(command);
                    }
                }
                Intent::Reconnect => self.reconnect(),
                Intent::Diagnostics => self.write_diagnostics(),
                Intent::ComponentInstall => self.start_component_job(opc_vcam::install::install),
                Intent::ComponentRemove => self.start_component_job(opc_vcam::install::remove),
                Intent::OpenUrl(url) => self.open_url(&url),
                Intent::PhoneControl(want) => self.phone_control(want),
            }
        }
        while let Some(request) = self.shell.take_lut_change() {
            self.apply_lut_request(request);
        }
    }

    /// A cube change from the `L` key or the LUT row: load what was picked, then tell
    /// the renderer. Loading happens here because the built-in looks come from the core.
    fn apply_lut_request(&mut self, request: LutRequest) {
        let on = match request {
            LutRequest::FalseColor(key) => {
                self.false_color = key.and_then(|key| {
                    let paint = Lut::false_color(key.scale, key.color_mode, key.iso, true);
                    let weight = Lut::false_color(key.scale, key.color_mode, key.iso, false);
                    match (paint, weight) {
                        (Ok(paint), Ok(weight)) => Some((paint, weight)),
                        (Err(error), _) | (_, Err(error)) => {
                            eprintln!("could not load false colour: {error}");
                            None
                        }
                    }
                });
                let cubes = self
                    .false_color
                    .as_ref()
                    .map(|(paint, weight)| (paint, weight));
                if let Some(renderer) = self.renderer.as_mut() {
                    if let Err(error) = renderer.set_false_color(cubes) {
                        eprintln!("could not set false colour: {error}");
                    }
                }
                return;
            }
            LutRequest::Toggle(on) => on,
            LutRequest::Load(choice) => {
                let loaded: Result<Option<Lut>, String> = match &choice {
                    LutChoice::Off => Ok(None),
                    // 33 is the lattice the shells build the built-in looks at.
                    LutChoice::BuiltIn(name) => Lut::built_in(name, 33)
                        .map(Some)
                        .map_err(|error| error.to_string()),
                    LutChoice::File(file) => {
                        std::fs::read_to_string(luts::custom_folder().join(file))
                            .map_err(|error| error.to_string())
                            .and_then(|text| Lut::parse(&text).map_err(|error| error.to_string()))
                            .map(Some)
                    }
                };
                match loaded {
                    Ok(cube) => {
                        if cube.is_some() {
                            self.lut = cube;
                        }
                        choice != LutChoice::Off
                    }
                    Err(error) => {
                        eprintln!("could not load the cube: {error}");
                        false
                    }
                }
            }
        };
        let cube = on.then_some(self.lut.as_ref()).flatten();
        if let Some(renderer) = self.renderer.as_mut() {
            if let Err(error) = renderer.set_lut(cube) {
                eprintln!("could not set the cube: {error}");
            }
        }
    }

    /// Tears the datalink down and opens a fresh one, as the Link tab asks.
    fn reconnect(&mut self) {
        self.link = match self.phone.clone() {
            Some(target) => Feed::Phone(PhoneLink::open(target)),
            None => {
                let (session_id, base_seq) = fresh_session();
                Feed::Camera(Link::open(self.remote, session_id, base_seq, self.model_id))
            }
        };
        self.latest = None;
        self.ready.clear();
        self.shell.set_phase(Phase::Waiting);
        self.shell.say("RECONNECTING");
    }

    /// Puts a command on whichever link this is. On a phone, only what the relay wire
    /// carries goes out, and only once the phone has granted control; the first ask
    /// without it is the request.
    fn send(&mut self, command: Command) {
        match &self.link {
            Feed::Camera(link) => link.send(command),
            Feed::Phone(link) => {
                let recording = self.shell.status().is_recording;
                match phone::proxy(&command, recording) {
                    Proxy::Quiet => {}
                    Proxy::Unavailable(label) => {
                        self.shell.say(&phone::unavailable_notice(label));
                    }
                    Proxy::Send(relay) => match self.shell.phone_control() {
                        Some(PhoneControl::Held) => link.send(relay),
                        Some(PhoneControl::Available) => {
                            link.control(true);
                            self.shell.say("CONTROL REQUESTED · GRANT IT ON THE PHONE");
                        }
                        Some(PhoneControl::Requested) => {
                            self.shell.say("WAITING FOR THE PHONE TO GRANT CONTROL");
                        }
                        Some(PhoneControl::HeldBy(name)) => {
                            let name = name.clone();
                            self.shell
                                .say(&format!("{} HOLDS CONTROL", name.to_uppercase()));
                        }
                        Some(PhoneControl::NotOffered) | None => {
                            self.shell.say("THE PHONE IS NOT OFFERING CONTROL");
                        }
                    },
                }
            }
        }
    }

    /// The Link tab's Request / Release, on a phone feed.
    fn phone_control(&mut self, want: bool) {
        if let Feed::Phone(link) = &self.link {
            link.control(want);
            self.shell.say(if want {
                "CONTROL REQUESTED · GRANT IT ON THE PHONE"
            } else {
                "CONTROL RELEASED"
            });
        }
    }

    fn note_presented(&self) {
        if let Feed::Camera(link) = &self.link {
            link.note_presented();
        }
    }

    fn note_decoder_failed(&self, failed: bool) {
        if let Feed::Camera(link) = &self.link {
            link.note_decoder_failed(failed);
        }
    }

    /// In the library or a playback a repair would tear the screen down under the
    /// operator; the watchdog waits until they are back on the live picture.
    fn sync_repair_blocked(&mut self) {
        let blocked = self.media.is_active() || self.shell.screen() != Screen::Viewfinder;
        if blocked == self.repair_blocked {
            return;
        }
        self.repair_blocked = blocked;
        if let Feed::Camera(link) = &self.link {
            link.set_repair_blocked(blocked);
        }
    }

    /// Writes everything a bug report needs next to the LUT folder.
    fn write_diagnostics(&mut self) {
        let now = self.now();
        let mut text = self.shell.diagnostics_text(now);
        text.push_str(&format!(
            "decoder {:?}\n",
            self.decoder.as_ref().map(|d| d.codec())
        ));
        let folder = opc_monitor::prefs::path()
            .parent()
            .map_or_else(|| PathBuf::from("."), |p| p.to_path_buf());
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let path = folder.join(format!("diagnostics-{stamp}.txt"));
        match std::fs::create_dir_all(&folder).and_then(|()| std::fs::write(&path, text)) {
            Ok(()) => {
                println!("Wrote {}", path.display());
                self.shell.say("DIAGNOSTICS WRITTEN TO THE CACHE FOLDER");
            }
            Err(error) => {
                eprintln!("could not write diagnostics: {error}");
                self.shell.say("COULD NOT WRITE DIAGNOSTICS");
            }
        }
    }

    /// Intents raised between frames rather than by a key or a tap: sends and media
    /// fetches. Nothing here can close the window.
    fn carry_out_quietly(&mut self, intents: Vec<Intent>, now: f64) {
        for intent in intents {
            match intent {
                Intent::Send(command) => self.send(command),
                Intent::Media(action) => {
                    let camera_id = self.camera_id.clone();
                    for command in self.media.action(&mut self.shell, action, &camera_id, now) {
                        self.send(command);
                    }
                }
                Intent::Reconnect => self.reconnect(),
                Intent::Diagnostics => self.write_diagnostics(),
                Intent::ComponentInstall => self.start_component_job(opc_vcam::install::install),
                Intent::ComponentRemove => self.start_component_job(opc_vcam::install::remove),
                Intent::OpenUrl(url) => self.open_url(&url),
                Intent::PhoneControl(want) => self.phone_control(want),
                Intent::Still | Intent::Quit | Intent::ToggleFullscreen => {}
            }
        }
    }

    /// Runs a component action off the window thread; one at a time.
    fn start_component_job(&mut self, job: fn() -> ComponentReport) {
        if self.component_job.is_some() {
            return;
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("opc-component".to_string())
            .spawn(move || {
                let _ = sender.send(job());
            })
            .ok();
        self.component_job = Some(receiver);
    }

    /// Takes a finished component job's answer to the Output tab, and restarts the
    /// camera so it sees what changed.
    fn poll_component_job(&mut self) {
        let Some(receiver) = self.component_job.as_ref() else {
            return;
        };
        let Ok(report) = receiver.try_recv() else {
            return;
        };
        self.component_job = None;
        let installed = report.state == opc_vcam::ComponentState::Installed;
        self.shell.set_component(report);
        if let Some(camera) = self.vcam.take() {
            camera.stop();
        }
        if installed && self.shell.vcam_backend() == Some(opc_vcam::Backend::Device) {
            self.shell.say("CAMERA COMPONENT INSTALLED · CAMERA ON");
        }
    }

    fn open_url(&mut self, url: &str) {
        if let Err(error) = opc_vcam::install::open_url(url) {
            eprintln!("{error}");
            self.shell.say("COULD NOT OPEN THE BROWSER");
        }
    }

    /// Takes everything the phone thread has posted.
    fn pump_phone(&mut self, events: Vec<FromPhone>) {
        for event in events {
            match event {
                FromPhone::Waiting(text) => {
                    self.shell.set_phase(Phase::Waiting);
                    self.shell.note_recovery(&text);
                }
                FromPhone::Joined(info) => {
                    self.shell
                        .set_link_info(&format!("Phone relay · {}", info.host));
                    self.shell.set_phone(Some(info));
                    self.shell.set_phase(Phase::Waiting);
                }
                FromPhone::Info(info) => {
                    let granted = info.control == PhoneControl::Held
                        && self.shell.phone_control() != Some(&PhoneControl::Held);
                    self.shell.set_phone(Some(info));
                    if granted {
                        self.shell.say("THE PHONE GRANTED CONTROL");
                    }
                }
                FromPhone::Picture(bytes) => {
                    let keyframe = is_keyframe(&bytes);
                    dump_unit(&bytes);
                    self.pending.push(Unit { keyframe, bytes });
                }
                FromPhone::Status(status) => {
                    self.shell.set_status(*status);
                    if matches!(self.shell.phase(), Phase::Waiting) && self.latest.is_some() {
                        self.shell.set_phase(Phase::Live);
                    }
                }
                FromPhone::Lost(reason) => self.shell.set_phase(Phase::Failed(reason)),
            }
        }
    }

    /// Takes everything the camera thread has posted.
    fn pump_camera(&mut self) {
        let events = match &self.link {
            Feed::Camera(link) => link.drain(),
            Feed::Phone(link) => {
                let events = link.drain();
                self.pump_phone(events);
                return;
            }
        };
        for event in events {
            match event {
                FromCamera::Opened => {
                    self.shell.set_phase(Phase::Waiting);
                    self.placeholder_presented = false;
                }
                FromCamera::Picture(bytes) => {
                    // The core marks keyframes; the depacketizer hands over whole access
                    // units, so the first NAL type is enough to know one.
                    let keyframe = is_keyframe(&bytes);
                    dump_unit(&bytes);
                    self.pending.push(Unit { keyframe, bytes });
                }
                FromCamera::Frame(frame) => {
                    let now = self.now();
                    if (frame.cmd_set, frame.cmd_id) == (0x02, 0xA5) {
                        if let Some(poll) = opc_camera::tracking_poll(&frame.payload) {
                            self.shell.tracking_reply(poll, now);
                        }
                    } else if (frame.cmd_set, frame.cmd_id) == (0x02, 0x89) {
                        if let Some(subject) = opc_camera::tracking_live_push(&frame.payload) {
                            self.shell.tracking_push(subject, now);
                        }
                    } else {
                        self.media.frame(frame, now);
                    }
                }
                FromCamera::Set(outcome) => self.shell.note_set(outcome),
                FromCamera::Status(status) => {
                    self.media.status(status.in_playback);
                    self.shell.set_status(*status);
                    self.placeholder_presented = false;
                    if matches!(self.shell.phase(), Phase::Waiting) && self.latest.is_some() {
                        self.shell.set_phase(Phase::Live);
                    }
                }
                FromCamera::Recovering(recovery) => {
                    self.shell.set_phase(Phase::Recovering);
                    self.shell.note_recovery(&format!("{recovery:?}"));
                    self.placeholder_presented = false;
                    if matches!(recovery, Recovery::RebuildDecoder) {
                        self.rebuild_decoder();
                    }
                }
                FromCamera::Lost(reason) => {
                    self.shell.set_phase(Phase::Failed(reason));
                    self.placeholder_presented = false;
                }
            }
        }
    }

    /// The watchdog says the decoder is wedged. A fresh one is cheap; a wedged one
    /// produces a black window with a live HUD, which reads as a camera fault.
    fn rebuild_decoder(&mut self) {
        let codec = self
            .decoder
            .as_ref()
            .map(Decoder::codec)
            .unwrap_or(Codec::Hevc);
        match Decoder::new(codec) {
            Ok(decoder) => {
                self.decoder = Some(decoder);
                self.note_decoder_failed(false);
                // Everything queued was for the old decoder's state.
                self.pending.clear();
                self.latest = None;
                self.ready.clear();
                self.placeholder_presented = false;
            }
            Err(error) => {
                eprintln!("could not rebuild the decoder: {error}");
                self.decoder = None;
                self.note_decoder_failed(true);
                self.shell
                    .set_phase(Phase::Failed(format!("decoder unavailable: {error}")));
                self.placeholder_presented = false;
            }
        }
    }

    fn note_decode_failure(&mut self, error: impl std::fmt::Display) {
        eprintln!("decoder failed: {error}");
        diagnostic(format_args!("decoder failed: {error}"));
        self.note_decoder_failed(true);
        self.shell
            .set_phase(Phase::Failed(format!("decoder failed: {error}")));
        self.placeholder_presented = false;
    }

    /// Decodes everything waiting, keeping the newest picture.
    fn decode(&mut self) {
        if self.decoder.is_none() {
            // Joining mid-stream, the first units are plain slices that name no codec.
            // Guessing HEVC for them built a decoder that never produced a picture from
            // an AVC stream, so wait for the first unit that carries parameter sets.
            let Some(at) = self
                .pending
                .iter()
                .position(|unit| codec_of(&unit.bytes).is_some())
            else {
                self.pending.clear();
                return;
            };
            self.pending.drain(..at);
            let Some(unit) = self.pending.first() else {
                return;
            };
            let codec = codec_of(&unit.bytes).unwrap_or(Codec::Hevc);
            match Decoder::new(codec) {
                Ok(decoder) => {
                    diagnostic(format_args!("created {codec:?} decoder"));
                    self.decoder = Some(decoder);
                }
                Err(error) => {
                    self.note_decode_failure(format!("could not create {codec:?}: {error}"));
                    return;
                }
            }
        }
        let Some(decoder) = self.decoder.as_mut() else {
            return;
        };
        if self.pending.len() > BACKLOG_LIMIT {
            if let Some(at) = self.pending.iter().rposition(|unit| unit.keyframe) {
                self.pending.drain(..at);
                decoder.flush();
            }
        }
        let mut failure = None;
        let had_picture = self.latest.is_some();
        for unit in self.pending.drain(..) {
            if let Err(error) = decoder.send(&unit.bytes) {
                // Pocket 3 sends AVC parameter sets before its first coded slice.
                // FFmpeg records the SPS/PPS then returns EINVAL / "no frame" for
                // that configuration-only packet. It is startup, not a dead decoder.
                if decoder.codec() == Codec::H264 && is_h264_configuration(&unit.bytes) {
                    diagnostic("accepted AVC configuration packet; awaiting keyframe");
                    continue;
                }
                // Joining a Pocket 3 AVC stream is not frame-aligned. FFmpeg can
                // reject the tail of the access unit already in flight before the
                // first SPS/PPS + IDR reaches us. Do not turn that expected startup
                // race into a permanent red decoder error; clear it and wait for the
                // next keyframe, while the watchdog remains responsible for a real
                // no-picture timeout.
                if !had_picture {
                    diagnostic(format_args!(
                        "ignored initial {:?} access unit: {error}; awaiting keyframe",
                        decoder.codec()
                    ));
                    decoder.flush();
                    continue;
                }
                failure = Some(error);
                break;
            }
            loop {
                match decoder.receive() {
                    Ok(Some(picture)) => {
                        if !had_picture && self.latest.is_none() && self.ready.is_empty() {
                            diagnostic(format_args!(
                                "decoded first picture {}x{} keyframe={}",
                                picture.width, picture.height, picture.is_keyframe
                            ));
                        }
                        self.pace.0 += 1;
                        self.ready.push_back(OwnedPicture::copy_from(&picture));
                    }
                    Ok(None) => break,
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            if failure.is_some() {
                break;
            }
        }
        if let Some(error) = failure {
            self.note_decode_failure(error);
        }
        // Show one decoded picture per redraw; only a backlog past a few frames skips
        // ahead, so latency stays low without dropping frames in ordinary bursts.
        while self.ready.len() > READY_LIMIT {
            self.ready.pop_front();
            self.pace.2 += 1;
        }
        if let Some(picture) = self.ready.pop_front() {
            self.latest = Some(picture);
            self.pace.1 += 1;
        }
        if self.pace.3.elapsed() >= Duration::from_secs(1) {
            diagnostic(format_args!(
                "pace: decoded {} shown {} skipped {} queued {}",
                self.pace.0,
                self.pace.1,
                self.pace.2,
                self.ready.len()
            ));
            self.pace = (0, 0, 0, Instant::now());
        }
        self.sample_scopes();
    }

    /// Gestures, from the PC's webcam or from the camera's own picture.
    fn poll_gestures(&mut self, now: f64) {
        use opc_monitor::appsettings::GestureSource;
        // The viewfinder's switch decides what runs: start or stop to match.
        let wanted = self.shell.gestures();
        if wanted != Some(GestureSource::Webcam) && self.gestures.is_some() {
            self.gestures = None;
        }
        if wanted == Some(GestureSource::Webcam) && self.gestures.is_none() {
            // `start` finds a webcam or says why not; ask once per switch.
            if !self.webcam_tried {
                self.webcam_tried = true;
                self.gestures = crate::webcam::start();
            }
        } else if wanted != Some(GestureSource::Webcam) {
            self.webcam_tried = false;
        }
        if wanted == Some(GestureSource::CameraFeed) {
            self.feed_gestures.get_or_insert_with(FeedGestures::new);
        } else {
            self.feed_gestures = None;
        }
        let mut seen: Vec<opc_monitor::gesture::Gesture> = Vec::new();
        if let Some(webcam) = self.gestures.as_ref() {
            seen.extend(webcam.receiver.try_iter());
        }
        if let (Some(feed), Some(picture)) = (self.feed_gestures.as_mut(), self.latest.as_ref()) {
            let pose = opc_monitor::moves::Waypoint::from_status(self.shell.status());
            seen.extend(feed.read(picture, pose, now));
        }
        if self.shell.hand_overlay() {
            match self.feed_gestures.as_ref() {
                Some(feed) => {
                    let shown = feed.hand.clone().map(|hand| {
                        let pose = opc_monitor::hand::pose_of(&hand);
                        (hand, pose, feed.hold(now))
                    });
                    self.shell.set_hand(&feed.status, shown);
                }
                None => self.shell.set_hand("", None),
            }
        }
        for gesture in seen {
            for intent in self.shell.gesture(gesture, now) {
                if let Intent::Send(command) = intent {
                    self.send(command);
                }
            }
        }
    }

    /// A connected game controller, on the phones' map. Polled once per frame.
    fn poll_pad(&mut self, now: f64) {
        let Some(pad) = self.pad.as_mut() else {
            return;
        };
        let mut intents = Vec::new();
        while let Some(gilrs::Event { id, event, .. }) = pad.next_event() {
            match event {
                gilrs::EventType::Connected => {
                    let name = pad.gamepad(id).name().to_string();
                    self.shell.set_gamepad(Some(name));
                }
                gilrs::EventType::Disconnected => self.shell.set_gamepad(None),
                gilrs::EventType::ButtonPressed(button, _) => {
                    let mapped = match button {
                        gilrs::Button::South => Some(PadButton::A),
                        gilrs::Button::East => Some(PadButton::B),
                        gilrs::Button::West => Some(PadButton::X),
                        gilrs::Button::North => Some(PadButton::Y),
                        gilrs::Button::LeftTrigger => Some(PadButton::LeftShoulder),
                        gilrs::Button::RightTrigger => Some(PadButton::RightShoulder),
                        gilrs::Button::DPadUp => Some(PadButton::DpadUp),
                        gilrs::Button::DPadDown => Some(PadButton::DpadDown),
                        gilrs::Button::DPadLeft => Some(PadButton::DpadLeft),
                        gilrs::Button::DPadRight => Some(PadButton::DpadRight),
                        _ => None,
                    };
                    if let Some(button) = mapped {
                        intents.extend(self.shell.controller_button(button, now));
                    }
                }
                _ => {}
            }
        }
        // The stick and the triggers are read as levels, not events, so a held throw
        // keeps streaming at the frame rate.
        if let Some((_, gamepad)) = pad.gamepads().next() {
            let axis = |axis: gilrs::Axis| f64::from(gamepad.value(axis));
            let (x, y) = (axis(gilrs::Axis::LeftStickX), axis(gilrs::Axis::LeftStickY));
            intents.extend(self.shell.controller_stick(x, y, now));
            let left = f64::from(
                gamepad
                    .button_data(gilrs::Button::LeftTrigger2)
                    .map_or(0.0, |data| data.value()),
            );
            let right = f64::from(
                gamepad
                    .button_data(gilrs::Button::RightTrigger2)
                    .map_or(0.0, |data| data.value()),
            );
            let dt = if self.last_pad_at.is_finite() {
                (now - self.last_pad_at).clamp(0.0, 0.1)
            } else {
                0.0
            };
            intents.extend(self.shell.controller_zoom(left, right, dt, now));
        }
        self.last_pad_at = now;
        for intent in intents {
            if let Intent::Send(command) = intent {
                self.send(command);
            }
        }
    }

    /// Reads the picture for the plates at about 15 Hz while any scope is on.
    fn sample_scopes(&mut self) {
        if !self.shell.scopes_wanted() {
            return;
        }
        let now = self.now();
        if now - self.last_scope_at < 1.0 / 15.0 {
            return;
        }
        if let Some(latest) = self.latest.as_ref() {
            self.shell
                .set_scope_samples(opc_monitor::scopes::ScopeSamples::read(latest));
            self.last_scope_at = now;
        }
    }

    /// Starts, stops or swaps the virtual camera to match the setting, and keeps the
    /// System tab's readout current about once a second.
    fn reconcile_vcam(&mut self, now: f64) {
        let wanted = self.shell.vcam_backend();
        let running = self.vcam.as_ref().map(VirtualCamera::backend);
        if running != wanted.as_ref() {
            if let Some(camera) = self.vcam.take() {
                camera.stop();
            }
            self.vcam = wanted.map(VirtualCamera::start);
            self.last_vcam_status_at = f64::NEG_INFINITY;
        }
        if now - self.last_vcam_status_at < 1.0 {
            return;
        }
        self.last_vcam_status_at = now;
        let line = self
            .vcam
            .as_ref()
            .map_or_else(|| "Off".to_string(), |camera| camera.status().line());
        self.shell.set_vcam_status(&line);
    }

    /// Hands the picture to the virtual camera at up to 30 frames a second: the feed
    /// on the viewfinder, the clip or the still in the player, nothing under the
    /// library. The chrome is never in it.
    fn feed_vcam(&mut self, picture: &opc_decode::Picture<'_>, now: f64) {
        let Some(camera) = self.vcam.as_ref() else {
            return;
        };
        if now - self.last_vcam_at < 1.0 / 30.0 {
            return;
        }
        if self.shell.screen() == Screen::Library {
            return;
        }
        let Some(renderer) = self.renderer.as_mut() else {
            return;
        };
        let options = self.shell.vcam_grade_options();
        match renderer.render_picture(picture, (opc_vcam::WIDTH, opc_vcam::HEIGHT), options) {
            Ok(image) => {
                camera.offer(opc_vcam::Frame {
                    width: image.width,
                    height: image.height,
                    rgba: image.pixels,
                });
                self.last_vcam_at = now;
            }
            Err(error) => eprintln!("virtual camera frame failed: {error}"),
        }
    }

    fn draw(&mut self) {
        let started = Instant::now();
        self.draw_frame();
        self.note_render_time(started.elapsed());
    }

    /// Once a second, how many frames were drawn and what each cost, in the log: what
    /// to read when fullscreen is slower than a window.
    fn note_render_time(&mut self, spent: Duration) {
        self.render_stats.0 += 1;
        self.render_stats.1 += spent;
        if self.render_stats.2.elapsed() >= Duration::from_secs(1) {
            let (draws, total, _) = self.render_stats;
            let size = self.window.as_ref().map(|w| w.inner_size());
            diagnostic(format_args!(
                "render: {draws} draws/s, {:.2} ms each on the CPU, window {:?}",
                total.as_secs_f64() * 1000.0 / f64::from(draws.max(1)),
                size.map(|s| (s.width, s.height))
            ));
            self.render_stats = (0, Duration::ZERO, Instant::now());
        }
    }

    fn draw_frame(&mut self) {
        self.pump_camera();
        self.decode();
        let now = self.now();
        self.poll_pad(now);
        self.poll_gestures(now);
        self.poll_component_job();
        self.reconcile_vcam(now);
        let intents = self.shell.tick(now);
        self.carry_out_quietly(intents, now);
        for command in self.media.tick(&mut self.shell, now) {
            self.send(command);
        }

        // A screen other than the viewfinder presents its own picture: black under the
        // library, the still in the viewer, the clip's frame in the player.
        let on_screen = self.shell.screen() != Screen::Viewfinder;
        // The live picture is already owned by `self.latest`. Copying its YUV planes
        // for every redraw turns a 25 fps Pocket stream into gigabytes of needless
        // memory traffic per second on an integrated GPU. Borrow it until the render
        // pass completes; only the optional virtual-camera output needs its own copy.
        let latest = if on_screen {
            self.media.picture()
        } else {
            self.latest.as_ref().unwrap_or(&self.placeholder)
        };
        let showing_placeholder = !on_screen && self.latest.is_none();
        if showing_placeholder && self.placeholder_presented {
            return;
        }
        let Some(renderer) = self.renderer.as_mut() else {
            return;
        };

        self.shell.set_source(latest.width, latest.height);
        if !showing_placeholder
            && !on_screen
            && matches!(self.shell.phase(), Phase::Waiting | Phase::Recovering)
        {
            self.shell.set_phase(Phase::Live);
        }

        // Hand the chrome over only when it was redrawn: comparing a fullscreen 4K
        // buffer pixel by pixel every frame costs more than the frame itself.
        let visible = self.shell.chrome(now).is_some();
        let key = (visible, self.shell.chrome_generation());
        if key != self.overlay_key {
            self.overlay_key = key;
            match self.shell.chrome(now) {
                Some(chrome) => renderer.set_overlay(chrome),
                None => renderer.clear_overlay(),
            }
        }

        let picture = latest.picture();
        let options = self.shell.grade_options();

        if self.take_still {
            self.take_still = false;
            let size = (latest.width, latest.height);
            match renderer
                .render(&picture, size, options)
                .map_err(|error| error.to_string())
                .and_then(|image| write_png(&self.still, &image))
            {
                Ok(()) => println!("Wrote {}", self.still.display()),
                Err(error) => eprintln!("could not write the still: {error}"),
            }
        }

        let present = renderer.present(&picture, options);
        // `feed_vcam` owns mutable renderer state, so make a copy only while that
        // optional output is actually running. Normal live view stays zero-copy here.
        let vcam_picture = self.vcam.as_ref().map(|_| latest.clone());
        match present {
            Ok(Presented::Shown) => {
                if self.render_error.take().is_some() {
                    if let Some(window) = self.window.as_ref() {
                        window.set_title("Pocket Monitor");
                    }
                }
                self.placeholder_presented = showing_placeholder;
                if on_screen {
                    self.media.note_presented(now);
                } else if !showing_placeholder {
                    self.shell.note_presented(now);
                    self.note_presented();
                }
            }
            Ok(Presented::Rebuilt) => self.placeholder_presented = false,
            Err(error) => {
                let message = error.to_string();
                if self.render_error.as_deref() != Some(message.as_str()) {
                    eprintln!("present failed: {message}");
                    if let Some(window) = self.window.as_ref() {
                        window.set_title("Pocket Monitor — renderer failed");
                    }
                    self.render_error = Some(message);
                }
                self.shell.set_phase(Phase::Failed(
                    "renderer failed — see terminal output".to_string(),
                ));
            }
        }
        if let Some(vcam_picture) = vcam_picture.as_ref() {
            self.feed_vcam(&vcam_picture.picture(), now);
        }
    }
}

/// winit's key to the shell's. Everything unmapped is dropped here rather than in the
/// shell, so the shell's table stays the whole story.
fn translate(key: &Key) -> Option<UiKey> {
    match key.as_ref() {
        Key::Named(NamedKey::Space) => Some(UiKey::Space),
        Key::Named(NamedKey::Escape) => Some(UiKey::Escape),
        Key::Named(NamedKey::Tab) => Some(UiKey::Tab),
        Key::Named(NamedKey::ArrowLeft) => Some(UiKey::Left),
        Key::Named(NamedKey::ArrowRight) => Some(UiKey::Right),
        Key::Named(NamedKey::ArrowUp) => Some(UiKey::Up),
        Key::Named(NamedKey::ArrowDown) => Some(UiKey::Down),
        Key::Character(text) => text.chars().next().map(UiKey::Char),
        _ => None,
    }
}

/// Whether this access unit can be decoded on its own.
///
/// Only the first coded slice is read: that NAL's type is the picture's type, and the
/// parameter sets ahead of it say nothing about whether it is a refresh. Scanning past
/// it would be reading a whole megabyte a frame to learn nothing new.
fn is_keyframe(access_unit: &[u8]) -> bool {
    let mut index = 0;
    while index + 4 < access_unit.len() {
        let start = if access_unit[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if access_unit[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        let first = access_unit[index + start];
        if codec_of(access_unit) == Some(Codec::H264) {
            return (first & 0x1F) == 5; // AVC IDR
        }
        let nal_type = (first >> 1) & 0x3F;
        if nal_type <= 31 {
            // A coded slice. 16..=23 are BLA through RASL — the types that refresh.
            return (16..=23).contains(&nal_type);
        }
        index += start;
    }
    false
}

/// AVC SPS/PPS packets configure FFmpeg but do not contain a picture. Pocket 3 emits
/// them separately at first connect, and FFmpeg's H.264 decoder reports `no frame`.
fn is_h264_configuration(access_unit: &[u8]) -> bool {
    let mut index = 0;
    let mut configuration = false;
    while index + 4 < access_unit.len() {
        let start = if access_unit[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if access_unit[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        let Some(header) = access_unit.get(index + start) else {
            break;
        };
        match header & 0x1F {
            1..=5 => return false,
            7 | 8 => configuration = true,
            _ => {}
        }
        index += start;
    }
    configuration
}

/// The camera declares its codec in the first Annex-B NAL. Most Pockets send HEVC,
/// but this Pocket 3's live stream is AVC (`67` SPS / `65` IDR), so the decoder must
/// follow the bytes rather than a model assumption.
/// With `OPC_DUMP_STREAM=<path>` set, appends every access unit to that file as a plain
/// Annex-B stream, so ffprobe and ffplay can look at what the camera really sends.
fn dump_unit(bytes: &[u8]) {
    use std::io::Write;
    static FILE: std::sync::OnceLock<Option<std::sync::Mutex<std::fs::File>>> =
        std::sync::OnceLock::new();
    let file = FILE.get_or_init(|| {
        let path = std::env::var_os("OPC_DUMP_STREAM")?;
        std::fs::File::create(path).ok().map(std::sync::Mutex::new)
    });
    if let Some(file) = file {
        if let Ok(mut file) = file.lock() {
            let _ = file.write_all(bytes);
        }
    }
}

fn codec_of(access_unit: &[u8]) -> Option<Codec> {
    let mut index = 0;
    while index + 4 < access_unit.len() {
        let start = if access_unit[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if access_unit[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        let first = *access_unit.get(index + start)?;
        // AVC parameter sets, IDR and ordinary slices have these unambiguous headers.
        if matches!(first & 0x1F, 5 | 7 | 8) {
            return Some(Codec::H264);
        }
        // HEVC VPS/SPS/PPS use types 32, 33 and 34.
        if matches!((first >> 1) & 0x3F, 32..=34) {
            return Some(Codec::Hevc);
        }
        index += start;
    }
    None
}

impl ApplicationHandler for View {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attributes = Window::default_attributes()
            .with_title("Pocket Monitor")
            .with_inner_size(winit::dpi::LogicalSize::new(1280.0, 720.0));
        let window = match event_loop.create_window(attributes) {
            Ok(window) => window,
            Err(error) => {
                eprintln!("could not open a window: {error}");
                event_loop.exit();
                return;
            }
        };
        let size = window.inner_size();
        let handles = window.display_handle().and_then(|display| {
            window
                .window_handle()
                .map(|handle| (display.as_raw(), handle.as_raw()))
        });
        let Ok((display, raw_window)) = handles else {
            eprintln!("this window gave no handles to draw into");
            event_loop.exit();
            return;
        };
        // Safety: `window` is stored below and dropped after `renderer`, so both handles
        // outlive every use of them.
        let renderer = unsafe {
            FeedRenderer::for_window(display, raw_window, size.width.max(1), size.height.max(1))
        };
        match renderer {
            Ok(mut renderer) => {
                if self.shell.toggles().grade {
                    let _ = renderer.set_lut(self.lut.as_ref());
                }
                println!("drawing on {}", renderer.device_name());
                self.shell.set_renderer_name(renderer.device_name());
                self.renderer = Some(renderer);
            }
            Err(error) => {
                eprintln!("could not start the feed pipeline: {error}");
                event_loop.exit();
                return;
            }
        }
        self.shell.set_window(size.width.max(1), size.height.max(1));
        self.window = Some(window);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let now = self.now();
        match event {
            WindowEvent::CloseRequested => {
                self.shell.pointer_cancel();
                let intents = self.shell.control_cancel();
                self.carry_out(intents, event_loop);
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                let (width, height) = (size.width.max(1), size.height.max(1));
                if let Some(renderer) = self.renderer.as_mut() {
                    renderer.resize(width, height);
                }
                self.shell.set_window(width, height);
                self.placeholder_presented = false;
            }
            WindowEvent::KeyboardInput { event, .. } => {
                let Some(key) = translate(&event.logical_key) else {
                    return;
                };
                let intents = match event.state {
                    // A held key repeats. The shell ignores a direction already down,
                    // and the rest are one-shot actions winit does not repeat for us.
                    ElementState::Pressed if event.repeat => return,
                    ElementState::Pressed => self.shell.press(key, now),
                    ElementState::Released => self.shell.release(key, now),
                };
                self.carry_out(intents, event_loop);
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.shell.note_time(now);
                self.pointer = (position.x, position.y);
                let intents = if self.pointer_control {
                    self.shell.control_moved(position.x, position.y)
                } else {
                    self.shell.slint_pointer_moved(position.x, position.y);
                    self.shell.pointer_moved(position.x, position.y);
                    Vec::new()
                };
                self.carry_out(intents, event_loop);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                self.shell.note_time(now);
                let (x, y) = self.pointer;
                // A notch of a wheel is a few rows; a trackpad reports pixels already.
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(dx, dy) => {
                        (f64::from(dx) * 40.0, f64::from(dy) * 40.0)
                    }
                    MouseScrollDelta::PixelDelta(pos) => (pos.x, pos.y),
                };
                let intents = self.shell.control_scroll(x, y, dx, dy);
                self.carry_out(intents, event_loop);
            }
            WindowEvent::MouseInput {
                button: MouseButton::Left,
                state,
                ..
            } => {
                self.shell.note_time(now);
                let (x, y) = self.pointer;
                match state {
                    ElementState::Pressed => match self.shell.control_down(x, y, now) {
                        Some(intents) => {
                            self.pointer_control = true;
                            self.carry_out(intents, event_loop);
                        }
                        None => self.shell.pointer_down(x, y),
                    },
                    ElementState::Released => {
                        let intents = if self.pointer_control {
                            self.pointer_control = false;
                            self.shell.control_up(x, y, now)
                        } else {
                            self.shell.pointer_up(x, y, now)
                        };
                        self.carry_out(intents, event_loop);
                    }
                }
            }
            WindowEvent::Touch(touch) => {
                let finger = match touch.phase {
                    TouchPhase::Started => Finger::Started,
                    TouchPhase::Moved => Finger::Moved,
                    TouchPhase::Ended => Finger::Ended,
                    TouchPhase::Cancelled => Finger::Cancelled,
                };
                let (x, y) = (touch.location.x, touch.location.y);
                let intents = self.shell.touch(touch.id, finger, x, y, now);
                self.carry_out(intents, event_loop);
            }
            WindowEvent::Focused(false) => {
                self.shell.pointer_cancel();
                let intents = self.shell.control_cancel();
                self.carry_out(intents, event_loop);
                self.pointer_control = false;
            }
            WindowEvent::RedrawRequested => {
                let started = Instant::now();
                let gap = started.duration_since(self.last_draw);
                self.last_draw = started;
                self.draw();
                let took = started.elapsed();
                if took > Duration::from_millis(40) || gap > Duration::from_millis(100) {
                    diagnostic(format_args!(
                        "slow: draw took {} ms, {} ms since the last draw",
                        took.as_millis(),
                        gap.as_millis()
                    ));
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.sync_repair_blocked();
        if self.latest.is_some()
            || self.media.is_active()
            || self.shell.screen() != Screen::Viewfinder
        {
            // Present at display rate, not as fast as a core can spin. The camera and
            // ACK pump run on their own thread; 60 Hz keeps 25/30/50 fps streams fresh
            // while leaving CPU/GPU room for decode and Vulkan.
            event_loop.set_control_flow(ControlFlow::WaitUntil(
                Instant::now() + Duration::from_millis(16),
            ));
        } else {
            // No picture yet: sleep until the next event to avoid spinning the GPU.
            event_loop.set_control_flow(ControlFlow::Wait);
        }
        if let Some(window) = self.window.as_ref() {
            window.request_redraw();
        }
    }
}

/// Opens the camera link and a window on it, and runs until the window closes.
pub fn run(options: Options) -> Result<(), String> {
    let link = match options.phone.clone() {
        Some(target) => Feed::Phone(PhoneLink::open(target)),
        None => {
            let (session_id, base_seq) = fresh_session();
            // A camera on the operator's own Wi-Fi serves its media there, not at the
            // SoftAP address the library would otherwise fetch from.
            if let Some(remote) = options.remote {
                opc_media::model::set_host(&remote.ip().to_string());
            }
            Feed::Camera(Link::open(
                options.remote,
                session_id,
                base_seq,
                options.model_id,
            ))
        }
    };
    let graded = options.lut.is_some();

    let mut view = View {
        renderer: None,
        window: None,
        shell: Shell::new()
            .with_grade(graded)
            .with_model(options.model_id)
            .with_saved_prefs(),
        media: {
            let mut media = MediaDriver::default();
            media.set_body(options.model_id);
            media
        },
        last_scope_at: f64::NEG_INFINITY,
        pad: gilrs::Gilrs::new()
            .map_err(|error| eprintln!("no game controller support: {error}"))
            .ok(),
        last_pad_at: f64::NEG_INFINITY,
        gestures: None,
        feed_gestures: None,
        webcam_tried: false,
        overlay_key: (false, u64::MAX),
        render_stats: (0, Duration::ZERO, Instant::now()),
        remote: options.remote,
        phone: options.phone.clone(),
        model_id: options.model_id,
        camera_id: options
            .model_id
            .map(|id| format!("model-{id:04x}"))
            .unwrap_or_else(|| "camera".to_string()),
        link,
        decoder: None,
        pending: Vec::new(),
        latest: None,
        ready: std::collections::VecDeque::new(),
        pace: (0, 0, 0, Instant::now()),
        last_draw: Instant::now(),
        placeholder: OwnedPicture::black(1280, 720),
        placeholder_presented: false,
        render_error: None,
        repair_blocked: false,
        lut: options.lut,
        false_color: None,
        still: options.still,
        take_still: false,
        pointer: (0.0, 0.0),
        pointer_control: false,
        started: Instant::now(),
        vcam: None,
        last_vcam_at: f64::NEG_INFINITY,
        last_vcam_status_at: f64::NEG_INFINITY,
        component_job: None,
    };
    view.start_component_job(opc_vcam::install::probe);
    match &options.phone {
        Some(target) => {
            view.shell
                .set_link_info(&format!("Phone relay · {}", target.name));
            view.shell.set_phone(Some(opc_monitor::sheets::PhoneInfo {
                host: target.name.clone(),
                ..Default::default()
            }));
        }
        None => view.shell.set_link_info(&format!(
            "Wi-Fi datalink · {}",
            options
                .remote
                .map_or_else(|| "camera default".to_string(), |addr| addr.to_string())
        )),
    }
    if let Some(pad) = view.pad.as_ref() {
        if let Some((_, gamepad)) = pad.gamepads().next() {
            view.shell.set_gamepad(Some(gamepad.name().to_string()));
        }
    }
    {
        let folder = luts::custom_folder();
        let _ = std::fs::create_dir_all(&folder);
        view.shell.set_lut_menu(opc_monitor::LutMenu {
            builtin: opc_render::built_in_names(),
            custom: luts::list_custom(&folder),
            folder: folder.display().to_string(),
        });
    }
    view.shell.set_phase(Phase::Waiting);

    let event_loop = EventLoop::new().map_err(|error| format!("no window system: {error}"))?;
    event_loop
        .run_app(&mut view)
        .map_err(|error| format!("the window closed unexpectedly: {error}"))
}

/// A session id and an 8-aligned base sequence, fresh per connect. A fixed base can
/// wedge the camera, so this must not be a constant.
fn fresh_session() -> (u16, u16) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.subsec_nanos())
        .unwrap_or(1);
    let session_id = (nanos & 0xFFFF) as u16 | 1;
    let base_seq = ((nanos >> 8) & 0xFFF8) as u16;
    (session_id, base_seq)
}


/// Gestures read from the camera's own picture: the operator stands in front of the
/// lens. The hand model runs on its own thread, so the picture never waits for it. The
/// gimbal moving shifts the whole scene, so sweeps are ignored while it moves and for
/// a moment after; held poses do not depend on that.
struct FeedGestures {
    worker: opc_monitor::handnet::HandWorker,
    holder: opc_monitor::hand::Holder,
    sweep: opc_monitor::hand::Sweep,
    last_sent: f64,
    last_pose: Option<(f64, f64)>,
    moving_until: f64,
    /// The latest hand found, for the hand view.
    hand: Option<opc_monitor::handnet::Hand>,
    /// What the model runs on and how long it takes, for the hand view.
    status: String,
    provider: &'static str,
}

impl FeedGestures {
    fn new() -> Self {
        Self {
            worker: opc_monitor::handnet::HandWorker::start(),
            holder: opc_monitor::hand::Holder::default(),
            sweep: opc_monitor::hand::Sweep::new(true),
            last_sent: f64::NEG_INFINITY,
            last_pose: None,
            moving_until: 0.0,
            hand: None,
            status: "loading the hand model".to_string(),
            provider: "",
        }
    }

    /// How far the pose in view is through its hold, 0 to 1.
    fn hold(&self, now: f64) -> f32 {
        self.holder.progress(now).map_or(0.0, |(_, done)| done)
    }

    fn read(
        &mut self,
        picture: &opc_decode::OwnedPicture,
        pose: Option<opc_monitor::moves::Waypoint>,
        now: f64,
    ) -> Vec<opc_monitor::gesture::Gesture> {
        use opc_monitor::gesture::Gesture;
        use opc_monitor::hand::{pose_of, Pose};
        use opc_monitor::handnet::Update;

        if let Some(pose) = pose {
            if let Some((yaw, pitch)) = self.last_pose {
                if (pose.yaw - yaw).abs() > 0.3 || (pose.pitch - pitch).abs() > 0.3 {
                    self.moving_until = now + 1.0;
                }
            }
            self.last_pose = Some((pose.yaw, pose.pitch));
        }
        // Offer a frame at about 20 a second; one is dropped if the model is still busy.
        if now - self.last_sent >= 1.0 / 20.0 && picture.width > 0 && picture.height > 0 {
            let width = 480usize;
            let height = ((width as u64 * u64::from(picture.height)
                / u64::from(picture.width)) as usize)
                .max(2);
            let rgb = opc_monitor::scopes::small_rgb(picture, width, height);
            if self.worker.submit(rgb, width, height) {
                self.last_sent = now;
            }
        }
        let mut found = Vec::new();
        for update in self.worker.updates() {
            match update {
                Update::Ready(provider) => {
                    self.provider = provider;
                    self.status = provider.to_string();
                }
                Update::Failed(error) => {
                    self.status = format!("model failed: {error}");
                }
                Update::Seen(hand, ms) => {
                    if !self.provider.is_empty() {
                        self.status = format!("{} {ms:.0} ms", self.provider);
                    }
                    let swipe = self.sweep.feed(hand.as_ref(), now);
                    if now >= self.moving_until {
                        found.extend(swipe);
                    }
                    let seen = hand.as_ref().and_then(pose_of);
                    if let Some(pose) = self.holder.feed(seen, now) {
                        found.push(match pose {
                            Pose::Fist => Gesture::Fist,
                            Pose::Point => Gesture::Point,
                            Pose::Two => Gesture::Two,
                            Pose::Palm => Gesture::Palm,
                        });
                    }
                    self.hand = hand;
                }
            }
        }
        if !found.is_empty() {
            // Putting the hand down afterwards must not read as a sweep.
            self.sweep.hold_off(now);
        }
        found
    }
}
