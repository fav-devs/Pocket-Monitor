//! btleplug implementation of [`BleTransport`].
//!
//! Wraps the async btleplug API in a synchronous shell using a dedicated Tokio runtime.
//! Notifications are buffered in a shared Vec so `take_notifications` can drain them
//! without a runtime context.

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use tokio::runtime::Runtime;
use uuid::Uuid;

use opc_camera::{BleTransport, Discovered, GattMap};

// ── simple file logger ────────────────────────────────────────────────────────

type Log = Arc<Mutex<Option<std::fs::File>>>;

pub(crate) fn log_path() -> Option<std::path::PathBuf> {
    // Writing inside a signed .app invalidates its resource seal and can prevent
    // macOS from granting the app Bluetooth access.
    #[cfg(target_os = "macos")]
    {
        opc_monitor::logfile::path().map(|path| path.with_file_name("opc-ble.log"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("opc-ble.log")))
    }
}

fn open_log() -> Log {
    let file = log_path().and_then(|p| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .ok()
    });
    Arc::new(Mutex::new(file))
}

macro_rules! blog {
    ($log:expr, $($t:tt)*) => {
        if let Ok(mut guard) = $log.lock() {
            if let Some(ref mut f) = *guard {
                let _ = writeln!(f, $($t)*);
                let _ = f.flush();
            }
        }
    };
}

// ── transport ─────────────────────────────────────────────────────────────────

pub struct BtleplugTransport {
    rt: Runtime,
    manager: Manager,
    /// Cached so `connect()` reuses the same adapter instance.
    /// A fresh `manager.adapters()` call returns a new object with an empty peripheral
    /// cache — that's what caused "device not found" on connect.
    adapter: Option<Adapter>,
    /// Peripherals discovered in the last scan, keyed by their id string.
    found: HashMap<String, Peripheral>,
    peripheral: Option<Peripheral>,
    service_uuid: Uuid,
    write_uuid: Uuid,
    notify_uuid: Uuid,
    notifications: Arc<Mutex<Vec<Vec<u8>>>>,
    log: Log,
}

impl BtleplugTransport {
    pub fn new(gatt: &GattMap) -> io::Result<Self> {
        let rt = Runtime::new().map_err(io_err)?;
        let manager = rt
            .block_on(Manager::new())
            .map_err(|e| io::Error::other(e.to_string()))?;

        let parse = |s: &str| {
            s.parse::<Uuid>()
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))
        };

        let log = open_log();
        blog!(
            log,
            "BtleplugTransport::new  service={} write={} notify={}",
            gatt.service,
            gatt.write,
            gatt.notify
        );

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
            log,
        })
    }

    fn get_adapter(&mut self) -> io::Result<Adapter> {
        if let Some(a) = self.adapter.clone() {
            return Ok(a);
        }
        let adapter = self.rt.block_on(async {
            let adapters = self
                .manager
                .adapters()
                .await
                .map_err(|e| io::Error::other(e.to_string()))?;
            adapters
                .into_iter()
                .next()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no Bluetooth adapter"))
        })?;
        blog!(self.log, "adapter acquired");
        self.adapter = Some(adapter.clone());
        Ok(adapter)
    }
}

impl BtleplugTransport {
    /// CoreBluetooth can deliver its first state update before the radio is ready.
    /// btleplug queues start_scan successfully even when macOS rejects that scan.
    #[cfg(target_os = "macos")]
    fn wait_for_bluetooth(&self, adapter: &Adapter) -> io::Result<()> {
        use btleplug::api::CentralState;
        use objc2_core_bluetooth::{
            CBCentralManager, CBManager, CBManagerAuthorization, CBManagerState,
        };

        // A state-only observer preserves the native failure reason that btleplug
        // maps to Unknown. It never scans, connects, or changes radio settings.
        let observer = unsafe { CBCentralManager::new() };
        self.rt.block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                let state = adapter.adapter_state().await.map_err(io_err)?;
                let native_state = unsafe { observer.state() };
                let authorization = unsafe { CBManager::authorization_class() };
                blog!(self.log, "Bluetooth state: {state:?}; native={native_state:?}; authorization={authorization:?}");
                if authorization == CBManagerAuthorization::Denied
                    || authorization == CBManagerAuthorization::Restricted
                {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "Bluetooth access is blocked. Allow Pocket Monitor in macOS System Settings → Privacy & Security → Bluetooth, then reopen the app.",
                    ));
                }
                if native_state == CBManagerState::Unsupported {
                    return Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "macOS reports that this Bluetooth adapter does not support Bluetooth LE. Pocket Monitor needs Bluetooth LE to find the camera; use a macOS-compatible Bluetooth LE adapter or connect the camera to Wi-Fi using DJI Mimo, then connect by address.",
                    ));
                }
                match state {
                    CentralState::PoweredOn => return Ok(()),
                    CentralState::PoweredOff => {
                        return Err(io::Error::other(
                            "Bluetooth is off. Turn it on in macOS System Settings, then scan again.",
                        ));
                    }
                    _ if tokio::time::Instant::now() >= deadline => {
                        return Err(io::Error::other(
                            "macOS Bluetooth is not ready. Allow Pocket Monitor in System Settings → Privacy & Security → Bluetooth, then reopen the app. If access is already enabled, check that your Bluetooth adapter supports Bluetooth LE.",
                        ));
                    }
                    _ => tokio::time::sleep(Duration::from_millis(250)).await,
                }
            }
        })
    }

    /// Every advertiser the radio hears, unfiltered, one line each. For the headless
    /// harness: it says whether the radio sees anything at all.
    pub fn scan_all(&mut self, seconds: f64) -> io::Result<Vec<String>> {
        let adapter = self.get_adapter()?;
        #[cfg(target_os = "macos")]
        self.wait_for_bluetooth(&adapter)?;
        let peripherals = self.rt.block_on(async {
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
        })?;
        let mut lines = Vec::new();
        for p in peripherals {
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
}

impl BleTransport for BtleplugTransport {
    fn scan(&mut self, seconds: f64) -> io::Result<Vec<Discovered>> {
        let service_uuid = self.service_uuid;
        let adapter = self.get_adapter()?;
        #[cfg(target_os = "macos")]
        self.wait_for_bluetooth(&adapter)?;
        let log = self.log.clone();

        blog!(
            log,
            "scan start  duration={seconds}s  filter_uuid={service_uuid}"
        );

        // Scan with no service filter so we also catch cameras that don't advertise
        // the service UUID in their advertisement packets (common on Windows WinRT).
        let peripherals = self.rt.block_on(async {
            adapter
                .start_scan(ScanFilter::default())
                .await
                .map_err(|e| io::Error::other(e.to_string()))?;

            tokio::time::sleep(Duration::from_secs_f64(seconds.max(3.0))).await;

            adapter
                .stop_scan()
                .await
                .map_err(|e| io::Error::other(e.to_string()))?;

            adapter
                .peripherals()
                .await
                .map_err(|e| io::Error::other(e.to_string()))
        })?;

        blog!(log, "scan complete  raw_count={}", peripherals.len());

        self.found.clear();
        let mut discovered = Vec::new();

        for p in peripherals {
            let props = match self.rt.block_on(p.properties()) {
                Ok(Some(props)) => props,
                _ => continue,
            };
            let name = props.local_name.clone().unwrap_or_default();
            let has_service = props.services.contains(&service_uuid);
            let looks_like_pocket = name.to_ascii_lowercase().contains("pocket")
                || name.to_ascii_lowercase().contains("osmo");

            blog!(
                log,
                "  peripheral  id={}  name={:?}  has_service={}  services={:?}",
                p.id(),
                name,
                has_service,
                props.services
            );

            if !has_service && !looks_like_pocket {
                continue;
            }

            let model_id = props
                .manufacturer_data
                .values()
                .find_map(|payload| opc_camera::Advert::decode(payload).and_then(|a| a.model_id));
            let addr = p.id().to_string();
            let display_name = if name.is_empty() {
                format!("Osmo Pocket ({})", &addr)
            } else {
                name
            };
            blog!(log, "  => accepted  addr={addr}  model_id={model_id:?}");
            self.found.insert(addr.clone(), p);
            discovered.push(Discovered {
                name: display_name,
                address: addr,
                advert: Some(opc_camera::Advert {
                    model_id,
                    new_format: false,
                    raw_product_type: None,
                }),
            });
        }
        blog!(log, "scan returning {} cameras", discovered.len());
        Ok(discovered)
    }

    fn connect(&mut self, address: &str) -> io::Result<()> {
        let notify_uuid = self.notify_uuid;
        let write_uuid = self.write_uuid;
        let log = self.log.clone();

        blog!(log, "connect  address={address}");

        let p = self.found.get(address).cloned().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("device {address} not in scan cache; scan again before connecting"),
            )
        })?;

        #[cfg(target_os = "macos")]
        let p = {
            // CoreBluetooth removes its backend record after disconnect. Pairing
            // deliberately disconnects before the operator enters home Wi-Fi;
            // retrieve the UUID again so provisioning gets a new live record.
            use btleplug::api::RetrievePeripheralsOptions;
            let adapter = self.get_adapter()?;
            let id = p.id();
            let refreshed = self.rt.block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(5),
                    adapter.retrieve_peripherals(RetrievePeripheralsOptions {
                        identifiers: Some(vec![id.clone()]),
                        services: None,
                    }),
                )
                .await
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Retrieving the camera timed out; scan again.",
                    )
                })?
                .map_err(io_err)?
                .into_iter()
                .find(|candidate| candidate.id() == id)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        "Camera no longer available; scan again.",
                    )
                })
            })?;
            self.found.insert(address.to_string(), refreshed.clone());
            if let Ok(mut pending) = self.notifications.lock() {
                pending.clear();
            }
            blog!(log, "  refreshed CoreBluetooth peripheral");
            refreshed
        };

        let setup = async {
            blog!(log, "  calling p.connect()");
            p.connect()
                .await
                .map_err(|e| io::Error::new(io::ErrorKind::ConnectionRefused, e.to_string()))?;
            blog!(log, "  connected; discovering services");

            p.discover_services()
                .await
                .map_err(|e| io::Error::other(e.to_string()))?;

            let chars = p.characteristics();
            blog!(log, "  {} characteristics found:", chars.len());
            for c in &chars {
                blog!(log, "    uuid={}  props={:?}", c.uuid, c.properties);
            }

            let notify_char = chars
                .iter()
                .find(|c| c.uuid == notify_uuid)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        format!(
                            "notify characteristic {notify_uuid} not found on device; \
                         camera may not be in pairing mode"
                        ),
                    )
                })?;

            // Subscribe to FFF4 (notify char) — enables server-side CCCD notifications.
            blog!(
                log,
                "  subscribing to notify char {} (FFF4)",
                notify_char.uuid
            );
            p.subscribe(notify_char)
                .await
                .map_err(|e| io::Error::other(e.to_string()))?;
            blog!(log, "  FFF4 subscribed");

            // Subscribe to FFF5 (write char) too — the Android app writes CCCD [0x01,0x00]
            // on both chars before arming pairing. Ignore errors: some cameras may not
            // advertise the Notify property on the write char.
            if let Some(write_char) = chars.iter().find(|c| c.uuid == write_uuid) {
                blog!(
                    log,
                    "  subscribing to write char {} (FFF5)",
                    write_char.uuid
                );
                match p.subscribe(write_char).await {
                    Ok(()) => blog!(log, "  FFF5 subscribed"),
                    Err(e) => blog!(log, "  FFF5 subscribe skipped: {e}"),
                }
            } else {
                blog!(log, "  FFF5 char not found; skipping subscribe");
            }

            // Small settle delay to match Android's sequential onDescriptorWrite callbacks.
            tokio::time::sleep(Duration::from_millis(100)).await;

            // Arm pairing: write [0x01, 0x00] to FFF4 itself (not a descriptor) WITH
            // RESPONSE. The Android app (BleLink.kt maybeArmPairing) does exactly this
            // after both CCCD writes settle. Without it the camera ignores SessionWake.
            blog!(
                log,
                "  arming pairing: writing [01 00] to FFF4 with response"
            );
            let notify_char2 = chars
                .iter()
                .find(|c| c.uuid == notify_uuid)
                .unwrap()
                .clone();
            p.write(&notify_char2, &[0x01, 0x00], WriteType::WithResponse)
                .await
                .map_err(|e| io::Error::other(format!("pairing arm write failed: {e}")))?;
            blog!(log, "  pairing armed");

            // Brief post-arm settle before the state machine sends SessionWake.
            tokio::time::sleep(Duration::from_millis(100)).await;

            Ok::<(), io::Error>(())
        };
        #[cfg(not(target_os = "macos"))]
        self.rt.block_on(setup)?;
        #[cfg(target_os = "macos")]
        {
            let result = self.rt.block_on(async {
                tokio::time::timeout(Duration::from_secs(30), setup)
                    .await
                    .unwrap_or_else(|_| {
                        Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "Bluetooth connection or service discovery timed out. Keep the camera awake and nearby, close DJI Mimo on your phone, approve any camera prompt, then scan and try again.",
                        ))
                    })
            });
            if let Err(error) = result {
                blog!(log, "  connection setup failed: {error}");
                // Cancel the pending native connection too: dropping its Rust
                // future alone leaves CoreBluetooth trying in the background.
                self.rt.block_on(async {
                    let _ = tokio::time::timeout(Duration::from_secs(3), p.disconnect()).await;
                });
                self.found.clear();
                self.adapter = None;
                return Err(error);
            }
        }

        // Spawn notification listener on the background runtime threads.
        let p2 = p.clone();
        let buf = Arc::clone(&self.notifications);
        let log2 = log.clone();
        self.rt.spawn(async move {
            use btleplug::api::Peripheral as _;
            use futures::StreamExt;
            blog!(log2, "  notification listener started");
            match p2.notifications().await {
                Err(e) => blog!(log2, "  notifications() error: {e}"),
                Ok(mut stream) => {
                    while let Some(notif) = stream.next().await {
                        blog!(
                            log2,
                            "  notification  char={}  len={}",
                            notif.uuid,
                            notif.value.len()
                        );
                        if let Ok(mut locked) = buf.lock() {
                            locked.push(notif.value);
                        }
                    }
                    blog!(log2, "  notification stream ended");
                }
            }
        });

        self.peripheral = Some(p);
        blog!(log, "connect done");
        Ok(())
    }

    fn write_frame(&mut self, frame: &[u8]) -> io::Result<()> {
        let Some(p) = self.peripheral.as_ref() else {
            return Err(io::Error::new(io::ErrorKind::NotConnected, "not connected"));
        };
        let write_uuid = self.write_uuid;
        let log = self.log.clone();

        let chars = p.characteristics();
        let write_char = chars
            .into_iter()
            .find(|c| c.uuid == write_uuid)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "write characteristic not found")
            })?;

        blog!(
            log,
            "write_frame  len={}  hex={}",
            frame.len(),
            frame
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let frame = frame.to_vec();
        let p = p.clone();
        self.rt.block_on(async move {
            // Pace writes 120 ms apart — the Android app queues BLE writes this way;
            // sending too fast drops frames on some cameras.
            tokio::time::sleep(Duration::from_millis(120)).await;
            p.write(&write_char, &frame, WriteType::WithoutResponse)
                .await
                .map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, e.to_string()))
        })
    }

    fn take_notifications(&mut self) -> Vec<Vec<u8>> {
        let out = self
            .notifications
            .lock()
            .map(|mut locked| std::mem::take(&mut *locked))
            .unwrap_or_default();
        if !out.is_empty() {
            blog!(self.log, "take_notifications  count={}", out.len());
        }
        out
    }

    fn disconnect(&mut self) -> io::Result<()> {
        blog!(self.log, "disconnect");
        let Some(p) = self.peripheral.take() else {
            return Ok(());
        };
        self.rt.block_on(async move {
            p.disconnect()
                .await
                .map_err(|e| io::Error::other(e.to_string()))
        })
    }
}

fn io_err(e: impl std::error::Error) -> io::Error {
    io::Error::other(e.to_string())
}
