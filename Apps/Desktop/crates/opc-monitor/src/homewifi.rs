//! The camera on the operator's own Wi-Fi: what the desktop remembers about it, and how
//! it reads the machine's networks. Bluetooth and the LAN search live in the binary;
//! this is the part with no hardware in it.

use std::net::Ipv4Addr;

/// A camera that has been put on a network of the operator's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedStation {
    /// The network the camera joined.
    pub ssid: String,
    /// The camera's `0x07/0x07` identity reply, which the LAN search checks against.
    pub identity: Vec<u8>,
    /// Where it answered last time, tried first.
    pub address: Option<Ipv4Addr>,
    pub model_id: Option<i32>,
}

const HEADER: &str = "openpocketcine-desktop-station-v1";

impl SavedStation {
    /// The file's text. Never the network password: the camera keeps that.
    pub fn to_text(&self) -> String {
        let identity: String = self.identity.iter().map(|b| format!("{b:02x}")).collect();
        format!(
            "{HEADER}\nssid={}\nidentity={identity}\naddress={}\nmodel={}\n",
            self.ssid,
            self.address.map_or_else(String::new, |a| a.to_string()),
            self.model_id.map_or_else(String::new, |id| id.to_string()),
        )
    }

    /// Reads a file written by [`Self::to_text`]; None for anything else.
    pub fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        if lines.next()? != HEADER {
            return None;
        }
        let mut station = Self {
            ssid: String::new(),
            identity: Vec::new(),
            address: None,
            model_id: None,
        };
        for line in lines {
            if let Some(ssid) = line.strip_prefix("ssid=") {
                station.ssid = ssid.to_string();
            } else if let Some(hex) = line.strip_prefix("identity=") {
                station.identity = (0..hex.len() / 2)
                    .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16))
                    .collect::<Result<_, _>>()
                    .ok()?;
            } else if let Some(address) = line.strip_prefix("address=") {
                station.address = address.parse().ok();
            } else if let Some(model) = line.strip_prefix("model=") {
                station.model_id = model.parse().ok();
            }
        }
        (!station.ssid.is_empty() && station.identity.len() > 2).then_some(station)
    }
}

/// The operator's home network as kept for next time: the name, and the password only
/// as the operating system sealed it for this user (never plain text on disk).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeNetwork {
    pub ssid: String,
    /// The sealed password; empty when this platform cannot seal one.
    pub sealed_password: Vec<u8>,
}

const HOME_HEADER: &str = "openpocketcine-desktop-homewifi-v1";

impl HomeNetwork {
    pub fn to_text(&self) -> String {
        let sealed: String = self.sealed_password.iter().map(|b| format!("{b:02x}")).collect();
        format!("{HOME_HEADER}\nssid={}\nsealed={sealed}\n", self.ssid)
    }

    pub fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        if lines.next()? != HOME_HEADER {
            return None;
        }
        let mut ssid = String::new();
        let mut sealed = Vec::new();
        for line in lines {
            if let Some(name) = line.strip_prefix("ssid=") {
                ssid = name.to_string();
            } else if let Some(hex) = line.strip_prefix("sealed=") {
                if hex.len() % 2 != 0 || !hex.is_ascii() {
                    return None;
                }
                sealed = (0..hex.len() / 2)
                    .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16))
                    .collect::<Result<_, _>>()
                    .ok()?;
            }
        }
        (!ssid.is_empty()).then_some(Self {
            ssid,
            sealed_password: sealed,
        })
    }
}

/// Which bodies want video mode selected before they join (Pocket 4 family).
pub fn wants_video_mode(model_id: Option<i32>) -> bool {
    matches!(model_id, Some(0x0021 | 0x0022))
}

/// Which bodies may answer the role query with "no such getter" (Pocket 3, Nano).
pub fn allows_missing_role_query(model_id: Option<i32>) -> bool {
    matches!(model_id, Some(0x0020 | 0x0019))
}

/// The IPv4 networks in `ipconfig` output: each adapter's address with its mask. Only
/// adapters with a default gateway count, which leaves out the camera's own network
/// and anything virtual.
pub fn networks_from_ipconfig(text: &str) -> Vec<(Ipv4Addr, Ipv4Addr)> {
    let mut networks = Vec::new();
    let mut address: Option<Ipv4Addr> = None;
    let mut mask: Option<Ipv4Addr> = None;
    let mut gateway = false;
    // The gateways are listed over several lines, the IPv6 one first on many machines.
    let mut in_gateways = false;
    let value = |line: &str| -> Option<String> {
        line.split_once(':')
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    for line in text.lines() {
        let trimmed = line.trim_start();
        let is_adapter_header = !line.starts_with(' ') && line.contains("adapter");
        if is_adapter_header {
            if let (Some(a), Some(m), true) = (address, mask, gateway) {
                networks.push((a, m));
            }
            address = None;
            mask = None;
            gateway = false;
            in_gateways = false;
            continue;
        }
        // Another gateway for the adapter above: an address with no label in front of it.
        if in_gateways && !trimmed.is_empty() && !trimmed.contains(" : ") {
            if trimmed.parse::<Ipv4Addr>().is_ok() {
                gateway = true;
            }
            continue;
        }
        in_gateways = false;
        if trimmed.starts_with("IPv4 Address") {
            address =
                value(trimmed).and_then(|v| v.trim_end_matches("(Preferred)").trim().parse().ok());
        } else if trimmed.starts_with("Subnet Mask") {
            mask = value(trimmed).and_then(|v| v.parse().ok());
        } else if trimmed.starts_with("Default Gateway") {
            in_gateways = true;
            gateway |= value(trimmed).is_some_and(|v| v.parse::<Ipv4Addr>().is_ok());
        }
    }
    if let (Some(a), Some(m), true) = (address, mask, gateway) {
        networks.push((a, m));
    }
    networks
}

/// The IPv4 networks in `ip -o -4 addr` output, loopback left out.
pub fn networks_from_ip_addr(text: &str) -> Vec<(Ipv4Addr, Ipv4Addr)> {
    text.lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let _index = words.next()?;
            let interface = words.next()?;
            if interface == "lo" {
                return None;
            }
            let inet = words.position(|w| w == "inet")?;
            let _ = inet;
            let cidr = line
                .split_whitespace()
                .skip_while(|w| *w != "inet")
                .nth(1)?;
            let (address, prefix) = cidr.split_once('/')?;
            let address: Ipv4Addr = address.parse().ok()?;
            let prefix: u32 = prefix.parse().ok()?;
            if prefix == 0 || prefix > 32 {
                return None;
            }
            let mask = Ipv4Addr::from(u32::MAX.checked_shl(32 - prefix).unwrap_or(0));
            Some((address, mask))
        })
        .collect()
}

/// Active broadcast IPv4 interfaces in macOS `ifconfig -a` output.
/// macOS prints masks in hexadecimal; loopback and point-to-point VPNs are
/// excluded so camera discovery searches the local LAN rather than tunnels.
pub fn networks_from_ifconfig(text: &str) -> Vec<(Ipv4Addr, Ipv4Addr)> {
    let mut networks = Vec::new();
    let mut usable = false;
    for line in text.lines() {
        if !line.starts_with(char::is_whitespace) && line.contains(": flags=") {
            let flags = line
                .split_once('<')
                .and_then(|(_, rest)| rest.split_once('>'));
            usable = flags.is_some_and(|(flags, _)| {
                let flags: Vec<_> = flags.split(',').collect();
                flags.contains(&"UP")
                    && flags.contains(&"RUNNING")
                    && flags.contains(&"BROADCAST")
                    && !flags.contains(&"LOOPBACK")
                    && !flags.contains(&"POINTOPOINT")
            });
            continue;
        }
        if !usable {
            continue;
        }
        let words: Vec<_> = line.split_whitespace().collect();
        if words.first() != Some(&"inet") {
            continue;
        }
        let Some(address) = words.get(1).and_then(|s| s.parse::<Ipv4Addr>().ok()) else {
            continue;
        };
        if address.is_unspecified()
            || address.is_loopback()
            || address.is_link_local()
            || address.is_multicast()
            || address.is_broadcast()
        {
            continue;
        }
        let Some(mask_text) = words
            .windows(2)
            .find(|pair| pair[0] == "netmask")
            .map(|pair| pair[1])
        else {
            continue;
        };
        let mask = if let Some(hex) = mask_text.strip_prefix("0x") {
            u32::from_str_radix(hex, 16).ok().map(Ipv4Addr::from)
        } else {
            mask_text.parse::<Ipv4Addr>().ok()
        };
        let Some(mask) = mask else {
            continue;
        };
        let host_bits = !u32::from(mask);
        if u32::from(mask) == 0 || host_bits & host_bits.wrapping_add(1) != 0 {
            continue;
        }
        if !networks.contains(&(address, mask)) {
            networks.push((address, mask));
        }
    }
    networks
}

/// The SSID in `netsh wlan show interfaces` output, if the machine is on Wi-Fi.
pub fn ssid_from_netsh(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let trimmed = line.trim_start();
        if trimmed.starts_with("SSID")
            && !trimmed.starts_with("SSID BSSID")
            && !trimmed.starts_with("BSSID")
        {
            trimmed
                .split_once(':')
                .map(|(_, v)| v.trim().to_string())
                .filter(|v| !v.is_empty())
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_station_survives_the_file_and_refuses_strangers() {
        let station = SavedStation {
            ssid: "Home".into(),
            identity: vec![0, 0x0b, b'O', b's', b'm', b'o'],
            address: Some(Ipv4Addr::new(192, 168, 1, 42)),
            model_id: Some(0x20),
        };
        let text = station.to_text();
        assert!(!text.contains("password"));
        assert_eq!(SavedStation::parse(&text), Some(station.clone()));
        let no_address = SavedStation {
            address: None,
            model_id: None,
            ..station
        };
        assert_eq!(SavedStation::parse(&no_address.to_text()), Some(no_address));
        assert_eq!(SavedStation::parse("something else\nssid=x\n"), None);
        assert_eq!(
            SavedStation::parse(&format!("{HEADER}\nssid=Home\nidentity=zz\n")),
            None,
            "bad hex is not an identity"
        );
        assert_eq!(SavedStation::parse(&format!("{HEADER}\nssid=Home\n")), None);
    }

    #[test]
    fn a_home_network_keeps_its_name_and_only_a_sealed_password() {
        let home = HomeNetwork {
            ssid: "Home Net".into(),
            sealed_password: vec![1, 2, 0xab],
        };
        let text = home.to_text();
        assert!(!text.contains("hunter2"));
        assert_eq!(HomeNetwork::parse(&text), Some(home));
        assert_eq!(HomeNetwork::parse("nope\nssid=x\n"), None);
        assert_eq!(HomeNetwork::parse(&format!("{HOME_HEADER}\nssid=\n")), None);
    }

    #[test]
    fn model_gates_follow_the_phone_apps() {
        assert!(wants_video_mode(Some(0x0022)));
        assert!(!wants_video_mode(Some(0x0020)));
        assert!(allows_missing_role_query(Some(0x0020)));
        assert!(allows_missing_role_query(Some(0x0019)));
        assert!(!allows_missing_role_query(Some(0x0022)));
        assert!(!allows_missing_role_query(None));
    }

    #[test]
    fn ipconfig_yields_the_adapters_with_a_gateway() {
        let text = "\
Windows IP Configuration

Wireless LAN adapter Wi-Fi:

   Connection-specific DNS Suffix  . : home
   IPv4 Address. . . . . . . . . . . : 192.168.1.23(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.1.1

Wireless LAN adapter Wi-Fi 2:

   IPv4 Address. . . . . . . . . . . : 192.168.2.5
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . :

Ethernet adapter vEthernet (WSL):

   IPv4 Address. . . . . . . . . . . : 172.29.0.1
   Subnet Mask . . . . . . . . . . . : 255.255.240.0
   Default Gateway . . . . . . . . . :
";
        assert_eq!(
            networks_from_ipconfig(text),
            [(
                Ipv4Addr::new(192, 168, 1, 23),
                Ipv4Addr::new(255, 255, 255, 0)
            )]
        );
    }

    #[test]
    fn an_ipv6_gateway_listed_first_does_not_hide_the_ipv4_one() {
        let text = "Wireless LAN adapter Wi-Fi:

   IPv4 Address. . . . . . . . . . . : 10.0.0.205
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : fe80::e2db:d1ff:fef8:15ed%22
                                       10.0.0.1

Ethernet adapter Bluetooth Network Connection:

   Media State . . . . . . . . . . . : Media disconnected
";
        assert_eq!(
            networks_from_ipconfig(text),
            [(Ipv4Addr::new(10, 0, 0, 205), Ipv4Addr::new(255, 255, 255, 0))]
        );
    }

    #[test]
    fn ip_addr_yields_every_interface_but_loopback() {
        let text = "\
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
3: wlan0    inet 10.0.0.7/22 brd 10.0.3.255 scope global dynamic noprefixroute wlan0\\       valid_lft 3000sec
";
        assert_eq!(
            networks_from_ip_addr(text),
            [(Ipv4Addr::new(10, 0, 0, 7), Ipv4Addr::new(255, 255, 252, 0))]
        );
    }

    #[test]
    fn macos_ifconfig_reads_active_lans_and_skips_loopback_vpn_and_down_interfaces() {
        let text = "lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
    inet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
    inet6 fe80::1%en0 prefixlen 64
    inet 10.0.0.58 netmask 0xffffff00 broadcast 10.0.0.255
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
    inet 100.64.0.2 --> 100.64.0.2 netmask 0xffffffff
en1: flags=8862<BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
    inet 192.168.1.3 netmask 0xffffff00 broadcast 192.168.1.255
";
        assert_eq!(
            networks_from_ifconfig(text),
            [(Ipv4Addr::new(10, 0, 0, 58), Ipv4Addr::new(255, 255, 255, 0))]
        );
    }

    #[test]
    fn macos_ifconfig_keeps_alias_networks_and_rejects_malformed_and_unusable_addresses() {
        let text = "en0: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
    inet 10.1.0.7 netmask 0xfffffc00 broadcast 10.1.3.255
    inet 192.168.50.7 netmask 255.255.255.0
    inet 192.168.50.7 netmask 0xffffff00
    inet 10.2.0.7 netmask 0xff00ff00
    inet 10.3.0.7 netmask 0xnothex
    inet 10.4.0.7
    inet 169.254.10.7 netmask 0xffff0000
    inet 0.0.0.0 netmask 0xffffff00
    inet 224.0.0.1 netmask 0xffffff00
";
        assert_eq!(
            networks_from_ifconfig(text),
            [
                (Ipv4Addr::new(10, 1, 0, 7), Ipv4Addr::new(255, 255, 252, 0)),
                (
                    Ipv4Addr::new(192, 168, 50, 7),
                    Ipv4Addr::new(255, 255, 255, 0)
                ),
            ]
        );
        assert!(networks_from_ifconfig("ifconfig failed").is_empty());
    }

    #[test]
    fn the_current_ssid_comes_out_of_netsh() {
        let text = "\
There is 1 interface on the system:

    Name                   : Wi-Fi
    State                  : connected
    SSID                   : Home Net
    BSSID                  : aa:bb:cc:dd:ee:ff
";
        assert_eq!(ssid_from_netsh(text), Some("Home Net".to_string()));
        assert_eq!(ssid_from_netsh("    State : disconnected\n"), None);
    }
}
