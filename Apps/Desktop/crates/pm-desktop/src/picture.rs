//! The native picture: a Vulkan swapchain under the transparent web view.
//!
//! `docs/desktop-expo-port.md` §3.2–§3.3 and §3.7. The render thread owns the
//! [`FeedRenderer`]. It is fed decoded pictures by the session thread through a small
//! latest-wins queue ([`READY_LIMIT`] deep, the old window's numbers), effects and the
//! web view's hole through the same inbox, and the window size from the main thread. It
//! presents on a new picture or every 16 ms while one exists (the old `WaitUntil(16 ms)`
//! cadence), counts what it shows, and tells the camera thread about every real present —
//! the watchdog's "presented" signal comes from here, not from the web view.

use std::collections::VecDeque;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opc_decode::OwnedPicture;
use opc_render::{fit_in, FalseColorScale, FeedRenderer, Lut, PictureFit, Presented, Rgba};
use pm_controller::decode::READY_LIMIT;
use pm_controller::effects::{feed_state, ColorAxis, FeedState, LutSource, PictureEffects};
use pm_controller::link::{diagnostic, LinkCommander};

use crate::luts::{Lookup, LutStore};
use crate::scopes::ScopeService;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Present cadence while a picture exists.
const FRAME: Duration = Duration::from_millis(16);
/// A draw slower than this, or a gap longer than [`SLOW_GAP`], is logged (P22).
const SLOW_DRAW: Duration = Duration::from_millis(40);
const SLOW_GAP: Duration = Duration::from_millis(100);

/// Where the web view's hole is, in CSS pixels of the viewport.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `picture://fit`: the picture inside the hole, in CSS pixels, from the same formula the
/// blit draws with (`opc_render::fit_in`, on the desqueezed shape, fit or fill). With
/// `fill` it can start outside the hole (the crop).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fit {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub source_width: u32,
    pub source_height: u32,
}

/// `picture://stats`, once a second.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub presented_fps: f32,
    pub decoded: u32,
    pub shown: u32,
    pub skipped: u32,
    pub queued: u32,
    pub last_frame_age_ms: f32,
    pub width: u32,
    pub height: u32,
}

enum RenderMsg {
    Resize(u32, u32),
    Layout(Option<(CssRect, f64)>),
    Effects(Box<PictureEffects>),
    Axis(ColorAxis),
    /// `resizeMode`: whole with bars, or filling the hole.
    Fit(PictureFit),
    /// A cube the LUT store was loading has landed (or failed): bind it now.
    LutReady,
    /// `still_capture`: the graded frame at its source raster, back to the command.
    Still(mpsc::Sender<Result<Rgba, String>>),
    /// Drop the picture (decoder rebuilt, link replaced): black until the next one.
    Clear,
    Stop,
}

#[derive(Default)]
struct Inbox {
    /// Shared, so the scope thread can read the latest picture without a copy.
    ready: VecDeque<Arc<OwnedPicture>>,
    messages: Vec<RenderMsg>,
    decoded: u32,
    skipped: u32,
}

/// What the session, the IPC handlers and the main thread share with the render thread.
pub struct PictureHub {
    inbox: Mutex<Inbox>,
    wake: Condvar,
    /// The camera link's command channel, for `note_presented`.
    pub commander: Arc<Mutex<Option<LinkCommander>>>,
    /// The last second's numbers, for the session's `connection.videoFps`.
    pub stats: Mutex<Stats>,
    /// The media player owns the picture: live pictures are held back (`player.rs`).
    player: std::sync::atomic::AtomicBool,
    /// Live pictures pushed so far, for the media resume loop's "fresh picture" test.
    live_pushed: std::sync::atomic::AtomicU64,
    /// Parsed cubes (`luts.rs`): the render thread only uploads them.
    pub luts: Arc<LutStore>,
    /// The scope thread (`scopes.rs`), fed the latest picture by reference count.
    pub scopes: Arc<ScopeService>,
}

impl std::fmt::Debug for PictureHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PictureHub").finish_non_exhaustive()
    }
}

impl PictureHub {
    pub fn new(commander: Arc<Mutex<Option<LinkCommander>>>) -> Arc<Self> {
        Arc::new(Self {
            inbox: Mutex::new(Inbox::default()),
            wake: Condvar::new(),
            commander,
            stats: Mutex::new(Stats::default()),
            player: std::sync::atomic::AtomicBool::new(false),
            live_pushed: std::sync::atomic::AtomicU64::new(0),
            luts: Arc::new(LutStore::default()),
            scopes: Arc::new(ScopeService::default()),
        })
    }

    fn post(&self, message: RenderMsg) {
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.messages.push(message);
        }
        self.wake.notify_one();
    }

    /// A decoded picture. More than [`READY_LIMIT`] waiting drops the oldest.
    pub fn push(&self, picture: OwnedPicture) {
        use std::sync::atomic::Ordering;
        self.live_pushed.fetch_add(1, Ordering::Relaxed);
        if self.player.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.decoded += 1;
            inbox.ready.push_back(Arc::new(picture));
            while inbox.ready.len() > READY_LIMIT {
                inbox.ready.pop_front();
                inbox.skipped += 1;
            }
        }
        self.wake.notify_one();
    }

    /// A media player picture (a clip frame at its time, or a still). Same queue as live.
    pub fn push_player(&self, picture: OwnedPicture) {
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.ready.push_back(Arc::new(picture));
            while inbox.ready.len() > READY_LIMIT {
                inbox.ready.pop_front();
            }
        }
        self.wake.notify_one();
    }

    /// The player takes the picture over (`true`) or gives it back to live view.
    pub fn set_player(&self, on: bool) {
        self.player.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /// Live pictures pushed so far (counted even while the player holds them back).
    pub fn live_count(&self) -> u64 {
        self.live_pushed.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn clear(&self) {
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.ready.clear();
            inbox.messages.push(RenderMsg::Clear);
        }
        self.wake.notify_one();
    }

    pub fn resize(&self, width: u32, height: u32) {
        self.post(RenderMsg::Resize(width.max(1), height.max(1)));
    }

    pub fn layout(&self, hole: Option<(CssRect, f64)>) {
        self.post(RenderMsg::Layout(hole));
    }

    pub fn effects(&self, effects: PictureEffects) {
        self.post(RenderMsg::Effects(Box::new(effects)));
    }

    pub fn axis(&self, axis: ColorAxis) {
        self.post(RenderMsg::Axis(axis));
    }

    /// `picture_layout`'s `fit`: `"fill"` fills the hole and crops; anything else fits.
    pub fn fit_mode(&self, fill: bool) {
        self.post(RenderMsg::Fit(if fill {
            PictureFit::Cover
        } else {
            PictureFit::Contain
        }));
    }

    /// A cube landed in the LUT store.
    pub fn lut_ready(&self) {
        self.post(RenderMsg::LutReady);
    }

    /// Asks the render thread for a still; the pixels (or why not) come back on `reply`.
    pub fn still(&self, reply: mpsc::Sender<Result<Rgba, String>>) {
        self.post(RenderMsg::Still(reply));
    }

    fn stop(&self) {
        self.scopes.stop();
        self.post(RenderMsg::Stop);
    }
}

/// The surface and the render thread. Lives in Tauri state; torn down on window close,
/// render thread first so the swapchain goes before the window it points at.
#[derive(Default)]
pub struct PictureHost {
    surface: Mutex<Option<pm_surface::PictureSurface>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for PictureHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PictureHost").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize)]
struct PictureError {
    message: String,
}

impl PictureHost {
    /// Main thread: follow the window's client area.
    pub fn resize(&self, hub: &PictureHub, width: u32, height: u32) {
        if let Ok(surface) = self.surface.lock() {
            if let Some(surface) = surface.as_ref() {
                surface.resize(width, height);
            }
        }
        hub.resize(width, height);
    }

    /// Stops the render thread, then destroys the surface.
    pub fn shutdown(&self, hub: &PictureHub) {
        hub.stop();
        if let Some(thread) = self.thread.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = thread.join();
        }
        if let Ok(mut surface) = self.surface.lock() {
            surface.take();
        }
    }
}

fn report(app: &AppHandle, message: String) {
    diagnostic(format_args!("picture: {message}"));
    let _ = app.emit("picture://error", PictureError { message });
}

/// Builds the surface and the renderer on the main thread (AppKit and the child HWND both
/// need it), then hands the renderer to its own thread.
pub fn start(window: WebviewWindow, hub: Arc<PictureHub>) {
    let target = window.clone();
    let result = window.with_webview(move |webview| {
        let app = target.app_handle().clone();
        #[cfg(target_os = "macos")]
        let web_pointer = Some(webview.inner());
        #[cfg(not(target_os = "macos"))]
        let web_pointer = {
            let _ = &webview;
            None
        };
        if let Err(message) = attach(&target, &hub, web_pointer) {
            report(&app, message);
        }
    });
    if let Err(error) = result {
        report(
            window.app_handle(),
            format!("no web view to put the picture under: {error}"),
        );
    }
}

fn attach(
    window: &WebviewWindow,
    hub: &Arc<PictureHub>,
    webview: Option<*mut std::ffi::c_void>,
) -> Result<(), String> {
    use raw_window_handle::{HasDisplayHandle, HasWindowHandle};

    let app = window.app_handle().clone();
    let host = app.state::<PictureHost>();
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let (width, height) = (size.width.max(1), size.height.max(1));
    let display = window
        .display_handle()
        .map_err(|error| error.to_string())?
        .as_raw();
    let parent = window
        .window_handle()
        .map_err(|error| error.to_string())?
        .as_raw();
    let mode = pm_surface::HostMode::from_env();
    // Safety: the window and its web view are live on this (main) thread, and the
    // surface is dropped in `PictureHost::shutdown` before the window goes.
    let surface = unsafe {
        pm_surface::PictureSurface::attach(display, parent, webview, mode, width, height)?
    };
    let (display, raw) = surface.handles();
    // Safety: `surface` is kept in `PictureHost` until after the render thread (and
    // with it the renderer) has stopped.
    let renderer = unsafe { FeedRenderer::for_window(display, raw, width, height) }
        .map_err(|error| format!("could not start the feed pipeline: {error}"))?;
    diagnostic(format_args!(
        "picture: drawing on {} ({mode:?} host, {width}x{height})",
        renderer.device_name()
    ));
    if let Ok(mut slot) = host.surface.lock() {
        *slot = Some(surface);
    }
    let thread_hub = hub.clone();
    let thread_app = app.clone();
    let thread = std::thread::Builder::new()
        .name("pm-render".to_string())
        .spawn(move || render_loop(renderer, thread_hub, &thread_app, (width, height)))
        .map_err(|error| error.to_string())?;
    if let Ok(mut slot) = host.thread.lock() {
        *slot = Some(thread);
    }
    Ok(())
}

/// The render thread's state between presents.
struct Render {
    renderer: FeedRenderer,
    hub: Arc<PictureHub>,
    surface: (u32, u32),
    hole: Option<(CssRect, f64)>,
    fit: PictureFit,
    effects: PictureEffects,
    axis: ColorAxis,
    feed: FeedState,
    lut_loaded: LutSource,
    lut_failed: Option<(LutSource, String)>,
    false_color_loaded: Option<(FalseColorScale, ColorAxis)>,
    unsupported_logged: Vec<&'static str>,
    last_fit: Option<Fit>,
    error: Option<String>,
}

impl Render {
    fn refresh_feed(&mut self, app: &AppHandle) {
        self.feed = feed_state(&self.effects, self.axis);
        if self.feed.unsupported != self.unsupported_logged {
            if !self.feed.unsupported.is_empty() {
                diagnostic(format_args!(
                    "picture: not painted on the desktop: {}",
                    self.feed.unsupported.join(", ")
                ));
            }
            self.unsupported_logged = self.feed.unsupported.clone();
        }
        self.renderer.set_look(self.feed.look);
        self.hub
            .scopes
            .set_axis(self.feed.axis, self.feed.look.signal);
        self.bind_lut(app);
        // The false-colour lattices sit on the signal's axis, as the zebra does.
        let wanted = self.feed.false_color.map(|scale| (scale, self.feed.axis));
        if wanted != self.false_color_loaded {
            let cubes = wanted.and_then(|(scale, axis)| {
                let paint = Lut::false_color(scale, axis.color_mode, axis.iso, true);
                let weight = Lut::false_color(scale, axis.color_mode, axis.iso, false);
                match (paint, weight) {
                    (Ok(paint), Ok(weight)) => Some((paint, weight)),
                    (Err(error), _) | (_, Err(error)) => {
                        report(app, format!("could not load false colour: {error}"));
                        None
                    }
                }
            });
            if let Err(error) = self
                .renderer
                .set_false_color(cubes.as_ref().map(|(paint, weight)| (paint, weight)))
            {
                report(app, format!("could not set false colour: {error}"));
            }
            self.false_color_loaded = wanted;
        }
    }

    /// The cube for `lutId`: parsed by the LUT store off this thread, uploaded here
    /// between frames. Until it lands the previous cube stays bound (no flash to the
    /// ungraded picture for a cube that is one parse away).
    fn bind_lut(&mut self, app: &AppHandle) {
        let wanted = self.feed.lut.clone();
        if wanted == self.lut_loaded {
            return;
        }
        if wanted == LutSource::Off {
            if let Err(error) = self.renderer.set_lut(None) {
                report(app, format!("could not clear the cube: {error}"));
            }
            self.lut_loaded = LutSource::Off;
            return;
        }
        let hub = Arc::clone(&self.hub);
        match self.hub.luts.lattice(&wanted, move || hub.lut_ready()) {
            Lookup::Ready(lattice) => {
                match self.renderer.set_lut_rgba(lattice.size, &lattice.rgba) {
                    Ok(()) => {
                        self.lut_loaded = wanted.clone();
                        self.lut_failed = None;
                        self.hub.luts.retain(&[wanted]);
                    }
                    Err(error) => self.lut_failure(app, wanted, error.to_string()),
                }
            }
            Lookup::Loading => {}
            Lookup::Failed(error) => self.lut_failure(app, wanted, error),
        }
    }

    /// A cube that cannot load is not painted: the picture says so rather than keep
    /// showing the previous look under the new one's name.
    fn lut_failure(&mut self, app: &AppHandle, source: LutSource, error: String) {
        if self.lut_loaded != LutSource::Off {
            if let Err(clear) = self.renderer.set_lut(None) {
                report(app, format!("could not clear the cube: {clear}"));
            }
            self.lut_loaded = LutSource::Off;
        }
        let failure = Some((source, error.clone()));
        if self.lut_failed != failure {
            report(app, format!("could not load the cube: {error}"));
            self.lut_failed = failure;
        }
    }

    /// The hole in surface pixels, or the whole surface without one.
    fn hole_pixels(&self) -> (u32, u32, u32, u32) {
        match self.hole {
            Some((rect, dpr)) => {
                let px = |value: f64| (value * dpr).round().max(0.0) as u32;
                (
                    px(rect.x),
                    px(rect.y),
                    px(rect.width).max(1),
                    px(rect.height).max(1),
                )
            }
            None => (0, 0, self.surface.0, self.surface.1),
        }
    }

    fn emit_fit(&mut self, app: &AppHandle, source: (u32, u32)) {
        let dpr = self.hole.map_or(1.0, |(_, dpr)| dpr).max(0.1);
        let shown = self.feed.look.desqueeze.display_size(source);
        let (x, y, width, height) = fit_in(shown, self.hole_pixels(), self.fit);
        let fit = Fit {
            x: f64::from(x) / dpr,
            y: f64::from(y) / dpr,
            width: f64::from(width) / dpr,
            height: f64::from(height) / dpr,
            source_width: source.0,
            source_height: source.1,
        };
        if self.last_fit != Some(fit) {
            self.last_fit = Some(fit);
            let _ = app.emit("picture://fit", fit);
        }
    }

    /// The graded frame at its source raster, desqueezed, without chrome.
    fn still(&mut self, picture: Option<&OwnedPicture>) -> Result<Rgba, String> {
        let picture = picture.ok_or_else(|| "There is no picture yet.".to_string())?;
        let size = self
            .feed
            .look
            .desqueeze
            .display_size((picture.width, picture.height));
        self.renderer
            .render_picture(&picture.picture(), size, self.feed.grade)
            .map_err(|error| error.to_string())
    }
}

fn render_loop(renderer: FeedRenderer, hub: Arc<PictureHub>, app: &AppHandle, size: (u32, u32)) {
    let hub = &hub;
    let mut render = Render {
        renderer,
        hub: Arc::clone(hub),
        surface: size,
        hole: None,
        fit: PictureFit::Contain,
        effects: PictureEffects::default(),
        axis: ColorAxis::default(),
        feed: feed_state(&PictureEffects::default(), ColorAxis::default()),
        lut_loaded: LutSource::Off,
        lut_failed: None,
        false_color_loaded: None,
        unsupported_logged: Vec::new(),
        last_fit: None,
        error: None,
    };
    let placeholder = OwnedPicture::black(1280, 720);
    let mut latest: Option<Arc<OwnedPicture>> = None;
    let mut latest_at = Instant::now();
    // Black is presented once, then not again until something changes (A10).
    let mut placeholder_presented = false;
    let mut last_draw = Instant::now();
    let mut second = (Instant::now(), 0u32, 0u32);

    loop {
        // Wait for a picture, a message, or the next frame while a picture is up.
        let (messages, next) = {
            let Ok(mut inbox) = hub.inbox.lock() else {
                return;
            };
            let deadline = last_draw + FRAME;
            while inbox.messages.is_empty()
                && inbox.ready.is_empty()
                && (latest.is_none() || Instant::now() < deadline)
            {
                let wait = if latest.is_some() {
                    deadline.saturating_duration_since(Instant::now())
                } else {
                    // Idle: wake now and then for the 1 Hz stats.
                    Duration::from_millis(250)
                };
                let Ok((guard, timeout)) = hub.wake.wait_timeout(inbox, wait) else {
                    return;
                };
                inbox = guard;
                if timeout.timed_out() && latest.is_none() {
                    break;
                }
            }
            let messages = std::mem::take(&mut inbox.messages);
            let next = inbox.ready.pop_front();
            (messages, next)
        };

        let mut dirty = false;
        for message in messages {
            match message {
                RenderMsg::Stop => return,
                RenderMsg::Resize(width, height) => {
                    render.surface = (width, height);
                    render.renderer.resize(width, height);
                    dirty = true;
                }
                RenderMsg::Layout(hole) => {
                    // No hole (the live screen is not mounted) keeps presenting into the
                    // last one, under the opaque web UI. Stopping would starve the
                    // watchdog's "presented" signal and make a route change cost an
                    // enable (G-ENABLE); the old window presented whenever it was open.
                    if let Some(hole) = hole {
                        render.hole = Some(hole);
                        let rect = render.hole_pixels();
                        render.renderer.set_picture_rect(Some(rect));
                        dirty = true;
                    }
                }
                RenderMsg::Effects(effects) => {
                    render.effects = *effects;
                    render.refresh_feed(app);
                    dirty = true;
                }
                RenderMsg::Axis(axis) => {
                    if axis != render.axis {
                        render.axis = axis;
                        render.refresh_feed(app);
                        dirty = true;
                    }
                }
                RenderMsg::Fit(fit) => {
                    if fit != render.fit {
                        render.fit = fit;
                        render.renderer.set_picture_fit(fit);
                        dirty = true;
                    }
                }
                RenderMsg::LutReady => {
                    render.bind_lut(app);
                    dirty = true;
                }
                RenderMsg::Still(reply) => {
                    let _ = reply.send(render.still(latest.as_deref()));
                }
                RenderMsg::Clear => {
                    latest = None;
                    dirty = true;
                }
            }
        }
        if dirty {
            placeholder_presented = false;
        }
        if let Some(picture) = next {
            // The scopes read the camera signal on their own thread (P20).
            hub.scopes.offer(&picture);
            latest = Some(picture);
            latest_at = Instant::now();
            second.1 += 1;
        }

        let started = Instant::now();
        let gap = started.duration_since(last_draw);
        let showing_placeholder = latest.is_none();
        if !(showing_placeholder && placeholder_presented) {
            let shown: &OwnedPicture = latest.as_deref().unwrap_or(&placeholder);
            render.emit_fit(app, (shown.width, shown.height));
            let picture = shown.picture();
            match render.renderer.present(&picture, render.feed.grade) {
                Ok(Presented::Shown) => {
                    if render.error.take().is_some() {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_title("Pocket Monitor");
                        }
                    }
                    placeholder_presented = showing_placeholder;
                    if !showing_placeholder {
                        // The virtual camera's frame and any still asked for (vcam.rs).
                        crate::vcam::after_present(
                            app,
                            &mut render.renderer,
                            &picture,
                            render.feed.grade,
                        );
                        second.2 += 1;
                        if let Ok(commander) = hub.commander.lock() {
                            if let Some(commander) = commander.as_ref() {
                                commander.note_presented();
                            }
                        }
                    }
                }
                Ok(Presented::Rebuilt) => placeholder_presented = false,
                Err(error) => {
                    let message = error.to_string();
                    if render.error.as_deref() != Some(message.as_str()) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_title("Pocket Monitor — renderer failed");
                        }
                        report(app, format!("present failed: {message}"));
                        render.error = Some(message);
                    }
                }
            }
            last_draw = started;
            let took = started.elapsed();
            if !showing_placeholder && (took > SLOW_DRAW || gap > SLOW_GAP) {
                diagnostic(format_args!(
                    "slow: draw took {} ms, {} ms since the last draw",
                    took.as_millis(),
                    gap.as_millis()
                ));
            }
        }

        if second.0.elapsed() >= Duration::from_secs(1) {
            let elapsed = second.0.elapsed().as_secs_f32();
            let (decoded, skipped, queued) = hub
                .inbox
                .lock()
                .map(|mut inbox| {
                    let counts = (inbox.decoded, inbox.skipped, inbox.ready.len() as u32);
                    inbox.decoded = 0;
                    inbox.skipped = 0;
                    counts
                })
                .unwrap_or_default();
            let stats = Stats {
                presented_fps: second.1 as f32 / elapsed,
                decoded,
                shown: second.1,
                skipped,
                queued,
                last_frame_age_ms: latest
                    .as_ref()
                    .map_or(0.0, |_| latest_at.elapsed().as_secs_f32() * 1000.0),
                width: latest.as_ref().map_or(0, |picture| picture.width),
                height: latest.as_ref().map_or(0, |picture| picture.height),
            };
            if latest.is_some() {
                // The old window's line, so the benchmark reads both builds the same way.
                diagnostic(format_args!(
                    "pace: decoded {decoded} shown {} skipped {skipped} queued {queued}",
                    second.1
                ));
            }
            if let Ok(mut slot) = hub.stats.lock() {
                *slot = stats;
            }
            let _ = app.emit("picture://stats", stats);
            second = (Instant::now(), 0, 0);
        }
    }
}
