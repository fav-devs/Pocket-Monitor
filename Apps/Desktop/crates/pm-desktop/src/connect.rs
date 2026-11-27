//! Getting to a camera (`docs/desktop-expo-port.md` §1.C, A3): Bluetooth scan and
//! pairing, the camera's own Wi-Fi through a Windows WLAN profile, and the launch chain
//! that tries the remembered cameras in the old order before asking to pair.
//!
//! Ported from `opc-monitor`'s `ble_impl.rs`, the BLE worker in `connect.rs` and the
//! Wi-Fi join and launch chain in `main.rs`. Two things changed on purpose:
//!
//! - **No payloads in the log.** The old worker wrote every BLE frame and notification as
//!   hex to `opc-ble.log`, which put the camera's Wi-Fi password (`0x07/0x0E`) and the
//!   home network's (`0x07/0x47`) on disk. Only command ids and lengths are logged now.
//! - **The SoftAP password stays in the backend.** `ble_pair` keeps what the camera
//!   handed over and gives the web the network name only; `camera_open {kind: "paired"}`
//!   writes the Windows profile from it.
//!
//! Threads: one `pm-ble` thread owns the Bluetooth adapter (btleplug on its own small
//! runtime, as before) and runs one job at a time. Every Tauri command here is `async`
//! and waits off the main thread (§3.3 rule 1).

use std::collections::HashMap;
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use opc_camera::{
    pair_approval_ack, pair_set_pin, pair_wake_access_point, status_string, BleTransport,
    Discovered, DumlFrame, GattMap, NotificationAssembler,
};
use pm_controller::homewifi::{self, LanCamera, SavedCamera, SavedStation};
use pm_controller::link::log_line;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager as _};
use tokio::runtime::Runtime;
use uuid::Uuid;

use crate::camera::{CameraService, Target};
use crate::station::{self, Progress, CANCELLED};

fn ble_log(message: impl std::fmt::Display) {
    log_line("ble", message);
}

fn wifi_log(message: impl std::fmt::Display) {
    log_line("wifi", message);
}

// ── the btleplug transport ───────────────────────────────────────────────────────

/// btleplug behind the core's synchronous [`BleTransport`], on a runtime of its own.
pub struct BtleplugTransport {
    rt: Runtime,
    manager: Manager,
    /// Cached so `connect()` reuses the adapter whose peripheral cache the scan filled:
    /// a fresh `manager.adapters()` has an empty cache ("device not found").
    adapter: Option<Adapter>,
    found: HashMap<String, Peripheral>,
    peripheral: Option<Peripheral>,
    service_uuid: Uuid,
    write_uuid: Uuid,
    notify_uuid: Uuid,
    notifications: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl std::fmt::Debug for BtleplugTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BtleplugTransport").finish_non_exhaustive()
    }
}

/// A scan result with what the web shows beside it.
#[derive(Debug, Clone)]
pub struct Sighting {
    pub camera: Discovered,
    pub rssi: Option<i16>,
}

impl BtleplugTransport {
    pub fn new(gatt: &GattMap) -> io::Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("pm-ble-io")
            .enable_all()
            .build()?;
        let manager = rt
            .block_on(Manager::new())
            .map_err(|e| io::Error::other(e.to_string()))?;
        let parse = |s: &str| {
            s.parse::<Uuid>()
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))
        };
        Ok(Self {
            rt,
            manager,
            adapter: None,
            found: HashMap::new(),
            peripheral: None,
            service_uuid: parse(&gatt.service)?,
            write_uuid: parse(&gatt.write)?,
            notify_uuid: parse(&gatt.notify)?,
            notifications: Arc::new(Mutex::new(Vec::new())),
        })
    }

    fn get_adapter(&mut self) -> io::Result<Adapter> {
        if let Some(adapter) = self.adapter.clone() {
            return Ok(adapter);
        }
        let adapter = self.rt.block_on(async {
            self.manager
                .adapters()
                .await
                .map_err(|e| io::Error::other(e.to_string()))?
                .into_iter()
                .next()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no Bluetooth adapter"))
        })?;
        ble_log("adapter acquired");
        self.adapter = Some(adapter.clone());
        Ok(adapter)
    }

    fn peripherals_after(&mut self, seconds: f64) -> io::Result<Vec<Peripheral>> {
        let adapter = self.get_adapter()?;
        self.rt.block_on(async {
            // No service filter: WinRT often leaves the service out of the advert.
            adapter
                .start_scan(ScanFilter::default())
                .await
                .map_err(|e| io::Error::other(e.to_string()))?;
            tokio::time::sleep(Duration::from_secs_f64(seconds.max(3.0))).await;
            let _ = adapter.stop_scan().await;
            adapter
                .peripherals()
                .await
                .map_err(|e| io::Error::other(e.to_string()))
        })
    }

    /// Every advertiser the radio hears, one line each, for the headless harness.
    pub fn scan_all(&mut self, seconds: f64) -> io::Result<Vec<String>> {
        let mut lines = Vec::new();
        for p in self.peripherals_after(seconds)? {
            if let Ok(Some(props)) = self.rt.block_on(p.properties()) {
                lines.push(format!(
                    "{}  name={:?}  rssi={:?}  services={:?}  mfr={:?}",
                    p.id(),
                    props.local_name.unwrap_or_default(),
                    props.rssi,
                    props.services,
                    props.manufacturer_data.keys().collect::<Vec<_>>()
                ));
            }
        }
        Ok(lines)
    }

    /// The cameras in a scan window of at least 3 s (C1), with their signal.
    pub fn scan_sightings(&mut self, seconds: f64) -> io::Result<Vec<Sighting>> {
        let peripherals = self.peripherals_after(seconds)?;
        self.found.clear();
        let mut sightings = Vec::new();
        for p in peripherals {
            let Ok(Some(props)) = self.rt.block_on(p.properties()) else {
                continue;
            };
            let name = props.local_name.clone().unwrap_or_default();
            let lower = name.to_ascii_lowercase();
            let has_service = props.services.contains(&self.service_uuid);
            if !has_service && !lower.contains("pocket") && !lower.contains("osmo") {
                continue;
            }
            let model_id = props
                .manufacturer_data
                .values()
                .find_map(|payload| opc_camera::Advert::decode(payload).and_then(|a| a.model_id));
            let address = p.id().to_string();
            let name = if name.is_empty() {
                format!("Osmo Pocket ({address})")
            } else {
                name
            };
            self.found.insert(address.clone(), p);
            sightings.push(Sighting {
                camera: Discovered {
                    name,
                    address,
                    advert: Some(opc_camera::Advert {
                        model_id,
                        new_format: false,
                        raw_product_type: None,
                    }),
                },
                rssi: props.rssi,
            });
        }
        ble_log(format_args!("scan: {} cameras", sightings.len()));
        Ok(sightings)
    }
}

impl BleTransport for BtleplugTransport {
    fn scan(&mut self, seconds: f64) -> io::Result<Vec<Discovered>> {
        Ok(self
            .scan_sightings(seconds)?
            .into_iter()
            .map(|sighting| sighting.camera)
            .collect())
    }

    fn connect(&mut self, address: &str) -> io::Result<()> {
        let notify_uuid = self.notify_uuid;
        let write_uuid = self.write_uuid;
        ble_log("connect");
        let p = self.found.get(address).cloned().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "the camera is not in the last scan; scan again before connecting",
            )
        })?;
        self.rt.block_on(async {
            p.connect()
                .await
                .map_err(|e| io::Error::new(io::ErrorKind::ConnectionRefused, e.to_string()))?;
            p.discover_services()
                .await
                .map_err(|e| io::Error::other(e.to_string()))?;
            let chars = p.characteristics();
            let notify = chars
                .iter()
                .find(|c| c.uuid == notify_uuid)
                .cloned()
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        "the camera's notify characteristic is missing; is it in pairing mode?",
                    )
                })?;
            p.subscribe(&notify)
                .await
                .map_err(|e| io::Error::other(e.to_string()))?;
            // The Android app writes the CCCD on both characteristics before arming.
            if let Some(write) = chars.iter().find(|c| c.uuid == write_uuid) {
                if let Err(error) = p.subscribe(write).await {
                    ble_log(format_args!(
                        "write characteristic subscribe skipped: {error}"
                    ));
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            // Arm pairing: [01 00] to the notify characteristic itself, with response
            // (BleLink.kt maybeArmPairing). Without it the camera ignores SessionWake.
            p.write(&notify, &[0x01, 0x00], WriteType::WithResponse)
                .await
                .map_err(|e| io::Error::other(format!("pairing arm write failed: {e}")))?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            Ok::<(), io::Error>(())
        })?;
        let listener = p.clone();
        let buffer = Arc::clone(&self.notifications);
        self.rt.spawn(async move {
            use futures::StreamExt;
            match listener.notifications().await {
                Err(error) => ble_log(format_args!("notifications failed: {error}")),
                Ok(mut stream) => {
                    while let Some(notification) = stream.next().await {
                        if let Ok(mut locked) = buffer.lock() {
                            locked.push(notification.value);
                        }
                    }
                }
            }
        });
        self.peripheral = Some(p);
        ble_log("connected");
        Ok(())
    }

    fn write_frame(&mut self, frame: &[u8]) -> io::Result<()> {
        let Some(p) = self.peripheral.clone() else {
            return Err(io::Error::new(io::ErrorKind::NotConnected, "not connected"));
        };
        let write_uuid = self.write_uuid;
        let write = p
            .characteristics()
            .into_iter()
            .find(|c| c.uuid == write_uuid)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "write characteristic not found")
            })?;
        let frame = frame.to_vec();
        self.rt.block_on(async move {
            // Writes paced 120 ms apart, as the Android app queues them (C2).
            tokio::time::sleep(Duration::from_millis(120)).await;
            p.write(&write, &frame, WriteType::WithoutResponse)
                .await
                .map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, e.to_string()))
        })
    }

    fn take_notifications(&mut self) -> Vec<Vec<u8>> {
        self.notifications
            .lock()
            .map(|mut locked| std::mem::take(&mut *locked))
            .unwrap_or_default()
    }

    fn disconnect(&mut self) -> io::Result<()> {
        let Some(p) = self.peripheral.take() else {
            return Ok(());
        };
        ble_log("disconnect");
        self.rt.block_on(async move {
            p.disconnect()
                .await
                .map_err(|e| io::Error::other(e.to_string()))
        })
    }
}

// ── the pairing exchange (C2) ────────────────────────────────────────────────────

/// What a pair reads from the camera. Never logged, never sent to the web whole.
#[derive(Clone)]
pub struct Credentials {
    pub ssid: String,
    pub password: String,
    pub model_id: Option<i32>,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("ssid", &self.ssid)
            .field("password", &"<hidden>")
            .finish()
    }
}

/// Steps the exchange reports to the screen.
trait Steps {
    fn step(&mut self, phase: &'static str, label: &str);
    fn cancelled(&self) -> bool;
}

fn poll<T: BleTransport>(
    transport: &mut T,
    assembler: &mut NotificationAssembler,
    mut seen: impl FnMut(&DumlFrame, &mut T) -> bool,
) -> bool {
    let mut done = false;
    for raw in transport.take_notifications() {
        for frame in assembler.append(&raw) {
            // The command and the size only: replies here carry the Wi-Fi password.
            ble_log(format_args!(
                "reply {:02x}/{:02x} len={}",
                frame.cmd_set,
                frame.cmd_id,
                frame.payload.len()
            ));
            if seen(&frame, transport) {
                done = true;
            }
        }
    }
    done
}

/// Wake (fire and forget), PIN, the operator's approval, wake AP, SSID, password, with
/// the old deadlines: PIN 90 s, AP 5 s, SSID 10 s, password 10 s.
fn pair_exchange<T: BleTransport>(
    transport: &mut T,
    steps: &mut dyn Steps,
) -> Result<(String, String), String> {
    let mut assembler = NotificationAssembler::new();
    let write =
        |transport: &mut T, frame: Result<Vec<u8>, String>, what: &str| -> Result<(), String> {
            let frame = frame?;
            transport
                .write_frame(&frame)
                .map_err(|error| format!("{what}: {error}"))
        };

    steps.step("bluetooth", "Opening session…");
    write(
        transport,
        opc_camera::Command::SessionWake
            .encode(0x802B)
            .map_err(|e| e.to_string()),
        "Wake",
    )?;
    write(
        transport,
        pair_set_pin("0000", Some("osmo")).map_err(|e| e.to_string()),
        "SetPin",
    )?;

    steps.step("bluetooth", "Authenticating…");
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut refused = false;
    let mut approval = false;
    loop {
        if steps.cancelled() {
            return Err(CANCELLED.into());
        }
        if Instant::now() > deadline {
            return Err("Pairing timed out. Hold the camera closer and try again.".into());
        }
        let accepted = poll(transport, &mut assembler, |frame, transport| {
            match (frame.cmd_set, frame.cmd_id) {
                (0x07, 0x45) => match frame.payload.get(1) {
                    Some(0x01) => true,
                    Some(0x02) => {
                        approval = true;
                        false
                    }
                    _ => {
                        refused = true;
                        false
                    }
                },
                (0x07, 0x46) => {
                    if let Ok(ack) = pair_approval_ack(frame.seq) {
                        if let Err(error) = transport.write_frame(&ack) {
                            ble_log(format_args!("approval ack failed: {error}"));
                        }
                    }
                    true
                }
                _ => false,
            }
        });
        if refused {
            return Err("Camera refused the pairing request.".into());
        }
        if accepted {
            break;
        }
        if approval {
            approval = false;
            steps.step(
                "authorizing",
                "Press the pairing button on the camera body.",
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    steps.step("wifi-handoff", "Waking camera Wi-Fi…");
    std::thread::sleep(Duration::from_millis(200));
    if let Ok(frame) = pair_wake_access_point() {
        if let Err(error) = transport.write_frame(&frame) {
            ble_log(format_args!("wake AP write failed: {error}"));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if steps.cancelled() {
            return Err(CANCELLED.into());
        }
        if poll(transport, &mut assembler, |f, _| {
            f.cmd_set == 0x53 && f.cmd_id == 0x10
        }) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(600));

    let mut read_string = |transport: &mut T,
                           steps: &mut dyn Steps,
                           label: &str,
                           command: opc_camera::Command,
                           seq: u16,
                           id: u8|
     -> Result<String, String> {
        steps.step("wifi-handoff", label);
        write(
            transport,
            command.encode(seq).map_err(|e| e.to_string()),
            label,
        )?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut value = String::new();
        while Instant::now() < deadline && value.is_empty() {
            if steps.cancelled() {
                return Err(CANCELLED.into());
            }
            poll(transport, &mut assembler, |f, _| {
                if f.cmd_set == 0x07 && f.cmd_id == id {
                    if let Ok(text) = status_string(&f.payload) {
                        if !text.is_empty() {
                            value = text;
                            return true;
                        }
                    }
                }
                false
            });
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(value)
    };
    let ssid = read_string(
        transport,
        steps,
        "Reading Wi-Fi name…",
        opc_camera::Command::GetWifiSsid,
        0x8007,
        0x07,
    )?;
    if ssid.is_empty() {
        return Err("Camera did not return a Wi-Fi name.".into());
    }
    let password = read_string(
        transport,
        steps,
        "Reading password…",
        opc_camera::Command::GetWifiPassword,
        0x800E,
        0x0E,
    )?;
    if password.is_empty() {
        return Err("Camera did not return a Wi-Fi password.".into());
    }
    ble_log("pair: done");
    Ok((ssid, password))
}

// ── the Bluetooth service ────────────────────────────────────────────────────────

/// `ble://adverts`: one camera the scan heard (the mobile `DiscoveredCamera` fields).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advert {
    pub id: String,
    pub name: String,
    pub model_id: Option<i32>,
    pub rssi: i16,
    pub pairable: bool,
}

/// `pair://step` and `station://step`: a phase in the mobile `ConnectionPhase` words.
#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub phase: &'static str,
    pub detail: String,
}

/// What `ble_pair` gives the web: the network name, never the password.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub ssid: String,
    pub model_id: Option<i32>,
}

/// What `station_join` gives the web.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationReady {
    pub host: String,
    pub model_id: Option<i32>,
    /// False when the camera's join reply never came and only the search found it.
    pub confirmed: bool,
}

type Reply<T> = Sender<Result<T, String>>;

enum Job {
    Scan,
    Pair {
        address: String,
        model_id: Option<i32>,
        reply: Reply<Credentials>,
    },
    Station {
        address: String,
        ssid: String,
        password: String,
        model_id: Option<i32>,
        reply: Reply<(Vec<u8>, bool)>,
    },
    Reset {
        address: String,
        reply: Reply<()>,
    },
}

/// The Bluetooth adapter's thread and what the last pair read.
pub struct BleService {
    jobs: Mutex<Option<Sender<Job>>>,
    scanning: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    /// A job other than a scan is waiting: the scan loop gives way.
    waiting: Arc<AtomicBool>,
    held: Mutex<Option<Credentials>>,
    /// Model ids the last scans saw, by address, for the pair that follows.
    models: Arc<Mutex<HashMap<String, Option<i32>>>>,
    app: AppHandle,
}

impl std::fmt::Debug for BleService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BleService").finish_non_exhaustive()
    }
}

struct EmitSteps<'a> {
    app: &'a AppHandle,
    event: &'static str,
    cancel: &'a AtomicBool,
}

impl Steps for EmitSteps<'_> {
    fn step(&mut self, phase: &'static str, label: &str) {
        let _ = self.app.emit(
            self.event,
            Step {
                phase,
                detail: label.to_string(),
            },
        );
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

impl Progress for EmitSteps<'_> {
    fn step(&mut self, label: &str) {
        Steps::step(self, "bluetooth", label);
    }

    fn awaiting_approval(&mut self) {
        Steps::step(
            self,
            "authorizing",
            "Press the pairing button on the camera body.",
        );
    }

    fn cancelled(&mut self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

impl BleService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            jobs: Mutex::new(None),
            scanning: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
            waiting: Arc::new(AtomicBool::new(false)),
            held: Mutex::new(None),
            models: Arc::new(Mutex::new(HashMap::new())),
            app,
        }
    }

    /// Starts the adapter thread on first use; Bluetooth is not touched before.
    fn send(&self, job: Job) -> Result<(), String> {
        let mut slot = self
            .jobs
            .lock()
            .map_err(|_| "Bluetooth is busy".to_string())?;
        if slot.is_none() {
            let (tx, rx) = channel();
            let app = self.app.clone();
            let scanning = self.scanning.clone();
            let cancel = self.cancel.clone();
            let waiting = self.waiting.clone();
            let models = self.models.clone();
            std::thread::Builder::new()
                .name("pm-ble".to_string())
                .spawn(move || worker(&app, &rx, &scanning, &cancel, &waiting, &models))
                .map_err(|error| error.to_string())?;
            *slot = Some(tx);
        }
        if !matches!(job, Job::Scan) {
            self.waiting.store(true, Ordering::Relaxed);
            self.cancel.store(false, Ordering::Relaxed);
        }
        slot.as_ref()
            .map(|tx| tx.send(job))
            .transpose()
            .map_err(|_| "Bluetooth stopped".to_string())?;
        Ok(())
    }

    pub fn scan_start(&self) -> Result<(), String> {
        if !self.scanning.swap(true, Ordering::Relaxed) {
            self.send(Job::Scan)?;
        }
        Ok(())
    }

    pub fn scan_stop(&self) {
        self.scanning.store(false, Ordering::Relaxed);
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    fn model_for(&self, address: &str) -> Option<i32> {
        self.models
            .lock()
            .ok()
            .and_then(|models| models.get(address).copied().flatten())
    }

    /// Runs a job and waits for its answer on a blocking thread.
    async fn ask<T: Send + 'static>(
        &self,
        make: impl FnOnce(Reply<T>) -> Job,
    ) -> Result<T, String> {
        let (tx, rx) = channel();
        self.send(make(tx))?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv()
                .unwrap_or_else(|_| Err("Bluetooth stopped".to_string()))
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub fn forget_held(&self) {
        if let Ok(mut held) = self.held.lock() {
            *held = None;
        }
    }

    pub fn take_held(&self, ssid: Option<&str>) -> Option<Credentials> {
        let held = self.held.lock().ok()?.clone()?;
        match ssid {
            Some(ssid) if ssid != held.ssid => None,
            _ => Some(held),
        }
    }
}

fn worker(
    app: &AppHandle,
    jobs: &Receiver<Job>,
    scanning: &AtomicBool,
    cancel: &AtomicBool,
    waiting: &AtomicBool,
    models: &Mutex<HashMap<String, Option<i32>>>,
) {
    let refuse = |message: String| {
        ble_log(format_args!("unavailable: {message}"));
        let _ = app.emit("ble://state", serde_json::json!({ "error": message }));
        message
    };
    let mut transport = match GattMap::from_core()
        .ok_or_else(|| "Cannot read the Bluetooth map from the core.".to_string())
        .and_then(|gatt| {
            BtleplugTransport::new(&gatt).map_err(|error| format!("Bluetooth unavailable: {error}"))
        }) {
        Ok(transport) => Some(transport),
        Err(message) => {
            refuse(message);
            None
        }
    };
    while let Ok(job) = jobs.recv() {
        let Some(transport) = transport.as_mut() else {
            let message = "Bluetooth is not available on this PC.".to_string();
            match job {
                Job::Scan => scanning.store(false, Ordering::Relaxed),
                Job::Pair { reply, .. } => drop(reply.send(Err(message))),
                Job::Station { reply, .. } => drop(reply.send(Err(message))),
                Job::Reset { reply, .. } => drop(reply.send(Err(message))),
            }
            continue;
        };
        match job {
            Job::Scan => {
                let _ = app.emit("ble://state", serde_json::json!({ "scanning": true }));
                while scanning.load(Ordering::Relaxed) && !waiting.load(Ordering::Relaxed) {
                    match transport.scan_sightings(3.0) {
                        Ok(sightings) => {
                            let adverts: Vec<Advert> = sightings
                                .iter()
                                .map(|s| Advert {
                                    id: s.camera.address.clone(),
                                    name: s.camera.name.clone(),
                                    model_id: s.camera.advert.as_ref().and_then(|a| a.model_id),
                                    rssi: s.rssi.unwrap_or(-70),
                                    pairable: true,
                                })
                                .collect();
                            if let Ok(mut models) = models.lock() {
                                for advert in &adverts {
                                    models.insert(advert.id.clone(), advert.model_id);
                                }
                            }
                            let _ = app.emit("ble://adverts", adverts);
                        }
                        Err(error) => {
                            let _ = app.emit(
                                "ble://state",
                                serde_json::json!({ "error": format!("Scan failed: {error}") }),
                            );
                            std::thread::sleep(Duration::from_secs(2));
                        }
                    }
                }
                // A pair that interrupted the scan resumes it afterwards.
                let resume = scanning.load(Ordering::Relaxed);
                let _ = app.emit("ble://state", serde_json::json!({ "scanning": false }));
                if !resume {
                    continue;
                }
            }
            Job::Pair {
                address,
                model_id,
                reply,
            } => {
                waiting.store(false, Ordering::Relaxed);
                let mut steps = EmitSteps {
                    app,
                    event: "pair://step",
                    cancel,
                };
                Steps::step(&mut steps, "bluetooth", "Connecting…");
                let result = transport
                    .connect(&address)
                    .map_err(|error| format!("Connect failed: {error}"))
                    .and_then(|()| pair_exchange(transport, &mut steps));
                let _ = transport.disconnect();
                let _ = reply.send(result.map(|(ssid, password)| Credentials {
                    ssid,
                    password,
                    model_id,
                }));
            }
            Job::Station {
                address,
                ssid,
                password,
                model_id,
                reply,
            } => {
                waiting.store(false, Ordering::Relaxed);
                let mut steps = EmitSteps {
                    app,
                    event: "station://step",
                    cancel,
                };
                let result =
                    station::provision(transport, &address, &ssid, &password, model_id, &mut steps);
                let _ = reply.send(result);
            }
            Job::Reset { address, reply } => {
                waiting.store(false, Ordering::Relaxed);
                let mut steps = EmitSteps {
                    app,
                    event: "station://step",
                    cancel,
                };
                let _ = reply.send(station::reset(transport, &address, &mut steps));
            }
        }
        if scanning.load(Ordering::Relaxed) && !waiting.load(Ordering::Relaxed) {
            // Go back to scanning while the screen still wants it.
            if let Some(tx) = app
                .try_state::<BleService>()
                .and_then(|s| s.jobs.lock().ok()?.clone())
            {
                let _ = tx.send(Job::Scan);
            }
        }
    }
}

// ── the camera's own Wi-Fi (C4, C5) ─────────────────────────────────────────────

/// A saved-profile reconnect is the fast path, not a reason to make an operator stare
/// at a blank screen while Windows waits through its full WLAN timeout.
#[cfg(target_os = "windows")]
const SAVED_WIFI_FAST_PATH: Duration = Duration::from_secs(12);

/// Joins the camera SoftAP with its password: a manual WLAN profile (`user=current`)
/// from a short-lived file that is deleted at once, then the saved-profile path. The
/// password exists only in that file and is never logged.
#[cfg(target_os = "windows")]
pub fn join_camera_wifi(ssid: &str, password: &str) -> Result<(), String> {
    use pm_controller::platform::background_command;
    let profile =
        std::env::temp_dir().join(format!("pocket-monitor-wifi-{}.xml", std::process::id()));
    std::fs::write(&profile, opc_camera::wifi::profile_xml(ssid, password))
        .map_err(|error| format!("could not prepare the camera Wi-Fi profile: {error}"))?;
    let add = background_command("netsh")
        .args(["wlan", "add", "profile"])
        .arg(format!("filename={}", profile.display()))
        .arg("user=current")
        .status();
    let _ = std::fs::remove_file(&profile);
    match add {
        Ok(status) if status.success() => {}
        Ok(status) => {
            return Err(format!(
                "Windows could not save the camera Wi-Fi profile (netsh exit {status})"
            ))
        }
        Err(error) => return Err(format!("could not start Windows Wi-Fi service: {error}")),
    }
    join_saved_camera_wifi(ssid)
}

/// Connects with the protected Windows profile the first pair installed: no password,
/// and deliberately the normal reconnect path. Polls `ipconfig` every 500 ms for a
/// `192.168.2.x` address, for at most 12 s.
#[cfg(target_os = "windows")]
pub fn join_saved_camera_wifi(ssid: &str) -> Result<(), String> {
    use pm_controller::platform::background_command;
    let profiles = background_command("netsh")
        .args(["wlan", "show", "profiles"])
        .output()
        .map_err(|error| format!("could not inspect Windows Wi-Fi profiles: {error}"))?;
    if !profiles.status.success()
        || !homewifi::profile_listed(&String::from_utf8_lossy(&profiles.stdout), ssid)
    {
        return Err(format!("no saved Windows Wi-Fi profile for {ssid}"));
    }
    wifi_log("requesting connection to the saved camera network");
    let retry_pause =
        Duration::from_secs_f64(opc_camera::wifi::JoinTiming::from_core().retry_pause);
    let started = Instant::now();
    let mut next_attempt = Instant::now();
    while started.elapsed() < SAVED_WIFI_FAST_PATH {
        if Instant::now() >= next_attempt {
            match background_command("netsh")
                .args(["wlan", "connect"])
                .arg(format!("name={ssid}"))
                .arg(format!("ssid={ssid}"))
                .status()
            {
                Ok(status) if status.success() => {
                    wifi_log("Windows accepted the camera Wi-Fi connection request")
                }
                Ok(status) => wifi_log(format_args!(
                    "Windows Wi-Fi connection request exited {status}"
                )),
                Err(error) => wifi_log(format_args!(
                    "could not request Windows Wi-Fi connection: {error}"
                )),
            }
            next_attempt = Instant::now() + retry_pause;
        }
        if let Ok(output) = background_command("ipconfig").output() {
            if homewifi::on_camera_subnet(&String::from_utf8_lossy(&output.stdout)) {
                wifi_log("camera subnet is ready");
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    wifi_log("timed out waiting for a camera DHCP address");
    Err("Windows did not receive an address from the saved camera Wi-Fi within 12 seconds.".into())
}

#[cfg(not(target_os = "windows"))]
pub fn join_camera_wifi(_ssid: &str, _password: &str) -> Result<(), String> {
    Err(
        "Joining the camera's Wi-Fi from the app is Windows only. Join it in the system's \
         Wi-Fi menu, then choose Already on camera Wi-Fi."
            .into(),
    )
}

#[cfg(not(target_os = "windows"))]
pub fn join_saved_camera_wifi(_ssid: &str) -> Result<(), String> {
    Err(
        "Joining the camera's Wi-Fi from the app is Windows only. Join it in the system's \
         Wi-Fi menu, then choose Already on camera Wi-Fi."
            .into(),
    )
}

// ── opening a camera (A3, B1, D-5) ──────────────────────────────────────────────

/// Where `camera_open` should go.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenTarget {
    /// The launch chain: the LAN camera, the saved station, the saved SoftAP profile,
    /// then pairing. `setup` skips all of them.
    Auto {
        #[serde(default)]
        model: Option<i32>,
        #[serde(default)]
        setup: bool,
    },
    /// *Connect by address* or `--camera`. A LAN address is remembered.
    Address {
        host: String,
        #[serde(default)]
        model: Option<i32>,
    },
    /// The camera remembered by address.
    Lan,
    /// The camera on the saved home network: search, then open.
    Station,
    /// The camera's own Wi-Fi through its saved profile.
    Softap {
        #[serde(default)]
        ssid: Option<String>,
        #[serde(default)]
        model: Option<i32>,
    },
    /// Right after `ble_pair`: write the profile from what it read, join, remember.
    Paired {
        #[serde(default)]
        model: Option<i32>,
    },
    /// *Already on camera Wi-Fi*: no Bluetooth, no Wi-Fi change (C3).
    Direct {
        #[serde(default)]
        model: Option<i32>,
    },
}

/// What `camera_open` did.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// The link is opening (the camera state takes over from here).
    pub connected: bool,
    pub host: Option<String>,
    pub model_id: Option<i32>,
    /// Nothing remembered answered: the web goes to pairing.
    pub pair: bool,
}

fn step(app: &AppHandle, phase: &'static str, detail: impl Into<String>) {
    let _ = app.emit(
        "pair://step",
        Step {
            phase,
            detail: detail.into(),
        },
    );
}

fn connect_at(app: &AppHandle, address: SocketAddr, model: Option<i32>) -> Result<Opened, String> {
    let camera = app.state::<CameraService>();
    camera.connect(Target {
        host: Some(address.to_string()),
        model,
    })?;
    Ok(Opened {
        connected: true,
        host: Some(address.to_string()),
        model_id: model,
        pair: false,
    })
}

fn answers(address: SocketAddr, timeout: Duration) -> bool {
    let poke = SocketAddr::new(address.ip(), homewifi::PROBE_PORT);
    TcpStream::connect_timeout(&poke, timeout).is_ok()
}

/// Blocking: the chain and the joins take seconds. Called on the blocking pool.
pub fn open(app: &AppHandle, target: OpenTarget) -> Result<Opened, String> {
    match target {
        OpenTarget::Address { host, model } => {
            let address = homewifi::parse_camera_address(&host).map_err(str::to_string)?;
            if let Some(mut lan) = homewifi::remembers_as_lan(address) {
                lan.model_id = model;
                if let Err(error) = homewifi::save_lan(&lan) {
                    wifi_log(format_args!(
                        "could not remember the camera address: {error}"
                    ));
                }
            }
            step(app, "datalink", format!("Linking {address}…"));
            connect_at(app, address, model)
        }
        OpenTarget::Lan => {
            let lan = homewifi::load_lan().ok_or("That camera is no longer remembered.")?;
            connect_at(app, lan.address(), lan.model_id)
        }
        OpenTarget::Station => {
            step(app, "joining-wifi", "Finding the camera on your Wi-Fi…");
            let (address, model) = station::find_saved()?;
            connect_at(app, address, model)
        }
        OpenTarget::Softap { ssid, model } => {
            let saved = homewifi::load_softap();
            let ssid = ssid
                .filter(|s| !s.is_empty())
                .or_else(|| saved.as_ref().map(|s| s.ssid.clone()))
                .ok_or("That camera is no longer remembered.")?;
            step(app, "joining-wifi", format!("Joining {ssid}…"));
            join_saved_camera_wifi(&ssid)
                .map_err(|error| format!("Couldn't join the camera's Wi-Fi: {error}"))?;
            let model = model.or_else(|| saved.and_then(|s| s.model_id));
            connect_at(app, homewifi::softap_address(), model)
        }
        OpenTarget::Paired { model } => {
            let held = app
                .state::<BleService>()
                .take_held(None)
                .ok_or("Pair the camera first.")?;
            step(app, "joining-wifi", format!("Joining {}…", held.ssid));
            join_camera_wifi(&held.ssid, &held.password)?;
            // Windows holds the password in its profile now; the backend lets go of it.
            app.state::<BleService>().forget_held();
            let model = model.or(held.model_id);
            homewifi::save_softap(&SavedCamera {
                ssid: held.ssid.clone(),
                model_id: model,
            })?;
            connect_at(app, homewifi::softap_address(), model)
        }
        OpenTarget::Direct { model } => {
            let model = model.or_else(|| homewifi::load_softap().and_then(|s| s.model_id));
            connect_at(app, homewifi::softap_address(), model)
        }
        OpenTarget::Auto { model, setup } => {
            if setup {
                return Ok(Opened {
                    pair: true,
                    ..Opened::default()
                });
            }
            // A camera on the operator's own network first: no Wi-Fi change, no BLE.
            if let Some(lan) = homewifi::load_lan() {
                step(
                    app,
                    "datalink",
                    format!("Looking for the camera at {}…", lan.ip),
                );
                if answers(lan.address(), Duration::from_millis(1500)) {
                    wifi_log(format_args!("remembered camera answers at {}", lan.ip));
                    return connect_at(app, lan.address(), lan.model_id.or(model));
                }
                wifi_log("remembered camera address did not answer");
            }
            if homewifi::load_station().is_some() {
                step(app, "joining-wifi", "Finding the camera on your Wi-Fi…");
                match station::find_saved() {
                    Ok((address, saved_model)) => {
                        return connect_at(app, address, saved_model.or(model))
                    }
                    Err(_) => wifi_log("camera not on the home network; trying its own Wi-Fi"),
                }
            }
            // The first pair's manual WLAN profile is all Windows needs from now on.
            if let Some(saved) = homewifi::load_softap() {
                step(app, "joining-wifi", format!("Joining {}…", saved.ssid));
                match join_saved_camera_wifi(&saved.ssid) {
                    Ok(()) => {
                        return connect_at(
                            app,
                            homewifi::softap_address(),
                            saved.model_id.or(model),
                        )
                    }
                    Err(error) => wifi_log(format_args!(
                        "saved camera Wi-Fi join unavailable; opening pair flow: {error}"
                    )),
                }
            }
            Ok(Opened {
                pair: true,
                ..Opened::default()
            })
        }
    }
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| error.to_string())?
}

// ── commands ─────────────────────────────────────────────────────────────────────

/// Starts scanning in ≥ 3 s windows; each window's cameras arrive as `ble://adverts`.
#[tauri::command]
pub fn ble_scan_start(ble: tauri::State<'_, BleService>) -> Result<(), String> {
    ble.scan_start()
}

#[tauri::command]
pub fn ble_scan_stop(ble: tauri::State<'_, BleService>) {
    ble.scan_stop();
}

/// Pairs over Bluetooth (C2). Steps arrive as `pair://step`. The password the camera
/// hands over is kept here for `camera_open {kind: "paired"}`.
#[tauri::command]
pub async fn ble_pair(
    app: AppHandle,
    address: String,
    model: Option<i32>,
) -> Result<Paired, String> {
    let ble = app.state::<BleService>();
    let model = model.or_else(|| ble.model_for(&address));
    let held = ble
        .ask(|reply| Job::Pair {
            address,
            model_id: model,
            reply,
        })
        .await?;
    let paired = Paired {
        ssid: held.ssid.clone(),
        model_id: held.model_id,
    };
    if let Ok(mut slot) = ble.held.lock() {
        *slot = Some(held);
    }
    Ok(paired)
}

/// Stops whatever Bluetooth exchange is running; it answers `cancelled`.
#[tauri::command]
pub fn ble_cancel(ble: tauri::State<'_, BleService>) {
    ble.cancel();
}

/// Joins a camera's own Wi-Fi with a password (the one `ble_pair` read when none is
/// given) and remembers it (C4, C5). Never logs the password.
#[tauri::command]
pub async fn wifi_join_camera(
    app: AppHandle,
    ssid: Option<String>,
    password: Option<String>,
    model: Option<i32>,
) -> Result<(), String> {
    let held = app.state::<BleService>().take_held(ssid.as_deref());
    let joined = blocking(move || {
        let (ssid, password, held_model) = match (ssid, password) {
            (Some(ssid), Some(password)) => (ssid, password, None),
            _ => {
                let held = held.ok_or("Pair the camera first.")?;
                (held.ssid, held.password, held.model_id)
            }
        };
        join_camera_wifi(&ssid, &password)?;
        homewifi::save_softap(&SavedCamera {
            ssid,
            model_id: model.or(held_model),
        })
    })
    .await;
    if joined.is_ok() {
        app.state::<BleService>().forget_held();
    }
    joined
}

/// Joins the remembered camera's own Wi-Fi through its saved profile (12 s fast path).
#[tauri::command]
pub async fn wifi_join_saved(ssid: Option<String>) -> Result<(), String> {
    blocking(move || {
        let ssid = ssid
            .filter(|s| !s.is_empty())
            .or_else(|| homewifi::load_softap().map(|s| s.ssid))
            .ok_or("No camera Wi-Fi is remembered.")?;
        join_saved_camera_wifi(&ssid)
    })
    .await
}

/// Opens a camera: a remembered one, an address, the launch chain or the camera just
/// paired. The link's own state follows on `camera://state`.
#[tauri::command]
pub async fn camera_open(app: AppHandle, target: OpenTarget) -> Result<Opened, String> {
    let handle = app.clone();
    let result = blocking(move || open(&handle, target)).await;
    if let Err(error) = &result {
        step(&app, "failed", error.clone());
    }
    result
}

/// Puts the camera on the operator's Wi-Fi over Bluetooth, finds it there and remembers
/// it (D-1, D-2, D-3). The password goes to the camera only.
#[tauri::command]
pub async fn station_join(
    app: AppHandle,
    address: String,
    ssid: String,
    password: String,
    model: Option<i32>,
) -> Result<StationReady, String> {
    let ble = app.state::<BleService>();
    let ssid = ssid.trim().to_string();
    if ssid.is_empty() {
        return Err("Type the network's name.".into());
    }
    let model = model.or_else(|| ble.model_for(&address));
    let (identity, confirmed) = ble
        .ask(|reply| Job::Station {
            address,
            ssid: ssid.clone(),
            password,
            model_id: model,
            reply,
        })
        .await?;
    if !confirmed {
        log_line(
            "station",
            "the camera did not confirm the join; searching anyway",
        );
    }
    let _ = app.emit(
        "station://step",
        Step {
            phase: "joining-wifi",
            detail: "Finding the camera on your Wi-Fi…".into(),
        },
    );
    blocking(move || {
        let address = station::find_camera(&identity, None).ok_or(station::NOT_FOUND)?;
        let mut saved = SavedStation {
            ssid,
            identity,
            address: None,
            model_id: model,
        };
        if let std::net::IpAddr::V4(v4) = address.ip() {
            saved.address = Some(v4);
        }
        homewifi::save_station(&saved)?;
        Ok(StationReady {
            host: address.to_string(),
            model_id: model,
            confirmed,
        })
    })
    .await
}

/// Returns the camera to its own Wi-Fi and forgets the home network (D-4).
#[tauri::command]
pub async fn station_reset(app: AppHandle, address: String) -> Result<(), String> {
    app.state::<BleService>()
        .ask(|reply| Job::Reset { address, reply })
        .await
}

/// Looks for the remembered station camera on this PC's networks (D-2, D-3).
#[tauri::command]
pub async fn station_find() -> Result<String, String> {
    blocking(|| station::find_saved().map(|(address, _)| address.to_string())).await
}

/// The Wi-Fi this PC is on, to prefill *Put the camera on my Wi-Fi*.
#[tauri::command]
pub async fn station_current_ssid() -> Result<Option<String>, String> {
    blocking(|| Ok(station::current_ssid())).await
}

/// Remembers `address` as the LAN camera when it is one (B1).
pub fn remember_command_line_camera(text: &str, model: Option<i32>) {
    if let Ok(address) = homewifi::parse_camera_address(text) {
        if let Some(lan) = homewifi::remembers_as_lan(address) {
            let _ = homewifi::save_lan(&LanCamera {
                model_id: model,
                ..lan
            });
        }
    }
}

// ── headless (B5) ────────────────────────────────────────────────────────────────

struct PrintSteps;

impl Steps for PrintSteps {
    fn step(&mut self, phase: &'static str, label: &str) {
        println!("step: {phase}: {label}");
    }

    fn cancelled(&self) -> bool {
        false
    }
}

impl Progress for PrintSteps {
    fn step(&mut self, label: &str) {
        println!("step: {label}");
    }

    fn awaiting_approval(&mut self) {
        println!("step: press the pairing button on the camera body");
    }

    fn cancelled(&mut self) -> bool {
        false
    }
}

/// `pocket-monitor headless scan [--seconds N] | pair | station --ssid NAME`: Bluetooth
/// from a terminal, every step printed, no window. `station` reads the network password
/// from `PM_WIFI_PASSWORD` (or `OPC_WIFI_PASSWORD`). Credentials are never printed.
pub fn headless(args: &[String]) -> Result<(), String> {
    let gatt = GattMap::from_core().ok_or("Cannot read GATT map from core.")?;
    let flag = |name: &str| pm_controller::launch::flag(args, name).map(str::to_string);
    let seconds: f64 = flag("seconds").and_then(|s| s.parse().ok()).unwrap_or(8.0);
    let mut transport = BtleplugTransport::new(&gatt).map_err(|e| e.to_string())?;
    match args.first().map(String::as_str) {
        Some("scan") => {
            println!("scanning every BLE advertiser for {seconds}s…");
            let lines = transport.scan_all(seconds).map_err(|e| e.to_string())?;
            println!("{} advertisers heard", lines.len());
            for line in lines {
                println!("  {line}");
            }
            Ok(())
        }
        Some(mode @ ("pair" | "station")) => {
            let ssid = flag("ssid");
            if mode == "station" && ssid.is_none() {
                return Err("station needs --ssid".into());
            }
            let found = transport.scan_sightings(5.0).map_err(|e| e.to_string())?;
            let first = found.into_iter().next().ok_or("no camera advertising")?;
            println!("camera: {} @ {}", first.camera.name, first.camera.address);
            let model = first.camera.advert.as_ref().and_then(|a| a.model_id);
            if mode == "pair" {
                transport
                    .connect(&first.camera.address)
                    .map_err(|e| format!("Connect failed: {e}"))?;
                let result = pair_exchange(&mut transport, &mut PrintSteps);
                let _ = transport.disconnect();
                result?;
                println!("pairing worked (credentials read; not printed)");
                Ok(())
            } else {
                let password = pm_controller::platform::env_var("WIFI_PASSWORD")
                    .ok_or_else(|| "set PM_WIFI_PASSWORD".to_string())?;
                let ssid = ssid.unwrap_or_default();
                let (identity, confirmed) = station::provision(
                    &mut transport,
                    &first.camera.address,
                    &ssid,
                    &password,
                    model,
                    &mut PrintSteps,
                )?;
                println!("station done; confirmed={confirmed}; searching the LAN…");
                let address =
                    station::find_camera(&identity, None).ok_or("camera not found on the LAN")?;
                println!("FOUND camera on the LAN at {address}");
                Ok(())
            }
        }
        _ => Err(
            "usage: pocket-monitor headless scan [--seconds N] | pair | station --ssid NAME".into(),
        ),
    }
}
