//! Which assists the operator has switched on, and what the feed pass paints for them.
//!
//! Moved out of `opc-monitor`'s shell so the Tauri backend and the old viewfinder share
//! one definition.

use opc_render::{AssistScalars, GradeOptions, Peaking, Zebra};

use crate::assists::AssistOptions;

/// Assists the operator has switched on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Toggles {
    pub zebra: bool,
    pub peaking: bool,
    pub grade: bool,
    pub mirror: bool,
    pub false_color: bool,
    pub grid: bool,
    pub guides: bool,
    pub cross: bool,
    /// The scopes.
    pub wave: bool,
    pub parade: bool,
    pub histo: bool,
    pub vector: bool,
    pub lights: bool,
    pub nd: bool,
    pub audio: bool,
}

impl Toggles {
    /// Whether any plate reads the picture, so the window samples it.
    pub fn any_scope(self) -> bool {
        self.wave || self.parade || self.histo || self.vector || self.lights || self.nd
    }
}

impl Toggles {
    /// What the feed pass paints. The zebra thresholds are the operator's IRE put on
    /// the feed's axis by the core; without the core linked they are read as a plain
    /// fraction, which is right for Rec.709 and generous for log.
    pub fn options(self, assists: &AssistOptions, scalars: Option<AssistScalars>) -> GradeOptions {
        let zebra = assists.zebra;
        let (highlight, midtone) = match scalars {
            Some(scalars) => (scalars.highlight, (scalars.midtone, scalars.midtone_half)),
            None => (
                zebra.highlight_ire / 100.0,
                (zebra.midtone_ire / 100.0, 0.05),
            ),
        };
        GradeOptions {
            mirror: self.mirror,
            zebra: self.zebra.then(|| Zebra {
                highlight: zebra.highlight_on.then_some(highlight),
                midtone: zebra.midtone_on.then_some(midtone),
                highlight_color: zebra.highlight_color.rgba(),
                midtone_color: zebra.midtone_color.rgba(),
            }),
            peaking: self.peaking.then(|| Peaking {
                sense: assists.peaking_sense,
                color: assists.peaking_color.rgba(),
            }),
            false_color: self.false_color,
            ..GradeOptions::default()
        }
    }

    pub fn names(self) -> Vec<&'static str> {
        [
            ("LUT", self.grade),
            ("ZEB", self.zebra),
            ("PEAK", self.peaking),
            ("FALSE", self.false_color),
            ("MIR", self.mirror),
        ]
        .into_iter()
        .filter(|(_, on)| *on)
        .map(|(name, _)| name)
        .collect()
    }
}
