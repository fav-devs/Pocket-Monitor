//! Bonjour discovery of sharing hosts.
//!
//! Hosts are only ever found on the camera's own Wi-Fi. There is no peer-to-peer
//! discovery and no fallback to another network: a watcher that cannot see a host is
//! told to join the camera Wi-Fi rather than quietly reaching one somewhere else.
//!
//! Two service types are browsed: Pocket Monitor phones advertise `_pocket-mon._tcp`, and
//! upstream OpenPocketCine iPhones the core's `_opc-mon._tcp`. The wire is the same. A name
//! seen on both is listed once, as the Pocket Monitor host.

use std::collections::BTreeMap;
use std::fmt;
use std::net::IpAddr;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent};

use crate::ffi::ProtocolInfo;

/// The Pocket Monitor phones' Bonjour type (the core's type is the legacy one).
pub const POCKET_SERVICE_TYPE: &str = "_pocket-mon._tcp";

/// Every type a watcher browses, in `mdns-sd` form, ours first. The core's type is kept
/// even if it ever equals ours.
pub fn browse_types(info: &ProtocolInfo) -> Vec<String> {
    let ours = format!("{POCKET_SERVICE_TYPE}.local.");
    let core = info.mdns_service_type();
    if core == ours {
        vec![ours]
    } else {
        vec![ours, core]
    }
}

/// Of two records for one name, the one from the type listed first wins.
fn preferred(existing: Option<&str>, incoming: &str, order: &[String]) -> bool {
    let rank = |t: &str| order.iter().position(|o| o == t).unwrap_or(usize::MAX);
    existing.is_none_or(|current| rank(incoming) <= rank(current))
}

/// A sharing host advertising on the shared Wi-Fi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredHost {
    pub name: String,
    pub camera: String,
    pub addresses: Vec<IpAddr>,
    pub port: u16,
    /// `_pocket-mon._tcp.local.` or `_opc-mon._tcp.local.`.
    pub service_type: String,
}

/// A host that advertises `w=0` is up but not offering a picture yet.
pub fn is_watchable(flag: Option<&str>) -> bool {
    flag != Some("0")
}

/// `Studio._opc-mon._tcp.local.` with the service type stripped back off.
pub fn instance_name(fullname: &str, service_type: &str) -> String {
    let suffix = format!(".{service_type}");
    fullname
        .strip_suffix(&suffix)
        .unwrap_or(fullname)
        .to_string()
}

#[derive(Debug)]
pub enum DiscoveryError {
    Mdns(mdns_sd::Error),
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mdns(error) => write!(f, "could not browse for shared feeds: {error}"),
        }
    }
}

impl std::error::Error for DiscoveryError {}

impl From<mdns_sd::Error> for DiscoveryError {
    fn from(error: mdns_sd::Error) -> Self {
        Self::Mdns(error)
    }
}

/// Watches the shared Wi-Fi for hosts, keeping the newest record for each name.
pub struct Browser {
    daemon: ServiceDaemon,
    receivers: Vec<(String, mdns_sd::Receiver<ServiceEvent>)>,
    service_types: Vec<String>,
    camera_key: String,
    watchable_key: String,
    hosts: BTreeMap<String, DiscoveredHost>,
}

impl fmt::Debug for Browser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Browser")
            .field("service_types", &self.service_types)
            .field("hosts", &self.hosts.len())
            .finish_non_exhaustive()
    }
}

/// How long `poll` waits between empty sweeps of the receivers.
const IDLE_SWEEP: Duration = Duration::from_millis(20);

impl Browser {
    pub fn start(info: &ProtocolInfo) -> Result<Self, DiscoveryError> {
        let daemon = ServiceDaemon::new()?;
        let service_types = browse_types(info);
        let mut receivers = Vec::with_capacity(service_types.len());
        for service_type in &service_types {
            receivers.push((service_type.clone(), daemon.browse(service_type)?));
        }
        Ok(Self {
            daemon,
            receivers,
            service_types,
            camera_key: info.txt_camera.clone(),
            watchable_key: info.txt_watchable.clone(),
            hosts: BTreeMap::new(),
        })
    }

    /// Drains events for up to `timeout` and returns the hosts known afterwards.
    pub fn poll(&mut self, timeout: Duration) -> Vec<DiscoveredHost> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let mut events = Vec::new();
            for (service_type, receiver) in &self.receivers {
                while let Ok(event) = receiver.try_recv() {
                    events.push((service_type.clone(), event));
                }
            }
            let idle = events.is_empty();
            for (service_type, event) in events {
                self.apply(&service_type, event);
            }
            let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
                break;
            };
            if idle {
                std::thread::sleep(remaining.min(IDLE_SWEEP));
            }
        }
        self.hosts()
    }

    fn apply(&mut self, service_type: &str, event: ServiceEvent) {
        match event {
            ServiceEvent::ServiceResolved(info) => {
                let name = instance_name(info.get_fullname(), service_type);
                if !is_watchable(info.get_property_val_str(&self.watchable_key)) {
                    if self
                        .hosts
                        .get(&name)
                        .is_some_and(|host| host.service_type == service_type)
                    {
                        self.hosts.remove(&name);
                    }
                    return;
                }
                let current = self.hosts.get(&name).map(|host| host.service_type.as_str());
                if !preferred(current, service_type, &self.service_types) {
                    return;
                }
                let mut addresses: Vec<IpAddr> = info
                    .get_addresses()
                    .iter()
                    .map(|ip| ip.to_ip_addr())
                    .collect();
                addresses.sort();
                self.hosts.insert(
                    name.clone(),
                    DiscoveredHost {
                        name,
                        camera: info
                            .get_property_val_str(&self.camera_key)
                            .unwrap_or_default()
                            .to_string(),
                        addresses,
                        port: info.get_port(),
                        service_type: service_type.to_string(),
                    },
                );
            }
            ServiceEvent::ServiceRemoved(_, fullname) => {
                let name = instance_name(&fullname, service_type);
                if self
                    .hosts
                    .get(&name)
                    .is_some_and(|host| host.service_type == service_type)
                {
                    self.hosts.remove(&name);
                }
            }
            _ => {}
        }
    }

    pub fn hosts(&self) -> Vec<DiscoveredHost> {
        self.hosts.values().cloned().collect()
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        for service_type in &self.service_types {
            let _ = self.daemon.stop_browse(service_type);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_zero_hides_a_host() {
        assert!(is_watchable(None));
        assert!(is_watchable(Some("1")));
        assert!(is_watchable(Some("")));
        assert!(!is_watchable(Some("0")));
    }

    #[test]
    fn the_service_type_is_stripped_from_the_instance_name() {
        assert_eq!(
            instance_name("Studio iPhone._opc-mon._tcp.local.", "_opc-mon._tcp.local."),
            "Studio iPhone"
        );
    }

    #[test]
    fn an_unexpected_fullname_is_left_alone() {
        assert_eq!(
            instance_name("something-else", "_opc-mon._tcp.local."),
            "something-else"
        );
    }

    #[test]
    fn a_pocket_monitor_name_is_stripped_of_its_own_type() {
        assert_eq!(
            instance_name("Pixel 9._pocket-mon._tcp.local.", "_pocket-mon._tcp.local."),
            "Pixel 9"
        );
        // The other type's suffix is not ours to strip.
        assert_eq!(
            instance_name("Pixel 9._pocket-mon._tcp.local.", "_opc-mon._tcp.local."),
            "Pixel 9._pocket-mon._tcp.local."
        );
    }

    #[test]
    fn our_type_wins_a_name_seen_on_both() {
        let order = vec![
            "_pocket-mon._tcp.local.".to_string(),
            "_opc-mon._tcp.local.".to_string(),
        ];
        assert!(preferred(None, "_opc-mon._tcp.local.", &order));
        assert!(preferred(
            Some("_opc-mon._tcp.local."),
            "_pocket-mon._tcp.local.",
            &order
        ));
        assert!(!preferred(
            Some("_pocket-mon._tcp.local."),
            "_opc-mon._tcp.local.",
            &order
        ));
        assert!(preferred(
            Some("_opc-mon._tcp.local."),
            "_opc-mon._tcp.local.",
            &order
        ));
    }

    fn info(service_type: &str) -> ProtocolInfo {
        ProtocolInfo {
            version: 1,
            hevc_codec: 1,
            max_payload_bytes: 8 * 1024 * 1024,
            framing_header_bytes: 5,
            max_retries: 3,
            join_timeout: Duration::from_secs(15),
            silence_timeout: Duration::from_secs(5),
            service_type: service_type.to_string(),
            txt_camera: "c".to_string(),
            txt_watchable: "w".to_string(),
        }
    }

    #[test]
    fn watchers_browse_ours_and_the_core_type() {
        assert_eq!(
            browse_types(&info("_opc-mon._tcp")),
            vec!["_pocket-mon._tcp.local.", "_opc-mon._tcp.local."]
        );
        assert_eq!(
            browse_types(&info(POCKET_SERVICE_TYPE)),
            vec!["_pocket-mon._tcp.local."]
        );
    }

    #[test]
    fn both_service_types_fit_the_bonjour_limit() {
        for service in [POCKET_SERVICE_TYPE, "_opc-mon._tcp"] {
            let label = service.trim_start_matches('_').trim_end_matches("._tcp");
            assert!(label.len() <= 15, "{service}");
        }
    }

    #[test]
    fn an_instance_name_may_contain_dots() {
        assert_eq!(
            instance_name("A.B iPhone._opc-mon._tcp.local.", "_opc-mon._tcp.local."),
            "A.B iPhone"
        );
    }
}
