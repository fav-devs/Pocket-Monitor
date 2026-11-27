//! The operator's webcam as a gesture source: FFmpeg (already shipped for the decoder)
//! captures the camera as tiny grey frames, and [`opc_monitor::gesture::Tracker`] reads
//! the sweeps. Off unless asked for: `--gestures` or `OPC_GESTURES=1`; `OPC_WEBCAM`
//! names a particular camera. Nothing is recorded or leaves the machine.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Instant;

use opc_monitor::gesture::Gesture;
use opc_monitor::hand::{pinch_ratio, pose_of, Holder, Sweep, HOLD, PINCH_OFF};
use opc_monitor::handnet::HandNet;

/// The size ffmpeg scales the webcam to for the hand model.
const WIDTH: usize = 480;
const HEIGHT: usize = 270;

/// The running webcam reader. Dropping it stops ffmpeg and so the camera light.
pub struct Webcam {
    pub receiver: std::sync::mpsc::Receiver<Gesture>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for Webcam {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

fn ffmpeg() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
    {
        if dir.join(name).is_file() {
            return Some(dir.join(name));
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if dir.join(name).is_file() {
                return Some(dir.join(name));
            }
        }
    }
    // winget's Gyan.FFmpeg package.
    let packages =
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Microsoft/WinGet/Packages");
    for package in std::fs::read_dir(packages).ok()?.flatten() {
        if !package
            .file_name()
            .to_string_lossy()
            .starts_with("Gyan.FFmpeg")
        {
            continue;
        }
        for build in std::fs::read_dir(package.path()).ok()?.flatten() {
            let candidate = build.path().join("bin").join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// FFmpeg is a console program: without this Windows opens a terminal window for it.
fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The first video device DirectShow lists, unless `OPC_WEBCAM` names one.
fn device(ffmpeg: &PathBuf) -> Option<String> {
    if let Ok(name) = std::env::var("OPC_WEBCAM") {
        return Some(name);
    }
    let output = quiet(Command::new(ffmpeg).args([
        "-hide_banner",
        "-list_devices",
        "true",
        "-f",
        "dshow",
        "-i",
        "dummy",
    ]))
    .output()
    .ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    // Cameras that are software, including this app's own virtual camera, are never
    // the operator's webcam: reading them would feed our own picture back in.
    let software = [
        "virtual",
        "obs",
        "openpocketcine",
        "pocket monitor",
        "droidcam",
        "ndi",
        "snap camera",
        "manycam",
    ];
    text.lines()
        .filter(|line| line.contains("(video)"))
        .filter_map(|line| {
            let start = line.find('"')? + 1;
            let end = start + line[start..].find('"')?;
            Some(line[start..end].to_string())
        })
        .find(|name| {
            let lower = name.to_lowercase();
            !software.iter().any(|word| lower.contains(word))
        })
}

/// Starts the capture thread. None if FFmpeg or a webcam is not there.
pub fn start() -> Option<Webcam> {
    let ffmpeg = ffmpeg().or_else(|| {
        eprintln!("gestures: ffmpeg not found");
        None
    })?;
    let device = device(&ffmpeg).or_else(|| {
        eprintln!("gestures: no webcam found");
        None
    })?;
    let (sender, receiver) = channel();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = stop.clone();
    std::thread::spawn(move || {
        let mut command = Command::new(&ffmpeg);
        command
            .args([
                "-loglevel",
                "quiet",
                "-f",
                "dshow",
                "-framerate",
                "20",
                "-i",
            ])
            .arg(format!("video={device}"))
            .args(["-vf", &format!("scale={WIDTH}:{HEIGHT},format=rgb24")])
            .args(["-f", "rawvideo", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        let child = quiet(&mut command).spawn();
        let Ok(mut child) = child else {
            eprintln!("gestures: could not start ffmpeg");
            return;
        };
        let Some(mut out) = child.stdout.take() else {
            return;
        };
        let mut net = match HandNet::new() {
            Ok(net) => net,
            Err(error) => {
                eprintln!("gestures: the hand model would not load: {error}");
                let _ = child.kill();
                return;
            }
        };
        let mut sweep = Sweep::new(true);
        let mut holder = Holder::default();
        let started = Instant::now();
        let mut frame = vec![0u8; WIDTH * HEIGHT * 3];
        while out.read_exact(&mut frame).is_ok() {
            if stopped.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let now = started.elapsed().as_secs_f64();
            let hands = net.detect(&frame, WIDTH, HEIGHT);
            // The webcam reads sweeps and held poses from a hand that is not pinching;
            // the pinch controls and the face finder run on the camera's own picture.
            let hand = hands.iter().find(|hand| pinch_ratio(hand) > PINCH_OFF);
            let swipe = sweep.feed(hand, now);
            let held = holder
                .feed(hand.and_then(pose_of), now, HOLD)
                .map(|pose| pose.gesture());
            if swipe.is_some() || held.is_some() {
                sweep.hold_off(now);
            }
            for gesture in swipe.into_iter().chain(held) {
                if sender.send(gesture).is_err() {
                    let _ = child.kill();
                    return;
                }
            }
        }
        let _ = child.kill();
    });
    Some(Webcam { receiver, stop })
}
