//! The cameras this PC remembers (`docs/desktop-expo-port.md` A1, X5–X7), for the home
//! screen: the camera by address, the camera on the home network, and the camera's own
//! Wi-Fi. The files are the old viewfinder's (`pm_controller::homewifi`), read in place.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use pm_controller::appsettings::model_label;
use pm_controller::homewifi;
use serde::Serialize;

/// One remembered camera, in the shape the web's saved-camera list wants.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownCamera {
    /// `desktop-lan`, `desktop-station` or `desktop-softap`.
    pub id: &'static str,
    /// `lan`, `station` or `softap`.
    pub kind: &'static str,
    /// The model as an operator knows it ("Osmo Pocket 3").
    pub name: &'static str,
    pub model_id: Option<i32>,
    /// The network: the home Wi-Fi or the camera's own.
    pub ssid: Option<String>,
    /// Where it answers: the LAN address, or the station's last address.
    pub host: Option<String>,
}

pub fn list() -> Vec<KnownCamera> {
    let mut cameras = Vec::new();
    if let Some(lan) = homewifi::load_lan() {
        cameras.push(KnownCamera {
            id: "desktop-lan",
            kind: "lan",
            name: model_label(lan.model_id),
            model_id: lan.model_id,
            ssid: None,
            host: Some(lan.ip.to_string()),
        });
    }
    if let Some(station) = homewifi::load_station() {
        cameras.push(KnownCamera {
            id: "desktop-station",
            kind: "station",
            name: model_label(station.model_id),
            model_id: station.model_id,
            ssid: Some(station.ssid.clone()),
            host: station.address.map(|ip| ip.to_string()),
        });
    }
    if let Some(softap) = homewifi::load_softap() {
        cameras.push(KnownCamera {
            id: "desktop-softap",
            kind: "softap",
            name: model_label(softap.model_id),
            model_id: softap.model_id,
            ssid: Some(softap.ssid),
            host: None,
        });
    }
    cameras
}

/// The cameras this PC remembers.
#[tauri::command]
pub fn known_cameras() -> Vec<KnownCamera> {
    list()
}

/// Forgets one remembered camera (*Forget* on its card). The Windows Wi-Fi profile of a
/// SoftAP camera stays: Windows owns it, and *Pair again* rewrites it.
#[tauri::command]
pub fn forget_camera(id: String) -> Result<(), String> {
    let path = match id.as_str() {
        "desktop-lan" | "lan" => homewifi::lan_path(),
        "desktop-station" | "station" => homewifi::station_path(),
        "desktop-softap" | "softap" => homewifi::softap_path(),
        _ => return Err("That camera is not remembered on this PC.".into()),
    };
    homewifi::forget(&path);
    Ok(())
}

/// Whether something answers the camera's TCP 7001 at `host` within 900 ms (A1's
/// reachability dot; the web asks every 3 s while the home screen is up).
#[tauri::command]
pub async fn probe_camera(host: String) -> Result<bool, String> {
    let address = homewifi::parse_camera_address(&host).map_err(str::to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        let poke = SocketAddr::new(address.ip(), homewifi::PROBE_PORT);
        TcpStream::connect_timeout(&poke, Duration::from_millis(900)).is_ok()
    })
    .await
    .map_err(|error| error.to_string())
}

/// *Connect by address*: `host:port` for what the operator typed, or the copy for
/// something that is not an address.
#[tauri::command]
pub fn camera_address_check(text: String) -> Result<String, String> {
    homewifi::parse_camera_address(&text)
        .map(|address| address.to_string())
        .map_err(str::to_string)
}
