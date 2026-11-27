//! The mobile `CameraState` (`Apps/Mobile/src/camera/types.ts`), built in Rust from the
//! core's [`Status`].
//!
//! The Tauri app emits this on `camera://state`. The shape is the contract the Expo screens
//! already read, so the desktop session is a thin merge on the web side. Every value is
//! what the body reported, decoded by the Swift core; labels and ladders come from
//! `opc_camera::capture` (the core's tables), never a second copy.
//!
//! [`StateThrottle`] is the replacement for the Slint chrome's 4 Hz status cap: at most
//! 5 Hz, except that a change to an *immediate* field (REC, phase, format, colour, zoom,
//! shooting mode, battery crossing 20 %) goes at once.

use opc_camera::capture::{self, color, mode};
use opc_camera::Status;
use serde::Serialize;

use crate::zoom::ZoomPolicy;

/// `CameraModelId` for a model id the body announced.
pub fn model_name(model_id: Option<i32>) -> &'static str {
    match model_id {
        Some(0x20) => "osmo-pocket-3",
        Some(0x21) => "osmo-pocket-4",
        Some(0x22) => "osmo-pocket-4-pro",
        Some(0x19) => "osmo-nano",
        _ => "unknown",
    }
}

/// `ColorMode` for a semantic colour code from the core.
pub fn color_mode_name(code: u8) -> &'static str {
    match code {
        color::HDR => "hlg",
        color::D_LOG => "dlog",
        color::D_LOG2 => "dlog2",
        color::NORMAL_10 => "10bit",
        color::D_LOG_M => "dlog-m",
        _ => "normal",
    }
}

/// The colour code for a `ColorMode` name.
pub fn color_mode_code(name: &str) -> Option<u8> {
    Some(match name {
        "normal" => color::NORMAL,
        "hlg" => color::HDR,
        "dlog" => color::D_LOG,
        "dlog2" => color::D_LOG2,
        "10bit" => color::NORMAL_10,
        "dlog-m" => color::D_LOG_M,
        _ => return None,
    })
}

/// The desktop mode strip, in its order, as `ShootingMode` names and core codes.
pub const SHOOTING_MODES: [(&str, u8); 6] = [
    ("timelapse", mode::TIME_LAPSE),
    ("slow-motion", mode::SLOW_MO),
    ("night", mode::SUPER_NIGHT),
    ("video", mode::VIDEO),
    ("photo", mode::PHOTO),
    ("hyperlapse", mode::HYPER_LAPSE),
];

/// `ShootingMode` for the code the body reported. Live Photo and the Pocket 3's `0x05`
/// read as photo, as on the desktop strip.
pub fn shooting_mode_name(code: Option<i32>) -> &'static str {
    let Some(code) = code.and_then(|code| u8::try_from(code).ok()) else {
        return "unknown";
    };
    if capture::mode_is_photo(code) {
        return "photo";
    }
    SHOOTING_MODES
        .iter()
        .find(|(_, candidate)| *candidate == code)
        .map_or("unknown", |(name, _)| name)
}

/// The connection spine as the Rust backend sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionState {
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub transport: &'static str,
    pub link_band: &'static str,
    pub signal_bars: u8,
    pub video_fps: f32,
    pub video_kbps: f32,
    pub last_frame_age_ms: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_codec: Option<&'static str>,
}

impl Default for ConnectionState {
    fn default() -> Self {
        Self {
            phase: "idle",
            detail: None,
            error: None,
            transport: "none",
            link_band: "stable",
            signal_bars: 0,
            video_fps: 0.0,
            video_kbps: 0.0,
            last_frame_age_ms: 0.0,
            stream_width: None,
            stream_height: None,
            stream_codec: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub name: &'static str,
    pub model: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub recording: bool,
    pub elapsed_sec: i32,
    pub remaining_sec: i32,
    pub countdown: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timecode: Option<String>,
    pub capturing_still: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exposure {
    pub mode: &'static str,
    pub iso: Option<i32>,
    pub iso_auto: bool,
    pub iso_options: Vec<u32>,
    pub shutter_denom: Option<i32>,
    pub shutter_auto: bool,
    pub shutter_options: Vec<i32>,
    pub ev: f64,
    pub ev_options: Vec<f64>,
    pub metered_ev: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhiteBalance {
    pub preset: &'static str,
    pub kelvin: Option<i32>,
    pub tint: Option<i32>,
    pub kelvin_min: i32,
    pub kelvin_max: i32,
    pub kelvin_step: i32,
    pub tint_min: i32,
    pub tint_max: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatOption {
    pub resolution: String,
    pub width: u32,
    pub height: u32,
    pub fps: Vec<u32>,
    pub aspect: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Format {
    pub shooting_mode: &'static str,
    pub shooting_mode_options: Vec<&'static str>,
    pub resolution: String,
    pub fps: u32,
    pub aspect: &'static str,
    pub options: Vec<FormatOption>,
    pub color_mode: &'static str,
    pub color_mode_options: Vec<&'static str>,
    pub codec: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Focus {
    pub mode: &'static str,
    pub x: f32,
    pub y: f32,
    pub has_point: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Zoom {
    pub factor: f64,
    pub stops: Vec<f64>,
    pub min: f64,
    pub max: f64,
    pub optical_max: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    pub status: &'static str,
    pub leg_seconds: [f64; 2],
    pub smoothness: f64,
    pub progress: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gimbal {
    pub available: bool,
    pub mode: &'static str,
    pub mode_options: Vec<&'static str>,
    pub speed: &'static str,
    pub face: &'static str,
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    pub locked_all_axes: bool,
    pub recentering: bool,
    pub program: Program,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracking {
    pub available: bool,
    pub status: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Power {
    pub battery_percent: i32,
    pub charging: bool,
    pub docked: bool,
    pub storage_free_mb: i32,
    pub storage_total_mb: i32,
    pub sd_present: bool,
    pub thermal: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    pub rms_db: f32,
    pub peak_db: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    pub left: Meter,
    pub right: Meter,
    pub channel: &'static str,
    pub source: &'static str,
    pub wind_reduction: bool,
    pub directional: &'static str,
    pub vocal_boost: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Level {
    pub roll: f64,
    pub pitch: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub zoom: bool,
    pub gimbal: bool,
    pub tracking: bool,
    pub selfie_flip: bool,
    pub aperture: bool,
    pub manual_focus: bool,
    pub audio_controls: bool,
    pub media: bool,
    pub timecode: bool,
}

/// The whole mobile `CameraState`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraState {
    pub identity: Option<Identity>,
    pub connection: ConnectionState,
    pub recording: Recording,
    pub exposure: Exposure,
    pub white_balance: WhiteBalance,
    pub format: Format,
    pub focus: Focus,
    pub zoom: Zoom,
    pub gimbal: Gimbal,
    pub tracking: Tracking,
    pub power: Power,
    pub audio: Audio,
    pub level: Level,
    pub capabilities: Capabilities,
}

/// What the camera is set to that the body does not report back (the shell's `Prefs`
/// keeps these as last commanded).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Commanded {
    /// The gimbal mode last asked for: the heartbeat cannot tell tilt-locked from follow.
    pub tilt_locked: bool,
    /// `0x02` slow, `0x01` default, `0x00` fast.
    pub gimbal_speed: Option<u8>,
}

/// `CameraCapabilities` for a model, matching `capabilitiesFor` on the phones.
pub fn capabilities(model: &str) -> Capabilities {
    let pocket = model.starts_with("osmo-pocket");
    Capabilities {
        zoom: model != "osmo-nano",
        gimbal: pocket,
        tracking: pocket,
        selfie_flip: pocket,
        aperture: model == "osmo-action-6",
        manual_focus: model != "osmo-nano",
        audio_controls: true,
        media: true,
        timecode: model != "osmo-nano",
    }
}

/// `1080p`, `2.7K 4:3`: the size, then the aspect when it is not 16:9.
fn split_label(label: &str) -> (String, &'static str) {
    let mut words = label.split_whitespace();
    let size = words.next().unwrap_or("").to_string();
    let aspect = match words.next() {
        Some("4:3") => "4:3",
        Some("1:1") => "1:1",
        Some("9:16") => "9:16",
        Some("3:2") => "3:2",
        _ => "16:9",
    };
    (size, aspect)
}

/// A nominal raster for a size label. The body never reports pixels; the phones use the
/// same nominal sizes for their picker.
fn raster(size: &str, aspect: &str) -> (u32, u32) {
    let long = match size {
        "4K" | "2160p" => 3840,
        "3K" => 2880,
        "2.7K" => 2688,
        "1080p" => 1920,
        "720p" => 1280,
        _ => 1920,
    };
    let (w, h) = match aspect {
        "4:3" => (long, long * 3 / 4),
        "1:1" => (long * 9 / 16, long * 9 / 16),
        "9:16" => (long * 9 / 16, long),
        "3:2" => (long, long * 2 / 3),
        _ => (long, long * 9 / 16),
    };
    (w, h)
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Builds the state from the body's status. `connection` is the backend's own view of the
/// link; `commanded` what it last asked for that the body does not echo.
pub fn camera_state(
    status: &Status,
    model_id: Option<i32>,
    connection: ConnectionState,
    commanded: Commanded,
    zoom_policy: &dyn ZoomPolicy,
) -> CameraState {
    let model = model_name(model_id);
    let model_code = model_id.unwrap_or(-1);
    let connected = !matches!(connection.phase, "idle" | "disconnected");

    // ISO and its ladder are read in the colour the picture is in; photo modes are Rec.709.
    let photo = status
        .shooting_mode
        .and_then(|code| u8::try_from(code).ok())
        .is_some_and(capture::mode_is_photo);
    let color_code = status.color_mode.unwrap_or(color::NORMAL);
    let iso_color = if photo { color::NORMAL } else { color_code };
    let manual = status.expo_mode == Some(0x04);
    let iso_options: Vec<u32> = capture::iso_indices(iso_color, &status.available_iso)
        .into_iter()
        .filter(|index| *index != capture::iso::AUTO)
        .filter_map(capture::iso_index_value)
        .collect();
    let iso_auto = status
        .iso_index
        .map_or(!manual, |index| index == capture::iso::AUTO);

    let kelvin = status.white_balance_kelvin.filter(|kelvin| *kelvin > 0);

    let (resolution, aspect) = status
        .video_resolution
        .map(|code| split_label(&capture::resolution_label(code)))
        .unwrap_or_else(|| (String::new(), "16:9"));
    let fps = status
        .video_frame_rate
        .and_then(capture::frame_rate_fps)
        .unwrap_or(0);
    let mut options: Vec<FormatOption> = Vec::new();
    for (res, rate) in capture::format_picker(
        &status.available_formats,
        model_code,
        status.shooting_mode.unwrap_or(-1),
    ) {
        let (size, aspect) = split_label(&capture::resolution_label(res));
        let Some(rate) = capture::frame_rate_fps(rate) else {
            continue;
        };
        match options
            .iter_mut()
            .find(|option| option.resolution == size && option.aspect == aspect)
        {
            Some(option) => {
                if !option.fps.contains(&rate) {
                    option.fps.push(rate);
                }
            }
            None => {
                let (width, height) = raster(&size, aspect);
                options.push(FormatOption {
                    resolution: size,
                    width,
                    height,
                    fps: vec![rate],
                    aspect,
                });
            }
        }
    }

    let stops = zoom_policy.stops(model_code, status.video_resolution, status.shooting_mode);
    let stops = if stops.is_empty() { vec![1.0] } else { stops };
    let zoom_max = stops.iter().copied().fold(1.0_f64, f64::max);

    let gimbal_mode = match status.gimbal_mode_family {
        Some(0) => "locked",
        Some(1) => "fpv",
        _ if commanded.tilt_locked => "tilt-locked",
        _ => "follow",
    };
    let tenth = |value: Option<i16>| value.map_or(0.0, |v| f64::from(v) / 10.0);

    let meters = status.audio_meters.map(|meters| meters.decibels());
    let meter = |level: usize, peak: usize| Meter {
        rms_db: meters.map_or(-120.0, |m| m[level]),
        peak_db: meters.map_or(-120.0, |m| m[peak]),
    };

    CameraState {
        identity: connected.then(|| Identity {
            id: format!("desktop-{model}"),
            name: crate::appsettings::model_label(model_id),
            model,
            firmware: status.firmware.clone(),
        }),
        connection,
        recording: Recording {
            recording: status.is_recording,
            elapsed_sec: status.record_elapsed.max(0),
            remaining_sec: if status.record_remaining > 0 {
                status.record_remaining
            } else {
                -1
            },
            countdown: None,
            timecode: status.timecode.clone(),
            capturing_still: false,
        },
        exposure: Exposure {
            mode: if manual { "manual" } else { "auto" },
            iso: status.iso,
            iso_auto,
            iso_options,
            shutter_denom: status.shutter_denominator,
            shutter_auto: !manual,
            shutter_options: capture::shutter_wheel(
                &status.available_shutter,
                status.shutter_denominator,
            ),
            ev: round1(f64::from(status.ev_thirds.unwrap_or(0)) / 3.0),
            ev_options: (-9..=9)
                .map(|third| round1(f64::from(third) / 3.0))
                .collect(),
            metered_ev: None,
        },
        white_balance: WhiteBalance {
            preset: if kelvin.is_some() { "custom" } else { "auto" },
            kelvin,
            tint: status.white_balance_tint,
            kelvin_min: 2000,
            kelvin_max: 10000,
            kelvin_step: 250,
            tint_min: -100,
            tint_max: 100,
        },
        format: Format {
            shooting_mode: shooting_mode_name(status.shooting_mode),
            shooting_mode_options: SHOOTING_MODES.iter().map(|(name, _)| *name).collect(),
            resolution,
            fps,
            aspect,
            options,
            color_mode: color_mode_name(color_code),
            color_mode_options: capture::color_modes(model_code, &status.available_colors)
                .into_iter()
                .map(color_mode_name)
                .collect(),
            codec: "h265",
        },
        focus: Focus {
            mode: match status.focus_mode.map(|code| code & 0x0F) {
                Some(0x01) => "afs",
                _ => "afc",
            },
            x: 0.5,
            y: 0.5,
            has_point: false,
        },
        zoom: Zoom {
            factor: status
                .zoom_hundredths
                .map_or(1.0, |hundredths| f64::from(hundredths) / 100.0),
            stops,
            min: 1.0,
            max: zoom_max,
            optical_max: 1.0,
        },
        gimbal: Gimbal {
            available: capabilities(model).gimbal,
            mode: gimbal_mode,
            mode_options: vec!["follow", "tilt-locked", "fpv", "locked"],
            speed: match commanded.gimbal_speed {
                Some(0x02) => "slow",
                Some(0x00) => "fast",
                _ => "normal",
            },
            face: "front",
            yaw: tenth(status.gimbal_yaw_tenth),
            pitch: tenth(status.gimbal_pitch_tenth),
            roll: 0.0,
            locked_all_axes: false,
            recentering: false,
            program: Program {
                status: "idle",
                leg_seconds: [5.0, 5.0],
                smoothness: 0.5,
                progress: 0.0,
            },
        },
        tracking: Tracking {
            available: capabilities(model).tracking,
            status: "idle",
        },
        power: Power {
            battery_percent: status.battery_percent.unwrap_or(0),
            charging: status.charging,
            docked: status.docked,
            storage_free_mb: status.storage_free_mb,
            storage_total_mb: status.storage_total_mb,
            sd_present: status.storage_total_mb > 0,
            thermal: "normal",
        },
        audio: Audio {
            left: meter(0, 2),
            right: meter(1, 3),
            channel: if status.audio_channel == Some(0x01) {
                "mono"
            } else {
                "stereo"
            },
            source: "internal",
            wind_reduction: status.wind_nr == Some(0x1A),
            directional: match status.directional_audio {
                Some(0x3A) => "front",
                Some(0xBA) => "surround",
                _ => "off",
            },
            vocal_boost: status.vocal_boost == Some(0x01),
        },
        level: Level {
            roll: 0.0,
            pitch: tenth(status.gimbal_pitch_tenth),
        },
        capabilities: capabilities(model),
    }
}

/// The fields that skip the 5 Hz throttle: an operator must see these the moment the
/// body says them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Immediate {
    phase: &'static str,
    recording: bool,
    format: (Option<u8>, Option<u8>),
    color: Option<u8>,
    zoom: Option<i32>,
    mode: Option<i32>,
    battery_critical: bool,
    error: Option<String>,
}

impl Immediate {
    pub fn of(status: &Status, connection: &ConnectionState) -> Self {
        Self {
            phase: connection.phase,
            recording: status.is_recording,
            format: (status.video_resolution, status.video_frame_rate),
            color: status.color_mode,
            zoom: status.zoom_hundredths,
            mode: status.shooting_mode,
            battery_critical: status.battery_percent.is_some_and(|percent| percent <= 20),
            error: connection.error.clone(),
        }
    }
}

/// At most 5 Hz, immediate fields at once (docs/desktop-expo-port.md §3.5, P19).
#[derive(Debug, Clone)]
pub struct StateThrottle {
    interval: f64,
    last_emit: f64,
    last_immediate: Option<Immediate>,
    dirty: bool,
}

/// `camera://state` cadence.
pub const STATE_INTERVAL: f64 = 0.2;

impl Default for StateThrottle {
    fn default() -> Self {
        Self::new(STATE_INTERVAL)
    }
}

impl StateThrottle {
    pub fn new(interval: f64) -> Self {
        Self {
            interval,
            last_emit: f64::NEG_INFINITY,
            last_immediate: None,
            dirty: false,
        }
    }

    /// Something changed. True when the state should be emitted now.
    pub fn offer(&mut self, immediate: Immediate, now: f64) -> bool {
        let urgent = self.last_immediate.as_ref() != Some(&immediate);
        self.last_immediate = Some(immediate);
        if urgent || now - self.last_emit >= self.interval {
            self.last_emit = now;
            self.dirty = false;
            return true;
        }
        self.dirty = true;
        false
    }

    /// A held change whose window has passed. True when it should be emitted now.
    pub fn due(&mut self, now: f64) -> bool {
        if self.dirty && now - self.last_emit >= self.interval {
            self.last_emit = now;
            self.dirty = false;
            return true;
        }
        false
    }

    /// How long until [`due`](Self::due) could fire, for a thread's wait.
    pub fn wait(&self, now: f64) -> Option<f64> {
        self.dirty
            .then(|| (self.last_emit + self.interval - now).max(0.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zoom::Assumed;

    fn live() -> ConnectionState {
        ConnectionState {
            phase: "live",
            transport: "softap",
            ..ConnectionState::default()
        }
    }

    #[test]
    fn the_state_has_the_mobile_shape() {
        let status = Status {
            battery_percent: Some(64),
            is_recording: true,
            record_elapsed: 12,
            record_remaining: 0,
            iso: Some(400),
            ev_thirds: Some(-2),
            shutter_denominator: Some(50),
            video_resolution: Some(0x10),
            video_frame_rate: Some(0x02),
            color_mode: Some(color::D_LOG_M),
            expo_mode: Some(0x04),
            white_balance_kelvin: Some(5600),
            zoom_hundredths: Some(250),
            gimbal_mode_family: Some(1),
            ..Status::default()
        };
        let state = camera_state(&status, Some(0x20), live(), Commanded::default(), &Assumed);
        let json = serde_json::to_value(&state).expect("serialises");
        for key in [
            "identity",
            "connection",
            "recording",
            "exposure",
            "whiteBalance",
            "format",
            "focus",
            "zoom",
            "gimbal",
            "tracking",
            "power",
            "audio",
            "level",
            "capabilities",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert_eq!(json["identity"]["model"], "osmo-pocket-3");
        assert_eq!(json["recording"]["recording"], true);
        assert_eq!(json["recording"]["remainingSec"], -1);
        assert_eq!(json["exposure"]["mode"], "manual");
        assert_eq!(json["exposure"]["ev"], -0.7);
        assert_eq!(json["format"]["resolution"], "4K");
        assert_eq!(json["format"]["fps"], 25);
        assert_eq!(json["format"]["colorMode"], "dlog-m");
        assert_eq!(json["whiteBalance"]["preset"], "custom");
        assert_eq!(json["zoom"]["factor"], 2.5);
        assert_eq!(json["gimbal"]["mode"], "fpv");
        assert_eq!(json["capabilities"]["gimbal"], true);
        assert_eq!(json["connection"]["phase"], "live");
    }

    #[test]
    fn an_idle_link_has_no_identity() {
        let state = camera_state(
            &Status::default(),
            None,
            ConnectionState::default(),
            Commanded::default(),
            &Assumed,
        );
        assert!(state.identity.is_none());
        assert_eq!(state.format.shooting_mode, "unknown");
    }

    #[test]
    fn shooting_modes_and_colours_round_trip_through_their_names() {
        for (name, code) in SHOOTING_MODES {
            assert_eq!(shooting_mode_name(Some(i32::from(code))), name);
        }
        for name in ["normal", "hlg", "dlog", "dlog2", "10bit", "dlog-m"] {
            assert_eq!(color_mode_name(color_mode_code(name).expect("known")), name);
        }
    }

    #[test]
    fn the_throttle_holds_ordinary_changes_to_5_hz_and_lets_rec_through() {
        let mut throttle = StateThrottle::default();
        let mut status = Status::default();
        let connection = live();
        assert!(
            throttle.offer(Immediate::of(&status, &connection), 0.0),
            "first goes"
        );
        status.iso = Some(800);
        assert!(
            !throttle.offer(Immediate::of(&status, &connection), 0.05),
            "held"
        );
        assert_eq!(throttle.wait(0.05).map(|w| (w * 100.0).round()), Some(15.0));
        assert!(!throttle.due(0.1));
        assert!(throttle.due(0.2), "flushed at the window");
        status.is_recording = true;
        assert!(
            throttle.offer(Immediate::of(&status, &connection), 0.21),
            "REC is immediate"
        );
    }
}
