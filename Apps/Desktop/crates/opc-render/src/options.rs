//! What the operator has turned on.
//!
//! These drive push constants and passes that already exist in the Android shell's
//! shaders — nothing here invents a look.

/// Zebra stripes over the ungraded source, the way `feed.frag` paints them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Zebra {
    /// Highlight threshold on 0..1, read off the maximum channel. `None` turns it off.
    pub highlight: Option<f32>,
    /// Midtone centre and half-width on 0..1, read off BT.709 luma.
    pub midtone: Option<(f32, f32)>,
    pub highlight_color: [f32; 4],
    pub midtone_color: [f32; 4],
}

impl Default for Zebra {
    fn default() -> Self {
        Self {
            highlight: None,
            midtone: None,
            highlight_color: [1.0, 1.0, 1.0, 1.0],
            midtone_color: [1.0, 1.0, 0.0, 1.0],
        }
    }
}

impl Zebra {
    /// Highlight stripes above `threshold`.
    pub fn highlight(threshold: f32) -> Self {
        Self {
            highlight: Some(threshold),
            ..Self::default()
        }
    }

    /// Midtone stripes in a band around `centre`.
    pub fn midtone(centre: f32, half_width: f32) -> Self {
        Self {
            midtone: Some((centre, half_width)),
            ..Self::default()
        }
    }

    pub(crate) fn is_off(&self) -> bool {
        self.highlight.is_none() && self.midtone.is_none()
    }
}

/// Peaking sensitivity.
///
/// Transcribed from `PeakingSense` in
/// `Apps/Android/app/src/main/kotlin/…/assists/LiveAssistTool.kt`. These numbers are an
/// assist policy and belong in `OpenPocketViewCore` alongside the rest; until they move
/// there, a third shell carrying its own copy is a drift risk worth naming.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PeakingSense {
    Low,
    #[default]
    Medium,
    High,
}

impl PeakingSense {
    pub fn ratio_threshold(self) -> f32 {
        match self {
            Self::Low => 2.30,
            Self::Medium => 2.10,
            Self::High => 1.90,
        }
    }

    pub fn noise_gate(self) -> f32 {
        match self {
            Self::Low => 0.005_22,
            Self::Medium => 0.001_74,
            Self::High => 0.000_58,
        }
    }
}

/// Focus peaking: a closed stroke over the edges the shader finds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Peaking {
    pub sense: PeakingSense,
    pub color: [f32; 4],
}

impl Default for Peaking {
    fn default() -> Self {
        Self {
            sense: PeakingSense::default(),
            color: [1.0, 0.0, 0.0, 1.0],
        }
    }
}

/// Which false-colour scale to paint, as the core numbers them.
///
/// The zones themselves come from the core as two cubes (see [`crate::Lut::false_color`]);
/// this only names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FalseColorScale {
    #[default]
    Stops,
    Ire,
    Limits,
    ElZone,
}

impl FalseColorScale {
    pub const ALL: [Self; 4] = [Self::Stops, Self::ElZone, Self::Ire, Self::Limits];

    /// The ordinal `opc_false_color_cube` takes (`OPC_FALSE_COLOR_*`).
    pub fn ordinal(self) -> i32 {
        match self {
            Self::Stops => 0,
            Self::Ire => 1,
            Self::Limits => 2,
            Self::ElZone => 3,
        }
    }

    /// The menu label the phones use.
    pub fn label(self) -> &'static str {
        match self {
            Self::Stops => "CineStop",
            Self::Ire => "IRE",
            Self::Limits => "Limits",
            Self::ElZone => "EL Zone",
        }
    }
}

/// Everything the feed pipeline needs to know for one frame.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct GradeOptions {
    /// Horizontal flip, the MIRROR assist.
    pub mirror: bool,
    /// Bicubic reconstruction when the display raster is larger than the source.
    pub upscale: bool,
    /// Show the cube on half the picture only.
    pub split: bool,
    /// Split down the middle rather than across it.
    pub split_vertical: bool,
    pub zebra: Option<Zebra>,
    pub peaking: Option<Peaking>,
    /// Paint the false-colour cubes the renderer was last given.
    pub false_color: bool,
}

impl GradeOptions {
    pub(crate) fn peaking_on(&self) -> bool {
        self.peaking.is_some()
    }
}

/// Which way an anamorphic lens squeezed the picture, and by how much.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Desqueeze {
    /// 1 is off. Clamped to 1…4 when used.
    pub factor: f32,
    /// The lens squeezed vertically: the picture is shown taller rather than wider.
    pub vertical: bool,
}

impl Default for Desqueeze {
    fn default() -> Self {
        Self {
            factor: 1.0,
            vertical: false,
        }
    }
}

impl Desqueeze {
    fn factor(self) -> f64 {
        f64::from(self.factor).clamp(1.0, 4.0)
    }

    /// The shape the picture is *shown* at: the source raster with the squeeze undone
    /// (display aspect × factor horizontally, ÷ factor vertically, as the phones do).
    pub fn display_size(self, source: (u32, u32)) -> (u32, u32) {
        let factor = self.factor();
        if factor <= 1.000_5 {
            return source;
        }
        if self.vertical {
            (source.0, (f64::from(source.1) * factor).round() as u32)
        } else {
            ((f64::from(source.0) * factor).round() as u32, source.1)
        }
    }
}

/// How the picture fills its rectangle: whole with bars (`Contain`, the monitor's default)
/// or filling it and cropped at the edges (`Cover`, the phones' `resizeMode: 'fill'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PictureFit {
    #[default]
    Contain,
    Cover,
}

/// The parts of the mobile `PictureEffects` contract that `GradeOptions` predates: the
/// display transform, the cube's intensity and input exposure, the mono and vertical-flip
/// views, solid zebra and the anamorphic desqueeze. Set once on the renderer when they
/// change ([`crate::FeedRenderer::set_look`]); the default changes nothing, so a shell that
/// never sets one paints exactly what it did before.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    /// The curve the feed is in (`signal`): exposure compensation linearises through it.
    pub signal: crate::color::Transfer,
    /// The display transform applied before the cube (`sourceColor`); Rec.709 is none.
    pub display: crate::color::Transfer,
    /// Input exposure in stops of `signal`, before the cube and the display transform.
    pub exposure_stops: f32,
    /// How much of the cube shows over the display transform, 0…1.
    pub lut_intensity: f32,
    /// Rec.709 luma of the graded picture; false colour still paints in colour.
    pub monochrome: bool,
    /// Top-to-bottom flip (MIRROR Vertical).
    pub mirror_vertical: bool,
    /// Zebra in 45° stripes (`true`) or solid.
    pub zebra_stripes: bool,
    pub desqueeze: Desqueeze,
    /// The mobile contract's own peaking ratio threshold and noise gate, when it sent
    /// them; `None` uses [`Peaking::sense`]'s presets (the same three pairs).
    pub peaking_thresholds: Option<[f32; 2]>,
}

impl Default for Look {
    fn default() -> Self {
        Self {
            signal: crate::color::Transfer::Rec709,
            display: crate::color::Transfer::Rec709,
            exposure_stops: 0.0,
            lut_intensity: 1.0,
            monochrome: false,
            mirror_vertical: false,
            zebra_stripes: true,
            desqueeze: Desqueeze::default(),
            peaking_thresholds: None,
        }
    }
}

impl Look {
    /// The same look without the diagnostic views (the virtual camera's "Clean").
    pub fn clean(self) -> Self {
        Self {
            monochrome: false,
            ..self
        }
    }
}
