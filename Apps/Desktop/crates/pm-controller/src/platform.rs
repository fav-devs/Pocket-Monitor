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

/// The folder the old viewfinder (`opc-monitor`) and the first Tauri builds kept every
/// remembered camera, the settings and the LUT drop folder in. Still the default, so the
/// old binary keeps reading and writing exactly where it always did until it is retired.
pub const LEGACY_DATA_FOLDER: &str = "OpenPocketCine";

/// Pocket Monitor's own folder name. `pm-desktop` selects it with [`set_data_folder`] at
/// startup and copies the old folder's files across once ([`migrate_legacy_data`]).
pub const DATA_FOLDER: &str = "Pocket Monitor";

static FOLDER_NAME: OnceLock<String> = OnceLock::new();

/// Names the per-user folder for this process (`%LOCALAPPDATA%\<name>`,
/// `~/.config/<name>`, `<cache>/<name>`). Call it first thing, before anything reads or
/// writes a file; later calls are ignored. The media cache follows it too.
pub fn set_data_folder(name: &str) {
    let _ = FOLDER_NAME.set(name.to_string());
    opc_media::cache::set_folder_name(name);
}

/// The per-user folder name this process uses: [`LEGACY_DATA_FOLDER`] unless
/// [`set_data_folder`] chose another.
pub fn data_folder() -> &'static str {
    FOLDER_NAME.get().map_or(LEGACY_DATA_FOLDER, String::as_str)
}

/// The directory the data folder sits in: `%LOCALAPPDATA%` on Windows;
/// `$XDG_CONFIG_HOME` or `~/.config` elsewhere (the old camera files' rule). `None` when
/// the environment names none of them.
pub fn config_root() -> Option<PathBuf> {
    config_root_from(
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

fn config_root_from(
    local_app_data: Option<PathBuf>,
    xdg_config: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    local_app_data
        .or(xdg_config)
        .or_else(|| home.map(|home| home.join(".config")))
}

/// `%LOCALAPPDATA%\<folder>` on Windows; `$XDG_CONFIG_HOME/<folder>` or
/// `~/.config/<folder>` elsewhere; beside the executable when there is none of those.
/// `<folder>` is [`data_folder`].
pub fn data_dir() -> PathBuf {
    data_dir_from(
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
        exe_dir(),
        data_folder(),
    )
}

/// [`data_dir`] from its inputs, for tests.
pub fn data_dir_from(
    local_app_data: Option<PathBuf>,
    xdg_config: Option<PathBuf>,
    home: Option<PathBuf>,
    exe_dir: Option<PathBuf>,
    folder: &str,
) -> PathBuf {
    config_root_from(local_app_data, xdg_config, home)
        .or(exe_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(folder)
}

/// `<cache>/<folder>`: the preferences, the app settings, the presets, the LUT drop
/// folder and its pick, beside the media cache. `<cache>` is `%LOCALAPPDATA%` on Windows
/// (so this is the same folder as [`data_dir`] there), `$XDG_CACHE_HOME` or `~/.cache`
/// elsewhere, else the executable's folder ([`opc_media::cache::cache_root`]).
pub fn cache_dir() -> PathBuf {
    opc_media::cache::cache_root().join(data_folder())
}

/// The executable's folder.
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

// ---- Moving over from the old folder ---------------------------------------------------

/// Files kept in [`data_dir`] that an upgrade carries over: the remembered cameras (SoftAP,
/// station, LAN) and the window's place.
pub const MIGRATED_DATA_FILES: &[&str] = &[
    "desktop-camera-v1.txt",
    "desktop-station-v1.txt",
    "desktop-lan-camera-v1.txt",
    "pocket-monitor-window-v1.txt",
];

/// Files kept in [`cache_dir`] that an upgrade carries over: preferences, app settings,
/// gimbal presets, the LUT pick, the watcher id and the web-seed marker.
pub const MIGRATED_CACHE_FILES: &[&str] = &[
    "desktop-prefs.txt",
    "desktop-app-v1.txt",
    "desktop-gimbal-presets-v1.txt",
    "desktop-lut-v1.txt",
    "watcher-id",
    "pocket-monitor-web-seeded-v1.txt",
];

/// The LUT drop folder, under [`cache_dir`]; copied with its files.
pub const MIGRATED_CACHE_DIRS: &[&str] = &["luts"];

/// One old/new pair of folders to migrate between.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationPaths {
    pub old_data: PathBuf,
    pub new_data: PathBuf,
    pub old_cache: PathBuf,
    pub new_cache: PathBuf,
}

impl MigrationPaths {
    /// The old ([`LEGACY_DATA_FOLDER`]) and current ([`data_folder`]) folders.
    pub fn current() -> Self {
        let data_root = data_dir()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let cache_root = opc_media::cache::cache_root();
        Self {
            old_data: data_root.join(LEGACY_DATA_FOLDER),
            new_data: data_dir(),
            old_cache: cache_root.join(LEGACY_DATA_FOLDER),
            new_cache: cache_dir(),
        }
    }

    fn entries(&self) -> Vec<(PathBuf, PathBuf, bool)> {
        let files = |old: &Path, new: &Path, names: &[&str], dir: bool| {
            names
                .iter()
                .map(|name| (old.join(name), new.join(name), dir))
                .collect::<Vec<_>>()
        };
        let mut all = files(&self.old_data, &self.new_data, MIGRATED_DATA_FILES, false);
        all.extend(files(
            &self.old_cache,
            &self.new_cache,
            MIGRATED_CACHE_FILES,
            false,
        ));
        all.extend(files(
            &self.old_cache,
            &self.new_cache,
            MIGRATED_CACHE_DIRS,
            true,
        ));
        all
    }

    /// Whether the new folders already hold anything worth keeping. Folders the app
    /// creates on its own (`logs`, the media cache) do not count.
    pub fn new_has_data(&self) -> bool {
        self.entries().iter().any(|(_, new, _)| new.exists())
    }
}

/// What [`migrate`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Migration {
    /// The files copied, as their new paths.
    pub copied: Vec<PathBuf>,
    /// Files that could not be copied, with the reason.
    pub failed: Vec<(PathBuf, String)>,
}

impl Migration {
    /// One line for the log.
    pub fn summary(&self, paths: &MigrationPaths) -> String {
        let mut line = format!(
            "copied {} file(s) from {} to {}",
            self.copied.len(),
            paths.old_data.display(),
            paths.new_data.display()
        );
        if paths.old_cache != paths.old_data {
            line.push_str(&format!(
                " (and {} to {})",
                paths.old_cache.display(),
                paths.new_cache.display()
            ));
        }
        line.push_str("; the old folder is left as it was");
        if !self.failed.is_empty() {
            let failed: Vec<String> = self
                .failed
                .iter()
                .map(|(path, error)| format!("{}: {error}", path.display()))
                .collect();
            line.push_str(&format!("; not copied: {}", failed.join(", ")));
        }
        line
    }
}

/// Copies the old folder's files into the new one when the new one has no data yet and
/// the old one exists. Never moves, overwrites or deletes anything: the old build keeps
/// working from its folder. `None` when there was nothing to do (already migrated, a fresh
/// install, or the two folders are the same).
pub fn migrate(paths: &MigrationPaths) -> Option<Migration> {
    if paths.old_data == paths.new_data && paths.old_cache == paths.new_cache {
        return None;
    }
    if !(paths.old_data.is_dir() || paths.old_cache.is_dir()) || paths.new_has_data() {
        return None;
    }
    let mut done = Migration::default();
    for (old, new, dir) in paths.entries() {
        if !old.exists() || new.exists() {
            continue;
        }
        let result = if dir {
            copy_dir(&old, &new, &mut done.copied)
        } else {
            copy_file(&old, &new).map(|()| done.copied.push(new.clone()))
        };
        if let Err(error) = result {
            done.failed.push((new, error.to_string()));
        }
    }
    Some(done)
}

/// [`migrate`] between the legacy folder and [`data_folder`].
pub fn migrate_legacy_data() -> Option<(MigrationPaths, Migration)> {
    let paths = MigrationPaths::current();
    migrate(&paths).map(|done| (paths, done))
}

fn copy_file(old: &Path, new: &Path) -> std::io::Result<()> {
    if let Some(parent) = new.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(old, new).map(|_| ())
}

/// Copies the plain files of `old` (one level: the LUT folder has no subfolders).
fn copy_dir(old: &Path, new: &Path, copied: &mut Vec<PathBuf>) -> std::io::Result<()> {
    std::fs::create_dir_all(new)?;
    for entry in std::fs::read_dir(old)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let target = new.join(entry.file_name());
        if target.exists() {
            continue;
        }
        std::fs::copy(entry.path(), &target)?;
        copied.push(target);
    }
    Ok(())
}

// ---- Environment -----------------------------------------------------------------------

/// `PM_<name>`, else the old `OPC_<name>`, which is still read so the old scripts,
/// shortcuts and habits keep working (`GESTURES`, `WEBCAM`, `PHONE_PASSCODE`,
/// `WIFI_PASSWORD`, `DUMP_STREAM`).
pub fn env_var_os(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(format!("PM_{name}")).or_else(|| std::env::var_os(format!("OPC_{name}")))
}

/// [`env_var_os`] as text; a value that is not Unicode counts as unset.
pub fn env_var(name: &str) -> Option<String> {
    env_var_os(name).and_then(|value| value.into_string().ok())
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
/// it is under Program Files. Neither test names the folder, so a new install
/// (`{autopf}\Pocket Monitor`), an upgraded one still in `{autopf}\OpenPocketCine` and
/// one the operator put elsewhere all count.
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
            data_dir_from(
                Some(local.clone()),
                Some("/x".into()),
                None,
                None,
                DATA_FOLDER
            ),
            local.join("Pocket Monitor")
        );
        assert_eq!(
            data_dir_from(None, None, Some("/home/op".into()), None, DATA_FOLDER),
            PathBuf::from("/home/op/.config/Pocket Monitor")
        );
        assert_eq!(
            data_dir_from(
                None,
                Some("/cfg".into()),
                Some("/home/op".into()),
                None,
                DATA_FOLDER
            ),
            PathBuf::from("/cfg/Pocket Monitor")
        );
        assert_eq!(
            data_dir_from(None, None, None, Some("D:/pm".into()), DATA_FOLDER),
            PathBuf::from("D:/pm/Pocket Monitor")
        );
        assert_eq!(
            data_dir_from(Some(local.clone()), None, None, None, LEGACY_DATA_FOLDER),
            local.join("OpenPocketCine"),
            "the old viewfinder keeps its folder"
        );
        assert_eq!(config_root_from(None, None, None), None);
    }

    #[test]
    fn the_old_viewfinder_keeps_its_folder_by_default() {
        // No test in this crate calls set_data_folder, so the process default shows.
        assert_eq!(data_folder(), LEGACY_DATA_FOLDER);
        assert_eq!(opc_media::cache::folder_name(), LEGACY_DATA_FOLDER);
        assert!(cache_dir().ends_with(LEGACY_DATA_FOLDER));
        assert!(crate::luts::custom_folder().ends_with("OpenPocketCine/luts"));
        assert!(crate::prefs::path().ends_with("OpenPocketCine/desktop-prefs.txt"));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-migrate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn split_paths(root: &Path) -> MigrationPaths {
        // The Linux shape: data under ~/.config, the rest under ~/.cache.
        MigrationPaths {
            old_data: root.join("config/OpenPocketCine"),
            new_data: root.join("config/Pocket Monitor"),
            old_cache: root.join("cache/OpenPocketCine"),
            new_cache: root.join("cache/Pocket Monitor"),
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, text).expect("write");
    }

    #[test]
    fn a_first_run_copies_the_old_files_and_leaves_them_in_place() {
        let root = scratch("copy");
        let paths = split_paths(&root);
        write(&paths.old_data.join("desktop-camera-v1.txt"), "camera");
        write(&paths.old_data.join("desktop-station-v1.txt"), "station");
        write(&paths.old_data.join("desktop-lan-camera-v1.txt"), "lan");
        write(&paths.old_data.join("logs/opc-monitor.log"), "log");
        write(&paths.old_cache.join("desktop-prefs.txt"), "prefs");
        write(&paths.old_cache.join("desktop-app-v1.txt"), "app");
        write(
            &paths.old_cache.join("desktop-lut-v1.txt"),
            "selected=file:A.cube",
        );
        write(&paths.old_cache.join("luts/A.cube"), "cube");
        write(&paths.old_cache.join("media/cam/index.json"), "{}");
        // The new app made its log folder before migrating: that is not data.
        std::fs::create_dir_all(paths.new_data.join("logs")).expect("logs");

        let done = migrate(&paths).expect("migrated");
        assert!(done.failed.is_empty(), "{:?}", done.failed);
        assert_eq!(done.copied.len(), 7, "{:?}", done.copied);
        let read = |path: PathBuf| std::fs::read_to_string(path).expect("copied");
        assert_eq!(read(paths.new_data.join("desktop-camera-v1.txt")), "camera");
        assert_eq!(
            read(paths.new_data.join("desktop-station-v1.txt")),
            "station"
        );
        assert_eq!(
            read(paths.new_data.join("desktop-lan-camera-v1.txt")),
            "lan"
        );
        assert_eq!(read(paths.new_cache.join("desktop-prefs.txt")), "prefs");
        assert_eq!(read(paths.new_cache.join("desktop-app-v1.txt")), "app");
        assert_eq!(
            read(paths.new_cache.join("desktop-lut-v1.txt")),
            "selected=file:A.cube"
        );
        assert_eq!(read(paths.new_cache.join("luts/A.cube")), "cube");
        assert!(
            !paths.new_cache.join("media").exists(),
            "the media cache is not copied"
        );
        assert!(
            !paths.new_data.join("logs/opc-monitor.log").exists(),
            "nor the logs"
        );
        assert!(
            paths.old_data.join("desktop-camera-v1.txt").exists(),
            "never moved"
        );
        assert!(paths.old_cache.join("luts/A.cube").exists());
        let line = done.summary(&paths);
        assert!(line.contains("copied 7 file(s)"), "{line}");
        assert!(line.contains("left as it was"), "{line}");

        // A second run finds data in the new folder and does nothing.
        write(
            &paths.old_cache.join("desktop-gimbal-presets-v1.txt"),
            "late",
        );
        assert_eq!(migrate(&paths), None);
        assert!(!paths
            .new_cache
            .join("desktop-gimbal-presets-v1.txt")
            .exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_is_copied_over_new_data_or_without_an_old_folder() {
        let root = scratch("skip");
        let paths = split_paths(&root);
        assert_eq!(migrate(&paths), None, "a fresh install: no old folder");

        write(&paths.old_cache.join("desktop-prefs.txt"), "old");
        write(&paths.new_cache.join("desktop-prefs.txt"), "new");
        assert!(paths.new_has_data());
        assert_eq!(migrate(&paths), None);
        assert_eq!(
            std::fs::read_to_string(paths.new_cache.join("desktop-prefs.txt")).expect("kept"),
            "new"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn one_folder_for_data_and_cache_on_windows() {
        let root = scratch("windows");
        let local = root.join("Local");
        let paths = MigrationPaths {
            old_data: local.join("OpenPocketCine"),
            new_data: local.join("Pocket Monitor"),
            old_cache: local.join("OpenPocketCine"),
            new_cache: local.join("Pocket Monitor"),
        };
        write(&paths.old_data.join("desktop-camera-v1.txt"), "camera");
        write(&paths.old_data.join("desktop-prefs.txt"), "prefs");
        write(&paths.old_data.join("watcher-id"), "id");
        let done = migrate(&paths).expect("migrated");
        assert_eq!(done.copied.len(), 3, "{:?}", done.copied);
        assert!(!done.summary(&paths).contains("(and"));
        assert!(paths.new_data.join("watcher-id").exists());

        let same = MigrationPaths {
            old_data: local.join("OpenPocketCine"),
            new_data: local.join("OpenPocketCine"),
            old_cache: local.join("OpenPocketCine"),
            new_cache: local.join("OpenPocketCine"),
        };
        assert_eq!(
            migrate(&same),
            None,
            "the old binary never migrates onto itself"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_installed_copy_logs_per_user_and_a_portable_one_beside_itself() {
        let exe = Path::new("D:/PocketMonitor");
        let data = Path::new("C:/Users/op/AppData/Local/Pocket Monitor");
        assert_eq!(log_dir_for(Some(exe), data, false, true), exe);
        assert_eq!(log_dir_for(Some(exe), data, true, true), data.join("logs"));
        assert_eq!(
            log_dir_for(Some(exe), data, false, false),
            data.join("logs"),
            "Program Files is not writable for a normal user"
        );
        assert_eq!(log_dir_for(None, data, false, true), data.join("logs"));
        // An upgraded install stays in the old folder; a new one goes to the new one.
        assert!(looks_installed(Path::new(
            "C:\\Program Files\\OpenPocketCine\\"
        )));
        assert!(looks_installed(Path::new(
            "C:\\Program Files\\Pocket Monitor\\"
        )));
        assert!(looks_installed(Path::new(
            "C:\\Program Files\\Pocket Monitor"
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
