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
use crate::sheets::Prefs;
use crate::shell::Toggles;
use opc_render::{FalseColorScale, PeakingSense};

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
}
