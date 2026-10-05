//! Finding a camera on a network it joined.
//!
//! Station mode leaves the camera with an address DHCP chose, so the laptop looks: every
//! host on its own subnet is asked for TCP `:9004` (the datalink port a station-mode
//! Pocket answers on) and, if that is quiet, TCP `:7001`. Each that answers is opened as
//! a UDP datalink after a TCP SetPairingPIN poke (7001 on SoftAP, 9004 in station mode)
//! and asked for its Wi-Fi identity. A silent getter still counts if the handshake
//! answers.

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::{CameraSession, Command, SessionEvent};

/// The port the Pocket family answers before its datalink opens.
pub const POKE_PORT: u16 = 7001;
/// The datalink port on a station-mode Pocket.
pub const DATALINK_PORT: u16 = 9004;
/// The largest subnet the search will walk, as the core bounds it: 1022 hosts.
const MOST_HOST_BITS: u32 = 1023;

/// Every other host on `address`'s subnet, in order. None for a subnet the search will
/// not walk: bigger than a /22, or a mask that is not a prefix.
pub fn subnet_hosts(address: Ipv4Addr, mask: Ipv4Addr) -> Option<Vec<Ipv4Addr>> {
    let ip = u32::from(address);
    let netmask = u32::from(mask);
    let host_bits = !netmask;
    if host_bits <= 1 || host_bits > MOST_HOST_BITS || host_bits & host_bits.wrapping_add(1) != 0 {
        return None;
    }
    let network = ip & netmask;
    Some(
        (1..host_bits)
            .map(|offset| Ipv4Addr::from(network | offset))
            .filter(|host| u32::from(*host) != ip)
            .collect(),
    )
}

/// The hosts that accept a TCP connection on `port`, tried `parallel` at a time with
/// `timeout` each. Stops after `most` hits.
pub fn probe_hosts(
    hosts: &[Ipv4Addr],
    port: u16,
    timeout: Duration,
    parallel: usize,
    most: usize,
) -> Vec<Ipv4Addr> {
    let mut found = Vec::new();
    for batch in hosts.chunks(parallel.max(1)) {
        let (tx, rx) = mpsc::channel();
        let mut workers = Vec::new();
        for host in batch {
            let host = *host;
            let tx = tx.clone();
            workers.push(std::thread::spawn(move || {
                let open =
                    TcpStream::connect_timeout(&SocketAddr::from((host, port)), timeout).is_ok();
                let _ = tx.send((host, open));
            }));
        }
        drop(tx);
        let mut hits: Vec<Ipv4Addr> = rx
            .iter()
            .filter(|(_, open)| *open)
            .map(|(host, _)| host)
            .collect();
        for worker in workers {
            let _ = worker.join();
        }
        hits.sort();
        found.extend(hits);
        if found.len() >= most {
            break;
        }
    }
    found.truncate(most);
    found
}

/// Opens a datalink to `address` and asks the camera there for its Wi-Fi identity.
/// `Ok` is this camera (or a handshake that answered when the getter stayed silent).
/// `Err` is the reason it is not.
pub fn identify_camera(
    address: SocketAddr,
    identity: &[u8],
    timeout: Duration,
) -> Result<String, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.subsec_nanos())
        .unwrap_or(1);
    let session_id = (nanos & 0xFFFF) as u16 | 1;
    let base_seq = ((nanos >> 8) & 0xFFF8) as u16;
    let mut session = CameraSession::connect_to(address, session_id, base_seq)
        .map_err(|error| format!("could not open a datalink: {error}"))?;
    let tcp = session.tcp_poke_status().to_string();
    // A closed poke port is not this camera; do not sit out the full verify budget.
    let budget = if tcp.starts_with("ready") {
        timeout
    } else {
        timeout.min(Duration::from_millis(500))
    };
    let deadline = Instant::now() + budget;
    let mut asked = false;
    let mut opened = false;
    while Instant::now() < deadline {
        let events = session
            .poll()
            .map_err(|error| format!("datalink poll failed: {error} tcp={tcp}"))?;
        for event in events {
            match event {
                SessionEvent::Opened if !asked => {
                    asked = true;
                    opened = true;
                    session.send(Command::GetWifiSsid);
                }
                SessionEvent::Frame(frame) if (frame.cmd_set, frame.cmd_id) == (0x07, 0x07) => {
                    let camera = frame.payload.len() > 2 && frame.payload[0] == 0;
                    if !camera {
                        return Err(format!("ssid getter was not a camera tcp={tcp}"));
                    }
                    if identity.is_empty() || frame.payload == identity {
                        return Ok(format!("identity matched tcp={tcp}"));
                    }
                    // BLE and UDP GetWifiSsid can disagree after a station join.
                    return Ok(format!("handshake ok (ssid getter differed) tcp={tcp}"));
                }
                SessionEvent::Unreachable => {
                    return Err(format!("UDP handshake unreachable tcp={tcp}"));
                }
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if opened {
        // Station-mode cameras often never return 0x07/0x07.
        return Ok(format!("handshake opened tcp={tcp}"));
    }
    Err(format!("no UDP handshake tcp={tcp}"))
}

/// True when [`identify_camera`] says this address is the camera.
pub fn identity_matches(address: SocketAddr, identity: &[u8], timeout: Duration) -> bool {
    identify_camera(address, identity, timeout).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_slash_24_lists_its_253_other_hosts_in_order() {
        let hosts = subnet_hosts(
            Ipv4Addr::new(192, 168, 1, 37),
            Ipv4Addr::new(255, 255, 255, 0),
        )
        .expect("a walkable subnet");
        assert_eq!(hosts.len(), 253);
        assert_eq!(hosts[0], Ipv4Addr::new(192, 168, 1, 1));
        assert_eq!(hosts[35], Ipv4Addr::new(192, 168, 1, 36));
        assert_eq!(
            hosts[36],
            Ipv4Addr::new(192, 168, 1, 38),
            "the laptop itself is skipped"
        );
        assert_eq!(*hosts.last().unwrap(), Ipv4Addr::new(192, 168, 1, 254));
    }

    #[test]
    fn subnets_the_core_would_not_walk_are_refused() {
        let a = Ipv4Addr::new(10, 0, 0, 5);
        assert!(
            subnet_hosts(a, Ipv4Addr::new(255, 255, 252, 0)).is_some(),
            "a /22 is the limit"
        );
        assert!(
            subnet_hosts(a, Ipv4Addr::new(255, 255, 248, 0)).is_none(),
            "a /21 is too big"
        );
        assert!(
            subnet_hosts(a, Ipv4Addr::new(255, 255, 255, 254)).is_none(),
            "a /31 has no others"
        );
        assert!(
            subnet_hosts(a, Ipv4Addr::new(255, 255, 0, 255)).is_none(),
            "not a prefix"
        );
    }

    #[test]
    fn probing_finds_the_one_host_that_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let port = listener.local_addr().unwrap().port();
        let hosts = [Ipv4Addr::new(127, 0, 0, 1), Ipv4Addr::new(127, 0, 0, 2)];
        // 127.0.0.2 refuses at once on Linux and macOS; on Windows the connect times out.
        let found = probe_hosts(&hosts, port, Duration::from_millis(400), 8, 8);
        assert_eq!(found, [Ipv4Addr::new(127, 0, 0, 1)]);
        let none = probe_hosts(&hosts, port, Duration::from_millis(400), 8, 0);
        assert!(none.is_empty(), "a zero budget asks nothing of the answer");
    }
}
