//! Held hand poses from a colour webcam frame, with no model: skin-coloured pixels are
//! found in YCbCr, the biggest hand-sized blob is taken, and the fingers are counted as
//! spikes in how far the blob reaches around its centre.
//!
//! It expects a hand held up with the fingers pointing up, a few tens of centimetres
//! from the lens. A face is skin too: a blob bigger than a hand is ignored, so keep the
//! hand closer than the face. Lighting that bleaches skin to white or tints it orange
//! will blind it. A pose counts only after it has been held steady for a second.

pub const WIDTH: usize = 160;
pub const HEIGHT: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pose {
    Fist,
    Point,
    Two,
    Palm,
}

/// A blob smaller than this share of the picture is noise; larger is a face or a wall.
const MIN_AREA: f32 = 0.015;
const MAX_AREA: f32 = 0.22;
const RAYS: usize = 72;
const MAX_REACH: f32 = 70.0;
/// How long a pose must be held, and how long it must be gone before it can fire again.
const HOLD: f64 = 1.0;
const RELEASE: f64 = 0.6;

fn is_skin(r: u8, g: u8, b: u8) -> bool {
    let (r, g, b) = (f32::from(r), f32::from(g), f32::from(b));
    let cb = 128.0 - 0.168_736 * r - 0.331_264 * g + 0.5 * b;
    let cr = 128.0 + 0.5 * r - 0.418_688 * g - 0.081_312 * b;
    let y = 0.299 * r + 0.587 * g + 0.114 * b;
    (77.0..=127.0).contains(&cb) && (133.0..=173.0).contains(&cr) && y > 50.0
}

/// The small grey picture the sweep reader differences, with everything that is not skin
/// coloured blacked out: a sweep is a hand moving, not the light changing or the camera
/// swaying. `rgb` is `WIDTH * HEIGHT`; `out` is `out_w * out_h`.
pub fn skin_grey(rgb: &[u8], out: &mut [u8], out_w: usize, out_h: usize) {
    if rgb.len() != WIDTH * HEIGHT * 3 || out.len() != out_w * out_h {
        return;
    }
    for y in 0..out_h {
        for x in 0..out_w {
            let at = ((y * HEIGHT / out_h) * WIDTH + x * WIDTH / out_w) * 3;
            let (r, g, b) = (rgb[at], rgb[at + 1], rgb[at + 2]);
            out[y * out_w + x] = if is_skin(r, g, b) {
                ((u16::from(r) + u16::from(g) + u16::from(b)) / 3) as u8
            } else {
                0
            };
        }
    }
}

/// What the detector found in one frame, in `WIDTH * HEIGHT` pixels: for the overlay.
#[derive(Debug, Clone, PartialEq)]
pub struct Hand {
    /// The blob's bounding box: left, top, right, bottom.
    pub bounds: (f32, f32, f32, f32),
    /// The palm circle: centre x, centre y, radius.
    pub palm: (f32, f32, f32),
    /// Fingertips counted.
    pub tips: Vec<(f32, f32)>,
    /// The pose they make, if it is one we name.
    pub pose: Option<Pose>,
}

/// The pose in one `WIDTH * HEIGHT` RGB frame, if a hand is showing one.
pub fn classify(rgb: &[u8]) -> Option<Pose> {
    analyse(rgb)?.pose
}

/// The hand in one frame with its geometry, or `None` when no hand-sized skin is there.
pub fn analyse(rgb: &[u8]) -> Option<Hand> {
    if rgb.len() != WIDTH * HEIGHT * 3 {
        return None;
    }
    let mask: Vec<bool> = rgb
        .chunks_exact(3)
        .map(|p| is_skin(p[0], p[1], p[2]))
        .collect();
    let blob = biggest_blob(&mask)?;
    let area = blob.len() as f32 / (WIDTH * HEIGHT) as f32;
    if !(MIN_AREA..=MAX_AREA).contains(&area) {
        return None;
    }
    let mut in_blob = vec![false; WIDTH * HEIGHT];
    for &i in &blob {
        in_blob[i] = true;
    }
    // The palm is the biggest circle that fits inside the blob: its centre and radius.
    let outside = |x: i32, y: i32| {
        x < 0
            || y < 0
            || x >= WIDTH as i32
            || y >= HEIGHT as i32
            || !in_blob[y as usize * WIDTH + x as usize]
    };
    let edge: Vec<(i32, i32)> = blob
        .iter()
        .map(|&i| ((i % WIDTH) as i32, (i / WIDTH) as i32))
        .filter(|&(x, y)| outside(x - 1, y) || outside(x + 1, y) || outside(x, y - 1) || outside(x, y + 1))
        .collect();
    let (mut cx, mut cy, mut best) = (0.0f32, 0.0f32, -1i32);
    for &i in &blob {
        let (x, y) = ((i % WIDTH) as i32, (i / WIDTH) as i32);
        let nearest = edge
            .iter()
            .map(|&(ex, ey)| (ex - x).pow(2) + (ey - y).pow(2))
            .min()
            .unwrap_or(0);
        if nearest > best {
            best = nearest;
            cx = x as f32;
            cy = y as f32;
        }
    }
    let palm = (best as f32).sqrt().max(3.0);
    // How far the blob reaches along each ray from its centre.
    let profile: Vec<f32> = (0..RAYS)
        .map(|k| {
            let angle = k as f32 / RAYS as f32 * std::f32::consts::TAU;
            let (dx, dy) = (angle.cos(), -angle.sin());
            let mut reach = 0.0;
            let mut gap = 0;
            let mut r = 0.0f32;
            while r < MAX_REACH {
                let (x, y) = ((cx + dx * r).round(), (cy + dy * r).round());
                if x < 0.0 || y < 0.0 || x >= WIDTH as f32 || y >= HEIGHT as f32 {
                    break;
                }
                if in_blob[y as usize * WIDTH + x as usize] {
                    reach = r;
                    gap = 0;
                } else {
                    gap += 1;
                    if gap > 2 {
                        break;
                    }
                }
                r += 1.0;
            }
            reach
        })
        .collect();
    let side = RAYS / 12; // a finger's valleys are within ±30°
    let mut tips = Vec::new();
    for k in 0..RAYS {
        let r = profile[k];
        let angle = k as f32 / RAYS as f32 * 360.0;
        // Fingers point up: ignore the wrist and forearm that run out of the bottom.
        if (215.0..=325.0).contains(&angle) || r <= 1.45 * palm || r - palm <= 5.0 {
            continue;
        }
        let at = |d: i32| profile[(k as i32 + d).rem_euclid(RAYS as i32) as usize];
        // The longest within a hand-width, the first of equals, so one finger is one hit.
        let top = (1..=2).all(|d| at(-d) < r && at(d) <= r);
        let valleys = [-1, 1]
            .iter()
            .all(|&sign| (2..=side as i32).map(|d| at(sign * d)).fold(f32::MAX, f32::min) < 0.75 * r);
        if top && valleys {
            let a = angle.to_radians();
            tips.push((cx + a.cos() * r, cy - a.sin() * r));
        }
    }
    let pose = match tips.len() {
        0 => Some(Pose::Fist),
        1 => Some(Pose::Point),
        2 => Some(Pose::Two),
        4 | 5 => Some(Pose::Palm),
        _ => None, // three, or a smear: not a pose we name
    };
    let (mut left, mut top, mut right, mut bottom) = (f32::MAX, f32::MAX, 0.0f32, 0.0f32);
    for &i in &blob {
        let (x, y) = ((i % WIDTH) as f32, (i / WIDTH) as f32);
        left = left.min(x);
        top = top.min(y);
        right = right.max(x);
        bottom = bottom.max(y);
    }
    Some(Hand {
        bounds: (left, top, right, bottom),
        palm: (cx, cy, palm),
        tips,
        pose,
    })
}

fn biggest_blob(mask: &[bool]) -> Option<Vec<usize>> {
    let mut seen = vec![false; mask.len()];
    let mut best: Vec<usize> = Vec::new();
    for start in 0..mask.len() {
        if !mask[start] || seen[start] {
            continue;
        }
        let mut blob = Vec::new();
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(i) = stack.pop() {
            blob.push(i);
            let (x, y) = (i % WIDTH, i / WIDTH);
            let neighbours = [
                (x > 0).then(|| i - 1),
                (x + 1 < WIDTH).then(|| i + 1),
                (y > 0).then(|| i - WIDTH),
                (y + 1 < HEIGHT).then(|| i + WIDTH),
            ];
            for n in neighbours.into_iter().flatten() {
                if mask[n] && !seen[n] {
                    seen[n] = true;
                    stack.push(n);
                }
            }
        }
        if blob.len() > best.len() {
            best = blob;
        }
    }
    (!best.is_empty()).then_some(best)
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
        let done = if self.fired { 1.0 } else { ((now - since) / HOLD).clamp(0.0, 1.0) };
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

#[cfg(test)]
mod tests {
    use super::*;

    const SKIN: [u8; 3] = [224, 172, 140];

    fn blank() -> Vec<u8> {
        [30u8, 30, 30].repeat(WIDTH * HEIGHT)
    }

    fn paint(frame: &mut [u8], x: i32, y: i32) {
        if (0..WIDTH as i32).contains(&x) && (0..HEIGHT as i32).contains(&y) {
            let i = (y as usize * WIDTH + x as usize) * 3;
            frame[i..i + 3].copy_from_slice(&SKIN);
        }
    }

    /// A hand: a disc, a forearm running down, and fingers at the given angles from up.
    fn hand(finger_degrees: &[f32]) -> Vec<u8> {
        let mut frame = blank();
        let (cx, cy) = (80.0f32, 55.0f32);
        for y in 0..HEIGHT as i32 {
            for x in 0..WIDTH as i32 {
                let (dx, dy) = (x as f32 - cx, y as f32 - cy);
                if dx.hypot(dy) <= 13.0 || (dy > 0.0 && dx.abs() <= 8.0 && dy < 60.0) {
                    paint(&mut frame, x, y);
                }
            }
        }
        for degrees in finger_degrees {
            let (sin, cos) = degrees.to_radians().sin_cos();
            for step in 0..34 {
                for width in -2..=2 {
                    let along = step as f32;
                    let x = cx + sin * along + cos * width as f32;
                    let y = cy - cos * along + sin * width as f32;
                    paint(&mut frame, x.round() as i32, y.round() as i32);
                }
            }
        }
        frame
    }

    #[test]
    fn fingers_are_counted_as_spikes() {
        assert_eq!(classify(&hand(&[])), Some(Pose::Fist));
        assert_eq!(classify(&hand(&[0.0])), Some(Pose::Point));
        assert_eq!(classify(&hand(&[-12.0, 12.0])), Some(Pose::Two));
        assert_eq!(
            classify(&hand(&[-48.0, -24.0, 0.0, 24.0, 48.0])),
            Some(Pose::Palm)
        );
    }

    #[test]
    fn the_hand_view_gets_the_palm_and_the_tips() {
        let found = analyse(&hand(&[-12.0, 12.0])).expect("a hand");
        assert_eq!(found.pose, Some(Pose::Two));
        assert_eq!(found.tips.len(), 2);
        let (cx, cy, radius) = found.palm;
        assert!((cx - 80.0).abs() < 6.0 && (cy - 55.0).abs() < 8.0 && radius > 8.0);
        let (left, top, right, _) = found.bounds;
        assert!(left < 80.0 && right > 80.0 && top < 40.0);
        assert!(found.tips.iter().all(|&(_, y)| y < cy));
        assert_eq!(analyse(&blank()), None);
    }

    #[test]
    fn only_skin_shows_up_for_the_sweep_reader() {
        let mut grey = vec![9u8; 64 * 48];
        skin_grey(&blank(), &mut grey, 64, 48);
        assert!(grey.iter().all(|&v| v == 0), "a dark scene is empty");
        skin_grey(&hand(&[0.0]), &mut grey, 64, 48);
        let lit = grey.iter().filter(|&&v| v > 0).count();
        assert!(lit > 50 && lit < 64 * 48 / 2);
    }

    #[test]
    fn no_skin_or_a_face_sized_blob_is_not_a_pose() {
        assert_eq!(classify(&blank()), None);
        let mut face = blank();
        for y in 0..HEIGHT as i32 {
            for x in 0..WIDTH as i32 {
                if (x - 80).pow(2) + (y - 60).pow(2) < 52 * 52 {
                    paint(&mut face, x, y);
                }
            }
        }
        assert_eq!(classify(&face), None);
        assert_eq!(classify(&[0u8; 12]), None);
    }

    #[test]
    fn a_pose_fires_once_after_a_steady_second() {
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
}
