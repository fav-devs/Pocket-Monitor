//! The camera's media library over IPC (§1.U): listing, the cache, fetches, star,
//! delete, and bringing live view back.
//!
//! The decisions are `opc-media`'s (the listing sequence `Browse`, the resume policy,
//! the cache layout, the SoftAP HTTP client) and `pm_controller::library`'s (merged
//! pages, the local star overlay, vouched handles). This is `opc-monitor`'s
//! `media.rs` without the Slint shell: a `pm-media` thread ticks the listing and the
//! resume loop at 50 Hz while either runs, drains the fetch worker, and emits
//! `media://list`, `media://progress` (≤ 4 Hz per file), `media://ready` and
//! `media://failed`. Camera replies reach it from the session thread through
//! [`tap_frame`] and [`tap_status`]; commands go onto the link's channel, never the
//! socket. Thumbnails are not here: `pm://thumb/…` (`uri.rs`) serves them, so a
//! thumbnail never waits behind a proxy download and never crosses JSON.
//!
//! While the library, the player or the resume loop is up, the watchdog's repairs are
//! held (U7), as the old window did.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opc_camera::{Command, DumlFrame};
use opc_media::browse::BrowseConfig;
use opc_media::{
    catalog, Browse, BrowseEvent, BrowseStep, MediaCache, MediaFile, MediaHttp, MediaJob,
    MediaReport, MediaWorker, ResumeAction, ResumePolicy, StorageMemo,
};
use pm_controller::library::{Library, MediaItem};
use pm_controller::link::log_line;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::picture::PictureHub;
use crate::player::PlayerService;

/// The resume loop's period (`ResumePolicy`).
const RESUME_PERIOD: f64 = 0.6;
/// The resume loop gives up after this many sends.
const RESUME_MOST: u32 = 24;
const TICK_ACTIVE: Duration = Duration::from_millis(20);
const TICK_IDLE: Duration = Duration::from_millis(200);
/// `media://progress` per file at most this often.
const PROGRESS_PERIOD: f64 = 0.25;

/// `media://list` and the answer to `media_list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPayload {
    pub items: Vec<MediaItem>,
    pub listing: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    id: String,
    done: u64,
    total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    id: String,
    /// The file on this machine.
    local: String,
    proxy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedPayload {
    id: String,
    reason: String,
}

/// The answer to `media_delete`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePayload {
    pub deleted: Vec<String>,
    pub refused: Vec<String>,
}

/// What a fetch is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Want {
    Play,
    View,
}

#[derive(Debug, Clone, Copy)]
struct Resume {
    attempt: u32,
    started: f64,
    last_sent: f64,
    exit_acked: bool,
}

struct Inner {
    camera_id: String,
    model_id: Option<i32>,
    cache: MediaCache,
    worker: Option<MediaWorker>,
    library: Library,
    loaded: bool,
    browse: Option<Browse>,
    resume: Option<Resume>,
    in_playback: bool,
    /// The library (or the player) is on screen.
    open: bool,
    want: HashMap<String, Want>,
    progress_at: HashMap<String, f64>,
    repair_blocked: bool,
    /// When a live picture last arrived after the resume started.
    live_count: u64,
    last_live: Option<f64>,
    /// Clip metadata sidecars the web sent, by camera path: written beside the original
    /// now if it is cached, else when its download lands (`pm_controller::sidecar`).
    sidecars: HashMap<String, String>,
}

impl Inner {
    fn new(camera_id: String, model_id: Option<i32>) -> Self {
        Self {
            cache: MediaCache::for_camera(&camera_id),
            camera_id,
            model_id,
            worker: None,
            library: Library::default(),
            loaded: false,
            browse: None,
            resume: None,
            in_playback: false,
            open: false,
            want: HashMap::new(),
            progress_at: HashMap::new(),
            repair_blocked: false,
            live_count: 0,
            last_live: None,
            sidecars: HashMap::new(),
        }
    }

    fn single_sd(&self) -> bool {
        // Osmo Pocket 3 is `0x0020`: one microSD, and `0x02/0x0c` refused after a take.
        self.model_id == Some(0x20)
    }

    fn worker(&mut self) -> &MediaWorker {
        let single_sd = self.single_sd();
        let cache = self.cache.clone();
        self.worker
            .get_or_insert_with(|| MediaWorker::spawn(cache, single_sd))
    }

    fn payload(&self) -> ListPayload {
        let status = if self.library.listing {
            if self.library.files.is_empty() {
                "Listing the card…".to_string()
            } else {
                format!("{} files · listing more…", self.library.files.len())
            }
        } else {
            self.library.status.clone()
        };
        ListPayload {
            items: self.library.items(),
            listing: self.library.listing,
            status,
        }
    }

    fn save(&self) {
        let _ = self.cache.save_index(&self.library.files);
        let _ = self.cache.save_favorites(&self.library.favorites);
    }

    fn start_browse(&mut self, now: f64) {
        self.library.listing = true;
        self.library.status.clear();
        self.browse = Some(Browse::start(
            BrowseConfig {
                single_sd: self.single_sd(),
                special_entry: true,
            },
            now,
        ));
    }

    fn active(&self) -> bool {
        self.open || self.browse.is_some() || self.resume.is_some()
    }
}

/// The service in Tauri state.
pub struct MediaService {
    app: AppHandle,
    inner: Arc<Mutex<Inner>>,
    started: Instant,
    stop: Arc<AtomicBool>,
    /// The library grid is on screen and no player is up: the virtual camera rests.
    showing: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    /// Thumbnail fetches, one at a time (the SoftAP server is small), off the IPC thread.
    thumbs: Mutex<(MediaHttp, StorageMemo)>,
}

impl std::fmt::Debug for MediaService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MediaService").finish_non_exhaustive()
    }
}

fn camera_id(model_id: Option<i32>) -> String {
    model_id.map_or_else(|| "camera".to_string(), |id| format!("model-{id:04x}"))
}

impl MediaService {
    pub fn new(app: AppHandle) -> Self {
        let inner = Arc::new(Mutex::new(Inner::new(camera_id(None), None)));
        let stop = Arc::new(AtomicBool::new(false));
        let showing = Arc::new(AtomicBool::new(false));
        let service = Self {
            app: app.clone(),
            inner: inner.clone(),
            started: Instant::now(),
            stop: stop.clone(),
            showing: showing.clone(),
            thread: Mutex::new(None),
            thumbs: Mutex::new((MediaHttp::new(), StorageMemo::new(false))),
        };
        let started = service.started;
        let thread = std::thread::Builder::new()
            .name("pm-media".to_string())
            .spawn(move || run(&app, &inner, started, &stop, &showing))
            .ok();
        if let Ok(mut slot) = service.thread.lock() {
            *slot = thread;
        }
        service
    }

    fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    /// The camera link opened on `remote` for `model_id`. A camera on the operator's own
    /// Wi-Fi serves its media there, not at the SoftAP address (D-6); a new body gets
    /// its own cache folder (`model-XXXX`).
    pub fn note_target(&self, remote: Option<SocketAddr>, model_id: Option<i32>) {
        let host = remote.map_or_else(
            || opc_media::model::HOST.to_string(),
            |a| a.ip().to_string(),
        );
        opc_media::model::set_host(&host);
        if let Ok(mut inner) = self.inner.lock() {
            if inner.model_id != model_id || inner.camera_id != camera_id(model_id) {
                *inner = Inner::new(camera_id(model_id), model_id);
            }
        }
        if let Ok(mut thumbs) = self.thumbs.lock() {
            thumbs.1 = StorageMemo::new(model_id == Some(0x20));
        }
    }

    /// `media_list`: the cached list at once (so the library opens instantly), and a
    /// fresh listing behind it unless one is running. `refresh` lists again regardless.
    pub fn list(&self, refresh: bool) -> ListPayload {
        let now = self.now();
        let Ok(mut inner) = self.inner.lock() else {
            return ListPayload {
                items: Vec::new(),
                listing: false,
                status: String::new(),
            };
        };
        inner.open = true;
        inner.resume = None;
        if !inner.loaded {
            inner.loaded = true;
            let cache = inner.cache.clone();
            if inner.library.files.is_empty() {
                inner.library.files = cache.load_index();
            }
            inner.library.favorites = cache.load_favorites();
            let files = inner.library.files.clone();
            for file in &files {
                if cache.has_original(file) {
                    inner.library.cached.insert(file.path.clone());
                }
                if cache.cached_proxy(file).is_some() {
                    inner.library.proxies.insert(file.path.clone());
                }
            }
        }
        if refresh || inner.browse.is_none() {
            inner.start_browse(now);
        }
        inner.payload()
    }

    fn file(&self, id: &str) -> Result<MediaFile, String> {
        self.inner
            .lock()
            .map_err(|_| "The library is not available.".to_string())?
            .library
            .file(id)
            .cloned()
            .ok_or_else(|| "That file is no longer on the camera.".to_string())
    }

    /// `media_play`: the proxy (or the original) to the cache, then the player opens.
    pub fn play(&self, id: &str) -> Result<(), String> {
        let file = self.file(id)?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.open = true;
        inner.want.insert(file.path.clone(), Want::Play);
        inner.worker().ask(MediaJob::Proxy(file));
        Ok(())
    }

    /// `media_view`: the still, decoded, then the viewer opens on it (graded).
    pub fn view(&self, id: &str) -> Result<(), String> {
        let file = self.file(id)?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.open = true;
        inner.want.insert(file.path.clone(), Want::View);
        inner.worker().ask(MediaJob::Photo(file));
        Ok(())
    }

    /// `media_download`: the original to `files/`, with `media://progress`.
    pub fn download(&self, id: &str) -> Result<(), String> {
        let file = self.file(id)?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.cache.has_original(&file) {
            let local = inner.cache.original_path(&file);
            drop(inner);
            let _ = self.app.emit(
                "media://ready",
                ReadyPayload {
                    id: file.path,
                    local: local.display().to_string(),
                    proxy: false,
                },
            );
            return Ok(());
        }
        inner.worker().ask(MediaJob::Original(file));
        Ok(())
    }

    /// `media_sidecar`: the clip's metadata sidecar from the web, beside the cached
    /// original now, or when its download lands. A clip not on this machine keeps it until
    /// then (the newest wins).
    pub fn sidecar(&self, id: &str, json: String) -> Result<Option<String>, String> {
        pm_controller::sidecar::validate(&json)?;
        let file = self.file(id)?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.cache.has_original(&file) {
            let original = inner.cache.original_path(&file);
            inner.sidecars.remove(&file.path);
            drop(inner);
            let path = pm_controller::sidecar::write_beside(&original, &json)?;
            return Ok(Some(path.display().to_string()));
        }
        inner.sidecars.insert(file.path, json);
        Ok(None)
    }

    /// `media_favorite`: the local star, and the camera's when the record has a handle.
    pub fn favorite(&self, id: &str, on: bool) -> Result<(), String> {
        let command = {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            let command = inner.library.set_favorite(id, on);
            let _ = inner.cache.save_favorites(&inner.library.favorites);
            command
        };
        if let Some(command) = command {
            self.send(command);
        }
        Ok(())
    }

    /// `media_delete`: one delete per vouched handle; the rest is refused and stays.
    pub fn delete(&self, ids: &[String]) -> Result<DeletePayload, String> {
        let (deleted, payload) = {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            let deleted = inner.library.delete(ids);
            for path in &deleted.deleted {
                inner.library.cached.remove(path);
                inner.library.proxies.remove(path);
            }
            inner.save();
            (deleted, inner.payload())
        };
        for command in deleted.commands {
            self.send(command);
        }
        let _ = self.app.emit("media://list", payload);
        Ok(DeletePayload {
            deleted: deleted.deleted,
            refused: deleted.refused,
        })
    }

    /// `media_close` / `media_resume_live`: leave the library and the player, then exit
    /// playback until the bit clears and enable live view (U6).
    pub fn resume_live(&self) {
        let now = self.now();
        if let Some(player) = self.app.try_state::<PlayerService>() {
            player.close();
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.open = false;
            inner.browse = None;
            inner.library.listing = false;
            inner.want.clear();
            inner.save();
            inner.resume = Some(Resume {
                attempt: 0,
                started: now,
                last_sent: now - RESUME_PERIOD,
                exit_acked: false,
            });
            inner.last_live = None;
        }
    }

    /// `media_cache_size`: every byte under this camera's cache folder.
    pub fn cache_size(&self) -> u64 {
        let root = self
            .inner
            .lock()
            .map(|inner| inner.cache.root().to_path_buf())
            .unwrap_or_default();
        folder_size(&root)
    }

    /// `media_cache_clear`.
    pub fn clear_cache(&self) -> Result<(), String> {
        let root = {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.library.cached.clear();
            inner.library.proxies.clear();
            inner.cache.root().to_path_buf()
        };
        if root.exists() {
            std::fs::remove_dir_all(&root)
                .map_err(|e| format!("could not clear the cache: {e}"))?;
        }
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// `pm://thumb/<path>`: the `.scr` JPEG from the cache, or fetched and cached.
    /// Blocking; `uri.rs` calls it on the blocking pool.
    pub fn thumb_bytes(&self, id: &str) -> Result<Vec<u8>, String> {
        let (file, cache) = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            let file = inner
                .library
                .file(id)
                .cloned()
                .ok_or_else(|| "not listed".to_string())?;
            (file, inner.cache.clone())
        };
        if let Some(bytes) = cache.read_thumb(&file) {
            return Ok(bytes);
        }
        if file.thumb_path.is_empty() {
            return Err("no thumbnail".to_string());
        }
        let mut thumbs = self.thumbs.lock().map_err(|e| e.to_string())?;
        // Another request may have fetched it while this one waited.
        if let Some(bytes) = cache.read_thumb(&file) {
            return Ok(bytes);
        }
        let (http, memo) = &mut *thumbs;
        let bytes = http
            .fetch(memo, &file, &file.thumb_path)
            .map_err(|error| error.to_string())?;
        let _ = cache.write_thumb(&file, &bytes);
        Ok(bytes)
    }

    /// `pm://file/<path>`: a cached original on this machine.
    pub fn local_original(&self, id: &str) -> Option<PathBuf> {
        let inner = self.inner.lock().ok()?;
        let file = inner.library.file(id)?;
        let path = inner.cache.original_path(file);
        path.is_file().then_some(path)
    }

    fn send(&self, command: Command) {
        send(&self.app, command);
    }

    /// Camera replies the browser reads (from the session thread).
    pub fn frame(&self, frame: DumlFrame) {
        let now = self.now();
        if let Ok(mut inner) = self.inner.lock() {
            if (frame.cmd_set, frame.cmd_id) == (0x02, 0x0C) {
                if let Some(resume) = inner.resume.as_mut() {
                    resume.exit_acked = true;
                }
            }
            if let Some(browse) = inner.browse.as_mut() {
                if (frame.cmd_set, frame.cmd_id) == (0x00, 0x27) {
                    browse.note_chunk(now);
                }
                browse.event(BrowseEvent::Frame(frame));
            }
        }
    }

    /// The `0x02/0x80` playback bit as the body reports it (from the session thread).
    pub fn status(&self, in_playback: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.in_playback != in_playback {
                inner.in_playback = in_playback;
            }
            if let Some(browse) = inner.browse.as_mut() {
                browse.event(BrowseEvent::InPlayback(in_playback));
            }
        }
    }

    /// The library grid is up without a player over it.
    pub fn library_showing(&self) -> bool {
        self.showing.load(Ordering::Relaxed)
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = thread.join();
        }
    }
}

/// A reply from the camera thread, for the library (tracking replies are not ours).
pub fn tap_frame(app: &AppHandle, frame: DumlFrame) {
    if matches!((frame.cmd_set, frame.cmd_id), (0x02, 0xA5) | (0x02, 0x89)) {
        return;
    }
    if let Some(media) = app.try_state::<MediaService>() {
        media.frame(frame);
    }
}

/// The camera's playback bit, for the library and the resume loop.
pub fn tap_status(app: &AppHandle, in_playback: bool) {
    if let Some(media) = app.try_state::<MediaService>() {
        media.status(in_playback);
    }
}

/// The link opened (from `CameraService::connect`).
pub fn tap_target(app: &AppHandle, remote: Option<SocketAddr>, model_id: Option<i32>) {
    if let Some(media) = app.try_state::<MediaService>() {
        media.note_target(remote, model_id);
    }
}

fn send(app: &AppHandle, command: Command) {
    if let Some(hub) = app.try_state::<Arc<PictureHub>>() {
        if let Ok(slot) = hub.commander.lock() {
            if let Some(commander) = slot.as_ref() {
                commander.send(command);
            }
        }
    }
}

fn set_repair_blocked(app: &AppHandle, blocked: bool) {
    if let Some(hub) = app.try_state::<Arc<PictureHub>>() {
        if let Ok(slot) = hub.commander.lock() {
            if let Some(commander) = slot.as_ref() {
                commander.set_repair_blocked(blocked);
            }
        }
    }
}

/// The `pm-media` thread.
fn run(
    app: &AppHandle,
    inner: &Mutex<Inner>,
    started: Instant,
    stop: &AtomicBool,
    showing: &AtomicBool,
) {
    // What the shared preview was last told (sharing.rs): the old window's `is_active`.
    let mut sharing_media = false;
    while !stop.load(Ordering::Relaxed) {
        let now = started.elapsed().as_secs_f64();
        let mut commands: Vec<Command> = Vec::new();
        let mut events: Vec<(&'static str, serde_json::Value)> = Vec::new();
        let mut player_jobs: Vec<PlayerJob> = Vec::new();
        let (active, blocked_change, playback) = {
            let Ok(mut inner) = inner.lock() else { return };
            tick_browse(&mut inner, now, &mut commands, &mut events);
            drain_worker(&mut inner, now, &mut events, &mut player_jobs);
            tick_resume(app, &mut inner, now, &mut commands);
            let player_open = app
                .try_state::<PlayerService>()
                .is_some_and(|player| player.is_open());
            showing.store(inner.open && !player_open, Ordering::Relaxed);
            let blocked = inner.active() || player_open;
            let change = (blocked != inner.repair_blocked).then(|| {
                inner.repair_blocked = blocked;
                blocked
            });
            let playback = inner.browse.is_some() || inner.resume.is_some() || player_open;
            (inner.active(), change, playback)
        };
        if playback != sharing_media {
            sharing_media = playback;
            crate::sharing::tap_media(app, playback);
        }
        for command in commands {
            send(app, command);
        }
        if let Some(blocked) = blocked_change {
            set_repair_blocked(app, blocked);
        }
        for (name, payload) in events {
            let _ = app.emit(name, payload);
        }
        if let Some(player) = app.try_state::<PlayerService>() {
            for job in player_jobs {
                match job {
                    PlayerJob::Clip { file, local, proxy } => player.open_clip(file, local, proxy),
                    PlayerJob::Still { file, picture } => player.open_still(file, picture),
                }
            }
        }
        std::thread::sleep(if active { TICK_ACTIVE } else { TICK_IDLE });
    }
}

enum PlayerJob {
    Clip {
        file: MediaFile,
        local: PathBuf,
        proxy: bool,
    },
    Still {
        file: MediaFile,
        picture: opc_media::thumbs::Rgba,
    },
}

fn emit_list(inner: &Inner, events: &mut Vec<(&'static str, serde_json::Value)>) {
    if let Ok(value) = serde_json::to_value(inner.payload()) {
        events.push(("media://list", value));
    }
}

fn tick_browse(
    inner: &mut Inner,
    now: f64,
    commands: &mut Vec<Command>,
    events: &mut Vec<(&'static str, serde_json::Value)>,
) {
    let Some(browse) = inner.browse.as_mut() else {
        return;
    };
    let mut finished = false;
    let mut pages: Vec<Vec<MediaFile>> = Vec::new();
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
                    browse.page_decoded(files.len(), &handles, now);
                    pages.push(files);
                }
                Err(error) => {
                    inner.library.status = format!("The list did not read: {error}");
                    finished = true;
                }
            },
            BrowseStep::Done => finished = true,
        }
    }
    let had_pages = !pages.is_empty();
    for files in pages {
        inner.library.listed(files);
    }
    if finished {
        inner.browse = None;
        inner.library.listing = false;
        if inner.library.files.is_empty() && inner.library.status.is_empty() {
            inner.library.status =
                "The camera listed nothing. A Pocket 3 lists only after playback opens; try Refresh."
                    .to_string();
        }
        log_line(
            "media",
            format_args!("listed {} files", inner.library.files.len()),
        );
        inner.save();
    }
    if had_pages || finished {
        emit_list(inner, events);
    }
}

fn drain_worker(
    inner: &mut Inner,
    now: f64,
    events: &mut Vec<(&'static str, serde_json::Value)>,
    player_jobs: &mut Vec<PlayerJob>,
) {
    let reports = inner
        .worker
        .as_ref()
        .map(MediaWorker::drain)
        .unwrap_or_default();
    let mut list_changed = false;
    for report in reports {
        match report {
            // Thumbnails go through `pm://thumb`, not the worker.
            MediaReport::Thumb { .. } => {}
            MediaReport::Photo { path, picture } => {
                inner.progress_at.remove(&path);
                if inner.want.remove(&path) == Some(Want::View) {
                    if let Some(file) = inner.library.file(&path).cloned() {
                        if inner.cache.has_original(&file) {
                            inner.library.cached.insert(path.clone());
                            list_changed = true;
                        }
                        player_jobs.push(PlayerJob::Still { file, picture });
                    }
                }
            }
            MediaReport::Progress { path, done, total } => {
                let due = inner
                    .progress_at
                    .get(&path)
                    .is_none_or(|at| now - at >= PROGRESS_PERIOD);
                let complete = total.is_some_and(|total| done >= total);
                if due || complete {
                    inner.progress_at.insert(path.clone(), now);
                    if let Ok(value) = serde_json::to_value(ProgressPayload {
                        id: path,
                        done,
                        total,
                    }) {
                        events.push(("media://progress", value));
                    }
                }
            }
            MediaReport::Ready { path, local, proxy } => {
                inner.progress_at.remove(&path);
                if proxy {
                    inner.library.proxies.insert(path.clone());
                } else {
                    inner.library.cached.insert(path.clone());
                    // The download path writes the clip's sidecar beside it.
                    if let Some(json) = inner.sidecars.remove(&path) {
                        if let Err(error) = pm_controller::sidecar::write_beside(&local, &json) {
                            log_line("media", format_args!("sidecar not written: {error}"));
                        }
                    }
                }
                list_changed = true;
                if inner.want.get(&path) == Some(&Want::Play) {
                    inner.want.remove(&path);
                    if let Some(file) = inner.library.file(&path).cloned() {
                        player_jobs.push(PlayerJob::Clip {
                            file,
                            local: local.clone(),
                            proxy,
                        });
                    }
                }
                if let Ok(value) = serde_json::to_value(ReadyPayload {
                    id: path,
                    local: local.display().to_string(),
                    proxy,
                }) {
                    events.push(("media://ready", value));
                }
            }
            MediaReport::Failed { path, reason } => {
                inner.progress_at.remove(&path);
                inner.want.remove(&path);
                log_line("media", format_args!("fetch failed: {reason}"));
                if let Ok(value) = serde_json::to_value(FailedPayload { id: path, reason }) {
                    events.push(("media://failed", value));
                }
            }
        }
    }
    if list_changed {
        emit_list(inner, events);
    }
}

fn tick_resume(app: &AppHandle, inner: &mut Inner, now: f64, commands: &mut Vec<Command>) {
    // A live picture after the resume started is the proof the feed is back; the
    // player's frames never count (they are not pushed as live).
    if let Some(hub) = app.try_state::<Arc<PictureHub>>() {
        let count = hub.live_count();
        if count != inner.live_count {
            inner.live_count = count;
            inner.last_live = Some(now);
        }
    }
    let Some(resume) = inner.resume.as_mut() else {
        return;
    };
    if now - resume.last_sent < RESUME_PERIOD {
        return;
    }
    resume.last_sent = now;
    let fresh = ResumePolicy::is_picture_fresh(inner.last_live, resume.started + 0.05);
    match ResumePolicy::action(resume.attempt, inner.in_playback, resume.exit_acked, fresh) {
        ResumeAction::ExitPlayback => {
            resume.attempt += 1;
            commands.push(Command::ExitPlayback);
        }
        ResumeAction::EnableLiveView => {
            resume.attempt += 1;
            commands.push(Command::LiveViewEnable);
            log_line("link", "enable reason=media-resume");
        }
        ResumeAction::Done => inner.resume = None,
    }
    if inner.resume.is_some_and(|r| r.attempt > RESUME_MOST) {
        inner.resume = None;
    }
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

// ───────────── Commands (§3.5 `media_*`) ─────────────

/// Disk and lock work goes to the blocking pool: a handler never stalls the main thread.
async fn blocking<T: Send + 'static>(
    app: AppHandle,
    job: impl FnOnce(&MediaService) -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || job(&app.state::<MediaService>()))
        .await
        .map_err(|error| error.to_string())
}

/// On a phone's shared feed the camera's card is the phone's, not ours (E3).
fn refuse_on_phone(app: &AppHandle) -> Result<(), String> {
    let watching = app
        .try_state::<crate::relay::RelayService>()
        .is_some_and(|relay| relay.watching());
    if watching {
        Err(pm_controller::phone::unavailable_notice("THE LIBRARY"))
    } else {
        Ok(())
    }
}

/// The cached list at once, and a fresh listing behind it (`media://list`).
#[tauri::command]
pub async fn media_list(app: AppHandle, refresh: Option<bool>) -> Result<ListPayload, String> {
    refuse_on_phone(&app)?;
    blocking(app, move |media| media.list(refresh.unwrap_or(false))).await
}

#[tauri::command]
pub async fn media_refresh(app: AppHandle) -> Result<ListPayload, String> {
    refuse_on_phone(&app)?;
    blocking(app, |media| media.list(true)).await
}

/// Fetches the proxy (the original as a fallback) and opens the player on it.
#[tauri::command]
pub async fn media_play(app: AppHandle, id: String) -> Result<(), String> {
    blocking(app, move |media| media.play(&id)).await?
}

/// Fetches a still and opens the viewer on it, graded.
#[tauri::command]
pub async fn media_view(app: AppHandle, id: String) -> Result<(), String> {
    blocking(app, move |media| media.view(&id)).await?
}

/// Fetches the original to the cache; `media://progress`, then `media://ready`.
#[tauri::command]
pub async fn media_download(app: AppHandle, id: String) -> Result<(), String> {
    blocking(app, move |media| media.download(&id)).await?
}

#[tauri::command]
pub async fn media_favorite(app: AppHandle, id: String, favorite: bool) -> Result<(), String> {
    blocking(app, move |media| media.favorite(&id, favorite)).await?
}

/// One delete per vouched handle (the batch delete too); the rest is refused.
#[tauri::command]
pub async fn media_delete(app: AppHandle, ids: Vec<String>) -> Result<DeletePayload, String> {
    blocking(app, move |media| media.delete(&ids)).await?
}

/// Leaves the library and the player, and brings live view back.
#[tauri::command]
pub fn media_close(media: tauri::State<'_, MediaService>) {
    media.resume_live();
}

#[tauri::command]
pub fn media_resume_live(media: tauri::State<'_, MediaService>) {
    media.resume_live();
}

/// The Storage section's size of this camera's cache.
#[tauri::command]
pub async fn media_cache_size(app: AppHandle) -> Result<u64, String> {
    blocking(app, MediaService::cache_size).await
}

#[tauri::command]
pub async fn media_cache_clear(app: AppHandle) -> Result<(), String> {
    blocking(app, MediaService::clear_cache).await?
}

/// The clip's metadata sidecar (`docs/clip-metadata.md`) beside its cached original, or
/// when its download lands. Returns the path when written now.
#[tauri::command]
pub async fn media_sidecar(
    app: AppHandle,
    id: String,
    json: String,
) -> Result<Option<String>, String> {
    blocking(app, move |media| media.sidecar(&id, json)).await?
}

/// "Export markers": the FCPXML / EDL / CSV text into `Videos/Pocket Monitor/Markers`,
/// never over an earlier file. Returns the path.
#[tauri::command]
pub async fn markers_save(file_name: String, contents: String) -> Result<String, String> {
    use pm_controller::sidecar;
    if contents.len() > sidecar::MAX_BYTES {
        return Err("The export is too large.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .ok_or_else(|| "No home folder to save into.".to_string())?;
        let folder = sidecar::markers_folder(std::path::Path::new(&home));
        let path = sidecar::unique_path(&folder, &sidecar::safe_file_name(&file_name));
        sidecar::write_whole(&path, contents.as_bytes())
            .map_err(|e| format!("Could not save the markers: {e}"))?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Puts the media, player, virtual camera and relay services into Tauri state (from
/// `setup`, after the camera service). Each starts its own thread.
pub fn start_services(app: &AppHandle) {
    app.manage(MediaService::new(app.clone()));
    app.manage(PlayerService::new(app.clone()));
    app.manage(crate::vcam::VcamService::new(app.clone()));
    app.manage(crate::relay::RelayService::new(app.clone()));
}

/// Stops them on exit: the relay and the player before the picture goes.
pub fn stop_services(app: &AppHandle) {
    if let Some(relay) = app.try_state::<crate::relay::RelayService>() {
        relay.shutdown();
    }
    if let Some(player) = app.try_state::<PlayerService>() {
        player.shutdown();
    }
    if let Some(media) = app.try_state::<MediaService>() {
        media.shutdown();
    }
    if let Some(vcam) = app.try_state::<crate::vcam::VcamService>() {
        vcam.shutdown();
    }
}
