//! The Wi-Fi this Mac is on. macOS gives the network's name only to an app that has
//! Location permission; `ipconfig` and `networksetup` redact or withhold it.

use std::cell::OnceCell;

use objc2::rc::Retained;
use objc2_core_location::{CLAuthorizationStatus, CLLocationManager};
use objc2_core_wlan::CWWiFiClient;

thread_local! {
    // The permission prompt is dismissed if the manager that asked for it is dropped.
    static LOCATION: OnceCell<Retained<CLLocationManager>> = const { OnceCell::new() };
}

/// The current network's name. The first call asks for Location permission and
/// returns None until the operator allows it, so a caller may ask again. Call it
/// from the main thread.
pub fn current_ssid() -> Option<String> {
    LOCATION.with(|cell| {
        // Safety: plain Objective-C calls with no arguments, on the calling thread.
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
