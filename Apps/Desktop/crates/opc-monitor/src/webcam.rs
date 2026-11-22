//! The operator's webcam as a gesture source: FFmpeg (already shipped for the decoder)
//! captures the camera as tiny grey frames, and [`opc_monitor::gesture::Tracker`] reads
//! the sweeps. Off unless asked for: `--gestures` or `OPC_GESTURES=1`; `OPC_WEBCAM`
//! names a particular camera. Nothing is recorded or leaves the machine.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Instant;

use opc_monitor::gesture::{Gesture, Tracker};
use opc_monitor::hand::{self, Holder, Pose, HEIGHT, WIDTH};

const GREY_W: usize = opc_monitor::gesture::WIDTH;
const GREY_H: usize = opc_monitor::gesture::HEIGHT;

pub fn wanted() -> bool {
    std::env::var_os("OPC_GESTURES").is_some_and(|value| value != "0")
}

fn ffmpeg() -> Option<PathBuf> {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) {
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
    let packages = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Microsoft/WinGet/Packages");
    for package in std::fs::read_dir(packages).ok()?.flatten() {
        if !package.file_name().to_string_lossy().starts_with("Gyan.FFmpeg") {
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

/// The first video device DirectShow lists, unless `OPC_WEBCAM` names one.
fn device(ffmpeg: &PathBuf) -> Option<String> {
    if let Ok(name) = std::env::var("OPC_WEBCAM") {
        return Some(name);
    }
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    // Cameras that are software, including this app's own virtual camera, are never
    // the operator's webcam: reading them would feed our own picture back in.
    let software = ["virtual", "obs", "openpocketcine", "pocket monitor", "droidcam", "ndi", "snap camera", "manycam"];
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
pub fn start() -> Option<Receiver<Gesture>> {
    let ffmpeg = ffmpeg().or_else(|| {
        eprintln!("gestures: ffmpeg not found");
        None
    })?;
    let device = device(&ffmpeg).or_else(|| {
        eprintln!("gestures: no webcam found");
        None
    })?;
    let (sender, receiver) = channel();
    std::thread::spawn(move || {
        let child = Command::new(&ffmpeg)
            .args(["-loglevel", "quiet", "-f", "dshow", "-framerate", "15", "-i"])
            .arg(format!("video={device}"))
            .args(["-vf", &format!("scale={WIDTH}:{HEIGHT},format=rgb24")])
            .args(["-f", "rawvideo", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            eprintln!("gestures: could not start ffmpeg");
            return;
        };
        let Some(mut out) = child.stdout.take() else {
            return;
        };
        let mut tracker = Tracker::new(true);
        let mut holder = Holder::default();
        let started = Instant::now();
        let mut frame = vec![0u8; WIDTH * HEIGHT * 3];
        let mut grey = vec![0u8; GREY_W * GREY_H];
        while out.read_exact(&mut frame).is_ok() {
            let now = started.elapsed().as_secs_f64();
            // The sweep reader works on a small grey picture sampled from the frame.
            for y in 0..GREY_H {
                for x in 0..GREY_W {
                    let at = ((y * HEIGHT / GREY_H) * WIDTH + x * WIDTH / GREY_W) * 3;
                    grey[y * GREY_W + x] = ((u16::from(frame[at])
                        + u16::from(frame[at + 1])
                        + u16::from(frame[at + 2]))
                        / 3) as u8;
                }
            }
            let swipe = tracker.feed(&grey, now);
            let held = holder.feed(hand::classify(&frame), now);
            let held = held.map(|pose| match pose {
                Pose::Fist => Gesture::Fist,
                Pose::Point => Gesture::Point,
                Pose::Two => Gesture::Two,
                Pose::Palm => Gesture::Palm,
            });
            for gesture in swipe.into_iter().chain(held) {
                if sender.send(gesture).is_err() {
                    let _ = child.kill();
                    return;
                }
            }
        }
        let _ = child.kill();
    });
    Some(receiver)
}
