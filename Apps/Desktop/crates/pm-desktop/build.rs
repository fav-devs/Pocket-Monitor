//! Tauri's build step, plus the Swift core link line `opc-monitor`'s build script emits.
//!
//! The app's own commands are declared so Tauri generates an `allow-<command>`
//! permission for each; `capabilities/default.json` grants them to the main window. Keep
//! this list in step with `generate_handler!` in `src/main.rs`.

use std::path::{Path, PathBuf};

const APP_COMMANDS: &[&str] = &[
    "launch_args",
    "keyboard_shortcuts",
    "ble_scan_start",
    "ble_scan_stop",
    "ble_pair",
    "ble_cancel",
    "wifi_join_camera",
    "wifi_join_saved",
    "camera_open",
    "station_join",
    "station_reset",
    "station_find",
    "station_current_ssid",
    "known_cameras",
    "forget_camera",
    "probe_camera",
    "camera_address_check",
    "prefs_get",
    "prefs_set",
    "app_settings_get",
    "app_settings_set",
    "prefs_web_seed",
    "prefs_web_seeded",
    "diagnostics_paths",
    "diagnostics_write",
    "log_tail",
    "open_folder",
    "camera_connect",
    "camera_disconnect",
    "camera_reconnect",
    "camera_state",
    "camera_command",
    "gimbal_drive",
    "gimbal_release",
    "picture_layout",
    "picture_set_effects",
    "lut_list",
    "lut_load",
    "lut_select",
    "lut_unload",
    "lut_auto",
    "scopes_configure",
    "still_capture",
    "window_fullscreen",
    "control_key",
    "control_keys",
    "picture_pointer",
    "focus_at",
    "track_clear",
    "zoom_write",
    "zoom_rate",
    "zoom_step",
    "record_countdown",
    "gimbal_lock_all",
    "input_configure",
    "input_resend",
    "moves_set_point",
    "moves_clear_point",
    "moves_configure",
    "moves_start",
    "moves_stop",
    "moves_pause",
    "moves_resume",
    "preset_save",
    "preset_go",
    "preset_clear",
    "preset_seconds",
    "gestures_set",
    "gestures_state",
    // Media library, player, virtual camera, relay (docs/desktop-expo-port.md §1.U–W, §1.E).
    "media_list",
    "media_refresh",
    "media_play",
    "media_view",
    "media_download",
    "media_favorite",
    "media_delete",
    "media_close",
    "media_resume_live",
    "media_cache_size",
    "media_cache_clear",
    "player_state",
    "player_toggle",
    "player_seek",
    "player_speed",
    "player_conform_next",
    "player_conform",
    "player_options",
    "player_screenshot",
    "player_close",
    "vcam_get",
    "vcam_set",
    "vcam_component_probe",
    "vcam_component_install",
    "vcam_component_remove",
    "open_url",
    "relay_browse",
    "relay_info",
    "relay_join",
    "relay_leave",
    "relay_control",
    "relay_command",
];

const LIB_NAME: &str = "OpenPocketCineDesktop";

fn has_library(dir: &Path) -> bool {
    ["dylib", "so", "dll"]
        .iter()
        .any(|ext| dir.join(format!("lib{LIB_NAME}.{ext}")).exists())
        || dir.join(format!("{LIB_NAME}.dll")).exists()
        || dir.join(format!("{LIB_NAME}.lib")).exists()
}

fn find_core() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("OPC_CORE_LIB_DIR") {
        if has_library(Path::new(&dir)) {
            return Some(PathBuf::from(dir));
        }
    }
    // crates/pm-desktop -> crates -> Apps/Desktop -> Apps -> repo root
    let manifest = std::env::var("CARGO_MANIFEST_DIR").ok()?;
    let root = Path::new(&manifest).ancestors().nth(4)?.to_path_buf();
    [
        root.join(".build/x86_64-unknown-windows-msvc/debug"),
        root.join(".build/x86_64-unknown-windows-msvc/release"),
        root.join(".build/release"),
        root.join(".build/debug"),
    ]
    .into_iter()
    .find(|candidate| has_library(candidate))
}

fn main() {
    println!("cargo::rustc-check-cfg=cfg(opc_core_linked)");
    println!("cargo:rerun-if-env-changed=OPC_CORE_LIB_DIR");
    if let Some(dir) = find_core() {
        // The executable boundary: make the Swift facade link explicit, as opc-monitor does.
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=dylib={LIB_NAME}");
        // A dependency's rustc-link-arg does not reach this executable: dyld needs the
        // facade's @rpath resolved here too (as opc-monitor's build script does).
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
        }
        println!("cargo:rustc-cfg=opc_core_linked");
    }
    // `frontendDist` must exist for `generate_context!`, even before the first export.
    let dist = Path::new("ui");
    if !dist.join("index.html").exists() {
        let _ = std::fs::create_dir_all(dist);
        let _ = std::fs::write(
            dist.join("index.html"),
            "<!doctype html><meta charset=utf-8><title>Pocket Monitor</title>\
             <body style=\"background:#0d0d0d;color:#ccc;font:14px system-ui\">\
             <p>No web build yet. Run <code>node scripts/prepare-ui.mjs</code>.</p>",
        );
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("tauri build step");
}
