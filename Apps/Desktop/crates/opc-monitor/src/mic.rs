//! The PC's microphone, listened to for a double clap. Nothing is recorded or kept: each
//! block of sound goes through the detector and is dropped.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use opc_monitor::clap::ClapDetector;

pub struct ClapMic {
    _stream: cpal::Stream,
    heard: Arc<AtomicBool>,
}

impl std::fmt::Debug for ClapMic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClapMic")
    }
}

impl ClapMic {
    /// None when the machine has no microphone or it will not open.
    pub fn open() -> Option<Self> {
        let device = cpal::default_host().default_input_device()?;
        let config = device.default_input_config().ok()?;
        let channels = usize::from(config.channels()).max(1);
        let format = config.sample_format();
        let rate = config.sample_rate().0;
        let heard = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&heard);
        let mut detector = ClapDetector::new(rate);
        let mut mono: Vec<f32> = Vec::new();
        let mut handle = move |frames: &mut dyn Iterator<Item = f32>| {
            mono.clear();
            let mut sum = 0.0;
            let mut count = 0;
            for sample in frames {
                sum += sample;
                count += 1;
                if count == channels {
                    mono.push(sum / channels as f32);
                    sum = 0.0;
                    count = 0;
                }
            }
            if detector.feed(&mono) {
                flag.store(true, Ordering::Relaxed);
            }
        };
        let config = config.config();
        let on_error = |_error| {};
        let stream = match format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    handle(&mut data.iter().copied());
                },
                on_error,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    handle(&mut data.iter().map(|s| f32::from(*s) / 32768.0));
                },
                on_error,
                None,
            ),
            _ => return None,
        }
        .ok()?;
        stream.play().ok()?;
        Some(Self {
            _stream: stream,
            heard,
        })
    }

    /// True once per double clap.
    pub fn take(&self) -> bool {
        self.heard.swap(false, Ordering::Relaxed)
    }
}
