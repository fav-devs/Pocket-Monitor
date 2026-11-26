//! Tauri's build step, plus the Swift core link line `opc-monitor`'s build script emits.
//!
//! The app's own commands are declared so Tauri generates an `allow-<command>`
//! permission for each; `capabilities/default.json` grants them to the main window. Keep
//! this list in step with `generate_handler!` in `src/main.rs`.

use std::path::{Path, PathBuf};

const APP_COMMANDS: &[&str] = &[
    "launch_args",
    "camera_connect",
    "camera_disconnect",
    "camera_reconnect",
    "camera_state",
    "camera_command",
    "gimbal_drive",
    "gimbal_release",
    "picture_layout",
    "picture_set_effects",
    "window_fullscreen",
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
