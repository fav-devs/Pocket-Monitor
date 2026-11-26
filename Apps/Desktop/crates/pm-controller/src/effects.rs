//! The mobile `PictureEffects` contract onto the Vulkan feed pass.
//!
//! The Expo web build computes `PictureEffects` exactly as the phones do
//! (`usePictureEffects`, `Apps/Mobile/modules/pocket-native/src/types.ts`) and sends it with
//! `picture_set_effects` when it changes. This maps every field onto what `opc-render`
//! paints: [`GradeOptions`] (zebra, peaking, false colour, mirror, the desktop's split),
//! [`Look`] (display transform, cube intensity and input exposure, mono, vertical mirror,
//! solid zebra, desqueeze), and which cube and false-colour lattice to bind. Every
//! threshold comes from the core, as on the old viewfinder: zebra through
//! `opc_render::assist_scalars`, the false-colour lattices through `Lut::false_color`,
//! built-in looks through `Lut::built_in`, all on the colour axis of the **signal** (the
//! body's colour mode and ISO, or the contract's `signal` when it names another curve).
//!
//! What cannot be honoured is reported in [`FeedState::unsupported`] rather than faked:
//! today only names this build does not know (an unknown false-colour scale, curve or
//! LUT id form).

use opc_render::{FalseColorScale, GradeOptions, Look, Peaking, PeakingSense, Transfer, Zebra};
use serde::Deserialize;

/// `[r, g, b]`, 0…1 (0…255 is accepted and scaled).
pub type Rgb = [f32; 3];

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZebraEffect {
    /// Highlight threshold in monitor IRE on max(R,G,B); far above 109 means off.
    pub upper: f32,
    /// Midtone centre in monitor IRE (±5 on luma), or off.
    pub lower: Option<f32>,
    pub paint: Rgb,
    #[serde(default = "yes")]
    pub stripes: bool,
    /// The midtone band already resolved to encoded luma codes 0…1, with its own paint.
    #[serde(default)]
    pub midtone: Option<MidtoneBand>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct MidtoneBand {
    pub lower: f32,
    pub upper: f32,
    pub paint: Rgb,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakingEffect {
    pub color: Rgb,
    pub ratio_threshold: f32,
    pub noise_gate: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Desqueeze {
    pub factor: f32,
    pub direction: SqueezeAxis,
}

/// Which way the lens squeezes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SqueezeAxis {
    Horizontal,
    Vertical,
}

impl Default for Desqueeze {
    fn default() -> Self {
        Self {
            factor: 1.0,
            direction: SqueezeAxis::Horizontal,
        }
    }
}

/// The mobile contract, field for field, plus the desktop's `split`. Unknown fields are
/// ignored so an additive change on the web side never breaks the desktop.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PictureEffects {
    #[serde(default = "rec709")]
    pub source_color: String,
    #[serde(default)]
    pub lut_id: Option<String>,
    #[serde(default = "one")]
    pub lut_intensity: f32,
    #[serde(default)]
    pub false_color: Option<String>,
    #[serde(default)]
    pub zebra: Option<ZebraEffect>,
    #[serde(default)]
    pub peaking: Option<PeakingEffect>,
    #[serde(default)]
    pub desqueeze: Desqueeze,
    #[serde(default)]
    pub mirror: bool,
    #[serde(default)]
    pub monochrome: bool,
    #[serde(default)]
    pub signal: Option<String>,
    #[serde(default)]
    pub clip_byte: Option<f32>,
    #[serde(default)]
    pub lut_exposure_stops: Option<f32>,
    #[serde(default)]
    pub mirror_vertical: Option<bool>,
    /// Desktop extra: the LUT 50/50 split, `'across'` (graded top half) or `'down'`
    /// (graded right half). Absent or null is off.
    #[serde(default)]
    pub split: Option<String>,
}

impl Default for PictureEffects {
    fn default() -> Self {
        Self {
            source_color: rec709(),
            lut_id: None,
            lut_intensity: 1.0,
            false_color: None,
            zebra: None,
            peaking: None,
            desqueeze: Desqueeze::default(),
            mirror: false,
            monochrome: false,
            signal: None,
            clip_byte: None,
            lut_exposure_stops: None,
            mirror_vertical: None,
            split: None,
        }
    }
}

fn rec709() -> String {
    "rec709".to_string()
}
fn one() -> f32 {
    1.0
}
fn yes() -> bool {
    true
}

/// Where the cube for a `lutId` comes from.
#[derive(Debug, Clone, PartialEq, Eq, Default, Hash)]
pub enum LutSource {
    #[default]
    Off,
    /// `look:<name>`: one of the core's built-in looks, at 33³.
    BuiltIn(String),
    /// `file:<name>`: a `.cube` in the desktop's LUT drop folder.
    File(String),
    /// `custom:<id>`: a cube the web registered with `lut_load` (the phones' document
    /// picker keeps these in web storage; the desktop session hands their text over).
    Custom(String),
}

impl LutSource {
    /// The `lutId` this source is spelled as.
    pub fn id(&self) -> Option<String> {
        match self {
            Self::Off => None,
            Self::BuiltIn(name) => Some(format!("look:{name}")),
            Self::File(name) => Some(format!("file:{name}")),
            Self::Custom(id) => Some(format!("custom:{id}")),
        }
    }
}

/// What the render thread binds for one `PictureEffects`.
#[derive(Debug, Clone, PartialEq)]
pub struct FeedState {
    pub grade: GradeOptions,
    pub look: Look,
    /// The cube to bind, `Off` for none.
    pub lut: LutSource,
    /// The false-colour lattice to build (core, for [`FeedState::axis`]).
    pub false_color: Option<FalseColorScale>,
    /// The colour axis the thresholds were put on: the body's, or the contract's `signal`.
    pub axis: ColorAxis,
    /// Contract values this build cannot honour, by their mobile names.
    pub unsupported: Vec<&'static str>,
}

/// The camera's colour mode (wire code) and ISO: the axis the core puts thresholds on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct ColorAxis {
    pub color_mode: i32,
    pub iso: i32,
}

impl ColorAxis {
    /// From the body's status; Rec.709 (`0x3F`) until it has said.
    pub fn from_status(status: &opc_camera::Status) -> Self {
        Self {
            color_mode: i32::from(status.color_mode.unwrap_or(0x3F)),
            iso: status.iso.unwrap_or(0),
        }
    }

    /// The curve this colour mode records in (`normal` and `10bit` are Rec.709).
    pub fn transfer(self) -> Transfer {
        u8::try_from(self.color_mode)
            .ok()
            .map(crate::state::color_mode_name)
            .and_then(Transfer::from_source_color)
            .unwrap_or_default()
    }

    /// This axis moved onto `signal`'s curve. The same curve keeps the body's own code and
    /// ISO; another one (a clip shot in a different colour, a demo) is asked of the core at
    /// its reference EI, since the contract carries no ISO.
    pub fn for_signal(self, signal: Transfer) -> Self {
        if signal == self.transfer() {
            return self;
        }
        let name = match signal {
            Transfer::Rec709 => "normal",
            Transfer::Hlg => "hlg",
            Transfer::DLog => "dlog",
            Transfer::DLog2 => "dlog2",
            Transfer::DLogM => "dlog-m",
        };
        Self {
            color_mode: crate::state::color_mode_code(name).map_or(0x3F, i32::from),
            iso: 0,
        }
    }
}

/// The mobile false-colour names onto the core's scales. `video` is the phones' EL Zone
/// lattice (`OPC_FALSE_COLOR_EL_ZONE`); confirm on hardware that the zones match.
pub fn false_color_scale(name: &str) -> Option<FalseColorScale> {
    Some(match name {
        "cinestop" => FalseColorScale::Stops,
        "video" => FalseColorScale::ElZone,
        "ire" => FalseColorScale::Ire,
        "limits" => FalseColorScale::Limits,
        _ => return None,
    })
}

/// `look:<name>` is a core built-in look, `file:<name>` a cube in the desktop drop folder,
/// `custom:<id>` a cube the web registered with `lut_load`. The flag is false for a form
/// this build does not know (it maps to `Off`).
pub fn lut_source(id: Option<&str>) -> (LutSource, bool) {
    match id {
        None | Some("") => (LutSource::Off, true),
        Some(id) => match id.split_once(':') {
            Some(("look", name)) if !name.is_empty() => {
                (LutSource::BuiltIn(name.to_string()), true)
            }
            Some(("file", name)) if crate::luts::is_safe_file_name(name) => {
                (LutSource::File(name.to_string()), true)
            }
            // The desktop lists its drop folder in the phones' custom list as
            // `file:<name>` entries, so they arrive as `custom:file:<name>`.
            Some(("custom", key)) if key.starts_with("file:") => match key.split_once(':') {
                Some((_, name)) if crate::luts::is_safe_file_name(name) => {
                    (LutSource::File(name.to_string()), true)
                }
                _ => (LutSource::Off, false),
            },
            Some(("custom", key)) if !key.is_empty() => (LutSource::Custom(key.to_string()), true),
            _ => (LutSource::Off, false),
        },
    }
}

/// The peaking sense whose ratio threshold is nearest the contract's (the mobile table is
/// the same three numbers: 2.30, 2.10, 1.90).
pub fn peaking_sense(ratio_threshold: f32) -> PeakingSense {
    [PeakingSense::Low, PeakingSense::Medium, PeakingSense::High]
        .into_iter()
        .min_by(|a, b| {
            (a.ratio_threshold() - ratio_threshold)
                .abs()
                .total_cmp(&(b.ratio_threshold() - ratio_threshold).abs())
        })
        .unwrap_or_default()
}

fn rgba(rgb: Rgb) -> [f32; 4] {
    let scale = if rgb.iter().any(|channel| *channel > 1.0) {
        1.0 / 255.0
    } else {
        1.0
    };
    [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale, 1.0]
}

#[cfg(opc_core_linked)]
fn scalars(
    axis: ColorAxis,
    highlight_ire: f32,
    midtone_ire: f32,
) -> Option<opc_render::AssistScalars> {
    opc_render::assist_scalars(axis.color_mode, axis.iso, highlight_ire, midtone_ire)
}

#[cfg(not(opc_core_linked))]
fn scalars(
    _axis: ColorAxis,
    _highlight_ire: f32,
    _midtone_ire: f32,
) -> Option<opc_render::AssistScalars> {
    None
}

/// Highlight IRE at or above this is the contract's "highlight off".
const ZEBRA_OFF_IRE: f32 = 200.0;
/// The desqueeze factors the phones offer top out at 2×; anything past 4× is a typo.
const MAX_DESQUEEZE: f32 = 4.0;

fn finite_or(value: Option<f32>, fallback: f32) -> f32 {
    value.filter(|value| value.is_finite()).unwrap_or(fallback)
}

/// Maps one `PictureEffects` onto the feed pass for the body's current colour axis.
pub fn feed_state(effects: &PictureEffects, body: ColorAxis) -> FeedState {
    let mut unsupported = Vec::new();

    // The curves: the display transform the picture applies (`sourceColor`), and the
    // curve the camera signal is in (`signal`, the display's when absent). Measurements
    // sit on the signal's axis.
    let display = Transfer::from_source_color(&effects.source_color).unwrap_or_else(|| {
        unsupported.push("sourceColor (unknown curve)");
        Transfer::Rec709
    });
    let signal = match effects.signal.as_deref() {
        None => display,
        Some(name) => Transfer::from_source_color(name).unwrap_or_else(|| {
            unsupported.push("signal (unknown curve)");
            body.transfer()
        }),
    };
    let axis = body.for_signal(signal);
    // `clipByte` is the web's reading of the same (colour, ISO) clip ceiling the core
    // gives this axis; the core's, which knows the body's ISO, is the one used.

    let zebra = effects.zebra.as_ref().and_then(|zebra| {
        let highlight_ire = zebra.upper;
        let midtone_ire = zebra.lower.unwrap_or(50.0);
        // Same fallback as the shell's: without the core, IRE read as a plain fraction.
        let (highlight, midtone) = match scalars(axis, highlight_ire.min(109.0), midtone_ire) {
            Some(s) => (s.highlight, (s.midtone, s.midtone_half)),
            None => (highlight_ire / 100.0, (midtone_ire / 100.0, 0.05)),
        };
        let highlight = (highlight_ire < ZEBRA_OFF_IRE).then_some(highlight);
        // The resolved band, when the web sent it, is already on the feed's axis.
        let (midtone, midtone_color) = match (zebra.midtone, zebra.lower) {
            (Some(band), _) => (
                Some((
                    (band.lower + band.upper) / 2.0,
                    (band.upper - band.lower).abs() / 2.0,
                )),
                rgba(band.paint),
            ),
            (None, Some(_)) => (Some(midtone), rgba(zebra.paint)),
            (None, None) => (None, rgba(zebra.paint)),
        };
        let out = Zebra {
            highlight,
            midtone,
            highlight_color: rgba(zebra.paint),
            midtone_color,
        };
        (out.highlight.is_some() || out.midtone.is_some()).then_some(out)
    });

    let peaking = effects.peaking.map(|peaking| Peaking {
        sense: peaking_sense(peaking.ratio_threshold),
        color: rgba(peaking.color),
    });
    // The contract's own numbers drive the mask (the iOS shader takes them as sent).
    let peaking_thresholds = effects
        .peaking
        .filter(|peaking| {
            peaking.ratio_threshold.is_finite()
                && peaking.noise_gate.is_finite()
                && peaking.ratio_threshold > 0.0
                && peaking.noise_gate >= 0.0
        })
        .map(|peaking| [peaking.ratio_threshold, peaking.noise_gate]);

    let false_color = effects.false_color.as_deref().and_then(false_color_scale);
    if effects.false_color.is_some() && false_color.is_none() {
        unsupported.push("falseColor (unknown scale)");
    }

    let (lut, known) = lut_source(effects.lut_id.as_deref());
    if !known {
        unsupported.push("lutId (unknown form)");
    }

    let (split, split_vertical) = match effects.split.as_deref() {
        Some("across") | Some("horizontal") => (true, false),
        Some("down") | Some("vertical") => (true, true),
        _ => (false, false),
    };
    let factor = effects.desqueeze.factor;
    let desqueeze = opc_render::Desqueeze {
        factor: if factor.is_finite() {
            factor.clamp(1.0, MAX_DESQUEEZE)
        } else {
            1.0
        },
        vertical: effects.desqueeze.direction == SqueezeAxis::Vertical,
    };

    FeedState {
        grade: GradeOptions {
            mirror: effects.mirror,
            // The old viewfinder never turned the flag on; the blit picks Catmull-Rom by
            // itself whenever the display raster is larger than the source.
            upscale: false,
            split,
            split_vertical,
            zebra,
            peaking,
            false_color: false_color.is_some(),
        },
        look: Look {
            signal,
            display,
            exposure_stops: finite_or(effects.lut_exposure_stops, 0.0).clamp(-8.0, 8.0),
            lut_intensity: if effects.lut_intensity.is_finite() {
                effects.lut_intensity.clamp(0.0, 1.0)
            } else {
                1.0
            },
            monochrome: effects.monochrome,
            mirror_vertical: effects.mirror_vertical == Some(true),
            zebra_stripes: effects.zebra.as_ref().is_none_or(|zebra| zebra.stripes),
            desqueeze,
            peaking_thresholds,
        },
        lut,
        false_color,
        axis,
        unsupported,
    }
}

/// The virtual camera's "Clean" picture: the look (the LUT and display transform) kept,
/// the diagnostic assists off (`vcam_grade_options` in the old shell).
pub fn clean(state: &FeedState) -> (GradeOptions, Look) {
    (
        GradeOptions {
            zebra: None,
            peaking: None,
            false_color: false,
            ..state.grade
        },
        state.look.clean(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> PictureEffects {
        serde_json::from_str(json).expect("valid PictureEffects")
    }

    #[test]
    fn the_mobile_defaults_paint_nothing() {
        let effects = parse(
            r#"{"sourceColor":"rec709","lutId":null,"lutIntensity":1,"falseColor":null,
                "zebra":null,"peaking":null,"desqueeze":{"factor":1,"direction":"horizontal"},
                "mirror":false,"monochrome":false}"#,
        );
        let state = feed_state(&effects, ColorAxis::default());
        assert_eq!(state.grade, GradeOptions::default());
        assert_eq!(state.look, Look::default());
        assert_eq!(state.lut, LutSource::Off);
        assert!(state.unsupported.is_empty(), "{:?}", state.unsupported);
    }

    #[test]
    fn zebra_peaking_mirror_and_false_colour_map_onto_the_feed_pass() {
        let effects = parse(
            r#"{"sourceColor":"rec709","lutId":"look:Contrast","lutIntensity":1,
                "falseColor":"cinestop",
                "zebra":{"upper":95,"lower":null,"paint":[1,1,1],"stripes":true},
                "peaking":{"color":[255,0,0],"ratioThreshold":1.9,"noiseGate":0.00058},
                "desqueeze":{"factor":1,"direction":"horizontal"},"mirror":true,"monochrome":false,
                "futureField":42}"#,
        );
        let state = feed_state(&effects, ColorAxis::default());
        assert!(state.grade.mirror);
        assert!(state.grade.false_color);
        assert_eq!(state.false_color, Some(FalseColorScale::Stops));
        assert_eq!(state.lut, LutSource::BuiltIn("Contrast".to_string()));
        let zebra = state.grade.zebra.expect("zebra on");
        assert!(zebra.highlight.is_some());
        assert!(zebra.midtone.is_none());
        let peaking = state.grade.peaking.expect("peaking on");
        assert_eq!(peaking.sense, PeakingSense::High);
        assert_eq!(peaking.color, [1.0, 0.0, 0.0, 1.0], "0…255 paint is scaled");
        assert_eq!(state.look.peaking_thresholds, Some([1.9, 0.00058]));
    }

    #[test]
    fn a_highlight_far_above_the_axis_is_off_and_the_resolved_midtone_band_is_used() {
        let effects = parse(
            r#"{"zebra":{"upper":1000,"lower":50,"paint":[1,1,0],"stripes":false,
                 "midtone":{"lower":0.4,"upper":0.5,"paint":[0,1,0]}}}"#,
        );
        let state = feed_state(&effects, ColorAxis::default());
        let zebra = state.grade.zebra.expect("midtone on");
        assert_eq!(zebra.highlight, None);
        let (centre, half) = zebra.midtone.expect("band");
        assert!((centre - 0.45).abs() < 1e-6 && (half - 0.05).abs() < 1e-6);
        assert_eq!(zebra.midtone_color, [0.0, 1.0, 0.0, 1.0]);
        assert!(!state.look.zebra_stripes, "stripes: false paints solid");
        assert!(state.unsupported.is_empty());
    }

    #[test]
    fn every_phase_one_gap_is_now_painted() {
        let effects = parse(
            r#"{"sourceColor":"dlog","signal":"dlog","lutId":"custom:abc","lutIntensity":0.5,
                "desqueeze":{"factor":1.33,"direction":"vertical"},"monochrome":true,
                "mirrorVertical":true,"lutExposureStops":1,"split":"down"}"#,
        );
        let state = feed_state(&effects, ColorAxis::default());
        assert!(state.unsupported.is_empty(), "{:?}", state.unsupported);
        assert_eq!(state.lut, LutSource::Custom("abc".to_string()));
        assert_eq!(state.look.display, Transfer::DLog);
        assert_eq!(state.look.signal, Transfer::DLog);
        assert!((state.look.lut_intensity - 0.5).abs() < 1e-6);
        assert!((state.look.exposure_stops - 1.0).abs() < 1e-6);
        assert!(state.look.monochrome && state.look.mirror_vertical);
        assert!((state.look.desqueeze.factor - 1.33).abs() < 1e-6);
        assert!(state.look.desqueeze.vertical);
        assert!(state.grade.split && state.grade.split_vertical);
        // The body says Rec.709; the signal is D-Log, so the thresholds go on D-Log's axis.
        assert_eq!(state.axis.transfer(), Transfer::DLog);
    }

    #[test]
    fn auto_on_a_log_body_is_the_display_transform_on_the_bodys_own_axis() {
        // What `derivePictureEffects` sends for Auto on a D-Log M body at ISO 800.
        let body = ColorAxis {
            color_mode: i32::from(crate::state::color_mode_code("dlog-m").expect("code")),
            iso: 800,
        };
        let effects = parse(r#"{"sourceColor":"dlog-m","signal":"dlog-m","clipByte":255}"#);
        let state = feed_state(&effects, body);
        assert_eq!(state.axis, body, "same curve keeps the body's code and ISO");
        assert_eq!(state.look.display, Transfer::DLogM);
        // A cube over the same body is fed the signal with no display transform first
        // only when the web says Rec.709 is the display.
        let cube = parse(r#"{"sourceColor":"rec709","signal":"dlog-m","lutId":"look:Mono"}"#);
        let state = feed_state(&cube, body);
        assert_eq!(state.look.display, Transfer::Rec709);
        assert_eq!(state.look.signal, Transfer::DLogM);
        assert_eq!(state.axis, body);
    }

    #[test]
    fn the_payload_the_expo_build_sends_parses_and_paints_nothing_unsupported() {
        // Captured from the web export's `picture_set_effects` call (assists off).
        let effects = parse(
            r#"{"sourceColor":"rec709","signal":"rec709","clipByte":255,"lutId":null,
                "lutIntensity":1,"lutExposureStops":0,"falseColor":null,"zebra":null,
                "peaking":null,"desqueeze":{"factor":1,"direction":"horizontal"},
                "mirror":false,"mirrorVertical":false,"monochrome":false}"#,
        );
        let state = feed_state(&effects, ColorAxis::default());
        assert_eq!(state.grade, GradeOptions::default());
        assert_eq!(state.look, Look::default());
        assert!(state.unsupported.is_empty(), "{:?}", state.unsupported);
    }

    #[test]
    fn unknown_names_are_named_not_faked() {
        let effects = parse(
            r#"{"sourceColor":"slog3","signal":"vlog","lutId":"cloud:x","falseColor":"heat"}"#,
        );
        let state = feed_state(&effects, ColorAxis::default());
        for name in [
            "sourceColor (unknown curve)",
            "signal (unknown curve)",
            "lutId (unknown form)",
            "falseColor (unknown scale)",
        ] {
            assert!(state.unsupported.contains(&name), "missing {name}");
        }
        assert_eq!(state.lut, LutSource::Off);
        assert_eq!(state.look.display, Transfer::Rec709);
    }

    #[test]
    fn hostile_values_are_clamped() {
        let effects = parse(
            r#"{"lutIntensity":7,"lutExposureStops":99,"lutId":"file:../x.cube",
                "desqueeze":{"factor":40,"direction":"horizontal"}}"#,
        );
        let state = feed_state(&effects, ColorAxis::default());
        assert_eq!(state.look.lut_intensity, 1.0);
        assert_eq!(state.look.exposure_stops, 8.0);
        assert_eq!(state.look.desqueeze.factor, MAX_DESQUEEZE);
        assert_eq!(
            state.lut,
            LutSource::Off,
            "a path out of the folder is refused"
        );
    }

    #[test]
    fn clean_drops_the_diagnostics_and_keeps_the_look() {
        let effects = parse(
            r#"{"sourceColor":"dlog2","lutId":"look:Warm","monochrome":true,"falseColor":"ire",
                "zebra":{"upper":95,"lower":null,"paint":[1,1,1],"stripes":true},
                "peaking":{"color":[1,0,0],"ratioThreshold":2.1,"noiseGate":0.00174}}"#,
        );
        let state = feed_state(&effects, ColorAxis::default());
        let (grade, look) = clean(&state);
        assert!(grade.zebra.is_none() && grade.peaking.is_none() && !grade.false_color);
        assert!(!look.monochrome);
        assert_eq!(look.display, Transfer::DLog2);
    }

    #[test]
    fn false_colour_names_follow_the_phones() {
        assert_eq!(false_color_scale("video"), Some(FalseColorScale::ElZone));
        assert_eq!(false_color_scale("ire"), Some(FalseColorScale::Ire));
        assert_eq!(false_color_scale("limits"), Some(FalseColorScale::Limits));
        assert_eq!(false_color_scale("nope"), None);
    }

    #[test]
    fn lut_ids_round_trip() {
        for id in ["look:Contrast", "file:My Look.cube", "custom:abc-123"] {
            let (source, known) = lut_source(Some(id));
            assert!(known);
            assert_eq!(source.id().as_deref(), Some(id));
        }
        assert_eq!(lut_source(None).0.id(), None);
        assert_eq!(
            lut_source(Some("custom:file:Kodak.cube")).0,
            LutSource::File("Kodak.cube".to_string())
        );
        assert_eq!(lut_source(Some("custom:file:..")).0, LutSource::Off);
    }
}
