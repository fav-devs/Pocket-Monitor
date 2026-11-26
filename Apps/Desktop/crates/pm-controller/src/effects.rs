//! The mobile `PictureEffects` contract onto the Vulkan feed pass.
//!
//! The Expo web build computes `PictureEffects` exactly as the phones do
//! (`usePictureEffects`, `Apps/Mobile/modules/pocket-native/src/types.ts`) and sends it with
//! `picture_set_effects` when it changes. This maps it onto what `opc-render`'s
//! `feed.frag` can paint today: [`GradeOptions`] plus which cube and which false-colour
//! lattice to bind. Every number comes from the core, as on the old viewfinder: zebra
//! thresholds through `opc_render::assist_scalars`, the false-colour lattices through
//! `Lut::false_color`, built-in looks through `Lut::built_in`.
//!
//! Fields the shader cannot paint yet are reported in [`FeedState::unsupported`] rather
//! than half-implemented. The list is in `docs/desktop-expo-port.md` (Phase 1 status).

use opc_render::{FalseColorScale, GradeOptions, Peaking, PeakingSense, Zebra};
use serde::Deserialize;

use crate::luts::LutChoice;

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

/// The mobile contract, field for field. Unknown fields are ignored so an additive change
/// on the web side never breaks the desktop.
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

/// What the render thread binds for one `PictureEffects`.
#[derive(Debug, Clone, PartialEq)]
pub struct FeedState {
    pub grade: GradeOptions,
    /// The cube to bind, `Off` for none.
    pub lut: LutChoice,
    /// The false-colour lattice to build (core, for this colour mode and ISO).
    pub false_color: Option<FalseColorScale>,
    /// Contract fields `feed.frag` cannot paint yet, by their mobile names.
    pub unsupported: Vec<&'static str>,
}

/// The camera's colour mode (wire code) and ISO: the axis the core puts thresholds on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
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

/// `look:<name>` is a core built-in look, `file:<name>` a cube in the desktop drop folder.
/// `custom:<id>` (a cube the phones' document picker registered in web storage) has no
/// desktop source yet and maps to `Off`, reported as unsupported.
pub fn lut_choice(id: Option<&str>) -> (LutChoice, bool) {
    match id {
        None | Some("") => (LutChoice::Off, true),
        Some(id) => match id.split_once(':') {
            Some(("look", name)) if !name.is_empty() => {
                (LutChoice::BuiltIn(name.to_string()), true)
            }
            Some(("file", name)) if !name.is_empty() => (LutChoice::File(name.to_string()), true),
            _ => (LutChoice::Off, false),
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

/// Maps one `PictureEffects` onto the feed pass for the body's current colour axis.
pub fn feed_state(effects: &PictureEffects, axis: ColorAxis) -> FeedState {
    let mut unsupported = Vec::new();

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
        if !zebra.stripes {
            unsupported.push("zebra.stripes=false");
        }
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

    let false_color = effects.false_color.as_deref().and_then(false_color_scale);
    if effects.false_color.is_some() && false_color.is_none() {
        unsupported.push("falseColor (unknown scale)");
    }

    let (lut, known) = lut_choice(effects.lut_id.as_deref());
    if !known {
        unsupported.push("lutId (custom: cubes)");
    }
    if lut != LutChoice::Off && (effects.lut_intensity - 1.0).abs() > 1e-3 {
        unsupported.push("lutIntensity");
    }
    if effects
        .lut_exposure_stops
        .is_some_and(|stops| stops.abs() > 1e-3)
    {
        unsupported.push("lutExposureStops");
    }
    if effects.desqueeze.factor > 1.001 {
        unsupported.push("desqueeze");
    }
    if effects.monochrome {
        unsupported.push("monochrome");
    }
    if effects.mirror_vertical == Some(true) {
        unsupported.push("mirrorVertical");
    }
    if effects.source_color != "rec709" {
        unsupported.push("sourceColor");
    }
    if effects
        .signal
        .as_deref()
        .is_some_and(|signal| signal != effects.source_color)
        || effects
            .clip_byte
            .is_some_and(|byte| (byte - 255.0).abs() > 0.5)
    {
        unsupported.push("signal/clipByte");
    }

    FeedState {
        grade: GradeOptions {
            mirror: effects.mirror,
            // The old viewfinder never turned the flag on; the blit picks Catmull-Rom by
            // itself whenever the display raster is larger than the source.
            upscale: false,
            split: false,
            split_vertical: false,
            zebra,
            peaking,
            false_color: false_color.is_some(),
        },
        lut,
        false_color,
        unsupported,
    }
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
        assert_eq!(state.lut, LutChoice::Off);
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
        assert_eq!(state.lut, LutChoice::BuiltIn("Contrast".to_string()));
        let zebra = state.grade.zebra.expect("zebra on");
        assert!(zebra.highlight.is_some());
        assert!(zebra.midtone.is_none());
        let peaking = state.grade.peaking.expect("peaking on");
        assert_eq!(peaking.sense, PeakingSense::High);
        assert_eq!(peaking.color, [1.0, 0.0, 0.0, 1.0], "0…255 paint is scaled");
    }

    #[test]
    fn a_highlight_far_above_the_axis_is_off_and_the_resolved_midtone_band_is_used() {
        let effects = parse(
            r#"{"zebra":{"upper":1000,"lower":50,"paint":[1,1,0],"stripes":true,
                 "midtone":{"lower":0.4,"upper":0.5,"paint":[0,1,0]}}}"#,
        );
        let zebra = feed_state(&effects, ColorAxis::default())
            .grade
            .zebra
            .expect("midtone on");
        assert_eq!(zebra.highlight, None);
        let (centre, half) = zebra.midtone.expect("band");
        assert!((centre - 0.45).abs() < 1e-6 && (half - 0.05).abs() < 1e-6);
        assert_eq!(zebra.midtone_color, [0.0, 1.0, 0.0, 1.0]);
    }

    #[test]
    fn what_the_shader_cannot_paint_is_named_not_faked() {
        let effects = parse(
            r#"{"sourceColor":"dlog","lutId":"custom:abc","lutIntensity":0.5,
                "desqueeze":{"factor":1.33,"direction":"horizontal"},"monochrome":true,
                "mirrorVertical":true,"lutExposureStops":1}"#,
        );
        let state = feed_state(&effects, ColorAxis::default());
        for name in [
            "lutId (custom: cubes)",
            "lutExposureStops",
            "desqueeze",
            "monochrome",
            "mirrorVertical",
            "sourceColor",
        ] {
            assert!(state.unsupported.contains(&name), "missing {name}");
        }
        assert_eq!(state.lut, LutChoice::Off);
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
        assert!(state.unsupported.is_empty(), "{:?}", state.unsupported);
    }

    #[test]
    fn false_colour_names_follow_the_phones() {
        assert_eq!(false_color_scale("video"), Some(FalseColorScale::ElZone));
        assert_eq!(false_color_scale("ire"), Some(FalseColorScale::Ire));
        assert_eq!(false_color_scale("limits"), Some(FalseColorScale::Limits));
        assert_eq!(false_color_scale("nope"), None);
    }
}
