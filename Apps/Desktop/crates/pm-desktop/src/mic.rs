//! The PC's microphone, listened to for a double clap while gestures are on (§1.T): a
//! double clap recentres the gimbal. Moved from `opc-monitor/src/mic.rs`.
//!
//! The cpal stream is not `Send` on every platform, so it lives on its own thread for as
//! long as the [`ClapMic`] does; dropping the handle ends the thread and the stream, which
//! releases the microphone (the OS indicator goes off). Each block of sound goes through
//! `pm_controller::clap::ClapDetector` and is dropped: nothing is recorded or kept, and
//! nothing leaves the machine. The input thread polls [`ClapMic::take`].

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use pm_controller::clap::{downmix, sample_i16, ClapDetector};
use pm_controller::link::log_line;

/// The listening thread. Dropping it lets the microphone go.
pub struct ClapMic {
    heard: Arc<AtomicBool>,
    /// Dropped with the handle: the thread's `recv` returns and the stream ends.
    _stop: Sender<()>,
}

impl std::fmt::Debug for ClapMic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClapMic")
    }
}

fn open(heard: Arc<AtomicBool>) -> Result<cpal::Stream, String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or("no microphone")?;
    let config = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    let channels = usize::from(config.channels()).max(1);
    let format = config.sample_format();
    let mut detector = ClapDetector::new(config.sample_rate().0);
    let mut mono: Vec<f32> = Vec::new();
    let mut handle = move |frames: &mut dyn Iterator<Item = f32>| {
        downmix(frames, channels, &mut mono);
        if detector.feed(&mono) {
            heard.store(true, Ordering::Relaxed);
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
                handle(&mut data.iter().map(|s| sample_i16(*s)));
            },
            on_error,
            None,
        ),
        other => return Err(format!("unsupported sample format {other:?}")),
    }
    .map_err(|error| error.to_string())?;
    stream.play().map_err(|error| error.to_string())?;
    Ok(stream)
}

impl ClapMic {
    /// Starts listening on its own thread (opening a device can take a moment, so the
    /// caller never waits for it). A machine with no microphone logs once and the handle
    /// simply never hears anything.
    pub fn start() -> Self {
        let heard = Arc::new(AtomicBool::new(false));
        let (stop, stopped) = channel::<()>();
        let flag = Arc::clone(&heard);
        let spawned = std::thread::Builder::new()
            .name("pm-mic".to_string())
            .spawn(move || match open(flag) {
                Ok(stream) => {
                    log_line("gestures", "listening for a double clap");
                    // Until the handle is dropped.
                    let _ = stopped.recv();
                    drop(stream);
                    log_line("gestures", "microphone released");
                }
                Err(error) => log_line("gestures", format_args!("no clap microphone: {error}")),
            });
        if let Err(error) = spawned {
            log_line(
                "gestures",
                format_args!("could not start the microphone: {error}"),
            );
        }
        Self { heard, _stop: stop }
    }

    /// True once per double clap.
    pub fn take(&self) -> bool {
        self.heard.swap(false, Ordering::Relaxed)
    }
}
