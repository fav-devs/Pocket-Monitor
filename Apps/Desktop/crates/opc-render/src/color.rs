//! Transfer curves and the log → Rec.709 display transform the phones apply.
//!
//! This is the mobile contract's `sourceColor` (`Apps/Mobile/src/core/media/transfer.ts`,
//! itself a port of OpenCine `TransferCurves`, `MonitorSceneToneMap` and
//! `MonitorLogDisplayTransform`, and the D-Gamut matrices in OpenPocketViewCore
//! `LiveColorScience`). The same numbers are in `shaders/feed.frag`, which applies them per
//! pixel; Rust needs them for the vectorscope and to hand the shader its matrix and tone
//! constants. The core's C facade has no display transform to ask, so this is a third copy
//! (after the TypeScript and the shader): `tests` pins it to the TypeScript's values.
//!
//! Everything speaks curve fractions (`byte / 255` on the tap axis).

/// The curve a picture is encoded in. The ordinals are the shader's (`feed.frag`), the same
/// as the web renderer's `TRANSFER_ID`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub enum Transfer {
    #[default]
    Rec709,
    Hlg,
    DLog,
    DLog2,
    DLogM,
}

const HLG_A: f64 = 0.178_832_77;
const HLG_B: f64 = 0.284_668_92;
const HLG_C: f64 = 0.559_910_73;

fn hlg_inverse_oetf(e: f64) -> f64 {
    if e <= 0.5 {
        e * e / 3.0
    } else {
        (((e - HLG_C) / HLG_A).exp() + HLG_B) / 12.0
    }
}

fn hlg_oetf(scene: f64) -> f64 {
    if scene <= 1.0 / 12.0 {
        (3.0 * scene).sqrt()
    } else {
        HLG_A * (12.0 * scene - HLG_B).ln() + HLG_C
    }
}

fn hlg_diffuse_white() -> f64 {
    hlg_inverse_oetf(0.75)
}

const DLOG2_A: f64 = 16.285_770_761_945_304;
const DLOG2_K1: f64 = 0.059_439_938_321_493;
const DLOG2_B1: f64 = 0.304_985_337_243_402;
const DLOG2_K2: f64 = 2.960_935_245_492_25;
const DLOG2_B2: f64 = 0.148_314_799_066_323;
const DLOG2_IN2: f64 = 0.028_961_695_254_132;
const DLOG2_PEAK: f64 = 475.0;

impl Transfer {
    /// The shader's ordinal.
    pub fn ordinal(self) -> u32 {
        match self {
            Self::Rec709 => 0,
            Self::Hlg => 1,
            Self::DLog => 2,
            Self::DLog2 => 3,
            Self::DLogM => 4,
        }
    }

    /// The mobile `sourceColor` / `signal` spelling (`'rec709' | 'hlg' | 'dlog-m' | 'dlog' |
    /// 'dlog2'`). Anything else is `None`.
    pub fn from_source_color(name: &str) -> Option<Self> {
        Some(match name {
            "rec709" => Self::Rec709,
            "hlg" => Self::Hlg,
            "dlog" => Self::DLog,
            "dlog2" => Self::DLog2,
            "dlog-m" => Self::DLogM,
            _ => return None,
        })
    }

    pub fn is_log(self) -> bool {
        matches!(self, Self::DLog | Self::DLog2 | Self::DLogM)
    }

    /// Raw curve decode to scene-linear (1.0 = diffuse white for HLG), unclamped.
    pub fn decode(self, e: f64) -> f64 {
        match self {
            Self::Rec709 => {
                if e < 0.081 {
                    e / 4.5
                } else {
                    ((e + 0.099) / 1.099).powf(1.0 / 0.45)
                }
            }
            Self::Hlg => hlg_inverse_oetf(e.clamp(0.0, 1.0)) / hlg_diffuse_white(),
            Self::DLog => {
                if e <= 0.14 {
                    (e - 0.0929) / 6.025
                } else {
                    (10f64.powf(3.89616 * e - 2.27752) - 0.0108) / 0.9892
                }
            }
            Self::DLog2 => {
                if e >= DLOG2_B1 {
                    (DLOG2_PEAK / (2f64.powf(DLOG2_A) - 1.0)) * (2f64.powf(DLOG2_A * e) - 1.0)
                } else if e >= DLOG2_B2 {
                    2f64.powf((e - DLOG2_B1) / DLOG2_K1 + 0.18f64.log2())
                } else {
                    (e - DLOG2_B2) / DLOG2_K2 + DLOG2_IN2
                }
            }
            Self::DLogM => {
                let t = 2f64.powf(e * 5.612_990_379_333_496 + 0.932_718_634_605_407_7)
                    - 2.428_226_947_784_424;
                let value = if t < 0.603_424_549_102_783_2 {
                    t * 1.015_179_634_094_238_3 + 0.517_889_559_268_951_4
                } else {
                    t * 1.873_430_371_284_485
                };
                value * (0.18 / 12.4054)
            }
        }
    }

    /// Scene-linear to the curve, clamped to 0…1.
    pub fn encode(self, linear: f64) -> f64 {
        let l = linear.max(0.0);
        let e = match self {
            Self::Rec709 => {
                let c = l.min(1.0);
                if c < 0.018 {
                    4.5 * c
                } else {
                    1.099 * c.powf(0.45) - 0.099
                }
            }
            Self::Hlg => hlg_oetf((l * hlg_diffuse_white()).clamp(0.0, 1.0)),
            Self::DLog => {
                if l <= 0.0078 {
                    6.025 * l + 0.0929
                } else {
                    (l * 0.9892 + 0.0108).log10() * 0.256_663 + 0.584_555
                }
            }
            Self::DLog2 => {
                if l >= 0.18 {
                    (1.0 / DLOG2_A) * (l * (2f64.powf(DLOG2_A) - 1.0) / DLOG2_PEAK + 1.0).log2()
                } else if l >= DLOG2_IN2 {
                    DLOG2_K1 * (l.max(1e-15).log2() - 0.18f64.log2()) + DLOG2_B1
                } else {
                    DLOG2_K2 * (l - DLOG2_IN2) + DLOG2_B2
                }
            }
            Self::DLogM => {
                let value = l / (0.18 / 12.4054);
                let t = if value < 0.603_424_549_102_783_2 * 1.873_430_371_284_485 {
                    (value - 0.517_889_559_268_951_4) / 1.015_179_634_094_238_3
                } else {
                    value / 1.873_430_371_284_485
                };
                ((t + 2.428_226_947_784_424).max(1e-6).log2() - 0.932_718_634_605_407_7)
                    / 5.612_990_379_333_496
            }
        };
        if e.is_finite() {
            e.clamp(0.0, 1.0)
        } else {
            0.0
        }
    }

    /// Source gamut → linear Rec.709, row-major. D-Log M rides identity (Pocket bodies put
    /// it close to Rec.709 primaries), as `LogColorTransform` does.
    pub fn gamut_to_rec709(self) -> [f64; 9] {
        match self {
            Self::DLog => [
                1.6746, -0.5797, -0.0949, -0.0981, 1.334, -0.2359, -0.041, -0.243, 1.284,
            ],
            Self::DLog2 => [
                1.8577, -0.7712, -0.0869, -0.2018, 1.4176, -0.2158, -0.0125, -0.1621, 1.1746,
            ],
            Self::Hlg => [
                1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187,
            ],
            Self::Rec709 | Self::DLogM => [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        }
    }
}

/// `MonitorSceneToneMap`: scene-linear onto a display code with an explicit scene white.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SceneToneMap {
    pub gain: f64,
    pub white_reinhard: f64,
    pub contrast: f64,
}

impl SceneToneMap {
    pub const DEFAULT_CONTRAST: f64 = 1.1;

    pub fn new(scene_white: f64, contrast: f64) -> Self {
        let middle_grey_display = 0.42f64.powf(2.4);
        let white_point = (scene_white / 0.18).max(0.000_001);
        let contrasted_white = white_point.powf(contrast);
        let white_contribution = 1.0 / (contrasted_white * contrasted_white);
        let numerator = middle_grey_display - white_contribution;
        let gain = (numerator / (1.0 - middle_grey_display)).max(0.000_001);
        Self {
            gain,
            white_reinhard: gain * contrasted_white,
            contrast,
        }
    }

    pub fn display_code(&self, scene_linear: f64) -> f64 {
        let x = scene_linear.max(0.0) / 0.18;
        let c = self.gain * x.powf(self.contrast);
        let w = self.white_reinhard;
        let mapped = (c * (1.0 + c / (w * w)) / (1.0 + c)).clamp(0.0, 1.0);
        mapped.powf(1.0 / 2.4)
    }
}

/// `MonitorLogDisplayTransform`: raw decode, source gamut → Rec.709, then the shared scene
/// tone map. Rec.709 is identity.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayTransform {
    pub transfer: Transfer,
    pub matrix: [f64; 9],
    pub tone: SceneToneMap,
}

impl DisplayTransform {
    pub fn new(transfer: Transfer) -> Self {
        Self {
            transfer,
            matrix: transfer.gamut_to_rec709(),
            tone: SceneToneMap::new(transfer.decode(1.0), SceneToneMap::DEFAULT_CONTRAST),
        }
    }

    pub fn is_identity(&self) -> bool {
        self.transfer == Transfer::Rec709
    }

    /// One encoded RGB triple (0…1) onto Rec.709 display codes.
    pub fn map(&self, rgb: [f64; 3]) -> [f64; 3] {
        if self.is_identity() {
            return rgb;
        }
        let t = self.transfer;
        let l = [t.decode(rgb[0]), t.decode(rgb[1]), t.decode(rgb[2])];
        let m = &self.matrix;
        let row = |at: usize| (m[at] * l[0] + m[at + 1] * l[1] + m[at + 2] * l[2]).max(0.0);
        [
            self.tone.display_code(row(0)),
            self.tone.display_code(row(3)),
            self.tone.display_code(row(6)),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Transfer; 5] = [
        Transfer::Rec709,
        Transfer::Hlg,
        Transfer::DLog,
        Transfer::DLog2,
        Transfer::DLogM,
    ];

    #[test]
    fn every_curve_round_trips_through_mid_grey() {
        for t in ALL {
            let code = t.encode(0.18);
            assert!(
                (t.decode(code) - 0.18).abs() < 1e-6,
                "{t:?}: {code} → {}",
                t.decode(code)
            );
        }
    }

    #[test]
    fn the_published_anchors_match_the_white_papers() {
        // D-Log: 18% → 408/1023. D-Log2: 18% → 0.304985, 0 → ~0.0626, 475 → 1.
        assert!((Transfer::DLog.encode(0.18) - 408.0 / 1023.0).abs() < 2e-3);
        assert!((Transfer::DLog2.encode(0.18) - 0.304_985).abs() < 1e-5);
        assert!((Transfer::DLog2.encode(0.0) - 0.062_561).abs() < 1e-3);
        assert!((Transfer::DLog2.encode(475.0) - 1.0).abs() < 1e-6);
        assert!((Transfer::Rec709.encode(1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn rec709_is_the_identity_and_log_grey_reads_as_display_grey() {
        let identity = DisplayTransform::new(Transfer::Rec709);
        assert_eq!(identity.map([0.2, 0.5, 0.9]), [0.2, 0.5, 0.9]);
        // The tone map puts 18% scene grey on 0.42 display code for every log curve.
        for t in [
            Transfer::DLog,
            Transfer::DLog2,
            Transfer::DLogM,
            Transfer::Hlg,
        ] {
            let grey = t.encode(0.18);
            let shown = DisplayTransform::new(t).map([grey; 3]);
            for channel in shown {
                assert!((channel - 0.42).abs() < 0.02, "{t:?}: grey shows {channel}");
            }
        }
    }

    #[test]
    fn the_source_colour_names_are_the_mobile_contracts() {
        assert_eq!(Transfer::from_source_color("dlog-m"), Some(Transfer::DLogM));
        assert_eq!(Transfer::from_source_color("hlg"), Some(Transfer::Hlg));
        assert_eq!(Transfer::from_source_color("dlog2"), Some(Transfer::DLog2));
        assert_eq!(Transfer::from_source_color("hdr"), None);
        assert_eq!(Transfer::DLog2.ordinal(), 3);
    }
}
