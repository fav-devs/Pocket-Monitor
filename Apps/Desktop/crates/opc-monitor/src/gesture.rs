//! Hand-wave gestures from frame differencing, with no model: where things are moving,
//! and a quick, mostly straight sweep of that motion is a swipe. Frames are small grey
//! pictures. The viewfinder now reads hands with the landmark model in [`crate::handnet`]
//! and [`crate::hand`]; this reader stays for pictures that model cannot be run on, and
//! owns the [`Gesture`] names and the actions they map to.

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
    /// Index and little finger out: the rock sign.
    Horns,
    /// Opening and closing a hand quickly, three times over.
    FaceTrack,
}

impl Gesture {
    pub const ALL: [Gesture; 10] = [
        Gesture::SwipeLeft,
        Gesture::SwipeRight,
        Gesture::SwipeUp,
        Gesture::SwipeDown,
        Gesture::Palm,
        Gesture::Fist,
        Gesture::Point,
        Gesture::Two,
        Gesture::Horns,
        Gesture::FaceTrack,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Gesture::SwipeLeft => "Swipe left",
            Gesture::SwipeRight => "Swipe right",
            Gesture::SwipeUp => "Swipe up",
            Gesture::SwipeDown => "Swipe down",
            Gesture::Palm => "Open palm",
            Gesture::Fist => "Fist",
            Gesture::Point => "One finger",
            Gesture::Two => "Two fingers (peace sign)",
            Gesture::Horns => "Rock sign",
            Gesture::FaceTrack => "Open and close, three times",
        }
    }

    /// How to make it.
    pub fn how(self) -> &'static str {
        match self {
            Gesture::SwipeLeft => "Sweep your hand to your left, quickly, in view of the camera",
            Gesture::SwipeRight => "Sweep your hand to your right, quickly",
            Gesture::SwipeUp => "Sweep your hand upward",
            Gesture::SwipeDown => "Sweep your hand downward",
            Gesture::Palm => "Hold up an open hand, four fingers out, for about a second",
            Gesture::Fist => "Hold up a closed fist for one second",
            Gesture::Point => "Hold up one finger for one second",
            Gesture::Two => "Hold up two fingers for one second",
            Gesture::Horns => "Index and little finger out, the others folded, for about a second",
            Gesture::FaceTrack => "Open your hand and close it to a fist, quickly, three times over",
        }
    }

    fn index(self) -> usize {
        Self::ALL.iter().position(|g| *g == self).unwrap_or(0)
    }

    fn key(self) -> &'static str {
        match self {
            Gesture::SwipeLeft => "swipe_left",
            Gesture::SwipeRight => "swipe_right",
            Gesture::SwipeUp => "swipe_up",
            Gesture::SwipeDown => "swipe_down",
            Gesture::Palm => "palm",
            Gesture::Fist => "fist",
            Gesture::Point => "point",
            Gesture::Two => "two",
            Gesture::Horns => "horns",
            Gesture::FaceTrack => "face_track",
        }
    }
}

/// What a gesture can be set to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GestureAction {
    Nothing,
    Recenter,
    Flip,
    NextPreset,
    PreviousPreset,
    /// Stop a move or recall in flight and let go of tracking.
    Stop,
    /// Start or stop recording. Held longer than the others, so it is never an accident.
    Record,
    /// Start tracking the face the camera sees, or stop tracking.
    FaceTrack,
}

impl GestureAction {
    pub const ALL: [GestureAction; 8] = [
        GestureAction::Nothing,
        GestureAction::Recenter,
        GestureAction::Flip,
        GestureAction::NextPreset,
        GestureAction::PreviousPreset,
        GestureAction::Stop,
        GestureAction::Record,
        GestureAction::FaceTrack,
    ];

    pub fn label(self) -> &'static str {
        match self {
            GestureAction::Nothing => "Do nothing",
            GestureAction::Recenter => "Recentre the gimbal",
            GestureAction::Flip => "Flip (selfie)",
            GestureAction::NextPreset => "Next preset",
            GestureAction::PreviousPreset => "Previous preset",
            GestureAction::Stop => "Stop everything",
            GestureAction::Record => "Start / stop recording (hold 2.5 s)",
            GestureAction::FaceTrack => "Face tracking on / off",
        }
    }

    fn key(self) -> &'static str {
        match self {
            GestureAction::Nothing => "nothing",
            GestureAction::Recenter => "recenter",
            GestureAction::Flip => "flip",
            GestureAction::NextPreset => "next_preset",
            GestureAction::PreviousPreset => "previous_preset",
            GestureAction::Stop => "stop",
            GestureAction::Record => "record",
            GestureAction::FaceTrack => "face_track",
        }
    }
}

/// Which action each gesture does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GestureMap([GestureAction; 10]);

impl Default for GestureMap {
    fn default() -> Self {
        let mut map = Self([GestureAction::Nothing; 10]);
        map.set(Gesture::SwipeLeft, GestureAction::PreviousPreset);
        map.set(Gesture::SwipeRight, GestureAction::NextPreset);
        // Raising and lowering a hand reads as a vertical sweep, so those do nothing
        // until the operator chooses otherwise.
        map.set(Gesture::Palm, GestureAction::Stop);
        map.set(Gesture::Fist, GestureAction::Recenter);
        map.set(Gesture::Point, GestureAction::NextPreset);
        // Recording is the one to never trigger by accident: a peace sign, held.
        map.set(Gesture::Two, GestureAction::Record);
        map.set(Gesture::Horns, GestureAction::Flip);
        map.set(Gesture::FaceTrack, GestureAction::FaceTrack);
        map
    }
}

impl GestureMap {
    pub fn get(&self, gesture: Gesture) -> GestureAction {
        self.0[gesture.index()]
    }

    pub fn set(&mut self, gesture: Gesture, action: GestureAction) {
        self.0[gesture.index()] = action;
    }

    /// One `gesture.NAME=action` line each.
    pub fn to_lines(&self) -> String {
        Gesture::ALL
            .iter()
            .map(|g| format!("gesture.{}={}\n", g.key(), self.get(*g).key()))
            .collect()
    }

    /// Reads one line of [`Self::to_lines`]; anything else is ignored.
    pub fn read_line(&mut self, line: &str) {
        let Some((key, value)) = line
            .strip_prefix("gesture.")
            .and_then(|rest| rest.split_once('='))
        else {
            return;
        };
        let gesture = Gesture::ALL.iter().find(|g| g.key() == key);
        let action = GestureAction::ALL.iter().find(|a| a.key() == value);
        if let (Some(gesture), Some(action)) = (gesture, action) {
            self.set(*gesture, *action);
        }
    }
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
    fn the_map_survives_its_lines_and_ignores_junk() {
        let mut map = GestureMap::default();
        map.set(Gesture::Fist, GestureAction::Record);
        map.set(Gesture::SwipeUp, GestureAction::Nothing);
        let mut read = GestureMap::default();
        for line in map.to_lines().lines() {
            read.read_line(line);
        }
        read.read_line("gesture.palm=launch_missiles");
        read.read_line("gesture.unknown=flip");
        read.read_line("nonsense");
        assert_eq!(read, map);
        assert_eq!(GestureMap::default().get(Gesture::Palm), GestureAction::Stop);
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
