//! The media player's clock and sound staging, without a decoder or a device (§1.V).
//!
//! Moved from `opc-monitor`'s `media.rs` (`MediaDriver::tick` and `release_audio`) so
//! the Tauri player thread runs the same numbers and they can be tested: a frame is
//! shown when the clock reaches its time; the clock runs at the conform speed; audio is
//! handed to the device [`AUDIO_LEAD_MS`] ahead of the picture, what is already behind
//! the clock after a scrub is dropped, and anything but the clip's own speed is silent.

/// Pictures decoded ahead of the clock. Their audio comes with them, so this is also
/// how far ahead the sound can be staged.
pub const LOOKAHEAD: usize = 8;
/// How far ahead of the picture on screen audio is handed to the device: enough to ride
/// out a late frame, little enough to stay in step.
pub const AUDIO_LEAD_MS: i64 = 80;
/// The filmstrip under the scrubber.
pub const STRIP_FRAMES: i64 = 8;
/// The filmstrip's frame width.
pub const STRIP_WIDTH: u32 = 160;

/// The clip's clock: the frame on screen, the wall time it was shown at, the rate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlayClock {
    pub shown_ms: i64,
    pub shown_at: f64,
    pub speed: f64,
}

impl Default for PlayClock {
    fn default() -> Self {
        Self {
            shown_ms: 0,
            shown_at: 0.0,
            speed: 1.0,
        }
    }
}

impl PlayClock {
    /// Where the clip should be at `now` (seconds).
    pub fn target_ms(&self, now: f64) -> i64 {
        self.shown_ms + ((now - self.shown_at) * 1000.0 * self.speed) as i64
    }

    /// A frame went up.
    pub fn shown(&mut self, pts: i64, now: f64) {
        self.shown_ms = pts;
        self.shown_at = now;
    }

    /// Re-anchors so a rate change starts from the frame on screen. A rate that is not a
    /// positive number is the clip's own.
    pub fn set_speed(&mut self, speed: f64, now: f64) {
        self.shown_at = now;
        self.speed = if speed.is_finite() && speed > 0.0 {
            speed
        } else {
            1.0
        };
    }
}

/// Decoded interleaved stereo waiting for the device, and the time of its first sample.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AudioStage {
    pub samples: Vec<f32>,
    pub pts: i64,
}

/// What [`AudioStage::release`] decided.
#[derive(Debug, Clone, PartialEq)]
pub enum Release {
    /// Nothing to do.
    Hold,
    /// Not the clip's own speed: drop everything, and clear the device.
    Silence,
    /// Hand these samples to the device.
    Push(Vec<f32>),
}

impl AudioStage {
    pub fn clear(&mut self) {
        self.samples.clear();
    }

    /// Decoded audio the reader handed over, starting at `pts`.
    pub fn stage(&mut self, samples: Vec<f32>, pts: i64) {
        if samples.is_empty() {
            return;
        }
        if self.samples.is_empty() {
            self.pts = pts;
        }
        self.samples.extend(samples);
    }

    /// The staged audio up to a little past `clock_ms` at a device running at `rate`,
    /// dropping what is already behind it.
    pub fn release(&mut self, clock_ms: i64, rate: u32, speed: f64) -> Release {
        if self.samples.is_empty() || rate == 0 {
            return Release::Hold;
        }
        if speed != 1.0 {
            self.samples.clear();
            return Release::Silence;
        }
        let per_ms = f64::from(rate) * 2.0 / 1000.0;
        let frames = |ms: i64| ((ms.max(0) as f64 * per_ms) as usize / 2) * 2;
        let late = frames(clock_ms - AUDIO_LEAD_MS / 2 - self.pts).min(self.samples.len());
        if late > 0 {
            self.samples.drain(..late);
            self.pts += (late / 2) as i64 * 1000 / i64::from(rate);
        }
        let release = frames(clock_ms + AUDIO_LEAD_MS - self.pts).min(self.samples.len());
        if release == 0 {
            return Release::Hold;
        }
        let out: Vec<f32> = self.samples.drain(..release).collect();
        self.pts += (release / 2) as i64 * 1000 / i64::from(rate);
        Release::Push(out)
    }
}

/// Where the eight filmstrip frames sit in a clip.
pub fn strip_positions(duration_ms: i64) -> Vec<i64> {
    if duration_ms <= 0 {
        return Vec::new();
    }
    (0..STRIP_FRAMES)
        .map(|index| duration_ms * index / STRIP_FRAMES)
        .collect()
}

/// `mm:ss`, or `h:mm:ss`, zero-padded like Mimo's time pill.
pub fn clock_label(ms: i64) -> String {
    let seconds = (ms / 1000).max(0);
    let (h, m, s) = (seconds / 3600, (seconds % 3600) / 60, seconds % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// A decoded picture's planes (BT.709 limited) to a `width`-wide RGBA frame, nearest
/// sampled: the filmstrip's frames.
#[allow(clippy::too_many_arguments)]
pub fn small_rgba(
    width: u32,
    height: u32,
    luma: &[u8],
    luma_stride: usize,
    cb: &[u8],
    cr: &[u8],
    chroma_stride: usize,
    out_width: u32,
) -> (u32, u32, Vec<u8>) {
    let out_width = out_width.max(1);
    let out_height =
        ((u64::from(height) * u64::from(out_width) / u64::from(width.max(1))).max(1)) as u32;
    let mut rgba = vec![0u8; (out_width * out_height * 4) as usize];
    for y in 0..out_height {
        let sy = (y * height / out_height).min(height.saturating_sub(1)) as usize;
        for x in 0..out_width {
            let sx = (x * width / out_width).min(width.saturating_sub(1)) as usize;
            let at =
                |plane: &[u8], index: usize| f32::from(plane.get(index).copied().unwrap_or(128));
            let luma = at(luma, sy * luma_stride + sx);
            let chroma = (sy / 2) * chroma_stride + sx / 2;
            let (b, r) = (at(cb, chroma) - 128.0, at(cr, chroma) - 128.0);
            let yy = (luma - 16.0) * 1.1644;
            let i = ((y * out_width + x) * 4) as usize;
            rgba[i] = (yy + 1.7927 * r).clamp(0.0, 255.0) as u8;
            rgba[i + 1] = (yy - 0.2132 * b - 0.5329 * r).clamp(0.0, 255.0) as u8;
            rgba[i + 2] = (yy + 2.1124 * b).clamp(0.0, 255.0) as u8;
            rgba[i + 3] = 255;
        }
    }
    (out_width, out_height, rgba)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_runs_at_the_conform_speed_from_the_frame_on_screen() {
        let mut clock = PlayClock::default();
        clock.shown(1000, 10.0);
        assert_eq!(clock.target_ms(10.5), 1500);
        clock.set_speed(0.2, 10.5);
        assert_eq!(clock.target_ms(11.5), 1200, "re-anchored at the change");
        clock.set_speed(f64::NAN, 11.5);
        assert_eq!(clock.speed, 1.0);
    }

    #[test]
    fn audio_goes_out_a_lead_ahead_and_what_is_behind_is_dropped() {
        let rate = 1000; // 2 samples per ms.
        let mut stage = AudioStage::default();
        stage.stage(vec![0.5; 2000], 0); // one second
        match stage.release(0, rate, 1.0) {
            Release::Push(out) => assert_eq!(out.len(), 160, "80 ms lead"),
            other => panic!("{other:?}"),
        }
        assert_eq!(stage.pts, 80);
        // A scrub put the clock at 500 ms: what is behind it (less half a lead) goes,
        // and the rest goes out up to a lead past the clock (460 → 580 ms).
        match stage.release(500, rate, 1.0) {
            Release::Push(out) => assert_eq!(out.len(), 240),
            other => panic!("{other:?}"),
        }
        assert_eq!(stage.pts, 580);
        assert_eq!(stage.release(500, rate, 1.0), Release::Hold);
        assert_eq!(stage.release(500, rate, 0.5), Release::Silence);
        assert!(stage.samples.is_empty(), "conform speeds play silent");
        assert_eq!(stage.release(600, 0, 1.0), Release::Hold, "no device");
    }

    #[test]
    fn the_strip_spans_the_clip() {
        assert_eq!(
            strip_positions(8000),
            [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]
        );
        assert!(strip_positions(0).is_empty());
    }

    #[test]
    fn the_player_reads_its_clock_as_the_phones_do() {
        assert_eq!(clock_label(9_400), "00:09");
        assert_eq!(clock_label(26_000), "00:26");
        assert_eq!(clock_label(3_726_000), "1:02:06");
    }

    #[test]
    fn a_grey_picture_stays_grey_in_the_strip() {
        let luma = vec![126u8; 4 * 4];
        let chroma = vec![128u8; 2 * 2];
        let (w, h, rgba) = small_rgba(4, 4, &luma, 4, &chroma, &chroma, 2, 2);
        assert_eq!((w, h), (2, 2));
        assert!(rgba
            .chunks(4)
            .all(|p| p[0] == p[1] && p[1] == p[2] && p[3] == 255));
    }
}
