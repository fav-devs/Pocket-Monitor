//! What the hands are doing, read from the 21 landmarks of [`crate::handnet`]: which
//! fingers are out (a pose), how long a pose has been held, whether the palm has swept
//! across the picture, and the two hands' continuous controls: pinch and drag one hand
//! for the gimbal stick, the other for zoom. The reading works at any tilt of the hand,
//! because it compares distances and not directions.

use std::collections::VecDeque;

use crate::gesture::Gesture;
use crate::handnet::Hand;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pose {
    Fist,
    Point,
    Two,
    /// Index and little finger out: the rock sign.
    Horns,
    Palm,
}

impl Pose {
    pub fn gesture(self) -> Gesture {
        match self {
            Pose::Fist => Gesture::Fist,
            Pose::Point => Gesture::Point,
            Pose::Two => Gesture::Two,
            Pose::Horns => Gesture::Horns,
            Pose::Palm => Gesture::Palm,
        }
    }
}

/// How long a pose is normally held before it counts, and how long it must be gone
/// before it can fire again.
pub const HOLD: f64 = 0.9;
const RELEASE: f64 = 0.5;

/// Distance between two landmarks, with the picture's shape taken out.
fn distance(hand: &Hand, a: usize, b: usize) -> f32 {
    let ((ax, ay), (bx, by)) = (hand.points[a], hand.points[b]);
    ((ax - bx) * hand.aspect).hypot(ay - by)
}

/// How far each finger's tip is from the wrist, as a multiple of how far its base is:
/// index, middle, ring, pinky. A straight finger reaches about 1.7 times as far as its
/// base (measured on real photos: 1.55 to 1.85); one folded into the palm 1.3 or less.
pub fn finger_reach(hand: &Hand) -> [f32; 4] {
    let reach =
        |base: usize, tip: usize| distance(hand, tip, 0) / distance(hand, base, 0).max(1e-4);
    [reach(5, 8), reach(9, 12), reach(13, 16), reach(17, 20)]
}

/// A finger counts as out past this reach.
const OUT: f32 = 1.42;

/// Thumb tip to index tip, as a share of the palm's length: near zero when pinched.
pub fn pinch_ratio(hand: &Hand) -> f32 {
    distance(hand, 4, 8) / distance(hand, 0, 9).max(1e-4)
}

/// Pinched at or below this; let go at or above [`PINCH_OFF`].
pub const PINCH_ON: f32 = 0.25;
pub const PINCH_OFF: f32 = 0.42;

/// Where the pinch is: halfway between the thumb tip and the index tip.
pub fn pinch_point(hand: &Hand) -> (f32, f32) {
    (
        (hand.points[4].0 + hand.points[8].0) / 2.0,
        (hand.points[4].1 + hand.points[8].1) / 2.0,
    )
}

/// The pose this hand makes, or `None` for a shape we have no name for. The thumb is
/// free: it does not change the pose. A pinch is not a pose: it is the controls' grip.
pub fn pose_of(hand: &Hand) -> Option<Pose> {
    if pinch_ratio(hand) < PINCH_OFF {
        return None;
    }
    let [index, middle, ring, pinky] = finger_reach(hand).map(|reach| reach > OUT);
    match [index, middle, ring, pinky] {
        [false, false, false, false] => Some(Pose::Fist),
        [true, false, false, false] => Some(Pose::Point),
        [true, true, false, false] => Some(Pose::Two),
        [true, false, false, true] => Some(Pose::Horns),
        [true, true, true, true] => Some(Pose::Palm),
        _ => None,
    }
}

/// Turns a stream of poses into held-pose events.
#[derive(Debug, Default)]
pub struct Holder {
    /// The pose, when it began, and how long it has to be held.
    current: Option<(Pose, f64, f64)>,
    fired: bool,
    gone_since: Option<f64>,
}

impl Holder {
    /// The pose being held and how far through the hold it is, 0 to 1.
    pub fn progress(&self, now: f64) -> Option<(Pose, f32)> {
        let (pose, since, hold) = self.current?;
        let done = if self.fired {
            1.0
        } else {
            ((now - since) / hold).clamp(0.0, 1.0)
        };
        Some((pose, done as f32))
    }

    /// `hold` is how long this pose has to be held, in seconds.
    pub fn feed(&mut self, seen: Option<Pose>, now: f64, hold: f64) -> Option<Pose> {
        match (seen, self.current) {
            (Some(pose), Some((held, since, needed))) if pose == held => {
                self.gone_since = None;
                if !self.fired && now - since >= needed {
                    self.fired = true;
                    return Some(pose);
                }
            }
            (Some(pose), _) => {
                self.gone_since = None;
                self.current = Some((pose, now, hold));
                self.fired = false;
            }
            (None, Some(_)) => {
                let since = *self.gone_since.get_or_insert(now);
                if now - since >= RELEASE {
                    self.current = None;
                    self.fired = false;
                    self.gone_since = None;
                }
            }
            (None, None) => {}
        }
        None
    }

    /// Forget what is being held, as when another gesture has just fired.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Opening and closing the hand quickly, three times over: a pattern, not a pose.
#[derive(Debug, Default)]
pub struct Pulse {
    /// Confirmed palm and fist states, with when each began.
    states: Vec<(Pose, f64)>,
    /// A palm or fist just seen, and since when.
    candidate: Option<(Pose, f64)>,
    last_seen: f64,
}

/// Each state must last at least this long to count, and at most the other.
const PULSE_MIN: f64 = 0.06;
const PULSE_MAX: f64 = 0.9;
/// Three open-and-close cycles within this.
const PULSE_WITHIN: f64 = 4.0;

impl Pulse {
    /// True once, when the third cycle completes.
    pub fn feed(&mut self, seen: Option<Pose>, now: f64) -> bool {
        match seen {
            Some(pose @ (Pose::Palm | Pose::Fist)) => {
                self.last_seen = now;
                match self.candidate {
                    Some((held, _)) if held == pose => {}
                    _ => self.candidate = Some((pose, now)),
                }
                if let Some((candidate, since)) = self.candidate {
                    let confirmed = now - since >= PULSE_MIN;
                    let new = self
                        .states
                        .last()
                        .is_none_or(|&(last, _)| last != candidate);
                    if confirmed && new {
                        self.states.push((candidate, since));
                    }
                }
            }
            Some(_) => {
                // Some other pose is not part of the pattern.
                self.states.clear();
                self.candidate = None;
            }
            None => {
                self.candidate = None;
                if now - self.last_seen > 1.0 {
                    self.states.clear();
                }
            }
        }
        self.states
            .retain(|&(_, since)| now - since <= PULSE_WITHIN);
        // Six states in a row: open, closed, open, closed, open, closed.
        if self.states.len() >= 6 {
            let tail = &self.states[self.states.len() - 6..];
            let quick = tail.windows(2).all(|pair| {
                let held = pair[1].1 - pair[0].1;
                (PULSE_MIN..=PULSE_MAX).contains(&held)
            });
            if quick {
                self.states.clear();
                self.candidate = None;
                return true;
            }
        }
        false
    }
}

// ---- Pinch and drag -----------------------------------------------------------------

/// Which control a hand is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Pinch and drag: the gimbal stick.
    Stick,
    /// Pinch and drag up or down: zoom.
    Zoom,
}

/// What a pinching hand asks for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Control {
    /// The stick, from -1 to 1 each way; up is positive.
    Stick {
        x: f32,
        y: f32,
    },
    /// The pinch was let go.
    StickEnd,
    /// Zoom rate from -1 (out) to 1 (in).
    Zoom {
        rate: f32,
    },
    ZoomEnd,
}

/// A pinch being held, for drawing: where it began and where the fingers are now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grab {
    pub role: Role,
    pub anchor: (f32, f32),
    pub point: (f32, f32),
}

/// How far the pinch has to move, as a share of the picture's height, for full stick.
const STICK_REACH: f32 = 0.18;
const ZOOM_REACH: f32 = 0.16;
const DEAD: f32 = 0.15;
/// A pinching hand that drops out of view this long is let go.
const LOST: f64 = 0.3;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
enum Grip {
    #[default]
    Idle,
    /// Pinched for this many readings so far.
    Closing(u8),
    Held {
        anchor: (f32, f32),
        seen: f64,
    },
}

/// Both hands' pinch controls.
#[derive(Debug)]
pub struct Controls {
    stick: Grip,
    zoom: Grip,
    /// Whether the right hand (as the camera sees it, which is the person's right) is
    /// the stick; the left is then the zoom.
    pub stick_is_right: bool,
}

/// What one reading of the hands gave.
#[derive(Debug, Default)]
pub struct Reading {
    pub controls: Vec<Control>,
    pub grabs: Vec<Grab>,
}

impl Controls {
    pub fn new(stick_is_right: bool) -> Self {
        Self {
            stick: Grip::Idle,
            zoom: Grip::Idle,
            stick_is_right,
        }
    }

    /// Whether either hand has hold of a control.
    pub fn busy(&self) -> bool {
        matches!(self.stick, Grip::Held { .. }) || matches!(self.zoom, Grip::Held { .. })
    }

    /// Lets go of everything, saying so for each control that was held.
    pub fn release(&mut self) -> Vec<Control> {
        let mut ended = Vec::new();
        if matches!(self.stick, Grip::Held { .. }) {
            ended.push(Control::StickEnd);
        }
        if matches!(self.zoom, Grip::Held { .. }) {
            ended.push(Control::ZoomEnd);
        }
        self.stick = Grip::Idle;
        self.zoom = Grip::Idle;
        ended
    }

    /// The hands in a frame at `now`.
    pub fn feed(&mut self, hands: &[Hand], now: f64) -> Reading {
        let mut reading = Reading::default();
        let stick_hand = hands.iter().find(|hand| hand.right == self.stick_is_right);
        let zoom_hand = hands.iter().find(|hand| hand.right != self.stick_is_right);
        for (role, hand) in [(Role::Stick, stick_hand), (Role::Zoom, zoom_hand)] {
            let grip = match role {
                Role::Stick => &mut self.stick,
                Role::Zoom => &mut self.zoom,
            };
            let pinch = hand.map(pinch_ratio);
            let next = match (*grip, hand, pinch) {
                (Grip::Idle, Some(_), Some(ratio)) if ratio < PINCH_ON => Grip::Closing(1),
                (Grip::Closing(n), Some(hand), Some(ratio)) if ratio < PINCH_ON => {
                    if n + 1 >= 2 {
                        Grip::Held {
                            anchor: pinch_point(hand),
                            seen: now,
                        }
                    } else {
                        Grip::Closing(n + 1)
                    }
                }
                (Grip::Closing(_), ..) => Grip::Idle,
                (Grip::Held { anchor, .. }, Some(_), Some(ratio)) if ratio < PINCH_OFF => {
                    Grip::Held { anchor, seen: now }
                }
                (Grip::Held { seen, .. }, None, _) if now - seen <= LOST => *grip,
                (Grip::Held { .. }, ..) => {
                    reading.controls.push(match role {
                        Role::Stick => Control::StickEnd,
                        Role::Zoom => Control::ZoomEnd,
                    });
                    Grip::Idle
                }
                _ => Grip::Idle,
            };
            *grip = next;
            if let (Grip::Held { anchor, .. }, Some(hand)) = (next, hand) {
                let point = pinch_point(hand);
                reading.grabs.push(Grab {
                    role,
                    anchor,
                    point,
                });
                let dx = (point.0 - anchor.0) * hand.aspect;
                let dy = point.1 - anchor.1;
                reading.controls.push(match role {
                    Role::Stick => {
                        let (x, y) = (dx / STICK_REACH, -dy / STICK_REACH);
                        let (x, y) = dead_zone(x, y);
                        Control::Stick { x, y }
                    }
                    Role::Zoom => {
                        let (_, rate) = dead_zone(0.0, -dy / ZOOM_REACH);
                        Control::Zoom { rate }
                    }
                });
            }
        }
        reading
    }
}

/// A stick throw with a dead zone in the middle and full throw at the edge.
fn dead_zone(x: f32, y: f32) -> (f32, f32) {
    let magnitude = x.hypot(y);
    if magnitude < DEAD {
        return (0.0, 0.0);
    }
    let scaled = ((magnitude - DEAD) / (1.0 - DEAD)).min(1.0);
    (x / magnitude * scaled, y / magnitude * scaled)
}

// ---- Sweeps -------------------------------------------------------------------------

/// How far the palm must travel, as a share of the picture, and how fast.
const SWEEP_TRAVEL: f32 = 0.28;
const SWEEP_WITHIN: f64 = 0.55;
const SWEEP_DOMINANCE: f32 = 1.8;
const SWEEP_COOLDOWN: f64 = 1.5;
/// A hand that has just come into view, or is being put down, is not sweeping: wait
/// this long after it appears before reading a sweep.
const SWEEP_SETTLE: f64 = 0.6;

/// Reads a sweep of the palm across the picture: a quick, mostly straight run.
#[derive(Debug)]
pub struct Sweep {
    trail: VecDeque<(f64, f32, f32)>,
    quiet_until: f64,
    /// When the hand came into view, while it has stayed in view.
    present_since: Option<f64>,
    last_seen: f64,
    mirror: bool,
}

impl Sweep {
    /// `mirror` flips left and right, for a picture that faces the operator.
    pub fn new(mirror: bool) -> Self {
        Self {
            trail: VecDeque::new(),
            quiet_until: 0.0,
            present_since: None,
            last_seen: f64::NEG_INFINITY,
            mirror,
        }
    }

    /// Holds sweeps off for the cooldown, as when another gesture has just fired.
    pub fn hold_off(&mut self, now: f64) {
        self.trail.clear();
        self.quiet_until = self.quiet_until.max(now + SWEEP_COOLDOWN);
    }

    /// The hand found in a frame at `now` (seconds), or `None` when there is none.
    pub fn feed(&mut self, hand: Option<&Hand>, now: f64) -> Option<Gesture> {
        while self
            .trail
            .front()
            .is_some_and(|(t, _, _)| now - t > SWEEP_WITHIN)
        {
            self.trail.pop_front();
        }
        let Some(hand) = hand else {
            if now - self.last_seen > 0.25 {
                self.present_since = None;
            }
            return None;
        };
        self.last_seen = now;
        let since = *self.present_since.get_or_insert(now);
        if now - since < SWEEP_SETTLE {
            return None;
        }
        let (mut x, y) = hand.palm_centre();
        if self.mirror {
            x = 1.0 - x;
        }
        self.trail.push_back((now, x, y));
        if now < self.quiet_until || self.trail.len() < 4 {
            return None;
        }
        let (first, last) = (*self.trail.front()?, *self.trail.back()?);
        let (dx, dy) = (last.1 - first.1, last.2 - first.2);
        let gesture = if dx.abs() >= SWEEP_TRAVEL && dx.abs() >= SWEEP_DOMINANCE * dy.abs() {
            Some(if dx > 0.0 {
                Gesture::SwipeRight
            } else {
                Gesture::SwipeLeft
            })
        } else if dy.abs() >= SWEEP_TRAVEL && dy.abs() >= SWEEP_DOMINANCE * dx.abs() {
            Some(if dy > 0.0 {
                Gesture::SwipeDown
            } else {
                Gesture::SwipeUp
            })
        } else {
            None
        };
        if gesture.is_some() {
            self.trail.clear();
            self.quiet_until = now + SWEEP_COOLDOWN;
        }
        gesture
    }
}

// ---- What the viewfinder draws --------------------------------------------------------

/// One hand as the hand view draws it.
#[derive(Debug, Clone, PartialEq)]
pub struct HandView {
    pub hand: Hand,
    pub pose: Option<Pose>,
}

/// Everything the hand view shows for one reading.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HandScene {
    pub hands: Vec<HandView>,
    pub grabs: Vec<Grab>,
    /// How far through its hold the pose being held is, 0 to 1.
    pub hold: f32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handnet::POINTS;

    /// A hand with the wrist at the bottom and each finger either out or curled, as a
    /// 4:3 picture sees it. Fingers are listed index to pinky.
    fn hand_with(out: [bool; 4], tilt: f32) -> Hand {
        let mut points = [(0.0f32, 0.0f32); POINTS];
        let (s, c) = tilt.sin_cos();
        // A point `along` up the hand and `across` it, from the wrist, rotated by `tilt`.
        let place = |across: f32, along: f32| {
            (
                0.5 + (across * c + along * s) * 0.75,
                0.8 - (along * c - across * s),
            )
        };
        points[0] = place(0.0, 0.0);
        points[9] = place(0.0, 0.18);
        // The thumb, out to the side and well clear of the index tip.
        points[4] = place(-0.16, 0.14);
        for (finger, &straight) in out.iter().enumerate() {
            let across = -0.045 + 0.03 * finger as f32;
            let base = 1 + 4 * (finger + 1);
            points[base] = place(across, 0.18);
            if straight {
                points[base + 1] = place(across, 0.27);
                points[base + 2] = place(across, 0.34);
                points[base + 3] = place(across, 0.40);
            } else {
                // Folded down over the palm: the tip comes back near the base.
                points[base + 1] = place(across, 0.24);
                points[base + 2] = place(across, 0.20);
                points[base + 3] = place(across, 0.14);
            }
        }
        Hand {
            points,
            aspect: 4.0 / 3.0,
            score: 0.99,
            right: true,
        }
    }

    /// A hand pinching with its index tip meeting its thumb tip at (x, y) in the picture.
    fn pinching_at(x: f32, y: f32, right: bool) -> Hand {
        let mut hand = hand_with([false, true, true, true], 0.0);
        hand.right = right;
        hand.points[8] = (x, y);
        hand.points[4] = (x + 0.004, y + 0.004);
        hand
    }

    #[test]
    fn fingers_out_make_the_poses() {
        assert_eq!(pose_of(&hand_with([false; 4], 0.0)), Some(Pose::Fist));
        assert_eq!(
            pose_of(&hand_with([true, false, false, false], 0.0)),
            Some(Pose::Point)
        );
        assert_eq!(
            pose_of(&hand_with([true, true, false, false], 0.0)),
            Some(Pose::Two)
        );
        assert_eq!(
            pose_of(&hand_with([true, false, false, true], 0.0)),
            Some(Pose::Horns)
        );
        assert_eq!(pose_of(&hand_with([true; 4], 0.0)), Some(Pose::Palm));
        assert_eq!(
            pose_of(&hand_with([false, true, true, false], 0.0)),
            None,
            "the middle two alone is not a pose we name"
        );
    }

    #[test]
    fn the_reading_does_not_care_which_way_the_hand_points() {
        for tilt in [-1.2f32, -0.6, 0.6, 1.5, 3.0] {
            assert_eq!(
                pose_of(&hand_with([true; 4], tilt)),
                Some(Pose::Palm),
                "{tilt}"
            );
            assert_eq!(
                pose_of(&hand_with([false; 4], tilt)),
                Some(Pose::Fist),
                "{tilt}"
            );
        }
    }

    #[test]
    fn a_pinch_is_not_a_pose() {
        let hand = pinching_at(0.5, 0.5, true);
        assert!(pinch_ratio(&hand) < PINCH_ON);
        assert_eq!(pose_of(&hand), None);
        assert!(pinch_ratio(&hand_with([true; 4], 0.0)) > PINCH_OFF);
    }

    #[test]
    fn a_pose_fires_once_after_its_hold_and_a_longer_hold_waits_longer() {
        let mut holder = Holder::default();
        let mut fired = Vec::new();
        let mut now = 0.0;
        for _ in 0..60 {
            fired.extend(holder.feed(Some(Pose::Fist), now, HOLD));
            now += 0.05;
        }
        assert_eq!(fired, [Pose::Fist]);
        // Lowering the hand re-arms it.
        for _ in 0..20 {
            holder.feed(None, now, HOLD);
            now += 0.05;
        }
        for _ in 0..30 {
            fired.extend(holder.feed(Some(Pose::Fist), now, HOLD));
            now += 0.05;
        }
        assert_eq!(fired, [Pose::Fist, Pose::Fist]);
        // A pose that must be held 2.5 s is not there at 1.5 s, and is at 2.6 s.
        let mut record = Holder::default();
        let mut at = 0.0;
        let mut got = Vec::new();
        while at < 1.5 {
            got.extend(record.feed(Some(Pose::Two), at, 2.5));
            at += 0.05;
        }
        assert!(got.is_empty());
        let (_, partway) = record.progress(at).expect("being held");
        assert!(partway > 0.5 && partway < 0.7, "{partway}");
        while at < 2.7 {
            got.extend(record.feed(Some(Pose::Two), at, 2.5));
            at += 0.05;
        }
        assert_eq!(got, [Pose::Two]);
    }

    #[test]
    fn a_flickering_pose_never_fires() {
        let mut holder = Holder::default();
        let mut now = 0.0;
        for i in 0..80 {
            let pose = if i % 10 < 5 { Pose::Palm } else { Pose::Fist };
            assert_eq!(holder.feed(Some(pose), now, HOLD), None);
            now += 0.05;
        }
    }

    #[test]
    fn opening_and_closing_three_times_is_a_pulse_and_holding_is_not() {
        let mut pulse = Pulse::default();
        let mut fired = 0;
        let mut now = 0.0;
        // Open, closed, three times over, each for about a third of a second.
        for cycle in 0..6 {
            let pose = if cycle % 2 == 0 {
                Pose::Palm
            } else {
                Pose::Fist
            };
            for _ in 0..7 {
                fired += usize::from(pulse.feed(Some(pose), now));
                now += 0.05;
            }
        }
        assert_eq!(fired, 1);
        let mut slow = Pulse::default();
        let mut now = 0.0;
        for cycle in 0..6 {
            let pose = if cycle % 2 == 0 {
                Pose::Palm
            } else {
                Pose::Fist
            };
            for _ in 0..40 {
                assert!(!slow.feed(Some(pose), now));
                now += 0.05;
            }
        }
        // And twice is not enough.
        let mut twice = Pulse::default();
        let mut now = 0.0;
        for cycle in 0..4 {
            let pose = if cycle % 2 == 0 {
                Pose::Palm
            } else {
                Pose::Fist
            };
            for _ in 0..7 {
                assert!(!twice.feed(Some(pose), now));
                now += 0.05;
            }
        }
    }

    #[test]
    fn pinching_and_dragging_one_hand_is_the_stick_until_the_pinch_is_let_go() {
        let mut controls = Controls::new(true);
        let mut last = Vec::new();
        // Pinch at the middle, hold still: grips after a couple of readings, no throw.
        for step in 0..4 {
            let hand = pinching_at(0.5, 0.5, true);
            last = controls.feed(&[hand], f64::from(step) * 0.05).controls;
        }
        assert_eq!(last, [Control::Stick { x: 0.0, y: 0.0 }]);
        assert!(controls.busy());
        // Drag up and to the right a good way: full throw up and right.
        let reading = controls.feed(&[pinching_at(0.7, 0.3, true)], 0.3);
        match reading.controls.as_slice() {
            [Control::Stick { x, y }] => assert!(*x > 0.5 && *y > 0.5, "{x} {y}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(reading.grabs.len(), 1);
        // Open the fingers: let go.
        let open = hand_with([true; 4], 0.0);
        let reading = controls.feed(&[open], 0.35);
        assert_eq!(reading.controls, [Control::StickEnd]);
        assert!(!controls.busy());
    }

    #[test]
    fn the_other_hand_zooms_by_dragging_up_and_down_and_the_hands_do_not_mix() {
        let mut controls = Controls::new(true);
        let mut zoom_rates = Vec::new();
        let mut stick_throws = Vec::new();
        for step in 0..5 {
            let t = f64::from(step) * 0.05;
            // The left hand pinches and drags down; the right hand just hangs there open.
            let zoom = pinching_at(0.3, 0.5 + 0.1 * step as f32, false);
            let stick = hand_with([true; 4], 0.0);
            for control in controls.feed(&[zoom, stick], t).controls {
                match control {
                    Control::Zoom { rate } => zoom_rates.push(rate),
                    Control::Stick { x, y } => stick_throws.push((x, y)),
                    _ => {}
                }
            }
        }
        assert!(stick_throws.is_empty(), "an open right hand is not a grip");
        assert!(
            zoom_rates.last().is_some_and(|rate| *rate < -0.5),
            "{zoom_rates:?}"
        );
        // Swapping hands makes the right the zoom.
        let mut swapped = Controls::new(false);
        let mut got = Vec::new();
        for step in 0..4 {
            got = swapped
                .feed(&[pinching_at(0.5, 0.5, true)], f64::from(step) * 0.05)
                .controls;
        }
        assert_eq!(got, [Control::Zoom { rate: 0.0 }]);
    }

    #[test]
    fn a_pinch_that_drops_out_of_view_lets_go_after_a_moment() {
        let mut controls = Controls::new(true);
        for step in 0..3 {
            controls.feed(&[pinching_at(0.5, 0.5, true)], f64::from(step) * 0.05);
        }
        assert!(controls.busy());
        assert!(
            controls.feed(&[], 0.2).controls.is_empty(),
            "a flicker is forgiven"
        );
        assert_eq!(controls.feed(&[], 0.5).controls, [Control::StickEnd]);
    }

    /// The hand's palm at (x, y) of the picture.
    fn hand_at(x: f32, y: f32) -> Hand {
        let mut hand = hand_with([true; 4], 0.0);
        let (cx, cy) = hand.palm_centre();
        for point in &mut hand.points {
            point.0 += x - cx;
            point.1 += y - cy;
        }
        hand
    }

    fn sweep_across(mirror: bool, from: (f32, f32), to: (f32, f32)) -> Vec<Gesture> {
        let mut sweep = Sweep::new(mirror);
        let mut found = Vec::new();
        // The hand is in view and still first, as a hand being held up is.
        let still = hand_at(from.0, from.1);
        for step in 0..14 {
            sweep.feed(Some(&still), -1.0 + f64::from(step) * 0.05);
        }
        for step in 0..=8 {
            let t = step as f32 / 8.0;
            let hand = hand_at(from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
            found.extend(sweep.feed(Some(&hand), f64::from(step) * 0.05));
        }
        found
    }

    #[test]
    fn a_quick_run_of_the_palm_is_a_sweep() {
        assert_eq!(
            sweep_across(false, (0.2, 0.5), (0.7, 0.5)),
            [Gesture::SwipeRight]
        );
        assert_eq!(
            sweep_across(false, (0.7, 0.5), (0.2, 0.5)),
            [Gesture::SwipeLeft]
        );
        assert_eq!(
            sweep_across(true, (0.2, 0.5), (0.7, 0.5)),
            [Gesture::SwipeLeft],
            "a mirrored picture swaps the sides"
        );
        assert_eq!(
            sweep_across(false, (0.5, 0.8), (0.5, 0.3)),
            [Gesture::SwipeUp]
        );
    }

    #[test]
    fn a_hand_coming_into_view_or_going_down_is_not_a_sweep() {
        let mut sweep = Sweep::new(false);
        let mut found = Vec::new();
        // Raised from low in the picture to high, in half a second, straight into view.
        for step in 0..=8 {
            let t = step as f32 / 8.0;
            let hand = hand_at(0.5, 0.9 - 0.5 * t);
            found.extend(sweep.feed(Some(&hand), f64::from(step) * 0.05));
        }
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn a_gesture_that_just_fired_holds_sweeps_off() {
        let mut sweep = Sweep::new(false);
        let still = hand_at(0.2, 0.5);
        for step in 0..14 {
            sweep.feed(Some(&still), f64::from(step) * 0.05);
        }
        sweep.hold_off(0.7);
        let mut found = Vec::new();
        for step in 0..=8 {
            let hand = hand_at(0.2 + 0.0625 * step as f32, 0.5);
            found.extend(sweep.feed(Some(&hand), 0.75 + f64::from(step) * 0.05));
        }
        assert!(found.is_empty());
    }

    #[test]
    fn a_hand_that_drifts_or_wobbles_is_not_a_sweep() {
        assert!(sweep_across(false, (0.4, 0.5), (0.5, 0.5)).is_empty());
        assert!(
            sweep_across(false, (0.2, 0.3), (0.5, 0.6)).is_empty(),
            "diagonal"
        );
        let mut slow = Sweep::new(false);
        let mut found = Vec::new();
        for step in 0..40 {
            let hand = hand_at(0.2 + 0.0125 * step as f32, 0.5);
            found.extend(slow.feed(Some(&hand), f64::from(step) * 0.2));
        }
        assert!(found.is_empty(), "a slow drift is not a sweep");
    }
}
