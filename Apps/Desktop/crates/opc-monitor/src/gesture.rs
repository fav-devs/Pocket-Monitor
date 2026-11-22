//! Hand-wave gestures from a webcam, with no model and no network: frame differencing
//! finds where things are moving, and a quick, mostly straight sweep of that motion is
//! a swipe. Frames are small grey pictures; the camera capture lives in the binary.
//!
//! This reads big, deliberate hand sweeps held in front of the lens. It does not read
//! finger poses (palm, fist, point): that needs a landmark model, which is a separate
//! step.

use std::collections::VecDeque;

/// Frame size the tracker works at.
pub const WIDTH: usize = 64;
pub const HEIGHT: usize = 48;

/// What the operator did, as they see it (the picture is mirrored, so a sweep to the
/// operator's right is [`Gesture::SwipeRight`] here).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gesture {
    SwipeLeft,
    SwipeRight,
    SwipeUp,
    SwipeDown,
    /// Held hand poses, from [`crate::hand`].
    Palm,
    Fist,
    Point,
    Two,
}

/// Per-pixel brightness change that counts as motion.
const PIXEL_DELTA: i16 = 28;
/// Fraction of the picture that must be moving for a frame to count.
const MIN_MOTION: f32 = 0.012;
/// More than this is the whole scene changing (exposure, a person walking in), not a hand.
const MAX_MOTION: f32 = 0.45;
/// How much of the picture's width or height a sweep must cover.
const MIN_TRAVEL: f32 = 0.30;
/// A sweep has to be at least this much more along one axis than the other.
const DOMINANCE: f32 = 1.8;
/// Seconds the motion is remembered, and the quiet period after a gesture fires.
const WINDOW: f64 = 0.7;
const COOLDOWN: f64 = 1.2;
/// Fewer motion frames than this is a flicker, not a sweep.
const MIN_SAMPLES: usize = 4;

#[derive(Debug)]
pub struct Tracker {
    previous: Option<Vec<u8>>,
    /// Motion centroids in 0..1 picture coordinates, with the time they were seen.
    trail: VecDeque<(f64, f32, f32)>,
    quiet_until: f64,
    mirror: bool,
}

impl Tracker {
    /// `mirror` flips left and right, for a webcam that faces the operator.
    pub fn new(mirror: bool) -> Self {
        Self {
            previous: None,
            trail: VecDeque::new(),
            quiet_until: 0.0,
            mirror,
        }
    }

    /// One grey frame of `WIDTH * HEIGHT` bytes at time `now` (seconds).
    pub fn feed(&mut self, frame: &[u8], now: f64) -> Option<Gesture> {
        if frame.len() != WIDTH * HEIGHT {
            return None;
        }
        let previous = self.previous.replace(frame.to_vec());
        let previous = previous?;
        let (mut count, mut sum_x, mut sum_y) = (0usize, 0.0f64, 0.0f64);
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let i = y * WIDTH + x;
                if (i16::from(frame[i]) - i16::from(previous[i])).abs() > PIXEL_DELTA {
                    count += 1;
                    sum_x += x as f64;
                    sum_y += y as f64;
                }
            }
        }
        let share = count as f32 / (WIDTH * HEIGHT) as f32;
        while self.trail.front().is_some_and(|(t, _, _)| now - t > WINDOW) {
            self.trail.pop_front();
        }
        if now < self.quiet_until {
            return None;
        }
        if !(MIN_MOTION..=MAX_MOTION).contains(&share) {
            if share > MAX_MOTION {
                self.trail.clear();
            }
            return self.judge(now);
        }
        let mut x = (sum_x / count as f64 / WIDTH as f64) as f32;
        if self.mirror {
            x = 1.0 - x;
        }
        let y = (sum_y / count as f64 / HEIGHT as f64) as f32;
        self.trail.push_back((now, x, y));
        None
    }

    /// Reads the trail once motion has stopped, so one sweep is one gesture.
    fn judge(&mut self, now: f64) -> Option<Gesture> {
        let (first, last) = (*self.trail.front()?, *self.trail.back()?);
        if now - last.0 < 0.12 {
            return None;
        }
        let samples = self.trail.len();
        self.trail.clear();
        if samples < MIN_SAMPLES {
            return None;
        }
        let (dx, dy) = (last.1 - first.1, last.2 - first.2);
        let gesture = if dx.abs() >= MIN_TRAVEL && dx.abs() >= DOMINANCE * dy.abs() {
            Some(if dx > 0.0 {
                Gesture::SwipeRight
            } else {
                Gesture::SwipeLeft
            })
        } else if dy.abs() >= MIN_TRAVEL && dy.abs() >= DOMINANCE * dx.abs() {
            Some(if dy > 0.0 {
                Gesture::SwipeDown
            } else {
                Gesture::SwipeUp
            })
        } else {
            None
        };
        if gesture.is_some() {
            self.quiet_until = now + COOLDOWN;
        }
        gesture
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dark picture with a bright block whose left edge is at `x`, top edge at `y`.
    fn frame(x: usize, y: usize) -> Vec<u8> {
        let mut grey = vec![20u8; WIDTH * HEIGHT];
        for row in y..(y + 12).min(HEIGHT) {
            for col in x..(x + 12).min(WIDTH) {
                grey[row * WIDTH + col] = 220;
            }
        }
        grey
    }

    /// Slides the block from one corner to another, then holds still.
    fn sweep(tracker: &mut Tracker, from: (usize, usize), to: (usize, usize)) -> Vec<Gesture> {
        let steps = 10;
        let mut seen = Vec::new();
        let mut now = 10.0;
        for step in 0..=steps {
            let x = from.0 as i32 + (to.0 as i32 - from.0 as i32) * step / steps;
            let y = from.1 as i32 + (to.1 as i32 - from.1 as i32) * step / steps;
            seen.extend(tracker.feed(&frame(x as usize, y as usize), now));
            now += 0.05;
        }
        for _ in 0..10 {
            seen.extend(tracker.feed(&frame(to.0, to.1), now));
            now += 0.05;
        }
        seen
    }

    #[test]
    fn a_sweep_across_is_one_swipe() {
        let mut tracker = Tracker::new(false);
        assert_eq!(sweep(&mut tracker, (4, 20), (48, 20)), [Gesture::SwipeRight]);
        let mut tracker = Tracker::new(false);
        assert_eq!(sweep(&mut tracker, (48, 20), (4, 20)), [Gesture::SwipeLeft]);
    }

    #[test]
    fn vertical_sweeps_read_up_and_down() {
        let mut tracker = Tracker::new(false);
        assert_eq!(sweep(&mut tracker, (26, 34), (26, 2)), [Gesture::SwipeUp]);
        let mut tracker = Tracker::new(false);
        assert_eq!(sweep(&mut tracker, (26, 2), (26, 34)), [Gesture::SwipeDown]);
    }

    #[test]
    fn a_mirrored_camera_swaps_left_and_right() {
        let mut tracker = Tracker::new(true);
        assert_eq!(sweep(&mut tracker, (4, 20), (48, 20)), [Gesture::SwipeLeft]);
    }

    #[test]
    fn stillness_and_a_short_twitch_do_nothing() {
        let mut tracker = Tracker::new(false);
        let mut now = 0.0;
        for _ in 0..30 {
            assert_eq!(tracker.feed(&frame(20, 20), now), None);
            now += 0.05;
        }
        let mut tracker = Tracker::new(false);
        assert!(sweep(&mut tracker, (20, 20), (26, 21)).is_empty());
    }

    #[test]
    fn the_whole_scene_changing_is_not_a_hand() {
        let mut tracker = Tracker::new(false);
        let mut now = 0.0;
        let mut seen = Vec::new();
        for i in 0..20 {
            let level = if i % 2 == 0 { 20u8 } else { 230u8 };
            seen.extend(tracker.feed(&vec![level; WIDTH * HEIGHT], now));
            now += 0.05;
        }
        assert!(seen.is_empty());
    }
}
