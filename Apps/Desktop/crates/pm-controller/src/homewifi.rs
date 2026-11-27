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

/// The file's first line: a format tag, not a name users see. Kept as it was so the old
/// viewfinder and this app read each other's files (and a migrated copy) unchanged.
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

/// The format tag, as [`HEADER`].
const HOME_HEADER: &str = "openpocketcine-desktop-homewifi-v1";

impl HomeNetwork {
    pub fn to_text(&self) -> String {
        let sealed: String = self
            .sealed_password
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
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

/// The non-secret half of a camera paired over Bluetooth whose own Wi-Fi the PC joins.
/// Windows owns the WLAN profile and its protected password; this file only says which
/// saved profile to use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedCamera {
    pub ssid: String,
    pub model_id: Option<i32>,
}

/// The format tag, as [`HEADER`].
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

// ---- The home Wi-Fi the operator asked to keep ----------------------------------------

/// `desktop-homewifi-v1.txt`, beside the station file: the home network's name and its
/// password sealed to this user. The password itself is never written in the clear.
pub fn home_path() -> PathBuf {
    crate::platform::data_dir().join("desktop-homewifi-v1.txt")
}

/// The network the operator asked to keep, with its password when it could be read back
/// (an empty password otherwise: other platforms keep the name only, and a file sealed
/// for another Windows user does not open).
pub fn load_home() -> Option<(String, String)> {
    let home = HomeNetwork::parse(&std::fs::read_to_string(home_path()).ok()?)?;
    let password = if home.sealed_password.is_empty() {
        String::new()
    } else {
        unseal_password(&home.sealed_password)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_default()
    };
    Some((home.ssid, password))
}

/// Keeps the network for next time. Where the password cannot be sealed only the name is
/// kept, and the operator is asked for the password again.
pub fn save_home(ssid: &str, password: &str) -> Result<(), String> {
    let home = HomeNetwork {
        ssid: ssid.to_string(),
        sealed_password: if password.is_empty() {
            Vec::new()
        } else {
            seal_password(password.as_bytes()).unwrap_or_default()
        },
    };
    write_creating(&home_path(), &home.to_text())
}

pub fn forget_home() {
    forget(&home_path());
}

/// What the web may know about the kept home network: its name, and whether a password
/// for it can be read back. Never the password itself.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeWifiSummary {
    pub ssid: String,
    pub has_password: bool,
}

impl HomeNetwork {
    /// `has_password` is true only when `unseal` opens the sealed password: a file sealed
    /// for another Windows user, or on a platform that cannot seal, has none to offer.
    pub fn summary(&self, unseal: impl Fn(&[u8]) -> Option<Vec<u8>>) -> HomeWifiSummary {
        let has_password = !self.sealed_password.is_empty()
            && unseal(&self.sealed_password).is_some_and(|plain| !plain.is_empty());
        HomeWifiSummary {
            ssid: self.ssid.clone(),
            has_password,
        }
    }
}

/// The kept home network as the web sees it.
pub fn home_summary() -> Option<HomeWifiSummary> {
    let home = HomeNetwork::parse(&std::fs::read_to_string(home_path()).ok()?)?;
    Some(home.summary(unseal_password))
}

/// The password a station join sends: the one typed, or, when none was typed, the kept
/// one if it is for this network. An open network (nothing typed, nothing kept) is empty.
pub fn station_password(typed: Option<&str>, ssid: &str, kept: Option<(String, String)>) -> String {
    match typed {
        Some(password) if !password.is_empty() => password.to_string(),
        _ => kept
            .filter(|(kept_ssid, _)| kept_ssid == ssid)
            .map(|(_, password)| password)
            .unwrap_or_default(),
    }
}

/// Seals `plain` to this Windows user with DPAPI (`CryptProtectData`).
#[cfg(windows)]
pub fn seal_password(plain: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(plain.len()).ok()?,
        pbData: plain.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: `input` points at `plain` for the call; on success the system allocates
    // `output`, which is copied out and then freed.
    unsafe {
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        );
        if ok == 0 || output.pbData.is_null() {
            return None;
        }
        let sealed = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        Some(sealed)
    }
}

/// Opens what [`seal_password`] sealed (`CryptUnprotectData`).
#[cfg(windows)]
pub fn unseal_password(sealed: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(sealed.len()).ok()?,
        pbData: sealed.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: as in `seal_password`.
    unsafe {
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        );
        if ok == 0 || output.pbData.is_null() {
            return None;
        }
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        Some(plain)
    }
}

// Other platforms keep the name only; the password is asked for each time.
#[cfg(not(windows))]
pub fn seal_password(_plain: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
pub fn unseal_password(_sealed: &[u8]) -> Option<Vec<u8>> {
    None
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
    fn the_web_learns_the_kept_network_name_and_whether_a_password_opens() {
        let home = HomeNetwork {
            ssid: "Home Net".into(),
            sealed_password: vec![9, 9, 9],
        };
        let opens = |_: &[u8]| Some(b"hunter22".to_vec());
        let refuses = |_: &[u8]| None;
        assert_eq!(
            home.summary(opens),
            HomeWifiSummary {
                ssid: "Home Net".into(),
                has_password: true
            }
        );
        assert!(!home.summary(refuses).has_password);
        let name_only = HomeNetwork {
            sealed_password: Vec::new(),
            ..home
        };
        assert!(!name_only.summary(opens).has_password);
        let json = serde_json::to_string(&name_only.summary(opens)).unwrap();
        assert_eq!(json, r#"{"ssid":"Home Net","hasPassword":false}"#);
    }

    #[test]
    fn a_station_join_uses_the_typed_password_else_the_kept_one_for_that_network() {
        let kept = || Some(("Home".to_string(), "kept-secret".to_string()));
        assert_eq!(
            station_password(Some("typed-one"), "Home", kept()),
            "typed-one"
        );
        assert_eq!(station_password(None, "Home", kept()), "kept-secret");
        assert_eq!(station_password(Some(""), "Home", kept()), "kept-secret");
        assert_eq!(station_password(None, "Office", kept()), "");
        assert_eq!(station_password(None, "Home", None), "");
    }

    #[test]
    fn a_password_is_sealed_only_where_the_system_can_seal_it() {
        #[cfg(windows)]
        {
            let sealed = seal_password(b"hunter2").expect("DPAPI seals for this user");
            assert!(!sealed.windows(7).any(|w| w == b"hunter2"));
            assert_eq!(unseal_password(&sealed).as_deref(), Some(&b"hunter2"[..]));
        }
        #[cfg(not(windows))]
        {
            assert_eq!(seal_password(b"hunter2"), None);
            assert_eq!(unseal_password(&[1, 2, 3]), None);
        }
        assert!(home_path().ends_with("desktop-homewifi-v1.txt"));
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
            [(
                Ipv4Addr::new(10, 0, 0, 205),
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
