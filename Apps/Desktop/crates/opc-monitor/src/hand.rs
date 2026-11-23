//! What the hand is doing, read from the 21 landmarks of [`crate::handnet`]: which
//! fingers are out (a pose), how long a pose has been held, and whether the palm has
//! swept across the picture. The reading works at any tilt of the hand, because it
//! compares distances and not directions.

use std::collections::VecDeque;

use crate::gesture::Gesture;
use crate::handnet::Hand;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pose {
    Fist,
    Point,
    Two,
    Palm,
}

/// How long a pose must be held, and how long it must be gone before it can fire again.
const HOLD: f64 = 0.9;
const RELEASE: f64 = 0.5;
/// How far each finger's tip is from the wrist, as a multiple of how far its base is:
/// index, middle, ring, pinky. A straight finger reaches about 1.7 times as far as its
/// base (measured on real photos: 1.55 to 1.85); one folded into the palm 1.3 or less.
pub fn finger_reach(hand: &Hand) -> [f32; 4] {
    let distance = |a: usize, b: usize| {
        let ((ax, ay), (bx, by)) = (hand.points[a], hand.points[b]);
        ((ax - bx) * hand.aspect).hypot(ay - by)
    };
    let reach = |base: usize, tip: usize| distance(tip, 0) / distance(base, 0).max(1e-4);
    [reach(5, 8), reach(9, 12), reach(13, 16), reach(17, 20)]
}

/// A finger counts as out past this reach.
const OUT: f32 = 1.42;

/// The pose this hand makes, or `None` for a shape we have no name for. The thumb is
/// free: it does not change the pose.
pub fn pose_of(hand: &Hand) -> Option<Pose> {
    let [index, middle, ring, pinky] = finger_reach(hand).map(|reach| reach > OUT);
    match [index, middle, ring, pinky] {
        [false, false, false, false] => Some(Pose::Fist),
        [true, false, false, false] => Some(Pose::Point),
        [true, true, false, false] => Some(Pose::Two),
        [true, true, true, true] => Some(Pose::Palm),
        _ => None,
    }
}

/// Turns a stream of poses into held-pose events.
#[derive(Debug, Default)]
pub struct Holder {
    current: Option<(Pose, f64)>,
    fired: bool,
    gone_since: Option<f64>,
}

impl Holder {
    /// The pose being held and how far through the hold it is, 0 to 1.
    pub fn progress(&self, now: f64) -> Option<(Pose, f32)> {
        let (pose, since) = self.current?;
        let done = if self.fired {
            1.0
        } else {
            ((now - since) / HOLD).clamp(0.0, 1.0)
        };
        Some((pose, done as f32))
    }

    pub fn feed(&mut self, seen: Option<Pose>, now: f64) -> Option<Pose> {
        match (seen, self.current) {
            (Some(pose), Some((held, since))) if pose == held => {
                self.gone_since = None;
                if !self.fired && now - since >= HOLD {
                    self.fired = true;
                    return Some(pose);
                }
            }
            (Some(pose), _) => {
                self.gone_since = None;
                self.current = Some((pose, now));
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
}

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
        assert_eq!(pose_of(&hand_with([true; 4], 0.0)), Some(Pose::Palm));
        assert_eq!(
            pose_of(&hand_with([true, false, false, true], 0.0)),
            None,
            "horns are not a pose we name"
        );
    }

    #[test]
    fn the_reading_does_not_care_which_way_the_hand_points() {
        for tilt in [-1.2f32, -0.6, 0.6, 1.5, 3.0] {
            assert_eq!(pose_of(&hand_with([true; 4], tilt)), Some(Pose::Palm), "{tilt}");
            assert_eq!(pose_of(&hand_with([false; 4], tilt)), Some(Pose::Fist), "{tilt}");
        }
    }

    #[test]
    fn a_pose_fires_once_after_a_steady_hold() {
        let mut holder = Holder::default();
        let mut fired = Vec::new();
        let mut now = 0.0;
        for _ in 0..60 {
            fired.extend(holder.feed(Some(Pose::Fist), now));
            now += 0.05;
        }
        assert_eq!(fired, [Pose::Fist]);
        // Lowering the hand re-arms it.
        for _ in 0..20 {
            holder.feed(None, now);
            now += 0.05;
        }
        for _ in 0..30 {
            fired.extend(holder.feed(Some(Pose::Fist), now));
            now += 0.05;
        }
        assert_eq!(fired, [Pose::Fist, Pose::Fist]);
    }

    #[test]
    fn a_flickering_pose_never_fires() {
        let mut holder = Holder::default();
        let mut now = 0.0;
        for i in 0..80 {
            let pose = if i % 10 < 5 { Pose::Palm } else { Pose::Fist };
            assert_eq!(holder.feed(Some(pose), now), None);
            now += 0.05;
        }
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
        assert!(sweep_across(false, (0.2, 0.3), (0.5, 0.6)).is_empty(), "diagonal");
        let mut slow = Sweep::new(false);
        let mut found = Vec::new();
        for step in 0..40 {
            let hand = hand_at(0.2 + 0.0125 * step as f32, 0.5);
            found.extend(slow.feed(Some(&hand), f64::from(step) * 0.2));
        }
        assert!(found.is_empty(), "a slow drift is not a sweep");
    }
}
