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
mod connect;
mod diagnostics;
mod gamepad;
mod gestures;
mod input;
mod keys;
mod known;
mod launch;
mod luts;
mod media;
mod moves;
mod picture;
mod player;
mod pointer;
mod prefs;
mod relay;
mod scopes;
mod station;
mod stills;
mod uri;
mod vcam;

use std::sync::{Arc, Mutex};

use pm_controller::command::CameraCommand;
use pm_controller::effects::PictureEffects;
use pm_controller::gimbal::DriveSource;
use pm_controller::link::log_line;
use pm_controller::state::CameraState;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

use camera::{CameraService, Target};
use picture::{CssRect, PictureHost, PictureHub};

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
fn picture_layout(
    hub: State<'_, Arc<PictureHub>>,
    rect: Option<CssRect>,
    dpr: Option<f64>,
    fit: Option<String>,
) {
    hub.layout(rect.map(|rect| (rect, dpr.unwrap_or(1.0).max(0.1))));
    // `resizeMode`: "fill" fills the hole and crops; absent or "fit" keeps the bars.
    if let Some(fit) = fit {
        hub.fit_mode(fit == "fill");
    }
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
    // The log (D3): per user when installed, beside the exe when portable.
    pm_controller::platform::set_log_name("pocket-monitor.log");
    // keys / version / --help / headless exit here; a second launch hands over (B6, A1).
    let launch = launch::from_command_line();
    launch::ensure_webview_runtime();
    if launch::hand_to_running(&launch) {
        return;
    }
    pm_controller::platform::rotate_log();
    log_line("pm-desktop", "starting");
    launch::log_args();
    std::panic::set_hook(Box::new(|info| {
        log_line("PANIC", info);
        eprintln!("pocket monitor panic: {info}");
    }));

    let commander = Arc::new(Mutex::new(None));
    let hub = PictureHub::new(commander.clone());

    let app = tauri::Builder::default()
        .manage(launch.clone())
        .manage(hub.clone())
        .manage(PictureHost::default())
        // Thumbnails, filmstrip frames and stills for the web view, never over JSON.
        .register_asynchronous_uri_scheme_protocol("pm", uri::handle)
        .setup(move |app| {
            let service = CameraService::new(app.handle().clone(), commander.clone(), hub.clone());
            app.manage(service);
            input::attach(app.handle());
            app.manage(connect::BleService::new(app.handle().clone()));
            launch::listen_for_launches(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                launch::restore_window(&window);
            }
            media::start_services(app.handle());
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
            launch::on_window_event(window, event);
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
            launch::launch_args,
            launch::keyboard_shortcuts,
            connect::ble_scan_start,
            connect::ble_scan_stop,
            connect::ble_pair,
            connect::ble_cancel,
            connect::wifi_join_camera,
            connect::wifi_join_saved,
            connect::camera_open,
            connect::station_join,
            connect::station_reset,
            connect::station_find,
            connect::station_current_ssid,
            known::known_cameras,
            known::forget_camera,
            known::probe_camera,
            known::camera_address_check,
            prefs::prefs_get,
            prefs::prefs_set,
            prefs::app_settings_get,
            prefs::app_settings_set,
            prefs::prefs_web_seed,
            prefs::prefs_web_seeded,
            diagnostics::diagnostics_paths,
            diagnostics::diagnostics_write,
            diagnostics::log_tail,
            diagnostics::open_folder,
            camera_connect,
            camera_disconnect,
            camera_reconnect,
            camera_state,
            camera_command,
            gimbal_drive,
            gimbal_release,
            picture_layout,
            picture_set_effects,
            luts::lut_list,
            luts::lut_load,
            luts::lut_select,
            luts::lut_unload,
            luts::lut_auto,
            scopes::scopes_configure,
            stills::still_capture,
            window_fullscreen,
            keys::control_key,
            keys::control_keys,
            pointer::picture_pointer,
            pointer::focus_at,
            pointer::track_clear,
            moves::zoom_write,
            moves::zoom_rate,
            moves::zoom_step,
            moves::record_countdown,
            moves::gimbal_lock_all,
            moves::input_configure,
            moves::input_resend,
            moves::moves_set_point,
            moves::moves_clear_point,
            moves::moves_configure,
            moves::moves_start,
            moves::moves_stop,
            moves::moves_pause,
            moves::moves_resume,
            moves::preset_save,
            moves::preset_go,
            moves::preset_clear,
            moves::preset_seconds,
            gestures::gestures_set,
            gestures::gestures_state,
            media::media_list,
            media::media_refresh,
            media::media_play,
            media::media_view,
            media::media_download,
            media::media_favorite,
            media::media_delete,
            media::media_close,
            media::media_resume_live,
            media::media_cache_size,
            media::media_cache_clear,
            player::player_state,
            player::player_toggle,
            player::player_seek,
            player::player_speed,
            player::player_conform_next,
            player::player_conform,
            player::player_options,
            player::player_screenshot,
            player::player_close,
            vcam::vcam_get,
            vcam::vcam_set,
            vcam::vcam_component_probe,
            vcam::vcam_component_install,
            vcam::vcam_component_remove,
            vcam::open_url,
            relay::relay_browse,
            relay::relay_info,
            relay::relay_join,
            relay::relay_leave,
            relay::relay_control,
            relay::relay_command,
        ])
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            log_line("pm-desktop", format_args!("could not start: {error}"));
            eprintln!("pocket monitor: {error}");
            // No terminal in the release build: say it in a dialog (A12).
            pm_controller::platform::message_box(
                "Pocket Monitor",
                &format!("Pocket Monitor could not start: {error}"),
                true,
            );
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            media::stop_services(app);
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
