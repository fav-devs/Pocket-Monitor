//! Launch (`docs/desktop-expo-port.md` §1.A, §1.B): the command line before the window,
//! one instance per user, the window where the operator left it, and the WebView2 check.
//!
//! - **Command line.** [`pm_controller::launch::parse`] decides; this prints `keys`,
//!   `version` and `--help` on the terminal the release build was started from (D2: the
//!   old release build printed nothing, being a `windows` subsystem app), runs the
//!   headless Bluetooth harness, or hands [`LaunchArgs`] to the web (`launch_args`).
//! - **Single instance.** A second launch (a Start-menu or desktop shortcut while the app
//!   is open) hands its arguments to the first over loopback and exits; the first comes to
//!   the front and tells the web (`launch://args`), so a shortcut always lands on a
//!   window. `PM_MULTI_INSTANCE=1` turns this off.
//! - **Window state.** Size, position and maximised are kept in
//!   `pocket-monitor-window-v1.txt` and restored on a monitor that still exists.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use pm_controller::launch::{self as cli, Env, Launch, LaunchArgs, Route};
use pm_controller::link::log_line;
use pm_controller::platform;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};

/// Reads the command line. Returns what the window should open on, or exits the process
/// for everything that is not a window.
pub fn from_command_line() -> LaunchArgs {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let settings = pm_controller::appsettings::load();
    match cli::parse(&args, &Env::current(), settings.open_camera_at_launch) {
        Launch::Print(text) => {
            if platform::attach_parent_console() {
                println!("{text}");
            } else {
                platform::message_box(cli::PRODUCT, &text, false);
            }
            std::process::exit(0);
        }
        Launch::Fail(message) => {
            log_line("pm-desktop", format_args!("error: {message}"));
            if platform::attach_parent_console() {
                eprintln!("pocket-monitor: {message}");
            } else {
                platform::message_box(cli::PRODUCT, &message, true);
            }
            std::process::exit(2);
        }
        Launch::Headless(rest) => {
            platform::attach_parent_console();
            let code = match crate::connect::headless(&rest) {
                Ok(()) => 0,
                Err(message) => {
                    eprintln!("pocket-monitor: {message}");
                    1
                }
            };
            std::process::exit(code);
        }
        Launch::Window(mut launch) => {
            // Webcam gestures read PM_GESTURES (B7, B8), as the old binary read OPC_GESTURES.
            if launch.gestures || settings.gestures {
                launch.gestures = true;
                std::env::set_var("PM_GESTURES", "1");
            }
            if launch.route == Route::Viewfinder {
                if let Some(camera) = launch.camera.as_deref() {
                    crate::connect::remember_command_line_camera(camera, launch.model);
                }
            }
            // `--lut FILE`: validate the cube and copy it into the LUT folder, then hand the web
            // its folder id so the picker and the picture select it like any other file.
            if let Some(path) = launch.lut.take() {
                match import_command_line_lut(&path) {
                    Ok(id) => launch.lut = Some(id),
                    Err(message) => {
                        log_line("lut", format_args!("--lut {path}: {message}"));
                        platform::message_box(cli::PRODUCT, &format!("{path}: {message}"), true);
                    }
                }
            }
            launch
        }
    }
}

fn import_command_line_lut(path: &str) -> Result<String, String> {
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    crate::luts::parse(&text)?;
    let folder = pm_controller::luts::custom_folder();
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let file = pm_controller::luts::import_name(path, |candidate| folder.join(candidate).exists());
    std::fs::write(folder.join(&file), text).map_err(|error| error.to_string())?;
    Ok(format!("file:{file}"))
}

/// The `args:` line of the old log, written once this process owns the log.
pub fn log_args() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    log_line("args", format_args!("{args:?}"));
}

/// The viewfinder's keys, as `keys` prints them, for the home screen's list (A2).
#[tauri::command]
pub fn keyboard_shortcuts() -> &'static str {
    cli::KEYS
}

/// What the command line asked for; the web picks its first route from it.
#[tauri::command]
pub fn launch_args(args: tauri::State<'_, LaunchArgs>) -> LaunchArgs {
    args.inner().clone()
}

// ── WebView2 (R8) ────────────────────────────────────────────────────────────────

/// The Evergreen bootstrapper's address, for the message.
#[cfg(target_os = "windows")]
pub const WEBVIEW2_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

/// On Windows the web view needs the WebView2 runtime. The installer installs it; a
/// portable copy checks here and says what to do, instead of failing with no window. A
/// Fixed Version runtime unpacked beside the executable in `WebView2\` is used when there.
pub fn ensure_webview_runtime() {
    #[cfg(target_os = "windows")]
    {
        if let Some(fixed) = platform::exe_dir().map(|dir| dir.join("WebView2")) {
            if fixed.join("msedgewebview2.exe").exists() {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &fixed);
                log_line(
                    "pm-desktop",
                    "using the WebView2 runtime beside the executable",
                );
                return;
            }
        }
        if webview2_installed() {
            return;
        }
        log_line("pm-desktop", "the WebView2 runtime is missing");
        platform::message_box(
            cli::PRODUCT,
            &format!(
                "Pocket Monitor needs the Microsoft Edge WebView2 Runtime, which this PC does not \
                 have.\n\nInstall it from {WEBVIEW2_URL} (the installer of Pocket Monitor does this \
                 for you), then start Pocket Monitor again."
            ),
            true,
        );
        let _ = std::process::Command::new("explorer")
            .arg(WEBVIEW2_URL)
            .spawn();
        std::process::exit(1);
    }
}

/// Whether the Evergreen runtime is registered (machine-wide or for this user).
#[cfg(target_os = "windows")]
fn webview2_installed() -> bool {
    type Hkey = isize;
    const HKEY_CURRENT_USER: Hkey = 0x8000_0001u32 as i32 as isize;
    const HKEY_LOCAL_MACHINE: Hkey = 0x8000_0002u32 as i32 as isize;
    const RRF_RT_REG_SZ: u32 = 0x2;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: Hkey,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut u16,
            size: *mut u32,
        ) -> i32;
    }
    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() };
    let client = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let keys = [
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{client}"),
        ),
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{client}"),
        ),
        (
            HKEY_CURRENT_USER,
            format!("Software\\Microsoft\\EdgeUpdate\\Clients\\{client}"),
        ),
    ];
    let value = wide("pv");
    keys.iter().any(|(root, subkey)| {
        let subkey = wide(subkey);
        let mut data = [0u16; 64];
        let mut size = (data.len() * 2) as u32;
        // Safety: NUL-terminated strings and a buffer whose size is passed in bytes.
        let status = unsafe {
            RegGetValueW(
                *root,
                subkey.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                data.as_mut_ptr(),
                &mut size,
            )
        };
        if status != 0 {
            return false;
        }
        let text = String::from_utf16_lossy(&data[..(size as usize / 2)]);
        let text = text.trim_end_matches('\0');
        !text.is_empty() && text != "0.0.0.0"
    })
}

// ── single instance (A1, I3) ─────────────────────────────────────────────────────

fn instance_file() -> PathBuf {
    platform::data_dir().join("pocket-monitor-instance.txt")
}

/// Hands this launch to a running instance. True when one took it.
pub fn hand_to_running(args: &LaunchArgs) -> bool {
    if std::env::var_os("PM_MULTI_INSTANCE").is_some() {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(instance_file()) else {
        return false;
    };
    let mut words = text.split_whitespace();
    let (Some(port), Some(token)) = (
        words.next().and_then(|p| p.parse::<u16>().ok()),
        words.next(),
    ) else {
        return false;
    };
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    // The passcode is not serialised; a second launch with one keeps it in the env.
    let payload = serde_json::to_string(args).unwrap_or_default();
    if writeln!(stream, "{token}\n{payload}").is_err() {
        return false;
    }
    let mut answer = String::new();
    let took = BufReader::new(stream).read_line(&mut answer).is_ok() && answer.trim() == "ok";
    if took {
        log_line("pm-desktop", "handed the launch to the running window");
    }
    took
}

/// Listens for later launches and brings the window forward for each.
pub fn listen_for_launches(app: &AppHandle) {
    if std::env::var_os("PM_MULTI_INSTANCE").is_some() {
        return;
    }
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else {
        return;
    };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else {
        return;
    };
    let token = format!(
        "{:x}{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    );
    let file = instance_file();
    if let Some(folder) = file.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    if std::fs::write(&file, format!("{port} {token}\n")).is_err() {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("pm-instance".to_string())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let Ok(reader_stream) = stream.try_clone() else {
                    continue;
                };
                let mut reader = BufReader::new(reader_stream);
                let mut first = String::new();
                if reader.read_line(&mut first).is_err() || first.trim() != token {
                    continue;
                }
                let mut payload = String::new();
                let _ = reader.read_line(&mut payload);
                let mut stream = stream;
                let _ = writeln!(stream, "ok");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                if let Ok(args) = serde_json::from_str::<serde_json::Value>(payload.trim()) {
                    let _ = app.emit("launch://args", args);
                }
            }
        });
}

/// The instance file goes with the process that wrote it.
pub fn forget_instance() {
    let _ = std::fs::remove_file(instance_file());
}

// ── window state (A6) ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

impl Placement {
    fn to_text(self) -> String {
        format!(
            "pocket-monitor-window-v1\n{} {} {} {} {}\n",
            self.x,
            self.y,
            self.width,
            self.height,
            u8::from(self.maximized)
        )
    }

    fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        if lines.next()? != "pocket-monitor-window-v1" {
            return None;
        }
        let words: Vec<&str> = lines.next()?.split_whitespace().collect();
        let [x, y, width, height, maximized] = words.as_slice() else {
            return None;
        };
        Some(Self {
            x: x.parse().ok()?,
            y: y.parse().ok()?,
            width: width.parse().ok().filter(|w| *w >= 320)?,
            height: height.parse().ok().filter(|h| *h >= 240)?,
            maximized: *maximized == "1",
        })
    }
}

fn placement_file() -> PathBuf {
    platform::data_dir().join("pocket-monitor-window-v1.txt")
}

static LAST: Mutex<Option<Placement>> = Mutex::new(None);

/// Puts the window where it was, if that is still on a monitor.
pub fn restore_window(window: &WebviewWindow) {
    let Some(placement) = std::fs::read_to_string(placement_file())
        .ok()
        .and_then(|text| Placement::parse(&text))
    else {
        return;
    };
    let centre = (
        placement.x + placement.width as i32 / 2,
        placement.y + placement.height as i32 / 2,
    );
    let on_screen = window.available_monitors().is_ok_and(|monitors| {
        monitors.iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            centre.0 >= p.x
                && centre.1 >= p.y
                && centre.0 < p.x + s.width as i32
                && centre.1 < p.y + s.height as i32
        })
    });
    if !on_screen {
        return;
    }
    let _ = window.set_size(PhysicalSize::new(placement.width, placement.height));
    let _ = window.set_position(PhysicalPosition::new(placement.x, placement.y));
    if placement.maximized {
        let _ = window.maximize();
    }
    if let Ok(mut last) = LAST.lock() {
        *last = Some(placement);
    }
}

fn note(window: &tauri::Window) {
    let maximized = window.is_maximized().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    if minimized || fullscreen {
        return;
    }
    let Ok(mut last) = LAST.lock() else { return };
    if maximized {
        // Keep the restored size for next time; only the flag changes.
        if let Some(placement) = last.as_mut() {
            placement.maximized = true;
        }
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    *last = Some(Placement {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
    });
}

fn save_placement() {
    if let Some(placement) = LAST.lock().ok().and_then(|last| *last) {
        let file = placement_file();
        if let Some(folder) = file.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        let _ = std::fs::write(file, placement.to_text());
    }
}

/// Follows the main window's moves and size, and saves them when it closes.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => note(window),
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
            save_placement();
            forget_instance();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_placement_survives_its_file_and_refuses_a_silly_one() {
        let placement = Placement {
            x: -1200,
            y: 40,
            width: 1280,
            height: 720,
            maximized: true,
        };
        assert_eq!(Placement::parse(&placement.to_text()), Some(placement));
        assert_eq!(
            Placement::parse("pocket-monitor-window-v1\n0 0 10 10 0\n"),
            None
        );
        assert_eq!(Placement::parse("junk"), None);
    }
}
