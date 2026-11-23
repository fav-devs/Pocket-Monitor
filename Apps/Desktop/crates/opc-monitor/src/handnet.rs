//! Hand tracking with a trained model: MediaPipe's palm detector finds a hand, a rotated
//! crop of it goes through MediaPipe's 21-point hand landmark model, and the landmarks
//! say where every finger joint is. Both models are ONNX files built into the program and
//! run on this PC through ONNX Runtime: on the GPU with DirectML where there is one, on
//! the CPU otherwise. Nothing leaves the machine.
//!
//! Once a hand is found the next frame's crop is placed from the last landmarks, so the
//! palm detector only runs again when the hand is lost.

use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::time::Instant;

use ort::session::Session;
use ort::value::Tensor;

const PALM_MODEL: &[u8] = include_bytes!("../assets/hand/palm_detection.onnx");
const HAND_MODEL: &[u8] = include_bytes!("../assets/hand/hand_landmarks.onnx");
const ANCHORS: &[u8] = include_bytes!("../assets/hand/anchors.bin");

/// Landmarks per hand.
pub const POINTS: usize = 21;
/// Which landmarks are joined, for drawing the skeleton.
pub const BONES: [(usize, usize); 21] = [
    (0, 1),
    (1, 2),
    (2, 3),
    (3, 4),
    (0, 5),
    (5, 6),
    (6, 7),
    (7, 8),
    (5, 9),
    (9, 10),
    (10, 11),
    (11, 12),
    (9, 13),
    (13, 14),
    (14, 15),
    (15, 16),
    (13, 17),
    (17, 18),
    (18, 19),
    (19, 20),
    (0, 17),
];
/// The five fingertips.
pub const TIPS: [usize; 5] = [4, 8, 12, 16, 20];

const PALM_SIZE: usize = 192;
const HAND_SIZE: usize = 224;
/// The palm detector must be at least this sure (0 to 1) there is a hand.
const PALM_SCORE: f32 = 0.6;
/// The landmark model must be at least this sure (0 to 1) it is looking at a hand.
const HAND_SCORE: f32 = 0.8;

/// One hand: its 21 landmarks in the frame's own units, x and y from 0 to 1 across and
/// down the frame (a little outside when the hand is half out of it).
#[derive(Debug, Clone, PartialEq)]
pub struct Hand {
    pub points: [(f32, f32); POINTS],
    /// The frame's width over its height, for measuring distances between landmarks.
    pub aspect: f32,
    /// How sure the model is that this is a hand, 0 to 1.
    pub score: f32,
    /// Whether the model reads it as a right hand.
    pub right: bool,
}

impl Hand {
    /// The box around every landmark: left, top, right, bottom.
    pub fn bounds(&self) -> (f32, f32, f32, f32) {
        let mut b = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &(x, y) in &self.points {
            b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
        }
        b
    }

    /// The middle of the palm: the wrist and the four finger bases.
    pub fn palm_centre(&self) -> (f32, f32) {
        let ids = [0, 5, 9, 13, 17];
        let n = ids.len() as f32;
        (
            ids.iter().map(|&i| self.points[i].0).sum::<f32>() / n,
            ids.iter().map(|&i| self.points[i].1).sum::<f32>() / n,
        )
    }
}

/// A square window onto the frame, in frame pixels, tilted by `angle` radians clockwise.
#[derive(Debug, Clone, Copy)]
struct Crop {
    cx: f32,
    cy: f32,
    side: f32,
    angle: f32,
}

impl Crop {
    /// Where the crop's local point (`x`, `y` from -side/2 to side/2, y down) lies in the frame.
    fn to_frame(&self, x: f32, y: f32) -> (f32, f32) {
        let (s, c) = self.angle.sin_cos();
        (self.cx + x * c - y * s, self.cy + x * s + y * c)
    }
}

/// The detector and the landmark model, ready to look at frames.
pub struct HandNet {
    palm: Session,
    hand: Session,
    anchors: Vec<(f32, f32)>,
    /// Where the hand was last frame, once one has been found.
    tracking: Option<Crop>,
    provider: &'static str,
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x.clamp(-60.0, 60.0)).exp())
}

fn build_session(model: &[u8]) -> Result<(Session, &'static str), String> {
    #[cfg(windows)]
    {
        use ort::execution_providers::DirectMLExecutionProvider;
        let gpu = Session::builder()
            .and_then(|builder| {
                builder.with_execution_providers([DirectMLExecutionProvider::default()
                    .build()
                    .error_on_failure()])
            })
            .and_then(|builder| builder.commit_from_memory(model));
        match gpu {
            Ok(session) => return Ok((session, "GPU")),
            Err(error) => eprintln!("hands: the GPU is not usable, using the CPU: {error}"),
        }
    }
    let session = Session::builder()
        .and_then(|builder| builder.commit_from_memory(model))
        .map_err(|error| error.to_string())?;
    Ok((session, "CPU"))
}

impl HandNet {
    pub fn new() -> Result<Self, String> {
        let (palm, provider) = build_session(PALM_MODEL)?;
        let (hand, _) = build_session(HAND_MODEL)?;
        let anchors = ANCHORS
            .chunks_exact(8)
            .map(|pair| {
                (
                    f32::from_le_bytes([pair[0], pair[1], pair[2], pair[3]]),
                    f32::from_le_bytes([pair[4], pair[5], pair[6], pair[7]]),
                )
            })
            .collect();
        Ok(Self {
            palm,
            hand,
            anchors,
            tracking: None,
            provider,
        })
    }

    /// "GPU" or "CPU": what the models run on.
    pub fn provider(&self) -> &'static str {
        self.provider
    }

    /// The hand in one `width * height` RGB frame, if there is one.
    pub fn detect(&mut self, rgb: &[u8], width: usize, height: usize) -> Option<Hand> {
        if width < 16 || height < 16 || rgb.len() != width * height * 3 {
            return None;
        }
        let frame = Frame { rgb, width, height };
        let crop = match self.tracking {
            Some(crop) => crop,
            None => self.find_palm(&frame)?,
        };
        match self.read_landmarks(&frame, crop) {
            Some((hand, next)) => {
                self.tracking = Some(next);
                Some(hand)
            }
            None => {
                // Lost it: look for a palm from scratch next time, and now.
                let was_tracking = self.tracking.take().is_some();
                if was_tracking {
                    let crop = self.find_palm(&frame)?;
                    let (hand, next) = self.read_landmarks(&frame, crop)?;
                    self.tracking = Some(next);
                    return Some(hand);
                }
                None
            }
        }
    }

    /// Runs the palm detector on the whole frame and places the first crop.
    fn find_palm(&mut self, frame: &Frame) -> Option<Crop> {
        // The frame, scaled to fit the model's square and centred on black.
        let ratio = PALM_SIZE as f32 / frame.width.max(frame.height) as f32;
        let (scaled_w, scaled_h) = (
            (frame.width as f32 * ratio).round(),
            (frame.height as f32 * ratio).round(),
        );
        let (pad_x, pad_y) = (
            (PALM_SIZE as f32 - scaled_w) / 2.0,
            (PALM_SIZE as f32 - scaled_h) / 2.0,
        );
        let mut input = vec![0f32; PALM_SIZE * PALM_SIZE * 3];
        for y in 0..PALM_SIZE {
            for x in 0..PALM_SIZE {
                let (fx, fy) = (
                    (x as f32 + 0.5 - pad_x) / ratio,
                    (y as f32 + 0.5 - pad_y) / ratio,
                );
                if fx < 0.0 || fy < 0.0 || fx >= frame.width as f32 || fy >= frame.height as f32 {
                    continue;
                }
                let at = (y * PALM_SIZE + x) * 3;
                let rgb = frame.sample(fx, fy);
                input[at..at + 3].copy_from_slice(&rgb);
            }
        }
        let tensor = Tensor::from_array(([1usize, PALM_SIZE, PALM_SIZE, 3], input)).ok()?;
        let outputs = self.palm.run(ort::inputs!["input_1" => tensor]).ok()?;
        let (boxes_shape, boxes) = outputs[0].try_extract_tensor::<f32>().ok()?;
        let (_, scores) = outputs[1].try_extract_tensor::<f32>().ok()?;
        let stride = *boxes_shape.last()? as usize;
        if stride < 18 || scores.len() < self.anchors.len() {
            return None;
        }
        let best = (0..self.anchors.len())
            .map(|i| (i, sigmoid(scores[i])))
            .filter(|&(_, score)| score >= PALM_SCORE)
            .max_by(|a, b| a.1.total_cmp(&b.1))?
            .0;
        let row = &boxes[best * stride..best * stride + stride];
        let anchor = self.anchors[best];
        let size = PALM_SIZE as f32;
        // Box and keypoints are offsets from the anchor, as fractions of the model's input;
        // back to frame pixels by undoing the letterbox.
        let to_frame = |nx: f32, ny: f32| {
            (
                (nx * size - pad_x) / ratio,
                (ny * size - pad_y) / ratio,
            )
        };
        let (cx, cy) = to_frame(anchor.0 + row[0] / size, anchor.1 + row[1] / size);
        let (w, h) = (row[2] / size * size / ratio, row[3] / size * size / ratio);
        let keypoint = |k: usize| {
            to_frame(
                anchor.0 + row[4 + 2 * k] / size,
                anchor.1 + row[5 + 2 * k] / size,
            )
        };
        let (wrist, middle) = (keypoint(0), keypoint(2));
        // Tilt so the wrist-to-middle-finger line points up.
        let angle = std::f32::consts::FRAC_PI_2 - (-(middle.1 - wrist.1)).atan2(middle.0 - wrist.0);
        let angle = angle - std::f32::consts::TAU * ((angle + std::f32::consts::PI) / std::f32::consts::TAU).floor();
        let (s, c) = angle.sin_cos();
        // Nudge the box toward the fingers and grow it to take in the whole hand.
        Some(Crop {
            cx: cx + 0.5 * h * s,
            cy: cy - 0.5 * h * c,
            side: w.max(h) * 2.6,
            angle,
        })
    }

    /// Runs the landmark model on `crop`. On success the hand, and the crop for next time.
    fn read_landmarks(&mut self, frame: &Frame, crop: Crop) -> Option<(Hand, Crop)> {
        let mut input = vec![0f32; HAND_SIZE * HAND_SIZE * 3];
        for y in 0..HAND_SIZE {
            for x in 0..HAND_SIZE {
                let local_x = ((x as f32 + 0.5) / HAND_SIZE as f32 - 0.5) * crop.side;
                let local_y = ((y as f32 + 0.5) / HAND_SIZE as f32 - 0.5) * crop.side;
                let (fx, fy) = crop.to_frame(local_x, local_y);
                if fx < 0.0 || fy < 0.0 || fx >= frame.width as f32 || fy >= frame.height as f32 {
                    continue;
                }
                let at = (y * HAND_SIZE + x) * 3;
                input[at..at + 3].copy_from_slice(&frame.sample(fx, fy));
            }
        }
        let tensor = Tensor::from_array(([1usize, HAND_SIZE, HAND_SIZE, 3], input)).ok()?;
        let outputs = self.hand.run(ort::inputs!["input_1" => tensor]).ok()?;
        let (_, raw) = outputs[0].try_extract_tensor::<f32>().ok()?;
        let (_, score) = outputs[1].try_extract_tensor::<f32>().ok()?;
        let (_, side) = outputs[2].try_extract_tensor::<f32>().ok()?;
        if raw.len() < POINTS * 3 || score.is_empty() || score[0] < HAND_SCORE {
            return None;
        }
        let mut points = [(0f32, 0f32); POINTS];
        let mut pixels = [(0f32, 0f32); POINTS];
        for (i, point) in points.iter_mut().enumerate() {
            let local_x = (raw[i * 3] / HAND_SIZE as f32 - 0.5) * crop.side;
            let local_y = (raw[i * 3 + 1] / HAND_SIZE as f32 - 0.5) * crop.side;
            let (fx, fy) = crop.to_frame(local_x, local_y);
            pixels[i] = (fx, fy);
            *point = (fx / frame.width as f32, fy / frame.height as f32);
        }
        // Next crop: the hand's own tilt, centred on what the landmarks cover.
        let (wrist, middle) = (pixels[0], pixels[9]);
        let angle = std::f32::consts::FRAC_PI_2 - (-(middle.1 - wrist.1)).atan2(middle.0 - wrist.0);
        let angle = angle - std::f32::consts::TAU * ((angle + std::f32::consts::PI) / std::f32::consts::TAU).floor();
        let (s, c) = angle.sin_cos();
        let (mut lo, mut hi) = ((f32::MAX, f32::MAX), (f32::MIN, f32::MIN));
        for &(x, y) in &pixels {
            // The landmark in the hand's own upright frame.
            let (u, v) = (x * c + y * s, -x * s + y * c);
            lo = (lo.0.min(u), lo.1.min(v));
            hi = (hi.0.max(u), hi.1.max(v));
        }
        let (mid_u, mid_v) = ((lo.0 + hi.0) / 2.0, (lo.1 + hi.1) / 2.0);
        let next = Crop {
            cx: mid_u * c - mid_v * s,
            cy: mid_u * s + mid_v * c,
            side: (hi.0 - lo.0).max(hi.1 - lo.1) * 2.0,
            angle,
        };
        let hand = Hand {
            points,
            aspect: frame.width as f32 / frame.height as f32,
            score: score[0],
            right: side.first().copied().unwrap_or(0.0) > 0.5,
        };
        Some((hand, next))
    }
}

/// An RGB frame, with bilinear sampling.
struct Frame<'a> {
    rgb: &'a [u8],
    width: usize,
    height: usize,
}

impl Frame<'_> {
    /// The colour at a frame position, as 0 to 1 floats.
    fn sample(&self, x: f32, y: f32) -> [f32; 3] {
        let (x, y) = ((x - 0.5).max(0.0), (y - 0.5).max(0.0));
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.width - 1), (y0 + 1).min(self.height - 1));
        let (x0, y0) = (x0.min(self.width - 1), y0.min(self.height - 1));
        let (fx, fy) = (x - x.floor(), y - y.floor());
        let at = |px: usize, py: usize, channel: usize| {
            f32::from(self.rgb[(py * self.width + px) * 3 + channel]) / 255.0
        };
        let mut out = [0f32; 3];
        for (channel, value) in out.iter_mut().enumerate() {
            let top = at(x0, y0, channel) * (1.0 - fx) + at(x1, y0, channel) * fx;
            let bottom = at(x0, y1, channel) * (1.0 - fx) + at(x1, y1, channel) * fx;
            *value = top * (1.0 - fy) + bottom * fy;
        }
        out
    }
}

// ---- Off the main thread -----------------------------------------------------------

/// What the worker reports.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    /// The models are loaded, on "GPU" or "CPU".
    Ready(&'static str),
    /// The models could not be loaded.
    Failed(String),
    /// One frame's result, and how long the models took on it.
    Seen(Option<Hand>, f32),
}

struct Job {
    rgb: Vec<u8>,
    width: usize,
    height: usize,
}

/// A thread that owns a [`HandNet`]: frames go in, results come out, and a frame sent
/// while it is busy is dropped rather than queued, so it never lags behind the picture.
pub struct HandWorker {
    jobs: SyncSender<Job>,
    updates: Receiver<Update>,
}

impl HandWorker {
    pub fn start() -> Self {
        let (jobs, job_rx) = sync_channel::<Job>(1);
        let (update_tx, updates) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut net = match HandNet::new() {
                Ok(net) => {
                    let _ = update_tx.send(Update::Ready(net.provider()));
                    net
                }
                Err(error) => {
                    let _ = update_tx.send(Update::Failed(error));
                    return;
                }
            };
            // Ends when the sender is dropped, which also ends the models.
            while let Ok(job) = job_rx.recv() {
                let started = Instant::now();
                let hand = net.detect(&job.rgb, job.width, job.height);
                let ms = started.elapsed().as_secs_f32() * 1000.0;
                if update_tx.send(Update::Seen(hand, ms)).is_err() {
                    break;
                }
            }
        });
        Self { jobs, updates }
    }

    /// Offers a frame; false when the worker is still busy with the last one.
    pub fn submit(&self, rgb: Vec<u8>, width: usize, height: usize) -> bool {
        match self.jobs.try_send(Job { rgb, width, height }) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
        }
    }

    /// Everything reported since the last call.
    pub fn updates(&self) -> Vec<Update> {
        self.updates.try_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_models_load_and_a_bare_wall_is_not_a_hand() {
        let mut net = HandNet::new().expect("the built-in models load");
        // Beige and flat, the kind of wall skin-colour tricks mistake for a hand.
        let wall = [214u8, 190, 165].repeat(480 * 270);
        for _ in 0..3 {
            assert_eq!(net.detect(&wall, 480, 270), None);
        }
        assert_eq!(net.detect(&[0u8; 30], 480, 270), None, "a wrong-sized frame");
        let black = vec![0u8; 480 * 270 * 3];
        assert_eq!(net.detect(&black, 480, 270), None);
    }

    #[test]
    fn a_crop_maps_its_corners_through_the_tilt() {
        let crop = Crop {
            cx: 100.0,
            cy: 100.0,
            side: 40.0,
            angle: std::f32::consts::FRAC_PI_2,
        };
        // Turned a quarter clockwise, the crop's right is the frame's down.
        let (x, y) = crop.to_frame(10.0, 0.0);
        assert!((x - 100.0).abs() < 1e-3 && (y - 110.0).abs() < 1e-3, "{x} {y}");
        let (x, y) = crop.to_frame(0.0, -10.0);
        assert!((x - 110.0).abs() < 1e-3 && (y - 100.0).abs() < 1e-3, "{x} {y}");
    }
}
