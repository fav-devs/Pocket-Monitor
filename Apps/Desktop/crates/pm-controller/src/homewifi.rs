//! The camera on the operator's own Wi-Fi: what the desktop remembers about it, and how
//! it reads the machine's networks. Bluetooth and the LAN search live in the binary;
//! this is the part with no hardware in it.
//!
//! Also the other two remembered cameras (`docs/desktop-expo-port.md` X5–X7): the
//! camera's own Wi-Fi joined through a saved Windows profile (`desktop-camera-v1.txt`)
//! and a camera known only by its address (`desktop-lan-camera-v1.txt`). The formats are
//! the old viewfinder's, byte for byte, so both builds read each other's files.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;

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

/// The non-secret half of a camera paired over Bluetooth whose own Wi-Fi the PC joins.
/// Windows owns the WLAN profile and its protected password; this file only says which
/// saved profile to use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedCamera {
    pub ssid: String,
    pub model_id: Option<i32>,
}

const CAMERA_HEADER: &str = "openpocketcine-desktop-camera-v1";

impl SavedCamera {
    /// The file's text; None for an SSID the file cannot hold.
    pub fn to_text(&self) -> Option<String> {
        if self.ssid.is_empty() || self.ssid.contains(['\r', '\n']) {
            return None;
        }
        let model = self.model_id.map_or_else(String::new, |id| id.to_string());
        Some(format!(
            "{CAMERA_HEADER}\nssid={}\nmodel={model}\n",
            self.ssid
        ))
    }

    pub fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        if lines.next()? != CAMERA_HEADER {
            return None;
        }
        let ssid = lines.next()?.strip_prefix("ssid=")?.to_string();
        if ssid.is_empty() {
            return None;
        }
        let model_id = lines
            .next()
            .and_then(|line| line.strip_prefix("model="))
            .and_then(|value| value.parse().ok());
        Some(Self { ssid, model_id })
    }
}

/// A camera remembered by its address alone, from `--camera` or *Connect by address*.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LanCamera {
    pub ip: Ipv4Addr,
    pub model_id: Option<i32>,
}

impl LanCamera {
    pub fn to_text(&self) -> String {
        let model = self.model_id.map(|m| m.to_string()).unwrap_or_default();
        format!("{}\n{model}\n", self.ip)
    }

    pub fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        let ip = lines.next()?.trim().parse().ok()?;
        let model_id = lines.next().and_then(|l| l.trim().parse().ok());
        Some(Self { ip, model_id })
    }

    /// Where the viewfinder links it.
    pub fn address(&self) -> SocketAddr {
        SocketAddr::from((self.ip, DATALINK_PORT))
    }
}

/// The camera's datalink port, the default for an address typed without one.
pub const DATALINK_PORT: u16 = 9004;
/// The port a powered camera answers TCP on; the reachability probe knocks here.
pub const PROBE_PORT: u16 = 7001;
/// The camera's own address on its SoftAP.
pub const SOFTAP_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 2, 1);

/// What *Connect by address* says to something that is not one.
pub const NOT_AN_ADDRESS: &str = "That isn't an address. Try something like 10.0.0.213.";

/// `10.0.0.5` or `10.0.0.5:9004`; the datalink port is the default.
pub fn parse_camera_address(text: &str) -> Result<SocketAddr, &'static str> {
    let text = text.trim();
    if let Ok(address) = text.parse::<SocketAddr>() {
        return Ok(address);
    }
    text.parse::<Ipv4Addr>()
        .map(|ip| SocketAddr::from((ip, DATALINK_PORT)))
        .map_err(|_| NOT_AN_ADDRESS)
}

/// A camera reached at `address` is worth remembering as the LAN camera: not loopback
/// (a capture or a fake camera) and not the camera's own SoftAP address (B1).
pub fn remembers_as_lan(address: SocketAddr) -> Option<LanCamera> {
    match address {
        SocketAddr::V4(v4) if !v4.ip().is_loopback() && *v4.ip() != SOFTAP_IP => Some(LanCamera {
            ip: *v4.ip(),
            model_id: None,
        }),
        _ => None,
    }
}

/// The SoftAP datalink address.
pub fn softap_address() -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(SOFTAP_IP, DATALINK_PORT))
}

/// Whether `ipconfig` shows an address on the camera's own network (DHCP gives
/// 192.168.2.2 through .254): the PC is on the camera's Wi-Fi.
pub fn on_camera_subnet(ipconfig: &str) -> bool {
    ipconfig.split_whitespace().any(|word| {
        word.trim_matches(|c: char| !c.is_ascii_digit() && c != '.')
            .starts_with("192.168.2.")
    })
}

/// Whether `netsh wlan show profiles` lists a profile for `ssid` (the old app's test).
pub fn profile_listed(netsh_profiles: &str, ssid: &str) -> bool {
    !ssid.is_empty() && netsh_profiles.contains(ssid)
}

/// The three remembered-camera files, in the shared data folder.
pub fn softap_path() -> PathBuf {
    crate::platform::data_dir().join("desktop-camera-v1.txt")
}

pub fn station_path() -> PathBuf {
    crate::platform::data_dir().join("desktop-station-v1.txt")
}

pub fn lan_path() -> PathBuf {
    crate::platform::data_dir().join("desktop-lan-camera-v1.txt")
}

fn write_creating(path: &std::path::Path, text: &str) -> Result<(), String> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, text).map_err(|error| error.to_string())
}

pub fn load_softap() -> Option<SavedCamera> {
    SavedCamera::parse(&std::fs::read_to_string(softap_path()).ok()?)
}

pub fn save_softap(camera: &SavedCamera) -> Result<(), String> {
    let text = camera
        .to_text()
        .ok_or("the camera returned an invalid Wi-Fi name")?;
    write_creating(&softap_path(), &text)
}

pub fn load_station() -> Option<SavedStation> {
    SavedStation::parse(&std::fs::read_to_string(station_path()).ok()?)
}

pub fn save_station(station: &SavedStation) -> Result<(), String> {
    write_creating(&station_path(), &station.to_text())
}

pub fn load_lan() -> Option<LanCamera> {
    LanCamera::parse(&std::fs::read_to_string(lan_path()).ok()?)
}

pub fn save_lan(camera: &LanCamera) -> Result<(), String> {
    write_creating(&lan_path(), &camera.to_text())
}

/// Forgets one remembered camera. Nothing the camera itself holds changes.
pub fn forget(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
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

    #[test]
    fn the_softap_camera_file_is_the_old_viewfinders() {
        let camera = SavedCamera {
            ssid: "OsmoPocket3-1A2B".into(),
            model_id: Some(0x20),
        };
        let text = camera.to_text().expect("a name the file holds");
        assert_eq!(
            text,
            "openpocketcine-desktop-camera-v1\nssid=OsmoPocket3-1A2B\nmodel=32\n"
        );
        assert!(!text.to_ascii_lowercase().contains("password"));
        assert_eq!(SavedCamera::parse(&text), Some(camera));
        assert_eq!(
            SavedCamera::parse("openpocketcine-desktop-camera-v1\nssid=Cam\n"),
            Some(SavedCamera {
                ssid: "Cam".into(),
                model_id: None
            })
        );
        assert_eq!(SavedCamera::parse("junk\nssid=Cam\n"), None);
        assert_eq!(
            SavedCamera::parse("openpocketcine-desktop-camera-v1\nssid=\n"),
            None
        );
        let broken = SavedCamera {
            ssid: "a\nb".into(),
            model_id: None,
        };
        assert_eq!(broken.to_text(), None);
    }

    #[test]
    fn the_lan_camera_file_is_the_old_viewfinders() {
        let camera = LanCamera {
            ip: Ipv4Addr::new(10, 0, 0, 213),
            model_id: Some(0x20),
        };
        assert_eq!(camera.to_text(), "10.0.0.213\n32\n");
        assert_eq!(LanCamera::parse(&camera.to_text()), Some(camera));
        assert_eq!(
            LanCamera::parse("10.0.0.9\n\n").map(|c| c.model_id),
            Some(None)
        );
        assert_eq!(LanCamera::parse("not an ip\n"), None);
        assert_eq!(camera.address().to_string(), "10.0.0.213:9004");
    }

    #[test]
    fn connect_by_address_takes_an_ip_with_or_without_a_port() {
        assert_eq!(
            parse_camera_address(" 10.0.0.5 ").unwrap().to_string(),
            "10.0.0.5:9004"
        );
        assert_eq!(
            parse_camera_address("10.0.0.5:9100").unwrap().to_string(),
            "10.0.0.5:9100"
        );
        assert_eq!(parse_camera_address("camera.local"), Err(NOT_AN_ADDRESS));
        assert_eq!(parse_camera_address(""), Err(NOT_AN_ADDRESS));
    }

    #[test]
    fn only_a_real_lan_address_is_remembered() {
        let lan = |text: &str| remembers_as_lan(text.parse().unwrap()).map(|c| c.ip);
        assert_eq!(lan("10.0.0.5:9004"), Some(Ipv4Addr::new(10, 0, 0, 5)));
        assert_eq!(lan("192.168.2.1:9004"), None, "the SoftAP address");
        assert_eq!(lan("127.0.0.1:9004"), None, "a capture or a fake camera");
        assert_eq!(softap_address().to_string(), "192.168.2.1:9004");
    }

    #[test]
    fn the_camera_subnet_and_saved_profiles_are_read_from_the_tools() {
        let ipconfig = "   IPv4 Address. . . . . . . . . . . : 192.168.2.23(Preferred)\n";
        assert!(on_camera_subnet(ipconfig));
        assert!(!on_camera_subnet(
            "   IPv4 Address. . . . . . . . . . . : 192.168.1.23(Preferred)\n"
        ));
        let profiles =
            "User profiles\n-------------\n    All User Profile     : OsmoPocket3-1A2B\n";
        assert!(profile_listed(profiles, "OsmoPocket3-1A2B"));
        assert!(!profile_listed(profiles, "Home"));
        assert!(!profile_listed(profiles, ""));
    }
}
