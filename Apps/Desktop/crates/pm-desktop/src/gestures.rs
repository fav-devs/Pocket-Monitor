//! Webcam gestures (§1.T): the operator's webcam read by the MediaPipe hand model
//! (`pm_controller::handnet`) for sweeps and held poses (`pm_controller::hand`), mapped
//! onto the gimbal by the input thread through the home screen's gesture map
//! (`LiveInput::gesture`).
//!
//! Capture is an `ffmpeg` child (the same FFmpeg the decoder ships with) at 15 fps,
//! 480×270 RGB24, as the old viewfinder's `webcam.rs` does: DirectShow on Windows (the
//! first video device that is not software, so this app's own virtual camera is never
//! read back), V4L2 on Linux, AVFoundation on macOS. `PM_WEBCAM` (or `OPC_WEBCAM`) names a device.
//! `ffmpeg` is looked for beside the executable, on `PATH`, then in winget's
//! `Gyan.FFmpeg` (D8: the release staging must ship `ffmpeg.exe` for this to work out of
//! the box). Nothing is recorded or leaves the machine.
//!
//! On when the home setting says so (`desktop-app-v1.txt` `gestures`), with
//! `--gestures`, or `PM_GESTURES=1` (`OPC_GESTURES=1`); `gestures_set` turns it on and off live.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use pm_controller::appsettings;
use pm_controller::hand::{pinch_ratio, pose_of, Holder, Sweep, HOLD, PINCH_OFF};
use pm_controller::handnet::HandNet;
use pm_controller::link::log_line;
use serde::Serialize;
use tauri::AppHandle;

use crate::input::{post, InputMsg};

/// The size ffmpeg scales the webcam to for the hand model.
const WIDTH: usize = 480;
const HEIGHT: usize = 270;

/// Words that mark a software camera, never the operator's webcam. "openpocketcine" is
/// the name an older install's virtual camera may still carry.
const SOFTWARE: [&str; 8] = [
    "virtual",
    "obs",
    "openpocketcine",
    "pocket monitor",
    "droidcam",
    "ndi",
    "snap camera",
    "manycam",
];

/// `gestures_state`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GesturesState {
    pub on: bool,
    pub device: Option<String>,
    /// Why it is not running, as operator copy.
    pub problem: Option<String>,
}

#[derive(Default)]
struct Capture {
    child: Option<Arc<Mutex<Option<Child>>>>,
    state: GesturesState,
}

fn slot() -> &'static Mutex<Capture> {
    static SLOT: OnceLock<Mutex<Capture>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(Capture::default()))
}

/// `--gestures`, `PM_GESTURES=1` (`OPC_GESTURES=1`), or the home setting (B7, B8, T5).
pub fn wanted() -> bool {
    std::env::args().any(|argument| argument == "--gestures")
        || pm_controller::platform::env_var_os("GESTURES").is_some_and(|value| value != "0")
        || appsettings::load().gestures
}

pub fn start_if_wanted(_app: &AppHandle) {
    if wanted() {
        // The device listing runs ffmpeg once: off the main thread.
        std::thread::spawn(|| {
            set(true);
        });
    }
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A windowed app spawning a console tool would flash a console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
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

/// The capture input arguments for this platform.
fn input_args(ffmpeg: &PathBuf) -> Option<(Vec<String>, String)> {
    let named = pm_controller::platform::env_var("WEBCAM");
    if cfg!(windows) {
        let device = named.or_else(|| {
            let output = hidden(&mut Command::new(ffmpeg))
                .args([
                    "-hide_banner",
                    "-list_devices",
                    "true",
                    "-f",
                    "dshow",
                    "-i",
                    "dummy",
                ])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&output.stderr);
            text.lines()
                .filter(|line| line.contains("(video)"))
                .filter_map(|line| {
                    let start = line.find('"')? + 1;
                    let end = start + line[start..].find('"')?;
                    Some(line[start..end].to_string())
                })
                .find(|name| {
                    let lower = name.to_lowercase();
                    !SOFTWARE.iter().any(|word| lower.contains(word))
                })
        })?;
        Some((
            vec![
                "-f".into(),
                "dshow".into(),
                "-framerate".into(),
                "15".into(),
                "-i".into(),
                format!("video={device}"),
            ],
            device,
        ))
    } else if cfg!(target_os = "macos") {
        let device = named.unwrap_or_else(|| "0".to_string());
        Some((
            vec![
                "-f".into(),
                "avfoundation".into(),
                "-framerate".into(),
                "15".into(),
                "-i".into(),
                device.clone(),
            ],
            device,
        ))
    } else {
        let device = named.unwrap_or_else(|| "/dev/video0".to_string());
        Some((
            vec![
                "-f".into(),
                "v4l2".into(),
                "-framerate".into(),
                "15".into(),
                "-i".into(),
                device.clone(),
            ],
            device,
        ))
    }
}

/// Starts or stops the capture. Returns what the operator should read.
pub fn set(on: bool) -> GesturesState {
    stop();
    if !on {
        return state();
    }
    let problem = |text: &str| {
        log_line("gestures", text);
        if let Ok(mut capture) = slot().lock() {
            capture.state = GesturesState {
                on: false,
                device: None,
                problem: Some(text.to_string()),
            };
        }
        state()
    };
    let Some(ffmpeg) = ffmpeg() else {
        return problem("FFmpeg not found beside the app or on PATH");
    };
    let Some((args, device)) = input_args(&ffmpeg) else {
        return problem("No webcam found");
    };
    // The model loads before the camera light comes on, so a failure is said at once.
    let mut net = match HandNet::new() {
        Ok(net) => net,
        Err(error) => {
            log_line(
                "gestures",
                format_args!("the hand model would not load: {error}"),
            );
            return problem("The hand-tracking model could not be loaded");
        }
    };
    let child = hidden(&mut Command::new(&ffmpeg))
        .args(["-loglevel", "quiet"])
        .args(&args)
        .args(["-vf", &format!("scale={WIDTH}:{HEIGHT},format=rgb24")])
        .args(["-f", "rawvideo", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return problem("Could not start FFmpeg for the webcam");
    };
    let Some(mut out) = child.stdout.take() else {
        let _ = child.kill();
        return problem("Could not read the webcam");
    };
    let shared = Arc::new(Mutex::new(Some(child)));
    let reader = shared.clone();
    log_line("gestures", format_args!("reading {device}"));
    std::thread::Builder::new()
        .name("pm-gestures".to_string())
        .spawn(move || {
            let mut sweep = Sweep::new(true);
            let mut holder = Holder::default();
            let started = Instant::now();
            let mut frame = vec![0u8; WIDTH * HEIGHT * 3];
            while out.read_exact(&mut frame).is_ok() {
                let now = started.elapsed().as_secs_f64();
                let hands = net.detect(&frame, WIDTH, HEIGHT);
                // Sweeps and held poses come from a hand that is not pinching, as the
                // old viewfinder's webcam reader does.
                let hand = hands.iter().find(|hand| pinch_ratio(hand) > PINCH_OFF);
                let swipe = sweep.feed(hand, now);
                let held = holder
                    .feed(hand.and_then(pose_of), now, HOLD)
                    .map(|pose| pose.gesture());
                if swipe.is_some() || held.is_some() {
                    sweep.hold_off(now);
                }
                for gesture in swipe.into_iter().chain(held) {
                    post(InputMsg::Gesture(gesture));
                }
            }
            if let Ok(mut child) = reader.lock() {
                if let Some(mut child) = child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            log_line("gestures", "webcam closed");
        })
        .ok();
    if let Ok(mut capture) = slot().lock() {
        capture.child = Some(shared);
        capture.state = GesturesState {
            on: true,
            device: Some(device),
            problem: None,
        };
    }
    state()
}

/// Stops the capture, if any.
pub fn stop() {
    let child = slot().lock().ok().and_then(|mut capture| {
        capture.state.on = false;
        capture.child.take()
    });
    if let Some(child) = child {
        if let Ok(mut child) = child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

pub fn state() -> GesturesState {
    slot()
        .lock()
        .map(|capture| capture.state.clone())
        .unwrap_or_default()
}

/// `gestures_set {on}`: turns the webcam on or off now, and remembers it as the home
/// setting does. The device listing and the spawn run off the main thread.
#[tauri::command]
pub async fn gestures_set(on: bool) -> Result<GesturesState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = appsettings::load();
        if settings.gestures != on {
            settings.gestures = on;
            appsettings::save(&settings);
        }
        set(on)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn gestures_state() -> GesturesState {
    state()
}
