// A release operator build is a normal Windows app, not a terminal program (A13).
#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

//! Pocket Monitor on the desktop: a Tauri 2 window whose interface is the Expo web build
//! of `Apps/Mobile`, over a native Vulkan picture.
//!
//! `docs/desktop-expo-port.md` §3. One process, one window. The web view is transparent
//! where the picture is and carries the chrome; the picture is `opc-render`'s feed
//! pipeline on a native surface below it (`pm-surface`), fed by the camera link and the
//! decode thread here. Video never crosses IPC.
//!
//! Threads: the main (tao) thread dispatches IPC and window events and never blocks;
//! `opc-camera` runs the datalink; `pm-session` decodes and folds status; `pm-render`
//! presents; `pm-input` streams the gimbal at 100 Hz.

mod camera;
mod input;
mod picture;

use std::sync::{Arc, Mutex};

use pm_controller::command::CameraCommand;
use pm_controller::effects::PictureEffects;
use pm_controller::gimbal::DriveSource;
use pm_controller::link::log_line;
use pm_controller::state::CameraState;
use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

use camera::{CameraService, Target};
use picture::{CssRect, PictureHost, PictureHub};

/// What the command line asked for, for the web's first route (B1, phase 1 subset).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchArgs {
    /// `--camera HOST[:PORT]` (or `PM_CAMERA`): connect at launch.
    camera: Option<String>,
    /// `--model ID` (decimal or 0x hex).
    model: Option<i32>,
    /// `demo`: stay on the web demo camera.
    demo: bool,
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|argument| argument == &format!("--{name}"))
        .and_then(|at| args.get(at + 1))
        .cloned()
}

fn parse_model(text: &str) -> Option<i32> {
    match text.strip_prefix("0x") {
        Some(hex) => i32::from_str_radix(hex, 16).ok(),
        None => text.parse().ok(),
    }
}

fn launch_args_from(args: &[String]) -> LaunchArgs {
    LaunchArgs {
        camera: flag(args, "camera").or_else(|| std::env::var("PM_CAMERA").ok()),
        model: flag(args, "model").as_deref().and_then(parse_model),
        demo: args.iter().any(|argument| argument == "demo"),
    }
}

#[tauri::command]
fn launch_args(args: State<'_, LaunchArgs>) -> LaunchArgs {
    args.inner().clone()
}

// Connect, disconnect and reconnect join threads (the old link's camera thread can take a
// reconnect pause to notice), so they run off the main thread (§3.3 rule 1).
async fn off_main<T: Send + 'static>(
    app: AppHandle,
    job: impl FnOnce(&CameraService) -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || job(&app.state::<CameraService>()))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn camera_connect(app: AppHandle, target: Option<Target>) -> Result<(), String> {
    off_main(app, move |camera| {
        camera.connect(target.unwrap_or_default())
    })
    .await?
}

#[tauri::command]
async fn camera_disconnect(app: AppHandle) -> Result<(), String> {
    off_main(app, CameraService::disconnect).await
}

#[tauri::command]
async fn camera_reconnect(app: AppHandle) -> Result<(), String> {
    off_main(app, CameraService::reconnect).await?
}

#[tauri::command]
fn camera_state(camera: State<'_, CameraService>) -> CameraState {
    camera.state()
}

/// One `CameraController`/`GimbalController` call. A refusal comes back as operator copy.
#[tauri::command]
fn camera_command(camera: State<'_, CameraService>, command: CameraCommand) -> Result<(), String> {
    camera
        .command(&command)
        .map_err(|refused| refused.to_string())
}

/// A stick throw in −1…1 (right and up positive). The web repeats it at ≥ 10 Hz while
/// held; 250 ms without one rests the gimbal.
#[tauri::command]
fn gimbal_drive(camera: State<'_, CameraService>, x: f64, y: f64, source: Option<DriveSource>) {
    camera
        .input
        .drive(x, y, source.unwrap_or(DriveSource::Touch));
}

#[tauri::command]
fn gimbal_release(camera: State<'_, CameraService>, source: Option<DriveSource>) {
    camera.input.release(source);
}

/// Where `<LivePicture>`'s transparent hole is (CSS px of the viewport) and the device
/// pixel ratio; `rect: null` when no live picture is on screen.
#[tauri::command]
fn picture_layout(hub: State<'_, Arc<PictureHub>>, rect: Option<CssRect>, dpr: Option<f64>) {
    hub.layout(rect.map(|rect| (rect, dpr.unwrap_or(1.0).max(0.1))));
}

/// The mobile `PictureEffects`, sent when it changes.
#[tauri::command]
fn picture_set_effects(hub: State<'_, Arc<PictureHub>>, effects: PictureEffects) {
    hub.effects(effects);
}

#[tauri::command]
fn window_fullscreen(window: tauri::WebviewWindow, on: Option<bool>) -> Result<bool, String> {
    let wanted = match on {
        Some(on) => on,
        None => !window.is_fullscreen().map_err(|error| error.to_string())?,
    };
    window
        .set_fullscreen(wanted)
        .map_err(|error| error.to_string())?;
    Ok(wanted)
}

fn main() {
    // First thing: no power throttling, 1 ms timers (A14, P9).
    pm_controller::platform::keep_timers_fast();
    log_line("pm-desktop", "starting");
    std::panic::set_hook(Box::new(|info| {
        log_line("PANIC", info);
        eprintln!("pocket monitor panic: {info}");
    }));

    let args: Vec<String> = std::env::args().skip(1).collect();
    log_line("args", format_args!("{args:?}"));
    let launch = launch_args_from(&args);

    let commander = Arc::new(Mutex::new(None));
    let hub = PictureHub::new(commander.clone());

    let app = tauri::Builder::default()
        .manage(launch.clone())
        .manage(hub.clone())
        .manage(PictureHost::default())
        .setup(move |app| {
            let service = CameraService::new(app.handle().clone(), commander.clone(), hub.clone());
            app.manage(service);
            if let Some(window) = app.get_webview_window("main") {
                picture::start(window, hub.clone());
            }
            if let Some(host) = launch.camera.clone() {
                let target = Target {
                    host: Some(host),
                    model: launch.model,
                };
                if let Err(error) = app.state::<CameraService>().connect(target) {
                    log_line("pm-desktop", format_args!("launch connect failed: {error}"));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                WindowEvent::Resized(size) => {
                    if let (Some(host), Some(hub)) = (
                        app.try_state::<PictureHost>(),
                        app.try_state::<Arc<PictureHub>>(),
                    ) {
                        host.resize(&hub, size.width, size.height);
                    }
                }
                // Rust rests the gimbal itself, whatever the web view is doing (§3.6).
                WindowEvent::Focused(false) => {
                    if let Some(camera) = app.try_state::<CameraService>() {
                        camera.input.rest("focus lost");
                    }
                }
                WindowEvent::CloseRequested { .. } => {
                    if let Some(camera) = app.try_state::<CameraService>() {
                        camera.input.rest("window closing");
                    }
                    // The swapchain goes before the window it points at.
                    if let (Some(host), Some(hub)) = (
                        app.try_state::<PictureHost>(),
                        app.try_state::<Arc<PictureHub>>(),
                    ) {
                        host.shutdown(&hub);
                    }
                }
                WindowEvent::Destroyed => {
                    if let (Some(host), Some(hub)) = (
                        app.try_state::<PictureHost>(),
                        app.try_state::<Arc<PictureHub>>(),
                    ) {
                        host.shutdown(&hub);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            launch_args,
            camera_connect,
            camera_disconnect,
            camera_reconnect,
            camera_state,
            camera_command,
            gimbal_drive,
            gimbal_release,
            picture_layout,
            picture_set_effects,
            window_fullscreen,
        ])
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            log_line("pm-desktop", format_args!("could not start: {error}"));
            eprintln!("pocket monitor: {error}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(camera) = app.try_state::<CameraService>() {
                camera.shutdown();
            }
            if let (Some(host), Some(hub)) = (
                app.try_state::<PictureHost>(),
                app.try_state::<Arc<PictureHub>>(),
            ) {
                host.shutdown(&hub);
            }
            log_line("pm-desktop", "exited ok");
        }
    });
}

/// The renderer is built on the main thread (AppKit needs it there) and moved to its own
/// thread, so it must be `Send`; this fails to compile the day it stops being.
#[allow(dead_code)]
fn assert_send() {
    fn send<T: Send>() {}
    send::<opc_render::FeedRenderer>();
    send::<pm_surface::PictureSurface>();
}
