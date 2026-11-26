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
            continue;
        }
        if trimmed.starts_with("IPv4 Address") {
            address =
                value(trimmed).and_then(|v| v.trim_end_matches("(Preferred)").trim().parse().ok());
        } else if trimmed.starts_with("Subnet Mask") {
            mask = value(trimmed).and_then(|v| v.parse().ok());
        } else if trimmed.starts_with("Default Gateway") {
            gateway = value(trimmed).is_some_and(|v| v.parse::<Ipv4Addr>().is_ok());
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
