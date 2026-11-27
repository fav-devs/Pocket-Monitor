//! The desktop viewfinder.
//!
//! Only the part that decides things lives here. The window and the camera link are
//! modules of the binary instead, because both reach the Swift core through
//! `opc-camera`, and a test of the viewfinder's behaviour should not need a toolchain
//! that can build it.

// The chrome-free logic moved to `pm-controller` (docs/desktop-expo-port.md §3.4). The
// paths stay the same here, so the shell, its tests and the binary build unchanged.
pub use pm_controller::{
    appsettings, assists, clap, facenet, gesture, hand, handnet, homewifi, luts, moves, pad, prefs,
    presets, scopes, zoom,
};

pub mod library;
pub mod logfile;
pub mod phone;
pub mod sheets;
pub mod shell;

pub use assists::{AssistOptions, AssistTool};
pub use library::{Library, MediaAction, Player};
pub use luts::{LutChoice, LutMenu};
pub use opc_camera::SetOutcome;
pub use pad::{PadAction, PadButton};
pub use sheets::{Part, Prefs, SetupInfo};
pub use shell::{FalseColorKey, GimbalMode, Intent, LutRequest, Shell, Toggles, TouchPhase};
