//! Process-wide settings a live monitor needs, shared by the Slint viewfinder and the
//! Tauri app (`docs/desktop-expo-port.md` A14, P9), plus where the desktop keeps its
//! files and its log (D3, Y1) and the Windows console and tool plumbing (D2, C4).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// A viewfinder that is not the focused window is a background process to Windows 11,
/// which then coarsens its timers and can leave the picture frozen for most of a second
/// at a time. A live monitor is never idle work: opt out of power throttling and ask for
/// 1 ms timers.
pub fn keep_timers_fast() {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct PowerThrottling {
            version: u32,
            control_mask: u32,
            state_mask: u32,
        }
        #[link(name = "winmm")]
        extern "system" {
            fn timeBeginPeriod(period: u32) -> u32;
        }
        extern "system" {
            fn GetCurrentProcess() -> *mut u8;
            fn SetProcessInformation(
                process: *mut u8,
                class: i32,
                info: *const PowerThrottling,
                size: u32,
            ) -> i32;
        }
        // ProcessPowerThrottling = 4; version 1; EXECUTION_SPEED = 1 controlled, state 0
        // means "do not throttle".
        let state = PowerThrottling {
            version: 1,
            control_mask: 1,
            state_mask: 0,
        };
        // Safety: plain Win32 calls on the current process with a correctly sized struct.
        unsafe {
            SetProcessInformation(
                GetCurrentProcess(),
                4,
                &state,
                std::mem::size_of::<PowerThrottling>() as u32,
            );
            timeBeginPeriod(1);
        }
    }
}

// ---- Where the desktop keeps its files -----------------------------------------------

/// The folder name both desktop builds share. The old viewfinder wrote every remembered
/// camera, its settings and the LUT drop folder here, so the Tauri app reads the same
/// files in place: an operator who upgrades keeps everything, and the two builds agree
/// while they live side by side.
pub const DATA_FOLDER: &str = "OpenPocketCine";

/// `%LOCALAPPDATA%\OpenPocketCine` on Windows; `$XDG_CONFIG_HOME/OpenPocketCine` or
/// `~/.config/OpenPocketCine` elsewhere (the old camera files' rule).
pub fn data_dir() -> PathBuf {
    data_dir_from(
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
        exe_dir(),
    )
}

/// [`data_dir`] from its inputs, for tests.
pub fn data_dir_from(
    local_app_data: Option<PathBuf>,
    xdg_config: Option<PathBuf>,
    home: Option<PathBuf>,
    exe_dir: Option<PathBuf>,
) -> PathBuf {
    local_app_data
        .or(xdg_config)
        .or_else(|| home.map(|home| home.join(".config")))
        .or(exe_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(DATA_FOLDER)
}

/// The folder the running executable is in.
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

// ---- The log ---------------------------------------------------------------------------

/// The old viewfinder's log name. The Tauri app names its own with [`set_log_name`].
pub const LEGACY_LOG_NAME: &str = "opc-monitor.log";

static LOG_NAME: OnceLock<String> = OnceLock::new();
static LOG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Names this process's log file. Call it first thing, before anything logs; later calls
/// are ignored.
pub fn set_log_name(name: &str) {
    let _ = LOG_NAME.set(name.to_string());
}

fn log_name() -> &'static str {
    LOG_NAME.get().map_or(LEGACY_LOG_NAME, String::as_str)
}

/// Where the log goes (D3): beside the executable for a portable copy or a developer
/// build, as before, so the benchmark and the field habits still find it there; under
/// `<data>/logs` for an installed copy, or whenever the executable's folder cannot be
/// written (`C:\Program Files\…` for a normal user).
pub fn log_dir_for(
    exe_dir: Option<&Path>,
    data_dir: &Path,
    installed: bool,
    exe_dir_writable: bool,
) -> PathBuf {
    match exe_dir {
        Some(dir) if !installed && exe_dir_writable => dir.to_path_buf(),
        _ => data_dir.join("logs"),
    }
}

/// Whether the executable sits in an installed copy: Inno's uninstaller is beside it, or
/// it is under Program Files.
pub fn looks_installed(exe_dir: &Path) -> bool {
    if exe_dir.join("unins000.exe").exists() {
        return true;
    }
    let text = exe_dir.to_string_lossy().to_ascii_lowercase();
    ["\\program files\\", "\\program files (x86)\\"]
        .iter()
        .any(|needle| text.contains(needle))
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".pm-write-test-{}", std::process::id()));
    let ok = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&probe)
        .is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// The log file this process appends to. Decided once.
pub fn log_path() -> Option<PathBuf> {
    LOG_PATH
        .get_or_init(|| {
            let exe = exe_dir();
            let data = data_dir();
            let installed = exe.as_deref().is_some_and(looks_installed);
            let exe_writable = exe.as_deref().is_some_and(writable);
            let dir = log_dir_for(exe.as_deref(), &data, installed, exe_writable);
            if std::fs::create_dir_all(&dir).is_err() && !writable(&dir) {
                return None;
            }
            Some(dir.join(log_name()))
        })
        .clone()
}

/// The folder the log is in, to show and to open.
pub fn log_dir() -> Option<PathBuf> {
    log_path().and_then(|path| path.parent().map(Path::to_path_buf))
}

/// The previous session's log, kept beside the current one.
pub fn previous_log_path(log: &Path) -> PathBuf {
    let stem = log
        .file_stem()
        .map_or_else(|| "log".to_string(), |s| s.to_string_lossy().into_owned());
    log.with_file_name(format!("{stem}.previous.log"))
}

/// Starts a fresh log for this run and keeps the last one as `<name>.previous.log`, so a
/// crash followed by a relaunch no longer wipes the evidence (the old build truncated it).
pub fn rotate_log() {
    if let Some(path) = log_path() {
        if path.exists() {
            let _ = std::fs::rename(&path, previous_log_path(&path));
        }
    }
}

/// The last `lines` lines of `text`.
pub fn tail_lines(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    let from = all.len().saturating_sub(lines);
    all[from..].join("\n")
}

// ---- Windows plumbing ----------------------------------------------------------------

/// A command that never flashes a console window. Wi-Fi joining retries `netsh` and
/// `ipconfig` by design, so they must stay invisible to the operator.
pub fn background_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Hooks the release build (a `windows` subsystem app, no console of its own) up to the
/// terminal it was started from, so `keys`, `version` and `--help` print where they were
/// typed (D2). True when there is somewhere to print: always off Windows, and on Windows
/// when a parent console exists or the output was redirected.
pub fn attach_parent_console() -> bool {
    #[cfg(target_os = "windows")]
    {
        type Handle = *mut core::ffi::c_void;
        extern "system" {
            fn AttachConsole(process: u32) -> i32;
            fn GetStdHandle(which: u32) -> Handle;
            fn SetStdHandle(which: u32, handle: Handle) -> i32;
            fn CreateFileW(
                name: *const u16,
                access: u32,
                share: u32,
                security: *mut core::ffi::c_void,
                disposition: u32,
                flags: u32,
                template: Handle,
            ) -> Handle;
        }
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
        const STD_ERROR_HANDLE: u32 = -12i32 as u32;
        const GENERIC_READ_WRITE: u32 = 0x8000_0000 | 0x4000_0000;
        const FILE_SHARE_WRITE: u32 = 0x2;
        const OPEN_EXISTING: u32 = 3;
        let invalid = |handle: Handle| handle.is_null() || handle as isize == -1;
        // Safety: plain Win32 calls; the name is NUL-terminated and outlives the call.
        unsafe {
            // Output redirected to a file or pipe by the caller: it already works.
            if !invalid(GetStdHandle(STD_OUTPUT_HANDLE)) {
                return true;
            }
            if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
                return false;
            }
            let name: Vec<u16> = "CONOUT$".encode_utf16().chain(Some(0)).collect();
            let console = CreateFileW(
                name.as_ptr(),
                GENERIC_READ_WRITE,
                FILE_SHARE_WRITE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            );
            if invalid(console) {
                return false;
            }
            SetStdHandle(STD_OUTPUT_HANDLE, console);
            if invalid(GetStdHandle(STD_ERROR_HANDLE)) {
                SetStdHandle(STD_ERROR_HANDLE, console);
            }
        }
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

/// A modal message where there is no terminal to read (A12): an error, or the text of
/// `--help` when the app was started from Explorer.
pub fn message_box(title: &str, text: &str, error: bool) {
    #[cfg(target_os = "windows")]
    {
        let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
        let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        extern "system" {
            fn MessageBoxW(
                window: *mut u8,
                text: *const u16,
                caption: *const u16,
                kind: u32,
            ) -> i32;
        }
        // MB_OK | MB_ICONERROR or MB_ICONINFORMATION
        let kind = if error { 0x10 } else { 0x40 };
        // Safety: both strings are NUL-terminated and outlive the call.
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), kind) };
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title, error);
        eprintln!("{text}");
    }
}

/// Opens a folder in the platform's file manager. Never blocks on it.
pub fn open_folder(path: &Path) -> std::io::Result<()> {
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_folder_follows_the_old_camera_files() {
        let local = PathBuf::from("C:/Users/op/AppData/Local");
        assert_eq!(
            data_dir_from(Some(local.clone()), Some("/x".into()), None, None),
            local.join("OpenPocketCine")
        );
        assert_eq!(
            data_dir_from(None, None, Some("/home/op".into()), None),
            PathBuf::from("/home/op/.config/OpenPocketCine")
        );
        assert_eq!(
            data_dir_from(None, Some("/cfg".into()), Some("/home/op".into()), None),
            PathBuf::from("/cfg/OpenPocketCine")
        );
    }

    #[test]
    fn an_installed_copy_logs_per_user_and_a_portable_one_beside_itself() {
        let exe = Path::new("D:/PocketMonitor");
        let data = Path::new("C:/Users/op/AppData/Local/OpenPocketCine");
        assert_eq!(log_dir_for(Some(exe), data, false, true), exe);
        assert_eq!(log_dir_for(Some(exe), data, true, true), data.join("logs"));
        assert_eq!(
            log_dir_for(Some(exe), data, false, false),
            data.join("logs"),
            "Program Files is not writable for a normal user"
        );
        assert_eq!(log_dir_for(None, data, false, true), data.join("logs"));
        assert!(looks_installed(Path::new(
            "C:\\Program Files\\OpenPocketCine\\"
        )));
        assert!(!looks_installed(Path::new("D:\\tools\\PocketMonitor")));
    }

    #[test]
    fn the_previous_log_sits_beside_the_current_one() {
        assert_eq!(
            previous_log_path(Path::new("/l/pocket-monitor.log")),
            PathBuf::from("/l/pocket-monitor.previous.log")
        );
    }

    #[test]
    fn a_tail_is_the_last_lines() {
        assert_eq!(tail_lines("a\nb\nc\n", 2), "b\nc");
        assert_eq!(tail_lines("a", 5), "a");
        assert_eq!(tail_lines("", 5), "");
    }
}
