//! The scope thread (§1.O, P20): WAVE / PARADE / HISTO / VECTOR traces and the LIGHTS,
//! ND and EV readings, sampled from the decoded camera signal and sent to the web view as
//! one binary message per tick on the `scope://samples` channel
//! (`pm_controller::scopes::tap` has the layout).
//!
//! The render thread offers each new picture by reference count — no copy — and only
//! while a plate is on and the tick is due ([`ScopeService::offer`] is one atomic load
//! otherwise). The tick is 15 Hz with up to two trace plates and 10 Hz with more (the
//! phones' budget, capped at the old desktop's 15). Sampling, the core's level table and
//! readings, and the encode all happen here, never on the render or main thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use opc_decode::OwnedPicture;
use opc_render::{DisplayTransform, Transfer};
use pm_controller::effects::ColorAxis;
use pm_controller::link::diagnostic;
use pm_controller::scopes::tap::{encode, Readings, Tap, TapRequest};
use pm_controller::scopes::{LightsReading, NdReading, ScopeScale};
use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::picture::PictureHub;

/// Which plates are on, as the web's assists say (`scopes_configure {plates}`).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ScopePlates {
    /// `'Luma' | 'RGB'` while WAVE is on.
    pub waveform: Option<String>,
    /// `'RGB' | 'YRGB'` while PARADE is on.
    pub parade: Option<String>,
    pub histogram: bool,
    /// The VECTOR zoom (1, 2 or 4) while it is on.
    pub vectorscope: Option<f32>,
    /// LIGHTS (or the histogram's lamps).
    pub lights: bool,
    /// The lamp threshold, `crushClipThreshold` (compensation stops / 10).
    pub lights_threshold: Option<f64>,
    /// The ND chip or the EV meter (both read the picture's stops).
    pub nd: bool,
}

impl ScopePlates {
    pub fn request(&self) -> TapRequest {
        let wave = self.waveform.as_deref().map(str::to_ascii_lowercase);
        let parade = self.parade.as_deref().map(str::to_ascii_lowercase);
        TapRequest {
            wave_luma: wave.as_deref() == Some("luma") || parade.as_deref() == Some("yrgb"),
            wave_rgb: wave.as_deref() == Some("rgb") || parade.is_some(),
            histogram: self.histogram,
            vector: self.vectorscope.is_some(),
            vector_gain: self
                .vectorscope
                .filter(|zoom| zoom.is_finite())
                .unwrap_or(1.0)
                .clamp(1.0, 4.0),
            lights: self.lights,
            lights_threshold: self
                .lights_threshold
                .filter(|value| value.is_finite())
                .unwrap_or(0.0)
                .clamp(0.0, 1.0),
            nd: self.nd,
        }
    }
}

#[derive(Default)]
struct State {
    request: TapRequest,
    channel: Option<Channel<InvokeResponseBody>>,
    picture: Option<Arc<OwnedPicture>>,
    axis: ColorAxis,
    signal: Transfer,
    last_offer: Option<Instant>,
    started: bool,
    stop: bool,
}

/// Lives in the [`PictureHub`]; the thread starts on the first configure.
#[derive(Default)]
pub struct ScopeService {
    on: AtomicBool,
    state: Mutex<State>,
    wake: Condvar,
}

impl std::fmt::Debug for ScopeService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScopeService").finish_non_exhaustive()
    }
}

impl ScopeService {
    /// Render thread, on every new picture: hands it over when a plate is on and the
    /// tick is due. Latest wins; nothing is copied.
    pub fn offer(&self, picture: &Arc<OwnedPicture>) {
        if !self.on.load(Ordering::Relaxed) {
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let due = state
            .last_offer
            .is_none_or(|at| at.elapsed() >= state.request.interval());
        if !due {
            return;
        }
        state.last_offer = Some(Instant::now());
        state.picture = Some(Arc::clone(picture));
        drop(state);
        self.wake.notify_one();
    }

    /// Render thread: the axis the measurements sit on (the signal's), and its curve for
    /// the vectorscope's display transform.
    pub fn set_axis(&self, axis: ColorAxis, signal: Transfer) {
        if let Ok(mut state) = self.state.lock() {
            state.axis = axis;
            state.signal = signal;
        }
    }

    fn configure(
        self: &Arc<Self>,
        request: TapRequest,
        channel: Option<Channel<InvokeResponseBody>>,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let on = request.any() && (channel.is_some() || state.channel.is_some());
        state.request = request;
        if channel.is_some() {
            state.channel = channel;
        }
        if !request.any() {
            // Off: drop the channel and any picture held, so nothing is kept alive.
            state.channel = None;
            state.picture = None;
        }
        state.last_offer = None;
        self.on.store(on, Ordering::Relaxed);
        if on && !state.started {
            state.started = true;
            let service = Arc::clone(self);
            if let Err(error) = std::thread::Builder::new()
                .name("pm-scopes".to_string())
                .spawn(move || service.run())
            {
                state.started = false;
                self.on.store(false, Ordering::Relaxed);
                diagnostic(format_args!("scopes: could not start: {error}"));
            }
        }
    }

    /// Ends the thread (window closing).
    pub fn stop(&self) {
        self.on.store(false, Ordering::Relaxed);
        if let Ok(mut state) = self.state.lock() {
            state.stop = true;
            state.channel = None;
            state.picture = None;
        }
        self.wake.notify_all();
    }

    fn run(&self) {
        let mut sequence = 0u32;
        let mut scale: Option<(ColorAxis, ScopeScale)> = None;
        let mut lights: Option<LightsReading> = None;
        loop {
            let (picture, request, channel, axis, signal) = {
                let Ok(mut state) = self.state.lock() else {
                    return;
                };
                while state.picture.is_none() && !state.stop {
                    state = match self.wake.wait(state) {
                        Ok(state) => state,
                        Err(_) => return,
                    };
                }
                if state.stop {
                    state.started = false;
                    return;
                }
                let picture = state.picture.take().expect("waited for a picture");
                let Some(channel) = state.channel.clone() else {
                    continue;
                };
                (picture, state.request, channel, state.axis, state.signal)
            };
            if !request.any() {
                continue;
            }
            let scale = match &scale {
                Some((cached, table)) if *cached == axis => table.clone(),
                _ => {
                    let table = ScopeScale::from_core(axis.color_mode, axis.iso);
                    scale = Some((axis, table.clone()));
                    // A new axis: the lamps' latch starts again.
                    lights = None;
                    table
                }
            };
            let display = DisplayTransform::new(signal);
            let tap = Tap::read(&picture.picture(), &scale, &display, &request);
            drop(picture);
            let readings = Readings {
                lights: request.lights.then(|| {
                    let reading = LightsReading::from_histograms(
                        [&tap.red, &tap.green, &tap.blue, &tap.luma],
                        axis.color_mode,
                        axis.iso,
                        request.lights_threshold,
                        lights.as_ref(),
                    );
                    lights = Some(reading);
                    reading
                }),
                nd: request
                    .nd
                    .then(|| NdReading::from_luma(&tap.luma, axis.color_mode, axis.iso))
                    .flatten(),
            };
            sequence = sequence.wrapping_add(1);
            let bytes = encode(&tap, &scale, &request, &readings, sequence);
            if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                // The web view went away (a reload configures a new channel).
                if let Ok(mut state) = self.state.lock() {
                    state.channel = None;
                }
                self.on.store(false, Ordering::Relaxed);
            }
        }
    }
}

/// `scopes_configure {plates, channel}`: which plates are on, and the channel the samples
/// go to (every call names one; the newest wins, so a web reload simply re-attaches).
/// `plates: null` (or all off) stops sampling and lets the channel go.
#[tauri::command]
pub fn scopes_configure(
    hub: tauri::State<'_, Arc<PictureHub>>,
    plates: Option<ScopePlates>,
    channel: Channel<InvokeResponseBody>,
) {
    let request = plates.map(|plates| plates.request()).unwrap_or_default();
    hub.scopes.configure(request, Some(channel));
}
