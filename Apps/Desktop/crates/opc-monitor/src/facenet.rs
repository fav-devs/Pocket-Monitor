//! Where faces are in a picture, with YuNet (a small trained face detector, built in,
//! run through ONNX Runtime like the hand models). It finds boxes only: it does not
//! recognise or identify anyone, and nothing is stored or sent.

use ort::session::Session;
use ort::value::Tensor;

const MODEL: &[u8] = include_bytes!("../assets/hand/face_detection_yunet.onnx");
const SIZE: usize = 640;
const STRIDES: [usize; 3] = [8, 16, 32];
const MIN_SCORE: f32 = 0.6;
const NMS: f32 = 0.3;

/// A face: the box around it as fractions of the frame, and how sure the model is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Face {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub score: f32,
}

impl Face {
    fn overlap(&self, other: &Face) -> f32 {
        let w = (self.x + self.width).min(other.x + other.width) - self.x.max(other.x);
        let h = (self.y + self.height).min(other.y + other.height) - self.y.max(other.y);
        if w <= 0.0 || h <= 0.0 {
            return 0.0;
        }
        let both = w * h;
        both / (self.width * self.height + other.width * other.height - both)
    }
}

pub struct FaceNet {
    session: Session,
}

impl FaceNet {
    pub fn new() -> Result<Self, String> {
        let (session, _) = crate::handnet::build_session(MODEL)?;
        Ok(Self { session })
    }

    /// Faces in one `width * height` RGB frame, biggest first.
    pub fn detect(&mut self, rgb: &[u8], width: usize, height: usize) -> Vec<Face> {
        if width < 16 || height < 16 || rgb.len() != width * height * 3 {
            return Vec::new();
        }
        // The frame scaled to fit the model's square and centred on black; the model
        // wants BGR planes in 0 to 255.
        let ratio = SIZE as f32 / width.max(height) as f32;
        let (pad_x, pad_y) = (
            (SIZE as f32 - width as f32 * ratio) / 2.0,
            (SIZE as f32 - height as f32 * ratio) / 2.0,
        );
        let mut input = vec![0f32; 3 * SIZE * SIZE];
        for y in 0..SIZE {
            let fy = ((y as f32 + 0.5 - pad_y) / ratio).floor();
            if fy < 0.0 || fy >= height as f32 {
                continue;
            }
            for x in 0..SIZE {
                let fx = ((x as f32 + 0.5 - pad_x) / ratio).floor();
                if fx < 0.0 || fx >= width as f32 {
                    continue;
                }
                let at = (fy as usize * width + fx as usize) * 3;
                let cell = y * SIZE + x;
                input[cell] = f32::from(rgb[at + 2]);
                input[SIZE * SIZE + cell] = f32::from(rgb[at + 1]);
                input[2 * SIZE * SIZE + cell] = f32::from(rgb[at]);
            }
        }
        let Ok(tensor) = Tensor::from_array(([1usize, 3, SIZE, SIZE], input)) else {
            return Vec::new();
        };
        let Ok(outputs) = self.session.run(ort::inputs!["input" => tensor]) else {
            return Vec::new();
        };
        let mut faces = Vec::new();
        for (level, &stride) in STRIDES.iter().enumerate() {
            let read = |index: usize| {
                outputs[index]
                    .try_extract_tensor::<f32>()
                    .ok()
                    .map(|(_, data)| data.to_vec())
            };
            let (Some(cls), Some(obj), Some(bbox)) =
                (read(level), read(3 + level), read(6 + level))
            else {
                return Vec::new();
            };
            let columns = SIZE / stride;
            for index in 0..columns * columns {
                let score = (cls[index].clamp(0.0, 1.0) * obj[index].clamp(0.0, 1.0)).sqrt();
                if score < MIN_SCORE {
                    continue;
                }
                let (row, column) = ((index / columns) as f32, (index % columns) as f32);
                let stride = stride as f32;
                let centre_x = (column + bbox[index * 4]) * stride;
                let centre_y = (row + bbox[index * 4 + 1]) * stride;
                let w = bbox[index * 4 + 2].clamp(-10.0, 10.0).exp() * stride;
                let h = bbox[index * 4 + 3].clamp(-10.0, 10.0).exp() * stride;
                // Back through the letterbox to fractions of the frame.
                let fx = (centre_x - w / 2.0 - pad_x) / ratio / width as f32;
                let fy = (centre_y - h / 2.0 - pad_y) / ratio / height as f32;
                faces.push(Face {
                    x: fx,
                    y: fy,
                    width: w / ratio / width as f32,
                    height: h / ratio / height as f32,
                    score,
                });
            }
        }
        faces.sort_by(|a, b| b.score.total_cmp(&a.score));
        let mut kept: Vec<Face> = Vec::new();
        for face in faces {
            if kept.iter().all(|other| other.overlap(&face) < NMS) {
                kept.push(face);
            }
        }
        // The biggest is the one in front.
        kept.sort_by(|a, b| (b.width * b.height).total_cmp(&(a.width * a.height)));
        kept
    }
}
