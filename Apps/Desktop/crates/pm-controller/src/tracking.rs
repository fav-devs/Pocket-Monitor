//! Pointing the camera at something: drag to track, click to focus (§1.K of
//! `docs/desktop-expo-port.md`).
//!
//! The decisions moved out of the Slint shell (`opc-monitor/src/shell.rs`): a drag becomes
//! a box on the sensor (mirroring undone, centre and size on the wire), a drag under 2 %
//! is a click and focuses there, a box under the core's minimum is refused with
//! "FRAME TOO SMALL". Once a box is out, the body is polled every 0.5 s until it locks
//! (six idle answers before a lock end it); its `0x02/0x89` pushes ease the painted box,
//! and 0.35 s of push silence means it let go. A clear ignores the leftover push for the
//! core's beat. A tap focuses with Mimo's four-write burst: the spot and the region now,
//! the hint and the commit after the region's ACK or 0.4 s.
//!
//! Pointers arrive in picture-normalised coordinates *as seen* (0…1 across the fitted
//! picture, outside it on a letterbox bar). One pointer owns a drag: a second finger or a
//! palm is ignored, a pointer that lands off the picture never claims the drag, and a
//! cancelled pointer abandons its box. Pure: every call takes `now` in seconds.

use opc_camera::{Box4, Command, SetOutcome, TrackingPoll, TrackingRules};
use opc_ui::Drag;
use serde::{Deserialize, Serialize};

/// How long a committed box stays drawn before the body has said anything.
pub const BOX_CONFIRM: f64 = 1.5;
/// How long the tap-to-focus reticle stays on the picture.
pub const FOCUS_MARKER_SECONDS: f64 = 1.5;
/// The phones' `0x02/0xA5` cadence, and how many idle answers end a search.
pub const TRACK_POLL_INTERVAL: f64 = 0.5;
pub const TRACK_IDLE_TICKS: u32 = 6;
/// A tap's hint and commit wait this long for the region ACK before going anyway.
pub const TAP_ACK_GRACE: f64 = 0.4;

/// What a pointer did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PointerPhase {
    Down,
    Move,
    Up,
    /// The system took the gesture, a palm landed, or the window lost focus.
    Cancel,
}

/// A rectangle in picture fractions, top-left and size.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn of(rect: (f64, f64, f64, f64)) -> Self {
        Self {
            x: rect.0,
            y: rect.1,
            width: rect.2,
            height: rect.3,
        }
    }
}

/// What the web draws: `tracking://box`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingView {
    /// `idle`, `searching` (a box is out, no lock yet) or `tracking` (locked).
    pub status: &'static str,
    /// The box to draw, as seen (mirroring applied): the body's eased subject once
    /// locked, the committed box while searching.
    #[serde(rename = "box")]
    pub seen: Option<Rect>,
    /// The same box on the sensor.
    pub sensor: Option<Rect>,
    /// A box being dragged right now, as seen.
    pub drag: Option<Rect>,
    /// The tap-focus reticle, as seen.
    pub focus: Option<(f64, f64)>,
    pub mirror: bool,
}

/// A box out with the body, and the polling that decides whether it took. Boxes are on
/// the sensor, top-left and size; mirroring is applied only when they are drawn.
#[derive(Debug, Clone, PartialEq)]
struct TrackingState {
    search: Box4,
    subject: Option<Box4>,
    saw_lock: bool,
    idle_ticks: u32,
    next_poll_at: f64,
    last_push_at: Option<f64>,
}

impl TrackingState {
    fn new(search: Box4, now: f64) -> Self {
        Self {
            search,
            subject: None,
            saw_lock: false,
            idle_ticks: 0,
            next_poll_at: now + TRACK_POLL_INTERVAL,
            last_push_at: None,
        }
    }
}

/// The tracking and tap-focus state machine.
#[derive(Debug, Clone)]
pub struct Tracker {
    drag: Option<Drag>,
    /// The pointer drawing the box. A second one must not take over.
    owner: Option<u64>,
    committed: Option<((f64, f64, f64, f64), f64)>,
    tracking: Option<TrackingState>,
    rules: TrackingRules,
    cleared_at: Option<f64>,
    pending_tap: Option<((f32, f32), f64)>,
    focus_marker: Option<((f64, f64), f64)>,
    next_track_id: u16,
    mirror: bool,
    notices: Vec<&'static str>,
}

impl Default for Tracker {
    fn default() -> Self {
        Self::new(opc_camera::tracking_rules())
    }
}

fn inside(u: f64, v: f64) -> bool {
    u.is_finite() && v.is_finite() && (0.0..=1.0).contains(&u) && (0.0..=1.0).contains(&v)
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

impl Tracker {
    pub fn new(rules: TrackingRules) -> Self {
        Self {
            drag: None,
            owner: None,
            committed: None,
            tracking: None,
            rules,
            cleared_at: None,
            pending_tap: None,
            focus_marker: None,
            next_track_id: 1,
            mirror: false,
            notices: Vec::new(),
        }
    }

    /// The picture is shown mirrored: pointers are undone onto the sensor, boxes are
    /// mirrored when drawn.
    pub fn set_mirror(&mut self, mirror: bool) {
        self.mirror = mirror;
    }

    pub fn mirror(&self) -> bool {
        self.mirror
    }

    /// Operator copy queued since the last call ("FRAME TOO SMALL").
    pub fn take_notices(&mut self) -> Vec<&'static str> {
        std::mem::take(&mut self.notices)
    }

    /// One pointer event at `(u, v)` in picture fractions, as seen.
    pub fn pointer(
        &mut self,
        phase: PointerPhase,
        id: u64,
        u: f64,
        v: f64,
        model_id: i32,
        now: f64,
    ) -> Vec<Command> {
        let mine = self.owner == Some(id);
        match phase {
            PointerPhase::Down => {
                if self.owner.is_some() || !inside(u, v) {
                    // A second finger, or a finger on a letterbox bar: neither starts a
                    // box, and the bar must not lock out the next finger.
                    return Vec::new();
                }
                self.drag = Some(Drag::start((u, v), self.mirror));
                self.owner = Some(id);
                self.committed = None;
                Vec::new()
            }
            PointerPhase::Move if mine => {
                if let Some(drag) = self.drag.as_mut() {
                    // A drag that leaves the picture keeps its corner on the edge.
                    drag.extend((clamp01(u), clamp01(v)));
                }
                Vec::new()
            }
            PointerPhase::Up if mine => {
                self.owner = None;
                let Some(mut drag) = self.drag.take() else {
                    return Vec::new();
                };
                drag.extend((clamp01(u), clamp01(v)));
                self.finish(drag, model_id, now)
            }
            PointerPhase::Cancel if mine => {
                // Abandoned, never committed: pointing the camera at whatever a palm
                // happened to cover is worse than not tracking at all.
                self.owner = None;
                self.drag = None;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// Every pointer is gone (focus loss, the picture left the screen).
    pub fn cancel_all(&mut self) {
        self.owner = None;
        self.drag = None;
    }

    fn finish(&mut self, drag: Drag, model_id: i32, now: f64) -> Vec<Command> {
        let Some(command) = drag.command(self.next_track_id) else {
            // A click, not a drag: tap to focus there, as a tap on the phones does.
            let (x, y, _, _) = drag.rectangle();
            return self.tap((x, y), model_id, now);
        };
        let (sx, sy, sw, sh) = drag.sensor_rectangle();
        let minimum = self.rules.minimum_side;
        if sw < minimum || sh < minimum {
            // Below this Mimo toasts and does not SET; the body would not lock anyway.
            self.notices.push("FRAME TOO SMALL");
            return Vec::new();
        }
        self.next_track_id = self.next_track_id.wrapping_add(1).max(1);
        self.committed = Some((drag.rectangle(), now + BOX_CONFIRM));
        self.tracking = Some(TrackingState::new(
            (sx as f32, sy as f32, sw as f32, sh as f32),
            now,
        ));
        self.cleared_at = None;
        vec![command]
    }

    /// Mimo's tap-to-focus burst at a point on the picture as seen. Mirroring is undone
    /// so the body focuses where the operator pointed. A body already following
    /// something is told to stop first, as on the phones. Nothing on a body without tap
    /// focus (the Nano).
    pub fn tap(&mut self, seen: (f64, f64), model_id: i32, now: f64) -> Vec<Command> {
        if !opc_camera::supports_tap_focus(model_id) {
            return Vec::new();
        }
        let seen = (clamp01(seen.0), clamp01(seen.1));
        let mut out = Vec::new();
        if self.tracking.take().is_some() {
            self.committed = None;
            self.cleared_at = Some(now);
            out.push(Command::TrackClear);
        }
        let x = if self.mirror { 1.0 - seen.0 } else { seen.0 };
        let point = (x as f32, seen.1 as f32);
        let [prepare, region, _, _] = Command::tap_focus(point.0, point.1);
        out.push(prepare);
        out.push(region);
        self.pending_tap = Some((point, now + TAP_ACK_GRACE));
        self.focus_marker = Some((seen, now + FOCUS_MARKER_SECONDS));
        out
    }

    fn finish_tap(&mut self) -> Vec<Command> {
        let Some((point, _)) = self.pending_tap.take() else {
            return Vec::new();
        };
        let [_, _, hint, commit] = Command::tap_focus(point.0, point.1);
        vec![hint, commit]
    }

    /// `X`, controller Y, a palm: clears what the body follows. Nothing out with the
    /// body means nothing to send: the phones send the all-zero SET only when a box is up.
    pub fn clear(&mut self, now: f64) -> Vec<Command> {
        self.drag = None;
        self.owner = None;
        self.committed = None;
        if self.tracking.take().is_none() {
            return Vec::new();
        }
        self.cleared_at = Some(now);
        vec![Command::TrackClear]
    }

    /// What became of a SET: the region's ACK releases the tap's tail; no answer drops it.
    pub fn note_set(&mut self, outcome: &SetOutcome) -> Vec<Command> {
        match outcome {
            SetOutcome::Unanswered {
                command: Command::TapFocusPoint { .. },
            } => {
                self.pending_tap = None;
                Vec::new()
            }
            SetOutcome::Acked {
                command: Command::TapFocusPoint { .. },
                ..
            } => self.finish_tap(),
            _ => Vec::new(),
        }
    }

    /// A reply frame from the body: `0x02/0xA5` poll answers and `0x02/0x89` pushes.
    pub fn frame(&mut self, cmd_set: u8, cmd_id: u8, payload: &[u8], now: f64) -> bool {
        match (cmd_set, cmd_id) {
            (0x02, 0xA5) => {
                if let Some(poll) = opc_camera::tracking_poll(payload) {
                    self.reply(poll, now);
                }
                true
            }
            (0x02, 0x89) => {
                if let Some(subject) = opc_camera::tracking_live_push(payload) {
                    self.push(subject, now);
                }
                true
            }
            _ => false,
        }
    }

    /// The body answered a tracking poll.
    pub fn reply(&mut self, poll: TrackingPoll, _now: f64) {
        let Some(tracking) = self.tracking.as_mut() else {
            return;
        };
        match poll {
            TrackingPoll::Locked(subject) => {
                tracking.saw_lock = true;
                tracking.idle_ticks = 0;
                // The live push is the finer signal; a poll only fills in before it.
                if tracking.last_push_at.is_none() {
                    if let Some(subject) = subject {
                        tracking.subject = Some(subject);
                    }
                }
                self.committed = None;
            }
            TrackingPoll::Idle => {
                if tracking.saw_lock {
                    self.tracking = None;
                    self.committed = None;
                } else {
                    tracking.idle_ticks += 1;
                    if tracking.idle_ticks >= TRACK_IDLE_TICKS {
                        self.tracking = None;
                        self.committed = None;
                    }
                }
            }
        }
    }

    /// The body pushed where its subject is. A push right after an operator clear is the
    /// leftover of the box just cleared and is ignored; a push with no box up is a lock
    /// started on the body's own screen, and becomes one.
    pub fn push(&mut self, subject: Box4, now: f64) {
        if let Some(cleared_at) = self.cleared_at {
            if now - cleared_at < self.rules.clear_ignore_seconds {
                return;
            }
            self.cleared_at = None;
        }
        let tracking = self
            .tracking
            .get_or_insert_with(|| TrackingState::new(subject, now));
        let dt = tracking.last_push_at.map_or(0.0, |at| (now - at).max(0.0));
        tracking.subject = Some(opc_camera::tracking_blend(tracking.subject, subject, dt));
        tracking.last_push_at = Some(now);
        tracking.saw_lock = true;
        tracking.idle_ticks = 0;
        self.committed = None;
    }

    /// The link went: a box the body was following is not ours any more.
    pub fn link_lost(&mut self) {
        self.tracking = None;
        self.committed = None;
        self.drag = None;
        self.owner = None;
        self.pending_tap = None;
    }

    /// The clock moved on: polls, push silence, the tap's ACK grace, fades.
    pub fn tick(&mut self, now: f64) -> Vec<Command> {
        let mut out = Vec::new();
        let silence = self.rules.push_silence_seconds;
        if let Some(tracking) = self.tracking.as_mut() {
            if tracking.last_push_at.is_some_and(|at| now - at >= silence) {
                self.tracking = None;
                self.committed = None;
            } else if now >= tracking.next_poll_at {
                tracking.next_poll_at = now + TRACK_POLL_INTERVAL;
                out.push(Command::TrackPoll);
            }
        }
        if self.pending_tap.is_some_and(|(_, until)| now >= until) {
            out.extend(self.finish_tap());
        }
        if self.focus_marker.is_some_and(|(_, until)| now >= until) {
            self.focus_marker = None;
        }
        if self.committed.is_some_and(|(_, until)| now >= until) {
            self.committed = None;
        }
        out
    }

    pub fn is_tracking(&self) -> bool {
        self.tracking.is_some()
    }

    pub fn is_locked(&self) -> bool {
        self.tracking.as_ref().is_some_and(|t| t.saw_lock)
    }

    pub fn is_dragging(&self) -> bool {
        self.drag.is_some()
    }

    fn seen(&self, sensor: (f64, f64, f64, f64)) -> (f64, f64, f64, f64) {
        let (x, y, w, h) = sensor;
        (if self.mirror { 1.0 - x - w } else { x }, y, w, h)
    }

    /// What to draw now.
    pub fn view(&self) -> TrackingView {
        let locked = self.tracking.as_ref().filter(|t| t.saw_lock);
        let sensor = locked.map(|tracking| {
            let b = tracking
                .subject
                .unwrap_or_else(|| opc_camera::tracking_subject_stand_in(tracking.search));
            (
                f64::from(b.0),
                f64::from(b.1),
                f64::from(b.2),
                f64::from(b.3),
            )
        });
        let (seen, sensor) = match sensor {
            Some(sensor) => (Some(self.seen(sensor)), Some(sensor)),
            None => match (&self.tracking, self.committed) {
                (Some(tracking), Some((drawn, _))) => {
                    let s = tracking.search;
                    (
                        Some(drawn),
                        Some((
                            f64::from(s.0),
                            f64::from(s.1),
                            f64::from(s.2),
                            f64::from(s.3),
                        )),
                    )
                }
                // Searching past the 1.5 s the committed box is drawn for: the body has
                // not said where the subject is, so nothing is drawn rather than a lie.
                (Some(tracking), None) => {
                    let s = tracking.search;
                    let sensor = (
                        f64::from(s.0),
                        f64::from(s.1),
                        f64::from(s.2),
                        f64::from(s.3),
                    );
                    (None, Some(sensor))
                }
                _ => (None, None),
            },
        };
        TrackingView {
            status: match (&self.tracking, locked) {
                (_, Some(_)) => "tracking",
                (Some(_), None) => "searching",
                _ => "idle",
            },
            seen: seen.map(Rect::of),
            sensor: sensor.map(Rect::of),
            drag: self.drag.map(|drag| Rect::of(drag.rectangle())),
            focus: self.focus_marker.map(|(seen, _)| seen),
            mirror: self.mirror,
        }
    }
}
