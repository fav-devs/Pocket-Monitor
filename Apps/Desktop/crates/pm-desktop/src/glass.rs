//! The window material behind the sidebar and the native Liquid Glass controls, asked for
//! by the web (`src/features/glass` in Apps/Mobile).
//!
//! `docs/desktop-expo-port.md` §5.14. `glass_caps` says what this machine can do;
//! `glass_material` turns the sidebar material on (the shell is showing) or off (a
//! full-bleed picture page); `glass_controls` places native glass under the controls the
//! web lists (macOS 26+; the web draws those controls' backgrounds transparent while they
//! are native). The views live in `pm_surface::glass`, between the picture surface and the
//! web view, and never take a click.

use pm_controller::link::log_line;
use pm_surface::glass::{self, GlassItem, Rect};
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassCaps {
    /// `"vibrancy"` (macOS), `"mica"` (Windows 11) or `"none"`.
    material: &'static str,
    /// Native `NSGlassEffectView` controls (macOS 26+).
    glass_controls: bool,
}

#[tauri::command]
pub fn glass_caps() -> GlassCaps {
    let caps = glass::capabilities();
    GlassCaps {
        material: caps.material.name(),
        glass_controls: caps.glass_controls,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub struct MaterialRequest {
    on: bool,
    /// Width of the leading strip the material shows under, CSS px.
    #[serde(default)]
    leading: f64,
    /// The web's colour scheme (Mica's light or dark variant).
    #[serde(default)]
    dark: bool,
    #[serde(default = "one")]
    dpr: f64,
}

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassItemRequest {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    radius: f64,
    tint: Option<String>,
    style: Option<String>,
    underlay: Option<String>,
    #[serde(default)]
    trailing: bool,
}

impl GlassItemRequest {
    fn item(&self) -> GlassItem {
        GlassItem::from_web(
            Rect::new(self.x, self.y, self.width, self.height),
            self.radius,
            self.tint.as_deref(),
            self.style.as_deref(),
            self.underlay.as_deref(),
            self.trailing,
        )
    }
}

#[tauri::command]
pub fn glass_material(window: WebviewWindow, request: MaterialRequest) -> Result<(), String> {
    platform::material(window, request)
}

/// Native glass under these controls (CSS px of the viewport); an empty list hides them
/// all. A no-op before macOS 26 and off macOS.
#[tauri::command]
pub fn glass_controls(
    window: WebviewWindow,
    items: Vec<GlassItemRequest>,
    dpr: Option<f64>,
) -> Result<(), String> {
    let items: Vec<GlassItem> = items.iter().map(GlassItemRequest::item).collect();
    platform::controls(window, items, dpr.unwrap_or(1.0))
}

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn log_once(message: String) {
    use std::sync::Mutex;
    static LAST: Mutex<String> = Mutex::new(String::new());
    if let Ok(mut last) = LAST.lock() {
        if *last != message {
            log_line("glass", &message);
            *last = message;
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;

    use pm_surface::glass::{GlassHost, GlassItem};
    use tauri::WebviewWindow;

    use super::{log_once, MaterialRequest};

    thread_local! {
        /// Built on the main thread the first time the web asks; main thread only.
        static HOST: RefCell<Option<GlassHost>> = const { RefCell::new(None) };
    }

    fn with_host(
        window: &WebviewWindow,
        job: impl FnOnce(&mut GlassHost) + Send + 'static,
    ) -> Result<(), String> {
        window
            .with_webview(move |webview| {
                HOST.with(|slot| {
                    let mut slot = slot.borrow_mut();
                    if slot.is_none() {
                        // Safety: the live WKWebView, on the main thread (with_webview).
                        match unsafe { GlassHost::attach(webview.inner()) } {
                            Ok(host) => *slot = Some(host),
                            Err(error) => {
                                log_once(format!("no window material: {error}"));
                                return;
                            }
                        }
                    }
                    if let Some(host) = slot.as_mut() {
                        job(host);
                    }
                });
            })
            .map_err(|error| error.to_string())
    }

    pub fn material(window: WebviewWindow, request: MaterialRequest) -> Result<(), String> {
        let width = request.on.then_some(request.leading);
        with_host(&window, move |host| {
            host.set_material(width, request.dpr);
            log_once(match width {
                Some(width) => format!("sidebar vibrancy on ({width:.0} px)"),
                None => "sidebar vibrancy off".to_string(),
            });
        })
    }

    pub fn controls(window: WebviewWindow, items: Vec<GlassItem>, dpr: f64) -> Result<(), String> {
        with_host(&window, move |host| {
            host.set_items(&items, dpr);
        })
    }
}

#[cfg(windows)]
mod platform {
    use pm_surface::glass::GlassItem;
    use raw_window_handle::HasWindowHandle;
    use tauri::{Manager, WebviewWindow};

    use super::{log_once, MaterialRequest};
    use crate::picture::PictureHost;

    /// Mica on the window, and the picture's child window slid off the sidebar strip so
    /// DWM's backdrop shows there. The web asks only while no picture is on screen.
    pub fn material(window: WebviewWindow, request: MaterialRequest) -> Result<(), String> {
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let Ok(handle) = target.window_handle() else {
                    return;
                };
                let raw = handle.as_raw();
                let applied = if request.on {
                    // Safety: the live top-level window, on its own thread.
                    unsafe { pm_surface::glass::apply_mica(raw, request.dark) }
                } else {
                    // Safety: as above.
                    unsafe { pm_surface::glass::clear_mica(raw) }
                };
                let inset = match (&applied, request.on) {
                    (Ok(()), true) => {
                        (request.leading.max(0.0) * request.dpr.max(0.1)).round() as u32
                    }
                    _ => 0,
                };
                if let Some(host) = target.app_handle().try_state::<PictureHost>() {
                    host.set_leading_inset(inset);
                }
                log_once(match applied {
                    Ok(()) if request.on => format!("mica on, picture inset {inset} px"),
                    Ok(()) => "mica off".to_string(),
                    Err(error) => format!("mica unavailable: {error}"),
                });
            })
            .map_err(|error| error.to_string())
    }

    pub fn controls(
        _window: WebviewWindow,
        _items: Vec<GlassItem>,
        _dpr: f64,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use pm_surface::glass::GlassItem;
    use tauri::WebviewWindow;

    use super::MaterialRequest;

    pub fn material(_window: WebviewWindow, _request: MaterialRequest) -> Result<(), String> {
        Ok(())
    }

    pub fn controls(
        _window: WebviewWindow,
        _items: Vec<GlassItem>,
        _dpr: f64,
    ) -> Result<(), String> {
        Ok(())
    }
}
