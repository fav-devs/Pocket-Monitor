//! The window's side of the media browser: everything that touches a socket, a file
//! or the clock. The shell decides what the screens show; this fetches, lists, plays
//! and brings live view back.

use std::collections::VecDeque;
use std::path::PathBuf;

use opc_camera::{Command, DumlFrame};
use opc_decode::{FileReader, OwnedPicture};
use opc_media::browse::BrowseConfig;
use opc_media::{
    catalog, Browse, BrowseEvent, BrowseStep, MediaCache, MediaFile, MediaJob, MediaReport,
    MediaWorker, ResumeAction, ResumePolicy,
};
use opc_monitor::library;
use opc_monitor::luts;
use opc_monitor::{MediaAction, Shell};

use crate::audio::AudioOut;

/// Leaving playback: exit until the bit clears, then enable live view.
#[derive(Debug, Clone, Copy)]
struct Resume {
    attempt: u32,
    started: f64,
    last_sent: f64,
    exit_acked: bool,
}

const RESUME_PERIOD: f64 = 0.6;
const SCREEN_PICTURE: (u32, u32) = (1280, 720);
/// Pictures decoded ahead of the clock. Their audio comes with them, so this is also
/// how far ahead the sound can be staged.
const LOOKAHEAD: usize = 8;
/// How far ahead of the picture on screen audio is handed to the device: enough to ride
/// out a late frame, little enough to stay in step.
const AUDIO_LEAD_MS: i64 = 80;

#[derive(Debug, Default)]
pub struct MediaDriver {
    cache: Option<MediaCache>,
    worker: Option<MediaWorker>,
    browse: Option<Browse>,
    resume: Option<Resume>,
    in_playback: bool,
    single_sd: bool,
    special_entry: bool,
    /// The clip on screen and the clock it runs on.
    reader: Option<FileReader>,
    playing: bool,
    /// Presentation time of the frame on screen, and the wall clock it was shown at.
    shown_ms: i64,
    shown_at: f64,
    /// Playback rate: 1 is the clip's own, a conform preview slows it.
    speed: f64,
    /// The next frames, decoded ahead of their time.
    ahead: VecDeque<(OwnedPicture, i64)>,
    /// The clip has no more pictures after those.
    drained: bool,
    /// The device the clip's sound goes to, once a clip has asked for it.
    audio: Option<AudioOut>,
    /// Decoded audio not yet handed to the device, and the time of its first sample.
    staged: Vec<f32>,
    staged_pts: i64,
    /// A clip the operator asked to play; the worker is fetching it.
    pending_play: Option<MediaFile>,
    pending_photo: Option<MediaFile>,
    /// What a screen presents under the chrome: black, a still, or the clip's frame.
    picture: Option<OwnedPicture>,
    /// The last frame presented, so the resume loop can tell fresh from stale.
    last_presented: Option<f64>,
}

impl MediaDriver {
    /// Which body this is decides the store rule and the playback entry.
    pub fn set_body(&mut self, model_id: Option<i32>) {
        // Osmo Pocket 3 is `0x0020`: one microSD, and `0x02/0x0c` refused after a take.
        self.single_sd = model_id == Some(0x20);
        self.special_entry = true;
        if let Some(worker) = &self.worker {
            worker.ask(MediaJob::SingleSd(self.single_sd));
        }
    }

    pub fn is_active(&self) -> bool {
        self.browse.is_some() || self.resume.is_some() || self.reader.is_some()
    }

    /// The picture a non-viewfinder screen presents.
    pub fn picture(&mut self) -> &OwnedPicture {
        self.picture
            .get_or_insert_with(|| OwnedPicture::black(SCREEN_PICTURE.0, SCREEN_PICTURE.1))
    }

    pub fn note_presented(&mut self, now: f64) {
        self.last_presented = Some(now);
    }

    fn ensure_worker(&mut self, camera_id: &str) {
        if self.worker.is_none() {
            let cache = MediaCache::for_camera(camera_id);
            self.worker = Some(MediaWorker::spawn(cache.clone(), self.single_sd));
            self.cache = Some(cache);
        }
    }

    /// A camera reply the browser reads.
    pub fn frame(&mut self, frame: DumlFrame, now: f64) {
        if (frame.cmd_set, frame.cmd_id) == (0x02, 0x0C) {
            if let Some(resume) = self.resume.as_mut() {
                resume.exit_acked = true;
            }
        }
        if let Some(browse) = self.browse.as_mut() {
            if (frame.cmd_set, frame.cmd_id) == (0x00, 0x27) {
                browse.note_chunk(now);
            }
            browse.event(BrowseEvent::Frame(frame));
        }
    }

    pub fn status(&mut self, in_playback: bool) {
        self.in_playback = in_playback;
        if let Some(browse) = self.browse.as_mut() {
            browse.event(BrowseEvent::InPlayback(in_playback));
        }
    }

    /// Carries out what the shell asked. Returns the commands to put on the wire.
    pub fn action(
        &mut self,
        shell: &mut Shell,
        action: MediaAction,
        camera_id: &str,
        now: f64,
    ) -> Vec<Command> {
        match action {
            MediaAction::OpenLibrary => {
                self.ensure_worker(camera_id);
                self.resume = None;
                if let Some(cache) = &self.cache {
                    let library = shell.library_mut();
                    if library.files.is_empty() {
                        library.files = cache.load_index();
                    }
                    library.favorites = cache.load_favorites();
                    for file in library.files.clone() {
                        if cache.has_original(&file) {
                            library.cached.insert(file.path.clone());
                        }
                        if cache.cached_proxy(&file).is_some() {
                            library.proxies.insert(file.path.clone());
                        }
                    }
                }
                self.start_browse(now);
            }
            MediaAction::Refresh => {
                self.start_browse(now);
            }
            MediaAction::CloseLibrary => {
                self.browse = None;
                self.stop_player();
                self.picture = None;
                self.save(shell);
                self.resume = Some(Resume {
                    attempt: 0,
                    started: now,
                    last_sent: now - RESUME_PERIOD,
                    exit_acked: false,
                });
            }
            MediaAction::CacheSize => {
                let bytes = self
                    .cache
                    .as_ref()
                    .map_or(0, |cache| folder_size(cache.root()));
                shell.set_cache_size(bytes);
            }
            MediaAction::ClearCache => {
                if let Some(cache) = &self.cache {
                    let root = cache.root().to_path_buf();
                    if let Err(error) = std::fs::remove_dir_all(&root) {
                        eprintln!("could not clear the cache: {error}");
                    }
                    let _ = std::fs::create_dir_all(&root);
                }
                shell.set_cache_size(0);
                shell.say("MEDIA CACHE CLEARED");
            }
            MediaAction::Thumb(file) => {
                if let Some(worker) = &self.worker {
                    worker.ask(MediaJob::Thumb(file));
                }
            }
            MediaAction::Download(file) => {
                if let Some(worker) = &self.worker {
                    worker.ask(MediaJob::Original(file));
                }
            }
            MediaAction::Play(file) => {
                self.pending_play = Some(file.clone());
                shell.library_progress(&file.path, 0, None);
                if let Some(worker) = &self.worker {
                    worker.ask(MediaJob::Proxy(file));
                }
            }
            MediaAction::Photo(file) => {
                self.pending_photo = Some(file.clone());
                shell.library_progress(&file.path, 0, None);
                if let Some(worker) = &self.worker {
                    worker.ask(MediaJob::Photo(file));
                }
            }
            MediaAction::PlayerToggle => {
                self.playing = shell.player().is_some_and(|player| player.playing);
                self.shown_at = now;
                if let Some(audio) = &self.audio {
                    audio.set_playing(self.playing);
                }
                if self.playing && self.reader.is_some() {
                    // Restarting at the end plays the clip again.
                    if let Some(player) = shell.player() {
                        if player.position_ms >= player.duration_ms && player.duration_ms > 0 {
                            self.seek(shell, 0);
                        }
                    }
                }
            }
            MediaAction::Speed(speed) => {
                // Re-anchor the clock so the rate change starts from the frame on screen.
                self.shown_at = now;
                self.speed = if speed.is_finite() && speed > 0.0 {
                    speed
                } else {
                    1.0
                };
            }
            MediaAction::PlayerSeek(position_ms) => {
                self.seek(shell, position_ms);
                self.shown_at = now;
            }
            MediaAction::ClosePlayer => {
                self.stop_player();
                self.picture = None;
            }
        }
        Vec::new()
    }

    fn start_browse(&mut self, now: f64) {
        self.browse = Some(Browse::start(
            BrowseConfig {
                single_sd: self.single_sd,
                special_entry: self.special_entry,
            },
            now,
        ));
    }

    fn save(&self, shell: &Shell) {
        if let Some(cache) = &self.cache {
            let library = shell.library();
            let _ = cache.save_index(&library.files);
            let _ = cache.save_favorites(&library.favorites);
        }
    }

    fn stop_player(&mut self) {
        self.reader = None;
        self.ahead.clear();
        self.drained = false;
        self.staged.clear();
        if let Some(audio) = &self.audio {
            audio.clear();
        }
        self.playing = false;
        self.pending_play = None;
        self.pending_photo = None;
    }

    fn seek(&mut self, shell: &mut Shell, position_ms: i64) {
        let Some(reader) = self.reader.as_mut() else {
            return;
        };
        if reader.seek(position_ms).is_ok() {
            self.ahead.clear();
            self.drained = false;
            self.staged.clear();
            if let Some(audio) = &self.audio {
                audio.clear();
            }
            // Decode up to the asked frame so a scrub lands where the thumb is.
            let mut landed = None;
            while let Ok(Some((picture, pts))) = reader.next_picture() {
                let past = pts >= position_ms;
                landed = Some((picture, pts));
                if past {
                    break;
                }
            }
            if let Some((picture, pts)) = landed {
                self.picture = Some(picture);
                self.shown_ms = pts;
                shell.player_position(pts);
            }
        }
    }

    fn open_clip(
        &mut self,
        shell: &mut Shell,
        file: MediaFile,
        local: PathBuf,
        proxy: bool,
        now: f64,
    ) {
        if self.audio.is_none() {
            self.audio = AudioOut::open();
        }
        let audio_rate = self.audio.as_ref().map_or(0, AudioOut::rate);
        match FileReader::open_with_audio(&local, audio_rate) {
            Ok(mut reader) => {
                let info = reader.info();
                shell.player_strip(&file.path, &filmstrip(&mut reader, info.duration_ms));
                let _ = reader.seek(0);
                let first = reader.next_picture().ok().flatten();
                if let Some((picture, pts)) = first {
                    self.picture = Some(picture);
                    self.shown_ms = pts;
                }
                self.ahead.clear();
                self.drained = false;
                self.staged.clear();
                if let Some(audio) = &self.audio {
                    audio.clear();
                    audio.set_playing(true);
                }
                self.reader = Some(reader);
                self.fill_ahead();
                self.playing = true;
                self.shown_at = now;
                self.speed = 1.0;
                shell.library_file_ready(&file.path, proxy);
                // The shot colour lives in the original's tail; a proxy is Rec.709
                // whatever the take was.
                let tail_color = self
                    .cache
                    .as_ref()
                    .filter(|cache| cache.has_original(&file))
                    .and_then(|cache| luts::read_tail(&cache.original_path(&file)))
                    .and_then(|tail| luts::clip_color_mode(&tail));
                let capture_rate = info.fps();
                let listed = file.fps.map_or(0.0, |fps| fps as f64);
                let targets = library::conform_targets(capture_rate, listed);
                shell.open_player(file, info.duration_ms, proxy, false);
                shell.player_conform_targets(capture_rate, targets);
                shell.auto_lut(tail_color);
            }
            Err(error) => {
                shell.library_failed(&file.path, &format!("cannot play: {error}"));
            }
        }
    }

    /// Decodes pictures ahead of the clock, and stages the audio that comes with them.
    fn fill_ahead(&mut self) {
        let Some(reader) = self.reader.as_mut() else {
            return;
        };
        while !self.drained && self.ahead.len() < LOOKAHEAD {
            match reader.next_picture() {
                Ok(Some(next)) => self.ahead.push_back(next),
                Ok(None) | Err(_) => self.drained = true,
            }
        }
        let (samples, pts) = reader.take_audio();
        if !samples.is_empty() {
            if self.staged.is_empty() {
                self.staged_pts = pts;
            }
            self.staged.extend(samples);
        }
    }

    /// Hands the device the staged audio up to a little past `clock_ms`, dropping what
    /// is already behind it. Anything but the clip's own speed plays silent.
    fn release_audio(&mut self, clock_ms: i64) {
        let Some(audio) = self.audio.as_ref() else {
            self.staged.clear();
            return;
        };
        if self.staged.is_empty() {
            return;
        }
        if self.speed != 1.0 {
            self.staged.clear();
            audio.clear();
            return;
        }
        let per_ms = f64::from(audio.rate()) * 2.0 / 1000.0;
        let frames = |ms: i64| ((ms.max(0) as f64 * per_ms) as usize / 2) * 2;
        let late = frames(clock_ms - AUDIO_LEAD_MS / 2 - self.staged_pts).min(self.staged.len());
        if late > 0 {
            self.staged.drain(..late);
            self.staged_pts += (late / 2) as i64 * 1000 / i64::from(audio.rate());
        }
        let release = frames(clock_ms + AUDIO_LEAD_MS - self.staged_pts).min(self.staged.len());
        if release > 0 {
            audio.push(&self.staged[..release]);
            self.staged.drain(..release);
            self.staged_pts += (release / 2) as i64 * 1000 / i64::from(audio.rate());
        }
    }

    /// Advances everything once per frame. Returns the commands to put on the wire.
    pub fn tick(&mut self, shell: &mut Shell, now: f64) -> Vec<Command> {
        let mut commands = Vec::new();

        // Listing.
        if let Some(browse) = self.browse.as_mut() {
            let mut finished = false;
            for step in browse.tick(now) {
                match step {
                    BrowseStep::Send(command) => commands.push(command),
                    BrowseStep::PageReady {
                        sd,
                        internal,
                        merged,
                        ..
                    } => match catalog::decode_page(&sd, &internal, &merged) {
                        Ok(files) => {
                            let handles: Vec<u32> = files.iter().map(|f| f.handle).collect();
                            let count = files.len();
                            shell.library_listed(files, false);
                            browse.page_decoded(count, &handles, now);
                        }
                        Err(error) => {
                            shell.library_status(format!("The list did not read: {error}"));
                            finished = true;
                        }
                    },
                    BrowseStep::Done => finished = true,
                }
            }
            if finished {
                self.browse = None;
                let count = shell.library().files.len();
                if count == 0 {
                    shell.library_status(
                        "The camera listed nothing. A Pocket 3 lists only after playback opens; try Refresh.",
                    );
                } else {
                    shell.library_listed(Vec::new(), true);
                }
                self.save(shell);
            }
        }

        // Fetches.
        let reports = self
            .worker
            .as_ref()
            .map(MediaWorker::drain)
            .unwrap_or_default();
        for report in reports {
            match report {
                MediaReport::Thumb { path, picture } => {
                    shell.library_thumb(&path, picture.width, picture.height, &picture.pixels);
                }
                MediaReport::Photo { path, picture } => {
                    if let Some(file) = self.pending_photo.take().filter(|file| file.path == path) {
                        self.picture = Some(OwnedPicture::from_rgba(
                            picture.width,
                            picture.height,
                            &picture.pixels,
                        ));
                        shell.library_file_ready(&path, false);
                        shell.open_player(file, 0, false, true);
                    }
                }
                MediaReport::Progress { path, done, total } => {
                    shell.library_progress(&path, done, total);
                }
                MediaReport::Ready { path, local, proxy } => {
                    if let Some(file) = self.pending_play.take().filter(|file| file.path == path) {
                        self.open_clip(shell, file, local, proxy, now);
                    } else {
                        shell.library_file_ready(&path, proxy);
                    }
                }
                MediaReport::Failed { path, reason } => {
                    if self.pending_play.as_ref().is_some_and(|f| f.path == path) {
                        self.pending_play = None;
                    }
                    if self.pending_photo.as_ref().is_some_and(|f| f.path == path) {
                        self.pending_photo = None;
                    }
                    shell.library_failed(&path, &reason);
                }
            }
        }

        // Playback pacing: show each frame when its time comes.
        if self.playing && self.reader.is_some() {
            let target_ms = self.shown_ms + ((now - self.shown_at) * 1000.0 * self.speed) as i64;
            while let Some((_, pts)) = self.ahead.front() {
                if *pts > target_ms {
                    break;
                }
                let (picture, pts) = self.ahead.pop_front().unwrap();
                self.picture = Some(picture);
                self.shown_ms = pts;
                self.shown_at = now;
                shell.player_position(pts);
            }
            self.fill_ahead();
            if self.drained && self.ahead.is_empty() {
                self.playing = false;
                shell.player_ended();
            }
            self.release_audio(target_ms);
        }

        // Leaving playback for live view.
        if let Some(resume) = self.resume.as_mut() {
            if now - resume.last_sent >= RESUME_PERIOD {
                resume.last_sent = now;
                let fresh = ResumePolicy::is_picture_fresh(self.last_presented, resume.started);
                match ResumePolicy::action(
                    resume.attempt,
                    self.in_playback,
                    resume.exit_acked,
                    fresh,
                ) {
                    ResumeAction::ExitPlayback => {
                        resume.attempt += 1;
                        commands.push(Command::ExitPlayback);
                    }
                    ResumeAction::EnableLiveView => {
                        resume.attempt += 1;
                        commands.push(Command::LiveViewEnable);
                    }
                    ResumeAction::Done => self.resume = None,
                }
                if self.resume.is_some_and(|r| r.attempt > 24) {
                    self.resume = None;
                }
            }
        }

        commands
    }
}

/// Eight frames across the clip, small, for the scrubber. Leaves the reader wherever
/// the last seek put it; the caller seeks back to the start.
fn filmstrip(reader: &mut FileReader, duration_ms: i64) -> Vec<(u32, u32, Vec<u8>)> {
    const FRAMES: i64 = 8;
    let mut frames = Vec::new();
    if duration_ms <= 0 {
        return frames;
    }
    for index in 0..FRAMES {
        let at = duration_ms * index / FRAMES;
        if reader.seek(at).is_err() {
            break;
        }
        match reader.next_picture() {
            Ok(Some((picture, _))) => frames.push(strip_frame(&picture)),
            _ => break,
        }
    }
    frames
}

/// A decoded picture to a 160-wide RGBA frame, nearest sampled, BT.709 limited range.
fn strip_frame(picture: &OwnedPicture) -> (u32, u32, Vec<u8>) {
    let source = picture.picture();
    let width = 160u32;
    let height = ((u64::from(source.height) * 160 / u64::from(source.width.max(1))).max(1)) as u32;
    let mut rgba = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        let sy = (y * source.height / height).min(source.height - 1) as usize;
        for x in 0..width {
            let sx = (x * source.width / width).min(source.width - 1) as usize;
            let luma = f32::from(source.luma[sy * source.luma_stride + sx]);
            let cb =
                f32::from(source.chroma_blue[(sy / 2) * source.chroma_stride + sx / 2]) - 128.0;
            let cr = f32::from(source.chroma_red[(sy / 2) * source.chroma_stride + sx / 2]) - 128.0;
            let yy = (luma - 16.0) * 1.1644;
            let r = yy + 1.7927 * cr;
            let g = yy - 0.2132 * cb - 0.5329 * cr;
            let b = yy + 2.1124 * cb;
            let i = ((y * width + x) * 4) as usize;
            rgba[i] = r.clamp(0.0, 255.0) as u8;
            rgba[i + 1] = g.clamp(0.0, 255.0) as u8;
            rgba[i + 2] = b.clamp(0.0, 255.0) as u8;
            rgba[i + 3] = 255;
        }
    }
    (width, height, rgba)
}

/// Every file under `root`, added up.
fn folder_size(root: &std::path::Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(folder) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}
