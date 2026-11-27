//! The media player (§1.V): a clip or a still from the camera, through the same native
//! feed pipeline as live view, so the LUT, zebra, peaking, false colour and mirror work
//! on playback exactly as they do on the live picture. Never a web `<video>` (§2.2).
//!
//! `opc-monitor`'s `media.rs` player, on its own `pm-player` thread: an
//! `opc_decode::FileReader` (frame-threaded, V4) decodes [`LOOKAHEAD`] pictures ahead of
//! the clock; each is pushed to the render thread when its time comes
//! ([`PictureHub::push_player`], which also holds the live feed back while a clip is
//! up); the clip's sound goes to the default output through cpal, 80 ms ahead of the
//! picture, silent at conform speeds (V2, the numbers in `pm_controller::playback`).
//! `player://state` carries the position at ≤ 10 Hz and everything else on change. The
//! eight-frame filmstrip is served as PNGs on `pm://strip/<version>/<n>`, never JSON.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use opc_decode::{FileReader, OwnedPicture};
use opc_media::MediaFile;
use pm_controller::library::Conform;
use pm_controller::link::log_line;
use pm_controller::luts;
use pm_controller::playback::{self, AudioStage, PlayClock, Release, LOOKAHEAD, STRIP_WIDTH};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::picture::PictureHub;

/// `player://state` position updates at most this often.
const POSITION_PERIOD: f64 = 0.1;

/// `player://state`.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub open: bool,
    pub id: String,
    pub is_photo: bool,
    pub proxy: bool,
    pub playing: bool,
    pub ended: bool,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub capture_rate: f64,
    pub conform_targets: Vec<f64>,
    pub conform: Option<f64>,
    pub conform_label: String,
    pub speed: f64,
    pub muted: bool,
    pub looping: bool,
    /// The filmstrip's URL version and frame count (`pm://strip/<version>/<n>`).
    pub strip_version: u32,
    pub strip_count: u32,
    /// The take's colour mode from the original's tail, for the auto LUT; a proxy is
    /// Rec.709 whatever the take was, so this is only known with the original cached.
    pub color_mode: Option<u8>,
    pub error: Option<String>,
}

enum PlayerMsg {
    Clip {
        file: MediaFile,
        local: PathBuf,
        proxy: bool,
        color_mode: Option<u8>,
    },
    Still {
        file: MediaFile,
        picture: opc_media::thumbs::Rgba,
    },
    Toggle(Option<bool>),
    Seek(i64),
    Speed(f64),
    ConformNext,
    Conform(Option<f64>),
    Options {
        muted: Option<bool>,
        looping: Option<bool>,
    },
    Close,
    Stop,
}

/// The player in Tauri state.
pub struct PlayerService {
    tx: Mutex<Sender<PlayerMsg>>,
    open: Arc<AtomicBool>,
    state: Arc<Mutex<PlayerState>>,
    /// The filmstrip: PNG bytes per frame, and the version they belong to.
    strip: Arc<Mutex<(u32, Vec<Vec<u8>>)>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for PlayerService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlayerService").finish_non_exhaustive()
    }
}

impl PlayerService {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = channel();
        let open = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(PlayerState::default()));
        let strip = Arc::new(Mutex::new((0, Vec::new())));
        let thread = {
            let (open, state, strip) = (open.clone(), state.clone(), strip.clone());
            std::thread::Builder::new()
                .name("pm-player".to_string())
                .spawn(move || run(&app, &rx, &open, &state, &strip))
                .ok()
        };
        Self {
            tx: Mutex::new(tx),
            open,
            state,
            strip,
            thread: Mutex::new(thread),
        }
    }

    fn post(&self, message: PlayerMsg) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(message);
        }
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::Relaxed)
    }

    pub fn state(&self) -> PlayerState {
        self.state.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// A clip on disk (from the media worker).
    pub fn open_clip(&self, file: MediaFile, local: PathBuf, proxy: bool) {
        // The shot colour lives in the original's tail; read it here, off the player's
        // clock, from the cache folder next to the file.
        let original = local
            .parent()
            .and_then(Path::parent)
            .map(|root| root.join("files").join(file.path.replace('/', "_")));
        let color_mode = original
            .filter(|path| path.is_file())
            .and_then(|path| luts::read_tail(&path))
            .and_then(|tail| luts::clip_color_mode(&tail));
        self.open.store(true, Ordering::Relaxed);
        self.post(PlayerMsg::Clip {
            file,
            local,
            proxy,
            color_mode,
        });
    }

    /// A still (from the media worker), shown through the grade as a 4:2:0 picture.
    pub fn open_still(&self, file: MediaFile, picture: opc_media::thumbs::Rgba) {
        self.open.store(true, Ordering::Relaxed);
        self.post(PlayerMsg::Still { file, picture });
    }

    pub fn toggle(&self, playing: Option<bool>) {
        self.post(PlayerMsg::Toggle(playing));
    }

    pub fn seek(&self, position_ms: i64) {
        self.post(PlayerMsg::Seek(position_ms));
    }

    pub fn speed(&self, speed: f64) {
        self.post(PlayerMsg::Speed(speed));
    }

    pub fn conform_next(&self) {
        self.post(PlayerMsg::ConformNext);
    }

    pub fn conform(&self, target: Option<f64>) {
        self.post(PlayerMsg::Conform(target));
    }

    pub fn options(&self, muted: Option<bool>, looping: Option<bool>) {
        self.post(PlayerMsg::Options { muted, looping });
    }

    pub fn close(&self) {
        self.post(PlayerMsg::Close);
    }

    /// `pm://strip/<version>/<n>`.
    pub fn strip_frame(&self, version: u32, index: usize) -> Option<Vec<u8>> {
        let strip = self.strip.lock().ok()?;
        (strip.0 == version)
            .then(|| strip.1.get(index).cloned())
            .flatten()
    }

    pub fn shutdown(&self) {
        self.post(PlayerMsg::Stop);
        if let Some(thread) = self.thread.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = thread.join();
        }
    }
}

/// The clip on screen and the clock it runs on.
struct Clip {
    reader: FileReader,
    ahead: VecDeque<(OwnedPicture, i64)>,
    drained: bool,
    clock: PlayClock,
    stage: AudioStage,
}

struct Player<'a> {
    app: &'a AppHandle,
    hub: Option<Arc<PictureHub>>,
    state: PlayerState,
    clip: Option<Clip>,
    conform: Conform,
    audio: Option<AudioOut>,
    audio_tried: bool,
    started: Instant,
    last_position_emit: f64,
    strip_version: u32,
}

impl Player<'_> {
    fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    fn push(&self, picture: OwnedPicture) {
        if let Some(hub) = &self.hub {
            hub.push_player(picture);
        }
    }

    fn emit(&mut self, shared: &Mutex<PlayerState>) {
        self.state.conform_targets = self.conform.targets.clone();
        self.state.conform = self.conform.current;
        self.state.conform_label = self.conform.label();
        self.state.speed = self.conform.speed();
        self.state.capture_rate = self.conform.capture_rate;
        if let Ok(mut slot) = shared.lock() {
            *slot = self.state.clone();
        }
        let _ = self.app.emit("player://state", self.state.clone());
        self.last_position_emit = self.now();
    }

    fn close(&mut self) {
        let was_open = self.state.open;
        self.clip = None;
        if let Some(audio) = &self.audio {
            audio.clear();
            audio.set_playing(false);
        }
        let (muted, looping) = (self.state.muted, self.state.looping);
        self.state = PlayerState {
            muted,
            looping,
            ..PlayerState::default()
        };
        self.conform = Conform::default();
        if was_open {
            if let Some(hub) = &self.hub {
                // Black until live view is back; then live pictures flow again.
                hub.set_player(false);
                hub.clear();
            }
        }
    }

    fn open_clip(
        &mut self,
        file: MediaFile,
        local: &Path,
        proxy: bool,
        color_mode: Option<u8>,
        strip: &Mutex<(u32, Vec<Vec<u8>>)>,
    ) {
        self.close();
        if self.audio.is_none() && !self.audio_tried {
            self.audio_tried = true;
            self.audio = AudioOut::open();
            if self.audio.is_none() {
                log_line("player", "no audio output; playback is silent");
            }
        }
        let audio_rate = self.audio.as_ref().map_or(0, AudioOut::rate);
        let mut reader = match FileReader::open_with_audio(local, audio_rate) {
            Ok(reader) => reader,
            Err(error) => {
                self.state = PlayerState {
                    open: true,
                    id: file.path.clone(),
                    error: Some(format!("Cannot play: {error}")),
                    ..PlayerState::default()
                };
                return;
            }
        };
        let info = reader.info();
        self.strip_version = self.strip_version.wrapping_add(1);
        let frames = filmstrip(&mut reader, info.duration_ms);
        if let Ok(mut slot) = strip.lock() {
            *slot = (self.strip_version, frames);
        }
        let _ = reader.seek(0);
        if let Some(hub) = &self.hub {
            hub.set_player(true);
        }
        let now = self.now();
        let mut clip = Clip {
            reader,
            ahead: VecDeque::new(),
            drained: false,
            clock: PlayClock::default(),
            stage: AudioStage::default(),
        };
        if let Ok(Some((picture, pts))) = clip.reader.next_picture() {
            self.push(picture);
            clip.clock.shown(pts, now);
        }
        clip.reader.discard_audio();
        if let Some(audio) = &self.audio {
            audio.clear();
            audio.set_playing(true);
        }
        fill_ahead(&mut clip);
        self.conform = Conform::for_clip(info.fps(), file.fps.map_or(0.0, |fps| fps as f64));
        let count = strip.lock().map(|s| s.1.len() as u32).unwrap_or(0);
        self.state = PlayerState {
            open: true,
            id: file.path,
            is_photo: false,
            proxy,
            playing: true,
            ended: false,
            position_ms: clip.clock.shown_ms,
            duration_ms: info.duration_ms,
            strip_version: self.strip_version,
            strip_count: count,
            color_mode,
            muted: self.state.muted,
            looping: self.state.looping,
            ..PlayerState::default()
        };
        self.clip = Some(clip);
    }

    fn open_still(&mut self, file: MediaFile, picture: &opc_media::thumbs::Rgba) {
        self.close();
        if let Some(hub) = &self.hub {
            hub.set_player(true);
        }
        self.push(OwnedPicture::from_rgba(
            picture.width,
            picture.height,
            &picture.pixels,
        ));
        self.state = PlayerState {
            open: true,
            id: file.path,
            is_photo: true,
            muted: self.state.muted,
            looping: self.state.looping,
            ..PlayerState::default()
        };
    }

    fn seek(&mut self, position_ms: i64) {
        let now = self.now();
        let duration = self.state.duration_ms;
        let Some(clip) = self.clip.as_mut() else {
            return;
        };
        let position_ms = position_ms.clamp(0, duration.max(0));
        if clip.reader.seek(position_ms).is_err() {
            return;
        }
        clip.ahead.clear();
        clip.drained = false;
        clip.stage.clear();
        if let Some(audio) = &self.audio {
            audio.clear();
        }
        // Decode up to the asked frame so a scrub lands where the thumb is.
        let mut landed = None;
        while let Ok(Some((picture, pts))) = clip.reader.next_picture() {
            let past = pts >= position_ms;
            landed = Some((picture, pts));
            if past {
                break;
            }
        }
        clip.reader.discard_audio();
        if let Some((picture, pts)) = landed {
            clip.clock.shown(pts, now);
            self.state.position_ms = pts;
            if let Some(hub) = &self.hub {
                hub.push_player(picture);
            }
        }
        self.state.ended = false;
    }

    fn toggle(&mut self, wanted: Option<bool>) {
        if self.clip.is_none() {
            return;
        }
        let playing = wanted.unwrap_or(!self.state.playing);
        // Restarting at the end plays the clip again.
        if playing && self.state.ended {
            self.seek(0);
        }
        self.state.playing = playing;
        let now = self.now();
        if let Some(clip) = self.clip.as_mut() {
            clip.clock.shown_at = now;
        }
        if let Some(audio) = &self.audio {
            audio.set_playing(playing);
        }
    }

    fn set_speed(&mut self, speed: f64) {
        let now = self.now();
        if let Some(clip) = self.clip.as_mut() {
            clip.clock.set_speed(speed, now);
        }
    }

    /// Shows each frame when its time comes. Returns whether the position moved.
    fn tick(&mut self) -> bool {
        if !self.state.playing {
            return false;
        }
        let now = self.now();
        let muted = self.state.muted;
        let Some(clip) = self.clip.as_mut() else {
            return false;
        };
        let target = clip.clock.target_ms(now);
        let mut moved = false;
        let mut show = None;
        while let Some((_, pts)) = clip.ahead.front() {
            if *pts > target {
                break;
            }
            show = clip.ahead.pop_front();
        }
        if let Some((picture, pts)) = show {
            clip.clock.shown(pts, now);
            self.state.position_ms = pts;
            moved = true;
            if let Some(hub) = &self.hub {
                hub.push_player(picture);
            }
        }
        fill_ahead(clip);
        if muted {
            clip.stage.clear();
        }
        let rate = self.audio.as_ref().map_or(0, AudioOut::rate);
        match clip.stage.release(target, rate, clip.clock.speed) {
            Release::Hold => {}
            Release::Silence => {
                if let Some(audio) = &self.audio {
                    audio.clear();
                }
            }
            Release::Push(samples) => {
                if let Some(audio) = &self.audio {
                    audio.push(&samples);
                }
            }
        }
        if clip.drained && clip.ahead.is_empty() {
            if self.state.looping {
                self.seek(0);
            } else {
                self.state.playing = false;
                self.state.ended = true;
                self.state.position_ms = self.state.duration_ms.max(self.state.position_ms);
                if let Some(audio) = &self.audio {
                    audio.set_playing(false);
                }
            }
            return true;
        }
        moved
    }
}

/// Decodes pictures ahead of the clock, and stages the audio that comes with them.
fn fill_ahead(clip: &mut Clip) {
    while !clip.drained && clip.ahead.len() < LOOKAHEAD {
        match clip.reader.next_picture() {
            Ok(Some(next)) => clip.ahead.push_back(next),
            Ok(None) | Err(_) => clip.drained = true,
        }
    }
    let (samples, pts) = clip.reader.take_audio();
    clip.stage.stage(samples, pts);
}

/// Eight frames across the clip, 160 wide, as PNGs for the scrubber. Leaves the reader
/// wherever the last seek put it; the caller seeks back to the start.
fn filmstrip(reader: &mut FileReader, duration_ms: i64) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    for at in playback::strip_positions(duration_ms) {
        if reader.seek(at).is_err() {
            break;
        }
        match reader.next_picture() {
            Ok(Some((picture, _))) => {
                let source = picture.picture();
                let (width, height, pixels) = playback::small_rgba(
                    source.width,
                    source.height,
                    source.luma,
                    source.luma_stride,
                    source.chroma_blue,
                    source.chroma_red,
                    source.chroma_stride,
                    STRIP_WIDTH,
                );
                let image = opc_render::Rgba {
                    width,
                    height,
                    pixels,
                };
                let mut png = Vec::new();
                if opc_render::encode(&mut png, &image).is_ok() {
                    frames.push(png);
                }
            }
            _ => break,
        }
    }
    reader.discard_audio();
    frames
}

fn run(
    app: &AppHandle,
    rx: &Receiver<PlayerMsg>,
    open: &AtomicBool,
    shared: &Mutex<PlayerState>,
    strip: &Mutex<(u32, Vec<Vec<u8>>)>,
) {
    let mut player = Player {
        app,
        hub: app
            .try_state::<Arc<PictureHub>>()
            .map(|hub| hub.inner().clone()),
        state: PlayerState::default(),
        clip: None,
        conform: Conform::default(),
        audio: None,
        audio_tried: false,
        started: Instant::now(),
        last_position_emit: 0.0,
        strip_version: 0,
    };
    loop {
        let wait = if player.state.playing {
            Duration::from_millis(4)
        } else {
            Duration::from_millis(100)
        };
        let first = match rx.recv_timeout(wait) {
            Ok(message) => Some(message),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        // A scrub sends seeks faster than they decode: only the last one counts.
        let mut messages: Vec<PlayerMsg> = first.into_iter().chain(rx.try_iter()).collect();
        let last_seek = messages
            .iter()
            .rposition(|message| matches!(message, PlayerMsg::Seek(_)));
        let mut index = 0;
        messages.retain(|message| {
            let keep = !matches!(message, PlayerMsg::Seek(_)) || Some(index) == last_seek;
            index += 1;
            keep
        });
        let mut changed = false;
        for message in messages {
            changed = true;
            match message {
                PlayerMsg::Stop => {
                    player.close();
                    return;
                }
                PlayerMsg::Clip {
                    file,
                    local,
                    proxy,
                    color_mode,
                } => {
                    if player.hub.is_none() {
                        player.hub = app
                            .try_state::<Arc<PictureHub>>()
                            .map(|hub| hub.inner().clone());
                    }
                    player.open_clip(file, &local, proxy, color_mode, strip);
                }
                PlayerMsg::Still { file, picture } => {
                    if player.hub.is_none() {
                        player.hub = app
                            .try_state::<Arc<PictureHub>>()
                            .map(|hub| hub.inner().clone());
                    }
                    player.open_still(file, &picture);
                }
                PlayerMsg::Toggle(wanted) => player.toggle(wanted),
                PlayerMsg::Seek(position) => player.seek(position),
                PlayerMsg::Speed(speed) => {
                    player.conform.current = None;
                    player.set_speed(speed);
                }
                PlayerMsg::ConformNext => {
                    player.conform.next();
                    let speed = player.conform.speed();
                    player.set_speed(speed);
                }
                PlayerMsg::Conform(target) => {
                    player.conform.set(target);
                    let speed = player.conform.speed();
                    player.set_speed(speed);
                }
                PlayerMsg::Options { muted, looping } => {
                    if let Some(muted) = muted {
                        player.state.muted = muted;
                        if muted {
                            if let Some(audio) = &player.audio {
                                audio.clear();
                            }
                        }
                    }
                    if let Some(looping) = looping {
                        player.state.looping = looping;
                    }
                }
                PlayerMsg::Close => player.close(),
            }
        }
        open.store(player.state.open, Ordering::Relaxed);
        let moved = player.tick();
        let ended_now = player.state.ended;
        if changed
            || ended_now && moved
            || (moved && player.now() - player.last_position_emit >= POSITION_PERIOD)
        {
            player.emit(shared);
        }
    }
}

/// The player's sound: the clip's audio out of the machine's default output device.
/// Moved from `opc-monitor`'s `audio.rs`. The cpal stream is not `Send` on every
/// platform, so it is opened and kept on the player thread.
struct AudioOut {
    stream: cpal::Stream,
    queue: Arc<Mutex<VecDeque<f32>>>,
    rate: u32,
}

/// The rate asked of the device when it offers it; the clips are 48 kHz.
const PREFERRED_RATE: u32 = 48_000;
/// More than this queued is a runaway, not a lead; the rest is dropped.
const MOST_QUEUED_SECONDS: f64 = 2.0;

impl AudioOut {
    fn open() -> Option<Self> {
        let device = cpal::default_host().default_output_device()?;
        let default = device.default_output_config().ok()?;
        let rate = device
            .supported_output_configs()
            .ok()
            .and_then(|configs| {
                configs
                    .filter(|c| c.channels() == 2 && c.sample_format() == cpal::SampleFormat::F32)
                    .find(|c| {
                        c.min_sample_rate().0 <= PREFERRED_RATE
                            && PREFERRED_RATE <= c.max_sample_rate().0
                    })
                    .map(|_| PREFERRED_RATE)
            })
            .unwrap_or(default.sample_rate().0);
        let config = cpal::StreamConfig {
            channels: 2,
            sample_rate: cpal::SampleRate(rate),
            buffer_size: cpal::BufferSize::Default,
        };
        let queue = Arc::new(Mutex::new(VecDeque::new()));
        let feed = Arc::clone(&queue);
        let stream = device
            .build_output_stream(
                &config,
                move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    let mut queued = feed.lock().unwrap_or_else(|e| e.into_inner());
                    for sample in out.iter_mut() {
                        *sample = queued.pop_front().unwrap_or(0.0);
                    }
                },
                |error| log_line("player", format_args!("audio output: {error}")),
                None,
            )
            .ok()?;
        stream.play().ok()?;
        Some(Self {
            stream,
            queue,
            rate,
        })
    }

    fn rate(&self) -> u32 {
        self.rate
    }

    fn push(&self, samples: &[f32]) {
        let mut queued = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let most = (f64::from(self.rate) * 2.0 * MOST_QUEUED_SECONDS) as usize;
        if queued.len() + samples.len() > most {
            return;
        }
        queued.extend(samples.iter().copied());
    }

    fn clear(&self) {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// Holds the device on pause so what is queued waits for the picture.
    fn set_playing(&self, playing: bool) {
        if playing {
            let _ = self.stream.play();
        } else {
            let _ = self.stream.pause();
        }
    }
}

// ───────────── Commands (§3.5 `player_*`) ─────────────

#[tauri::command]
pub fn player_state(player: tauri::State<'_, PlayerService>) -> PlayerState {
    player.state()
}

/// Play or pause; `playing` forces one, absent toggles.
#[tauri::command]
pub fn player_toggle(player: tauri::State<'_, PlayerService>, playing: Option<bool>) {
    player.toggle(playing);
}

/// Where to go, in milliseconds. The web sends ≤ 30 a second while scrubbing; the
/// player thread keeps only the latest it has not reached yet.
#[tauri::command]
pub fn player_seek(player: tauri::State<'_, PlayerService>, position_ms: i64) {
    player.seek(position_ms);
}

/// A playback rate (1 is the clip's own); clears the conform chip.
#[tauri::command]
pub fn player_speed(player: tauri::State<'_, PlayerService>, speed: f64) {
    player.speed(speed);
}

/// The conform chip: the core's next target, or off past the last.
#[tauri::command]
pub fn player_conform_next(player: tauri::State<'_, PlayerService>) {
    player.conform_next();
}

/// A conform target picked directly; `null` is real time.
#[tauri::command]
pub fn player_conform(player: tauri::State<'_, PlayerService>, target: Option<f64>) {
    player.conform(target);
}

#[tauri::command]
pub fn player_options(
    player: tauri::State<'_, PlayerService>,
    muted: Option<bool>,
    looping: Option<bool>,
) {
    player.options(muted, looping);
}

/// The frame on screen, graded, at its own raster, to `Pictures/Pocket Monitor` (the
/// still path, `stills.rs`: the player's frame is the picture on screen).
#[tauri::command]
pub async fn player_screenshot(app: AppHandle) -> Result<String, String> {
    let open = app
        .try_state::<PlayerService>()
        .is_some_and(|player| player.state().open);
    if !open {
        return Err("Nothing is playing.".to_string());
    }
    crate::stills::still_capture(app)
        .await
        .map(|still| still.path)
}

/// Back to the library: the player closes, live view stays held while the grid is up.
#[tauri::command]
pub fn player_close(player: tauri::State<'_, PlayerService>) {
    player.close();
}
