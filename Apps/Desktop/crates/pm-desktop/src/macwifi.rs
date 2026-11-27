//! The Wi-Fi this Mac is on (main 62a09c8, `opc-monitor/src/macwifi.rs`). macOS gives the
//! network's name only to an app that has Location permission; `ipconfig` and
//! `networksetup` redact or withhold it. CoreLocation wants its manager on the main
//! thread, so the Tauri command asks there through `run_on_main_thread`.

use std::cell::OnceCell;
use std::time::Duration;

use objc2::rc::Retained;
use objc2_core_location::{CLAuthorizationStatus, CLLocationManager};
use objc2_core_wlan::CWWiFiClient;
use tauri::AppHandle;

thread_local! {
    // The permission prompt is dismissed if the manager that asked for it is dropped.
    static LOCATION: OnceCell<Retained<CLLocationManager>> = const { OnceCell::new() };
}

/// The current network's name. The first call asks for Location permission and returns
/// None until the operator allows it, so a caller may ask again. Call it from the main
/// thread.
fn current_ssid() -> Option<String> {
    LOCATION.with(|cell| {
        // Safety: plain Objective-C calls with no arguments, on the calling (main) thread.
        let manager = cell.get_or_init(|| unsafe { CLLocationManager::new() });
        unsafe {
            if manager.authorizationStatus()
                == CLAuthorizationStatus::kCLAuthorizationStatusNotDetermined
            {
                manager.requestWhenInUseAuthorization();
            }
        }
    });
    // Safety: the shared client and its default interface are always safe to query.
    let ssid = unsafe { CWWiFiClient::sharedWiFiClient().interface()?.ssid()? };
    Some(ssid.to_string()).filter(|name| !name.is_empty())
}

/// [`current_ssid`] on the main thread, from a blocking-pool thread. None when the main
/// thread is busy for longer than a second or the name is not available yet.
pub fn current_ssid_on_main(app: &AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(current_ssid());
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(1)).ok().flatten()
}
