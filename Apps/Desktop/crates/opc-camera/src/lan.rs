//! Finding a camera on a network it joined.
//!
//! Station mode leaves the camera with an address DHCP chose, so the laptop looks: every
//! host on its own subnet is asked for the TCP `:7001` poke port, and each that answers
//! is opened as a datalink and asked for its Wi-Fi identity, which must match what the
//! camera said over Bluetooth. Only that identity match makes an address the camera's.

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

/// Opens a datalink to `address` and asks the camera there for its Wi-Fi identity. True
/// when it matches `identity`; false when it answers with another, or not at all.
pub fn identity_matches(address: SocketAddr, identity: &[u8], timeout: Duration) -> bool {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.subsec_nanos())
        .unwrap_or(1);
    let session_id = (nanos & 0xFFFF) as u16 | 1;
    let base_seq = ((nanos >> 8) & 0xFFF8) as u16;
    let Ok(mut session) = CameraSession::connect_to(address, session_id, base_seq) else {
        return false;
    };
    let deadline = Instant::now() + timeout;
    let mut asked = false;
    while Instant::now() < deadline {
        let Ok(events) = session.poll() else {
            return false;
        };
        for event in events {
            match event {
                SessionEvent::Opened if !asked => {
                    asked = true;
                    session.send(Command::GetWifiSsid);
                }
                SessionEvent::Frame(frame) if (frame.cmd_set, frame.cmd_id) == (0x07, 0x07) => {
                    return frame.payload == identity;
                }
                SessionEvent::Unreachable => return false,
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
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
