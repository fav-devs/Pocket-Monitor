//! Hearing a double clap in the microphone. Pure signal handling; the stream that feeds
//! it lives in the binary.
//!
//! A clap is a burst that is much louder than the room and rises within a few
//! milliseconds. Two of them, a fraction of a second apart, are the signal: one clap is
//! too easy to make by accident (a door, a desk, a cough).

/// Block length the detector reasons in, in seconds.
const BLOCK: f32 = 0.01;
/// The burst must beat the room's usual level by this much, and this absolute floor.
const RATIO: f32 = 6.0;
const FLOOR: f32 = 0.12;
/// A second clap comes no sooner and no later than this after the first.
const GAP_MIN: f64 = 0.15;
const GAP_MAX: f64 = 0.8;
/// After a double clap, ignore the microphone this long.
const COOLDOWN: f64 = 2.5;
/// Echoes and the tail of one clap are not a second one.
const REFRACTORY: f64 = 0.1;

#[derive(Debug, Default)]
pub struct ClapDetector {
    rate: f32,
    block: Vec<f32>,
    /// Slow average of the room's level.
    room: f32,
    last_level: f32,
    clock: f64,
    first: Option<f64>,
    last_clap: f64,
    quiet_until: f64,
}

impl ClapDetector {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            rate: sample_rate.max(8000) as f32,
            room: 0.01,
            last_clap: f64::MIN,
            ..Self::default()
        }
    }

    /// Mono samples in -1..1. True once, when a double clap has just completed.
    pub fn feed(&mut self, samples: &[f32]) -> bool {
        let per_block = (self.rate * BLOCK) as usize;
        let mut heard = false;
        for &sample in samples {
            self.block.push(sample);
            if self.block.len() >= per_block {
                heard |= self.block_done();
                self.block.clear();
            }
        }
        heard
    }

    fn block_done(&mut self) -> bool {
        self.clock += f64::from(BLOCK);
        let peak = self.block.iter().fold(0.0_f32, |m, s| m.max(s.abs()));
        let level =
            (self.block.iter().map(|s| s * s).sum::<f32>() / self.block.len() as f32).sqrt();
        let rising = level > 3.0 * self.last_level + 0.02;
        let loud = peak > FLOOR && peak > RATIO * self.room;
        self.last_level = level;
        // The room follows quiet blocks only, so a clap does not raise its own bar.
        if !loud {
            self.room += (level - self.room) * 0.02;
        }
        if self.clock < self.quiet_until || !(loud && rising) {
            return false;
        }
        if self.clock - self.last_clap < REFRACTORY {
            return false;
        }
        self.last_clap = self.clock;
        match self.first {
            Some(first) if (GAP_MIN..=GAP_MAX).contains(&(self.clock - first)) => {
                self.first = None;
                self.quiet_until = self.clock + COOLDOWN;
                true
            }
            _ => {
                self.first = Some(self.clock);
                false
            }
        }
    }
}

/// A device's interleaved samples (`channels` per frame) as mono into `out`, the average
/// of each frame's channels. A partial frame at the end is dropped.
pub fn downmix(interleaved: impl Iterator<Item = f32>, channels: usize, out: &mut Vec<f32>) {
    let channels = channels.max(1);
    out.clear();
    let mut sum = 0.0;
    let mut count = 0;
    for sample in interleaved {
        sum += sample;
        count += 1;
        if count == channels {
            out.push(sum / channels as f32);
            sum = 0.0;
            count = 0;
        }
    }
}

/// A 16-bit sample in -1..1.
pub fn sample_i16(sample: i16) -> f32 {
    f32::from(sample) / 32768.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_is_averaged_into_mono() {
        let mut out = vec![9.0];
        downmix([0.5, -0.5, 1.0, 0.0, 0.25].into_iter(), 2, &mut out);
        assert_eq!(out, [0.0, 0.5]);
        downmix([0.1, 0.2].into_iter(), 0, &mut out);
        assert_eq!(out, [0.1, 0.2]);
        assert_eq!(sample_i16(i16::MIN), -1.0);
        assert_eq!(sample_i16(16384), 0.5);
    }

    const RATE: u32 = 16_000;

    fn room(seconds: f32) -> Vec<f32> {
        // Steady low hum.
        (0..(RATE as f32 * seconds) as usize)
            .map(|i| 0.01 * ((i as f32) * 0.3).sin())
            .collect()
    }

    fn clap() -> Vec<f32> {
        // A 20 ms burst, decaying.
        (0..320)
            .map(|i| 0.8 * (-(i as f32) / 80.0).exp() * if i % 2 == 0 { 1.0 } else { -0.7 })
            .collect()
    }

    fn run(parts: &[Vec<f32>]) -> usize {
        let mut detector = ClapDetector::new(RATE);
        parts.iter().filter(|part| detector.feed(part)).count()
    }

    #[test]
    fn two_claps_close_together_fire_once() {
        let parts = vec![room(1.0), clap(), room(0.3), clap(), room(1.0)];
        assert_eq!(run(&parts), 1);
    }

    #[test]
    fn one_clap_does_nothing() {
        assert_eq!(run(&[room(1.0), clap(), room(2.0)]), 0);
    }

    #[test]
    fn claps_far_apart_do_nothing() {
        assert_eq!(run(&[room(1.0), clap(), room(1.5), clap(), room(1.0)]), 0);
    }

    #[test]
    fn a_steady_loud_room_is_not_a_clap() {
        let loud: Vec<f32> = (0..RATE as usize * 3)
            .map(|i| 0.3 * ((i as f32) * 0.2).sin())
            .collect();
        assert_eq!(run(&[loud]), 0);
    }

    #[test]
    fn it_rests_after_firing() {
        let parts = vec![
            room(1.0),
            clap(),
            room(0.3),
            clap(),
            room(0.3),
            clap(),
            room(0.3),
            clap(),
            room(1.0),
        ];
        assert_eq!(run(&parts), 1);
    }
}
