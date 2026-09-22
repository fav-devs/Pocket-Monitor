//! The player's sound: the clip's audio out of the machine's default output device.
//!
//! The device pulls from a queue on its own thread; the player pushes what the reader
//! decoded, released a little ahead of the picture on screen so the two stay together.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// The rate asked of the device when it offers it; the clips are 48 kHz.
const PREFERRED_RATE: u32 = 48_000;
/// More than this queued is a runaway, not a lead; the rest is dropped.
const MOST_QUEUED_SECONDS: f64 = 2.0;

/// An open output stream and the samples waiting for it.
pub struct AudioOut {
    stream: cpal::Stream,
    queue: Arc<Mutex<VecDeque<f32>>>,
    rate: u32,
}

impl std::fmt::Debug for AudioOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioOut")
            .field("rate", &self.rate)
            .finish()
    }
}

impl AudioOut {
    /// Opens the default output device for interleaved stereo float. None when the
    /// machine has no usable output; the player is then silent.
    pub fn open() -> Option<Self> {
        let device = cpal::default_host().default_output_device()?;
        let default = device.default_output_config().ok()?;
        let rate = device
            .supported_output_configs()
            .ok()
            .and_then(|configs| {
                configs
                    .filter(|c| c.channels() == 2 && c.sample_format() == cpal::SampleFormat::F32)
                    .find(|c| {
                        c.min_sample_rate().0 <= PREFERRED_RATE
                            && PREFERRED_RATE <= c.max_sample_rate().0
                    })
                    .map(|_| PREFERRED_RATE)
            })
            .unwrap_or(default.sample_rate().0);
        let config = cpal::StreamConfig {
            channels: 2,
            sample_rate: cpal::SampleRate(rate),
            buffer_size: cpal::BufferSize::Default,
        };
        let queue = Arc::new(Mutex::new(VecDeque::new()));
        let feed = Arc::clone(&queue);
        let stream = device
            .build_output_stream(
                &config,
                move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    let mut queued = feed.lock().unwrap_or_else(|e| e.into_inner());
                    for sample in out.iter_mut() {
                        *sample = queued.pop_front().unwrap_or(0.0);
                    }
                },
                |error| eprintln!("audio output: {error}"),
                None,
            )
            .ok()?;
        stream.play().ok()?;
        Some(Self {
            stream,
            queue,
            rate,
        })
    }

    /// The rate the device runs at, which the reader resamples to.
    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// Queues interleaved stereo samples.
    pub fn push(&self, samples: &[f32]) {
        let mut queued = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let most = (f64::from(self.rate) * 2.0 * MOST_QUEUED_SECONDS) as usize;
        if queued.len() + samples.len() > most {
            return;
        }
        queued.extend(samples.iter().copied());
    }

    /// Drops everything waiting.
    pub fn clear(&self) {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// Holds the device on pause so what is queued waits for the picture.
    pub fn set_playing(&self, playing: bool) {
        if playing {
            let _ = self.stream.play();
        } else {
            let _ = self.stream.pause();
        }
    }
}
