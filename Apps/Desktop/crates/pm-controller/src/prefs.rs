//! Where the desktop keeps what the operator set up: a plain `key=value` file next to
//! the LUT folder, read on start and written on every change.
//!
//! Only the operator's own settings live here — the things the body does not report
//! back, the assist toolbar's shape, the setup tabs. Nothing the camera says is
//! remembered; the camera is asked again.

use std::path::{Path, PathBuf};

use crate::assists::{AssistOptions, GuideFamily, PeakingColor, ZebraPaint};
use crate::luts::{self, LutChoice};
use crate::scopes::{NdNotation, ParadeMode, ScopeOptions, WaveMode};
use crate::toggles::Toggles;
use opc_render::{FalseColorScale, PeakingSense};

/// Settings the body does not report back, kept as last commanded, plus the desktop's
/// own overlays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prefs {
    /// `0x01` mono, `0x02` stereo, `0x03` spatial.
    pub audio_channel: u8,
    pub vocal_boost: u8,
    /// `0x01` wide, `0x05` natural.
    pub fov: u8,
    /// `0x02` slow, `0x01` default, `0x00` fast.
    pub gimbal_speed: u8,
    pub timecode: bool,
    /// The stick's first-order follow: 0 off, 1 soft, 2 medium.
    pub ramp: u8,
    /// The `T` take countdown, in seconds.
    pub countdown_seconds: u32,
    /// The phones' joystick sensitivity ticks, 1…5; 4 is the captured throw.
    pub stick_sensitivity: u8,
    /// Whether a game controller drives the shell.
    pub gamepad: bool,
    /// Which parts of the chrome are drawn (the phones' DISP toggles).
    pub show_exposure: bool,
    pub show_status: bool,
    pub show_zoom: bool,
    pub show_pad: bool,
    pub show_modes: bool,
    /// The viewfinder as a camera for other apps: 0 off, 1 a camera device, 2 the
    /// loopback MJPEG stream.
    pub vcam: u8,
    /// Send the picture without zebra, peaking or false colour on it.
    pub vcam_clean: bool,
    /// The stream's port on 127.0.0.1.
    pub vcam_port: u16,
    /// Read the shutter as an angle at the frame rate rather than 1/N.
    pub shutter_angle: bool,
}

/// A part of the chrome the Display tab can hide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Exposure,
    Status,
    Zoom,
    Pad,
    Modes,
}

impl Part {
    pub const ALL: [Self; 5] = [
        Self::Exposure,
        Self::Status,
        Self::Zoom,
        Self::Pad,
        Self::Modes,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Exposure => "Exposure plate",
            Self::Status => "Status plate",
            Self::Zoom => "Zoom ruler",
            Self::Pad => "Gimbal pad",
            Self::Modes => "Mode strip",
        }
    }
}

impl Prefs {
    pub fn shows(&self, part: Part) -> bool {
        match part {
            Part::Exposure => self.show_exposure,
            Part::Status => self.show_status,
            Part::Zoom => self.show_zoom,
            Part::Pad => self.show_pad,
            Part::Modes => self.show_modes,
        }
    }

    pub fn set_shows(&mut self, part: Part, on: bool) {
        match part {
            Part::Exposure => self.show_exposure = on,
            Part::Status => self.show_status = on,
            Part::Zoom => self.show_zoom = on,
            Part::Pad => self.show_pad = on,
            Part::Modes => self.show_modes = on,
        }
    }
}

impl Prefs {
    /// The ramp's time constant, as the mobile shells define it.
    pub fn ramp_tau(&self) -> f64 {
        match self.ramp {
            1 => 0.35,
            2 => 0.18,
            _ => 0.0,
        }
    }
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            audio_channel: 0x02,
            vocal_boost: 0x00,
            fov: 0x01,
            gimbal_speed: 0x01,
            timecode: false,
            ramp: 0,
            countdown_seconds: 3,
            stick_sensitivity: 4,
            gamepad: true,
            show_exposure: true,
            show_status: true,
            show_zoom: true,
            show_pad: true,
            show_modes: true,
            vcam: 0,
            vcam_clean: true,
            vcam_port: opc_vcam::DEFAULT_PORT,
            shutter_angle: false,
        }
    }
}

/// `<cache>/OpenPocketCine/desktop-prefs.txt`, beside the LUT folder.
pub fn path() -> PathBuf {
    luts::custom_folder()
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
        .join("desktop-prefs.txt")
}

impl Prefs {
    /// One `key=value` per line, in a fixed order.
    pub fn to_lines(&self) -> String {
        let mut out = String::new();
        let mut line = |key: &str, value: String| {
            out.push_str(key);
            out.push('=');
            out.push_str(&value);
            out.push('\n');
        };
        line("audio_channel", self.audio_channel.to_string());
        line("vocal_boost", self.vocal_boost.to_string());
        line("fov", self.fov.to_string());
        line("gimbal_speed", self.gimbal_speed.to_string());
        line("timecode", self.timecode.to_string());
        line("ramp", self.ramp.to_string());
        line("countdown_seconds", self.countdown_seconds.to_string());
        line("stick_sensitivity", self.stick_sensitivity.to_string());
        line("gamepad", self.gamepad.to_string());
        line("show_exposure", self.show_exposure.to_string());
        line("show_status", self.show_status.to_string());
        line("show_zoom", self.show_zoom.to_string());
        line("show_pad", self.show_pad.to_string());
        line("show_modes", self.show_modes.to_string());
        line("vcam", self.vcam.to_string());
        line("vcam_clean", self.vcam_clean.to_string());
        line("vcam_port", self.vcam_port.to_string());
        line("shutter_angle", self.shutter_angle.to_string());
        out
    }

    /// The defaults with every line that parses laid over them. A stray or unknown
    /// line is ignored rather than refused, so an older file still loads.
    pub fn from_lines(text: &str) -> Self {
        let mut prefs = Self::default();
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let value = value.trim();
            match key.trim() {
                "audio_channel" => {
                    prefs.audio_channel = value.parse().unwrap_or(prefs.audio_channel)
                }
                "vocal_boost" => prefs.vocal_boost = value.parse().unwrap_or(prefs.vocal_boost),
                "fov" => prefs.fov = value.parse().unwrap_or(prefs.fov),
                "gimbal_speed" => prefs.gimbal_speed = value.parse().unwrap_or(prefs.gimbal_speed),
                "timecode" => prefs.timecode = value.parse().unwrap_or(prefs.timecode),
                "ramp" => prefs.ramp = value.parse().unwrap_or(prefs.ramp),
                "countdown_seconds" => {
                    prefs.countdown_seconds = value.parse().unwrap_or(prefs.countdown_seconds)
                }
                "stick_sensitivity" => {
                    prefs.stick_sensitivity = value
                        .parse()
                        .map_or(prefs.stick_sensitivity, |v: u8| v.clamp(1, 5))
                }
                "gamepad" => prefs.gamepad = value.parse().unwrap_or(prefs.gamepad),
                "show_exposure" => prefs.show_exposure = value.parse().unwrap_or(true),
                "show_status" => prefs.show_status = value.parse().unwrap_or(true),
                "show_zoom" => prefs.show_zoom = value.parse().unwrap_or(true),
                "show_pad" => prefs.show_pad = value.parse().unwrap_or(true),
                "show_modes" => prefs.show_modes = value.parse().unwrap_or(true),
                "vcam" => prefs.vcam = value.parse().ok().filter(|v| *v <= 2).unwrap_or(0),
                "vcam_clean" => prefs.vcam_clean = value.parse().unwrap_or(true),
                "vcam_port" => {
                    prefs.vcam_port = value
                        .parse()
                        .ok()
                        .filter(|port| *port != 0)
                        .unwrap_or(opc_vcam::DEFAULT_PORT)
                }
                "shutter_angle" => prefs.shutter_angle = value.parse().unwrap_or(false),
                _ => {}
            }
        }
        prefs
    }
}

/// Everything the desktop remembers between runs: the setup prefs, which assists and
/// scopes are on and how they are set, and the cube in use. The phones remember all
/// of this too; an operator who set zebra to 95 IRE last night wants it there today.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Saved {
    pub prefs: Prefs,
    pub toggles: Toggles,
    pub assists: AssistOptions,
    pub scopes: ScopeOptions,
    pub lut: LutChoice,
}

fn name_of<T: PartialEq + Copy>(value: T, table: &[(T, &'static str)]) -> &'static str {
    table
        .iter()
        .find(|(candidate, _)| *candidate == value)
        .map_or("", |(_, name)| name)
}

fn value_of<T: Copy>(name: &str, table: &[(T, &'static str)], fallback: T) -> T {
    table
        .iter()
        .find(|(_, candidate)| *candidate == name)
        .map_or(fallback, |(value, _)| *value)
}

const SCALES: [(FalseColorScale, &str); 4] = [
    (FalseColorScale::Stops, "stops"),
    (FalseColorScale::Ire, "ire"),
    (FalseColorScale::Limits, "limits"),
    (FalseColorScale::ElZone, "el-zone"),
];
const PEAKING_COLORS: [(PeakingColor, &str); 4] = [
    (PeakingColor::White, "white"),
    (PeakingColor::Blue, "blue"),
    (PeakingColor::Red, "red"),
    (PeakingColor::Green, "green"),
];
const PEAKING_SENSES: [(PeakingSense, &str); 3] = [
    (PeakingSense::Low, "low"),
    (PeakingSense::Medium, "medium"),
    (PeakingSense::High, "high"),
];
const PAINTS: [(ZebraPaint, &str); 5] = [
    (ZebraPaint::White, "white"),
    (ZebraPaint::Amber, "amber"),
    (ZebraPaint::Red, "red"),
    (ZebraPaint::Cyan, "cyan"),
    (ZebraPaint::Green, "green"),
];
const FAMILIES: [(GuideFamily, &str); 2] =
    [(GuideFamily::Film, "film"), (GuideFamily::Social, "social")];
const WAVES: [(WaveMode, &str); 2] = [(WaveMode::Luma, "luma"), (WaveMode::Rgb, "rgb")];
const PARADES: [(ParadeMode, &str); 2] = [(ParadeMode::Rgb, "rgb"), (ParadeMode::Yrgb, "yrgb")];
const ND_NOTATIONS: [(NdNotation, &str); 3] = [
    (NdNotation::Stops, "stops"),
    (NdNotation::Factor, "factor"),
    (NdNotation::Density, "density"),
];

impl Saved {
    /// The prefs lines, then one `key=value` per remembered thing.
    pub fn to_lines(&self) -> String {
        let mut out = self.prefs.to_lines();
        let mut line = |key: &str, value: String| {
            out.push_str(key);
            out.push('=');
            out.push_str(&value);
            out.push('\n');
        };
        let t = self.toggles;
        for (key, on) in [
            ("zebra", t.zebra),
            ("peaking", t.peaking),
            ("mirror", t.mirror),
            ("false_color", t.false_color),
            ("grid", t.grid),
            ("guides", t.guides),
            ("cross", t.cross),
            ("wave", t.wave),
            ("parade", t.parade),
            ("histo", t.histo),
            ("vector", t.vector),
            ("lights", t.lights),
            ("nd", t.nd),
            ("audio", t.audio),
        ] {
            line(key, on.to_string());
        }
        let a = &self.assists;
        line(
            "false_color_scale",
            name_of(a.false_color.scale, &SCALES).to_string(),
        );
        line("false_color_reference", a.false_color.reference.to_string());
        line(
            "peaking_color",
            name_of(a.peaking_color, &PEAKING_COLORS).to_string(),
        );
        line(
            "peaking_sense",
            name_of(a.peaking_sense, &PEAKING_SENSES).to_string(),
        );
        line("zebra_ire_units", a.zebra.ire_units.to_string());
        line("zebra_highlight_on", a.zebra.highlight_on.to_string());
        line("zebra_highlight_ire", a.zebra.highlight_ire.to_string());
        line(
            "zebra_highlight_color",
            name_of(a.zebra.highlight_color, &PAINTS).to_string(),
        );
        line("zebra_midtone_on", a.zebra.midtone_on.to_string());
        line("zebra_midtone_ire", a.zebra.midtone_ire.to_string());
        line(
            "zebra_midtone_color",
            name_of(a.zebra.midtone_color, &PAINTS).to_string(),
        );
        line("grid_thirds", a.grid.thirds.to_string());
        line("grid_phi", a.grid.phi.to_string());
        line("grid_diagonal", a.grid.diagonal.to_string());
        line(
            "guide_family",
            name_of(a.guides.family, &FAMILIES).to_string(),
        );
        line("guide_bits", a.guides.bits().to_string());
        line("guide_mask", a.guides.mask.to_string());
        let s = &self.scopes;
        line("wave_mode", name_of(s.wave, &WAVES).to_string());
        line("wave_guide_clip", s.wave_guides.0.to_string());
        line("wave_guide_crush", s.wave_guides.1.to_string());
        line("wave_guide_middle", s.wave_guides.2.to_string());
        line("parade_mode", name_of(s.parade, &PARADES).to_string());
        line("vector_gain", s.vector_gain.to_string());
        line("brightness", s.brightness.to_string());
        line("lights_compensation", s.lights_compensation.to_string());
        line(
            "nd_notation",
            name_of(s.nd_notation, &ND_NOTATIONS).to_string(),
        );
        line(
            "lut",
            match &self.lut {
                LutChoice::Off => "off".to_string(),
                LutChoice::BuiltIn(name) => format!("builtin:{name}"),
                LutChoice::File(name) => format!("file:{name}"),
            },
        );
        out
    }

    /// The defaults with every line that parses laid over them, so an older file (or
    /// one from before an option existed) still loads.
    pub fn from_lines(text: &str) -> Self {
        let mut saved = Self {
            prefs: Prefs::from_lines(text),
            ..Self::default()
        };
        let t = &mut saved.toggles;
        let a = &mut saved.assists;
        let s = &mut saved.scopes;
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let value = value.trim();
            let flag = |current: bool| value.parse().unwrap_or(current);
            match key.trim() {
                "zebra" => t.zebra = flag(t.zebra),
                "peaking" => t.peaking = flag(t.peaking),
                "mirror" => t.mirror = flag(t.mirror),
                "false_color" => t.false_color = flag(t.false_color),
                "grid" => t.grid = flag(t.grid),
                "guides" => t.guides = flag(t.guides),
                "cross" => t.cross = flag(t.cross),
                "wave" => t.wave = flag(t.wave),
                "parade" => t.parade = flag(t.parade),
                "histo" => t.histo = flag(t.histo),
                "vector" => t.vector = flag(t.vector),
                "lights" => t.lights = flag(t.lights),
                "nd" => t.nd = flag(t.nd),
                "audio" => t.audio = flag(t.audio),
                "false_color_scale" => {
                    a.false_color.scale = value_of(value, &SCALES, a.false_color.scale)
                }
                "false_color_reference" => a.false_color.reference = flag(a.false_color.reference),
                "peaking_color" => {
                    a.peaking_color = value_of(value, &PEAKING_COLORS, a.peaking_color)
                }
                "peaking_sense" => {
                    a.peaking_sense = value_of(value, &PEAKING_SENSES, a.peaking_sense)
                }
                "zebra_ire_units" => a.zebra.ire_units = flag(a.zebra.ire_units),
                "zebra_highlight_on" => a.zebra.highlight_on = flag(a.zebra.highlight_on),
                "zebra_highlight_ire" => {
                    a.zebra.highlight_ire = value
                        .parse()
                        .map_or(a.zebra.highlight_ire, |v: f32| v.clamp(0.0, 109.0))
                }
                "zebra_highlight_color" => {
                    a.zebra.highlight_color = value_of(value, &PAINTS, a.zebra.highlight_color)
                }
                "zebra_midtone_on" => a.zebra.midtone_on = flag(a.zebra.midtone_on),
                "zebra_midtone_ire" => {
                    a.zebra.midtone_ire = value
                        .parse()
                        .map_or(a.zebra.midtone_ire, |v: f32| v.clamp(0.0, 109.0))
                }
                "zebra_midtone_color" => {
                    a.zebra.midtone_color = value_of(value, &PAINTS, a.zebra.midtone_color)
                }
                "grid_thirds" => a.grid.thirds = flag(a.grid.thirds),
                "grid_phi" => a.grid.phi = flag(a.grid.phi),
                "grid_diagonal" => a.grid.diagonal = flag(a.grid.diagonal),
                "guide_family" => a.guides.family = value_of(value, &FAMILIES, a.guides.family),
                "guide_bits" => {
                    if let Ok(bits) = value.parse() {
                        a.guides = a.guides.with_bits(bits);
                    }
                }
                "guide_mask" => a.guides.mask = flag(a.guides.mask),
                "wave_mode" => s.wave = value_of(value, &WAVES, s.wave),
                "wave_guide_clip" => s.wave_guides.0 = flag(s.wave_guides.0),
                "wave_guide_crush" => s.wave_guides.1 = flag(s.wave_guides.1),
                "wave_guide_middle" => s.wave_guides.2 = flag(s.wave_guides.2),
                "parade_mode" => s.parade = value_of(value, &PARADES, s.parade),
                "vector_gain" => {
                    s.vector_gain = value
                        .parse()
                        .ok()
                        .filter(|gain: &f32| [1.0, 2.0, 4.0].contains(gain))
                        .unwrap_or(s.vector_gain)
                }
                "brightness" => {
                    s.brightness = value.parse().map_or(s.brightness, |v: u32| v.clamp(0, 200))
                }
                "lights_compensation" => {
                    s.lights_compensation = value.parse().unwrap_or(s.lights_compensation)
                }
                "nd_notation" => s.nd_notation = value_of(value, &ND_NOTATIONS, s.nd_notation),
                "lut" => {
                    saved.lut = match value.split_once(':') {
                        Some(("builtin", name)) if !name.is_empty() => {
                            LutChoice::BuiltIn(name.to_string())
                        }
                        Some(("file", name)) if !name.is_empty() => {
                            LutChoice::File(name.to_string())
                        }
                        _ => LutChoice::Off,
                    }
                }
                _ => {}
            }
        }
        saved
    }
}

/// The saved settings, or `None` when there is no file or it cannot be read.
pub fn load(path: &Path) -> Option<Saved> {
    std::fs::read_to_string(path)
        .ok()
        .map(|text| Saved::from_lines(&text))
}

/// Writes the settings, creating the folder on the way.
pub fn save(path: &Path, saved: &Saved) -> std::io::Result<()> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    std::fs::write(path, saved.to_lines())
}

// ---- The Tauri app's web UI ----------------------------------------------------------
//
// The Tauri app keeps this file as the owner of the desktop's settings (X1, X2): the Rust
// side reads it for the gimbal, the countdown and the virtual camera, and the web reads
// and writes the desktop-only lines through `prefs_get`/`prefs_set`. The web UI also has
// its own stores in the mobile shape (`pm.preferences.v1`, `pm.assists.v1`); on the
// first run on a PC that the old viewfinder was used on, those are seeded once from this
// file ([`web_seed`]) so the operator's zebra, peaking, guides and stick feel carry over.

/// Beside the settings file once the web stores have been seeded from it.
pub const WEB_SEED_MARKER: &str = "pocket-monitor-web-seeded-v1.txt";

fn camel_to_snake(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn snake_to_camel(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut upper = false;
    for c in key.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// The prefs lines as a camelCase JSON object, typed (`true`, `3`), for the web.
pub fn prefs_json(prefs: &Prefs) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for line in prefs.to_lines().lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let typed = match value {
            "true" => serde_json::Value::Bool(true),
            "false" => serde_json::Value::Bool(false),
            number => number.parse::<u64>().map_or_else(
                |_| serde_json::Value::String(number.to_string()),
                Into::into,
            ),
        };
        map.insert(snake_to_camel(key), typed);
    }
    serde_json::Value::Object(map)
}

/// The prefs with a camelCase patch from the web laid over them. Each value goes through
/// the file's own reader, so a value out of range is clamped or ignored exactly as a
/// hand-edited file would be. Unknown keys are ignored.
pub fn apply_prefs_patch(prefs: &Prefs, patch: &serde_json::Value) -> Prefs {
    let mut text = prefs.to_lines();
    if let Some(map) = patch.as_object() {
        for (key, value) in map {
            let value = match value {
                serde_json::Value::Bool(on) => on.to_string(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::String(s) if !s.contains(['\n', '\r']) => s.clone(),
                _ => continue,
            };
            text.push_str(&format!("{}={value}\n", camel_to_snake(key)));
        }
    }
    Prefs::from_lines(&text)
}

/// The assists, scopes and stick feel the old viewfinder remembered, as patches for the
/// mobile stores: `{ preferences, assists: { on, options }, desktop }`. `desktop` carries
/// the prefs the mobile stores have no field for (as [`prefs_json`] writes them), and the
/// drop-folder cube when one was in use (`lutFile`).
pub fn web_seed(saved: &Saved) -> serde_json::Value {
    use crate::assists::sense_label;
    use serde_json::json;

    let t = saved.toggles;
    let a = &saved.assists;
    let sc = &saved.scopes;
    let p = &saved.prefs;
    let false_mode = match a.false_color.scale {
        FalseColorScale::Stops => "cinestop",
        FalseColorScale::ElZone => "video",
        FalseColorScale::Ire => "ire",
        FalseColorScale::Limits => "limits",
    };
    let zoom = if sc.vector_gain >= 4.0 {
        "4x"
    } else if sc.vector_gain >= 2.0 {
        "2x"
    } else {
        "1x"
    };
    // The phones' five crush/clip steps, by their stops.
    let crush_clip = [(0.0, 0), (0.25, 2), (0.5, 5), (0.75, 7), (1.0, 10)]
        .into_iter()
        .min_by(|a: &(f64, u8), b| {
            (a.0 - sc.lights_compensation)
                .abs()
                .total_cmp(&(b.0 - sc.lights_compensation).abs())
        })
        .map_or(0, |(_, value)| value);
    let (selection, lut_file) = match &saved.lut {
        LutChoice::BuiltIn(name) => (format!("look:{name}"), None),
        LutChoice::File(name) => ("auto".to_string(), Some(name.clone())),
        LutChoice::Off => ("auto".to_string(), None),
    };
    let frames: Vec<&str> = a.guides.frames().iter().map(|f| f.label()).collect();
    let brightness = sc.brightness.min(200);
    json!({
        "preferences": {
            "stickSensitivity": p.stick_sensitivity.clamp(1, 5),
            "shutterUsesAngle": p.shutter_angle,
            "gamepadEnabled": p.gamepad,
        },
        "assists": {
            "on": {
                "LUT": t.grade,
                "PEAK": t.peaking,
                "FALSE": t.false_color,
                "ZEBRA": t.zebra,
                "WAVE": t.wave,
                "PARADE": t.parade,
                "HISTO": t.histo,
                "VECTOR": t.vector,
                "LIGHTS": t.lights,
                "ND": t.nd,
                "AUDIO": t.audio,
                "GUIDES": t.guides,
                "GRID": t.grid,
                "CROSS": t.cross,
                "MIRROR": t.mirror,
            },
            "options": {
                "lut": { "selection": selection },
                "peaking": {
                    "color": a.peaking_color.label(),
                    "sense": sense_label(a.peaking_sense),
                },
                "falseColor": { "mode": false_mode, "reference": a.false_color.reference },
                "zebra": {
                    "unit": if a.zebra.ire_units { "IRE" } else { "Native" },
                    "highlight": a.zebra.highlight_on,
                    "highlightIRE": a.zebra.highlight_ire,
                    "highlightColor": a.zebra.highlight_color.label(),
                    "midtone": a.zebra.midtone_on,
                    "midtoneIRE": a.zebra.midtone_ire,
                    "midtoneColor": a.zebra.midtone_color.label(),
                },
                "waveform": {
                    "mode": match sc.wave { WaveMode::Luma => "Luma", WaveMode::Rgb => "RGB" },
                    "brightness": brightness,
                    "guides": {
                        "clip": sc.wave_guides.0,
                        "crush": sc.wave_guides.1,
                        "middle": sc.wave_guides.2,
                    },
                },
                "parade": {
                    "mode": match sc.parade { ParadeMode::Rgb => "RGB", ParadeMode::Yrgb => "YRGB" },
                    "brightness": brightness,
                },
                "vectorscope": { "zoom": zoom, "brightness": brightness },
                "crushClip": crush_clip,
                "nd": {
                    "notation": match sc.nd_notation {
                        NdNotation::Stops => "stops",
                        NdNotation::Factor => "factor",
                        NdNotation::Density => "density",
                    },
                },
                "guides": {
                    "family": a.guides.family.label(),
                    "selected": frames,
                    "mask": a.guides.mask,
                },
                "grid": { "thirds": a.grid.thirds, "phi": a.grid.phi, "diagonal": a.grid.diagonal },
            },
        },
        "desktop": prefs_json(p),
        "lutFile": lut_file,
    })
}

/// The one-time seed for the web stores, if it is still owed: the settings file exists
/// and no marker says it was taken. A PC the old viewfinder never ran on owes nothing.
pub fn pending_web_seed(prefs_file: &Path) -> Option<serde_json::Value> {
    let marker = prefs_file.with_file_name(WEB_SEED_MARKER);
    if marker.exists() {
        return None;
    }
    load(prefs_file).map(|saved| web_seed(&saved))
}

/// Records that the web stores took the seed, so it is never applied twice.
pub fn mark_web_seeded(prefs_file: &Path) -> std::io::Result<()> {
    let marker = prefs_file.with_file_name(WEB_SEED_MARKER);
    if let Some(folder) = marker.parent() {
        std::fs::create_dir_all(folder)?;
    }
    std::fs::write(
        marker,
        "The Pocket Monitor web UI took its first settings from desktop-prefs.txt.\n",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_survive_a_round_trip_and_an_older_file() {
        let mut prefs = Prefs {
            ramp: 2,
            countdown_seconds: 10,
            stick_sensitivity: 2,
            show_pad: false,
            vcam: 2,
            vcam_clean: false,
            vcam_port: 9000,
            ..Prefs::default()
        };
        prefs.timecode = true;
        let back = Prefs::from_lines(&prefs.to_lines());
        assert_eq!(back, prefs);
        // A file from before the setup tabs: what it does not say stays default.
        let older =
            Prefs::from_lines("ramp=1\nnonsense\nstick_sensitivity=9\nvcam=7\nvcam_port=0\n");
        assert_eq!(older.ramp, 1);
        assert_eq!(older.vcam, 0, "an unknown camera mode is off");
        assert_eq!(older.vcam_port, opc_vcam::DEFAULT_PORT, "port 0 is no port");
        assert_eq!(older.stick_sensitivity, 5, "clamped to the phones' range");
        assert!(older.show_zoom);
        assert_eq!(older.countdown_seconds, Prefs::default().countdown_seconds);
    }

    #[test]
    fn a_file_is_written_where_it_is_read() {
        let dir = std::env::temp_dir().join(format!("opc-prefs-{}", std::process::id()));
        let file = dir.join("nested").join("desktop-prefs.txt");
        let saved = Saved {
            prefs: Prefs {
                gamepad: false,
                ..Prefs::default()
            },
            ..Saved::default()
        };
        save(&file, &saved).expect("saved");
        assert_eq!(load(&file), Some(saved));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_assists_scopes_and_cube_survive_a_round_trip() {
        let mut saved = Saved::default();
        saved.toggles.zebra = true;
        saved.toggles.wave = true;
        saved.toggles.mirror = true;
        saved.assists.false_color.scale = FalseColorScale::ElZone;
        saved.assists.peaking_color = PeakingColor::Blue;
        saved.assists.peaking_sense = PeakingSense::High;
        saved.assists.zebra.highlight_ire = 95.0;
        saved.assists.zebra.midtone_color = ZebraPaint::Cyan;
        saved.assists.grid.phi = true;
        saved.assists.guides = saved.assists.guides.with_bits(0b101);
        saved.assists.guides.family = GuideFamily::Social;
        saved.assists.guides.mask = true;
        saved.scopes.wave = WaveMode::Luma;
        saved.scopes.wave_guides = (false, true, true);
        saved.scopes.vector_gain = 2.0;
        saved.scopes.brightness = 150;
        saved.scopes.nd_notation = NdNotation::Density;
        saved.lut = LutChoice::File("mine.cube".to_string());
        let back = Saved::from_lines(&saved.to_lines());
        assert_eq!(back, saved);
        // A file from before any of this: the phones' defaults, cube off.
        let older = Saved::from_lines("ramp=1\nzebra=maybe\nvector_gain=3\nlut=file:\n");
        assert_eq!(older.toggles, Toggles::default());
        assert_eq!(
            older.scopes.vector_gain,
            ScopeOptions::default().vector_gain
        );
        assert_eq!(older.lut, LutChoice::Off);
        assert_eq!(older.prefs.ramp, 1);
    }

    #[test]
    fn the_web_reads_and_patches_the_prefs_through_the_files_own_reader() {
        let prefs = Prefs {
            countdown_seconds: 10,
            show_pad: false,
            ..Prefs::default()
        };
        let json = prefs_json(&prefs);
        assert_eq!(json["countdownSeconds"], 10);
        assert_eq!(json["showPad"], false);
        assert_eq!(json["vcamPort"], u64::from(opc_vcam::DEFAULT_PORT));
        let patched = apply_prefs_patch(
            &prefs,
            &serde_json::json!({ "timecode": true, "stickSensitivity": 9, "nonsense": 1, "ramp": "x" }),
        );
        assert!(patched.timecode);
        assert_eq!(
            patched.stick_sensitivity, 5,
            "clamped like a hand-edited file"
        );
        assert_eq!(
            patched.ramp, prefs.ramp,
            "a value that does not parse is ignored"
        );
        assert_eq!(patched.countdown_seconds, 10, "untouched lines stay");
    }

    #[test]
    fn the_web_seed_carries_the_old_viewfinders_assists() {
        let mut saved = Saved::default();
        saved.prefs.stick_sensitivity = 2;
        saved.prefs.shutter_angle = true;
        saved.toggles.zebra = true;
        saved.toggles.grade = true;
        saved.assists.zebra.highlight_ire = 95.0;
        saved.assists.zebra.midtone_color = ZebraPaint::Cyan;
        saved.assists.peaking_color = PeakingColor::Blue;
        saved.assists.peaking_sense = PeakingSense::High;
        saved.assists.false_color.scale = FalseColorScale::ElZone;
        saved.assists.guides = saved.assists.guides.with_bits(0);
        saved.scopes.vector_gain = 2.0;
        saved.scopes.lights_compensation = 0.5;
        saved.scopes.wave = WaveMode::Luma;
        saved.lut = LutChoice::BuiltIn("Contrast".into());
        let seed = web_seed(&saved);
        assert_eq!(seed["preferences"]["stickSensitivity"], 2);
        assert_eq!(seed["preferences"]["shutterUsesAngle"], true);
        let on = &seed["assists"]["on"];
        assert_eq!(on["ZEBRA"], true);
        assert_eq!(on["LUT"], true);
        assert_eq!(on["PEAK"], false);
        let options = &seed["assists"]["options"];
        assert_eq!(options["zebra"]["highlightIRE"], 95.0);
        assert_eq!(options["zebra"]["midtoneColor"], "Cyan");
        assert_eq!(options["zebra"]["unit"], "IRE");
        assert_eq!(options["peaking"]["color"], "Blue");
        assert_eq!(options["peaking"]["sense"], "High");
        assert_eq!(options["falseColor"]["mode"], "video");
        assert_eq!(options["guides"]["selected"], serde_json::json!(["2.39:1"]));
        assert_eq!(options["vectorscope"]["zoom"], "2x");
        assert_eq!(options["crushClip"], 5);
        assert_eq!(options["waveform"]["mode"], "Luma");
        assert_eq!(options["lut"]["selection"], "look:Contrast");
        assert_eq!(seed["lutFile"], serde_json::Value::Null);
        saved.lut = LutChoice::File("mine.cube".into());
        let seed = web_seed(&saved);
        assert_eq!(seed["assists"]["options"]["lut"]["selection"], "auto");
        assert_eq!(seed["lutFile"], "mine.cube");
        assert_eq!(seed["desktop"]["shutterAngle"], true);
    }

    #[test]
    fn the_web_seed_is_owed_once_and_only_where_the_old_app_ran() {
        let dir = std::env::temp_dir().join(format!("pm-web-seed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("desktop-prefs.txt");
        assert!(pending_web_seed(&file).is_none(), "a fresh PC owes nothing");
        let mut saved = Saved::default();
        saved.toggles.peaking = true;
        save(&file, &saved).unwrap();
        let seed = pending_web_seed(&file).expect("owed after the old app ran");
        assert_eq!(seed["assists"]["on"]["PEAK"], true);
        mark_web_seeded(&file).unwrap();
        assert!(pending_web_seed(&file).is_none(), "never twice");
        assert_eq!(
            load(&file),
            Some(saved),
            "the file itself is left as it was"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
