//! The camera-feed gesture source (§1.T): the hands and faces in the camera's own
//! decoded picture, as the old viewfinder's `FeedGestures` read them.
//!
//! The render thread already holds every decoded live picture by reference count (the
//! scopes take theirs the same way). While the source is on it offers one about 20 times
//! a second ([`OFFER_INTERVAL`]) to the hand models' worker
//! ([`pm_controller::handnet::HandWorker`]) by reference count: no copy, no readback, and
//! a `try_lock` + `try_send`, so the present path never waits. The worker scales the
//! picture to 480 across, runs the MediaPipe palm and landmark models (and YuNet, a few
//! times a second while a face is wanted) on its own thread, and drops a picture that
//! arrives while it is busy. The input thread reads the worker's results
//! ([`VisionService::updates`]) into `pm_controller::vision::FeedReader` and carries out
//! what they come to on `LiveInput`, so nothing here touches the camera link.
//!
//! Gestures act only while the live picture is on screen ([`VisionService::on_screen`]):
//! the old viewfinder ignored them off the viewfinder too. Nothing is recorded or leaves
//! the machine.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use opc_decode::OwnedPicture;
use pm_controller::handnet::{HandWorker, Update};
use pm_controller::link::log_line;
use pm_controller::vision::{FACE_ASK_INTERVAL, FRAME_WIDTH, OFFER_INTERVAL};

#[derive(Debug, Default)]
struct Clock {
    last_offer: Option<Instant>,
    last_face_ask: Option<Instant>,
}

/// The worker and what the render and input threads share about it.
#[derive(Default)]
pub struct VisionService {
    /// The camera feed is the gesture source and gestures are on.
    reading: AtomicBool,
    worker: Mutex<Option<HandWorker>>,
    clock: Mutex<Clock>,
    /// The reader wants faces in the next picture offered.
    want_faces: AtomicBool,
    /// The live picture has a hole on screen.
    hole: AtomicBool,
    /// The media player holds the picture.
    player: AtomicBool,
}

impl std::fmt::Debug for VisionService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VisionService").finish_non_exhaustive()
    }
}

/// The one service.
pub fn service() -> &'static VisionService {
    static SERVICE: OnceLock<VisionService> = OnceLock::new();
    SERVICE.get_or_init(VisionService::default)
}

impl VisionService {
    /// Render thread, on every new live picture: one atomic load while the source is
    /// off; otherwise, when the offer is due and the worker is free, the picture goes to
    /// it by reference count. Never blocks.
    pub fn offer(&self, picture: &Arc<OwnedPicture>) {
        if !self.reading.load(Ordering::Relaxed) || picture.width == 0 || picture.height == 0 {
            return;
        }
        let Ok(mut clock) = self.clock.try_lock() else {
            return;
        };
        let due = clock
            .last_offer
            .is_none_or(|at| at.elapsed().as_secs_f64() >= OFFER_INTERVAL);
        if !due {
            return;
        }
        let faces = self.want_faces.load(Ordering::Relaxed)
            && clock
                .last_face_ask
                .is_none_or(|at| at.elapsed().as_secs_f64() >= FACE_ASK_INTERVAL);
        let Ok(worker) = self.worker.try_lock() else {
            return;
        };
        let Some(worker) = worker.as_ref() else {
            return;
        };
        if worker.submit_picture(Arc::clone(picture), FRAME_WIDTH, faces) {
            let now = Instant::now();
            clock.last_offer = Some(now);
            if faces {
                clock.last_face_ask = Some(now);
            }
        }
    }

    /// Input thread: starts the worker (it loads the models on its own thread) or ends
    /// it (dropping it ends its thread and frees the models).
    pub fn set_reading(&self, on: bool) {
        if self.reading.load(Ordering::Relaxed) == on {
            return;
        }
        let Ok(mut worker) = self.worker.lock() else {
            return;
        };
        if on {
            *worker = Some(HandWorker::start());
            log_line("gestures", "reading the camera's picture");
        } else {
            *worker = None;
            self.want_faces.store(false, Ordering::Relaxed);
            log_line("gestures", "stopped reading the camera's picture");
        }
        if let Ok(mut clock) = self.clock.lock() {
            *clock = Clock::default();
        }
        self.reading.store(on, Ordering::Relaxed);
    }

    /// Input thread: everything the worker reported since the last call.
    pub fn updates(&self) -> Vec<Update> {
        self.worker
            .lock()
            .ok()
            .and_then(|worker| worker.as_ref().map(HandWorker::updates))
            .unwrap_or_default()
    }

    pub fn set_want_faces(&self, on: bool) {
        self.want_faces.store(on, Ordering::Relaxed);
    }

    /// `picture_layout`: whether the live picture has a hole on screen.
    pub fn set_hole(&self, on: bool) {
        self.hole.store(on, Ordering::Relaxed);
    }

    /// The media player took the picture (`true`) or gave it back.
    pub fn set_player(&self, on: bool) {
        self.player.store(on, Ordering::Relaxed);
    }

    /// Whether the live picture is what the operator is looking at: gestures, hand
    /// control and the clap act only then.
    pub fn on_screen(&self) -> bool {
        self.hole.load(Ordering::Relaxed) && !self.player.load(Ordering::Relaxed)
    }
}
