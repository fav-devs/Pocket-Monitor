//! Pocket Monitor's controller: the decisions and the camera-side threads, without a
//! window or a UI toolkit.
//!
//! This is the `opc-controller` crate of `docs/desktop-expo-port.md` §3.4, under the
//! product's own name. The logic modules moved here verbatim from `opc-monitor` (which
//! re-exports them, so the Slint viewfinder keeps building on them until the Tauri app
//! passes the acceptance gates):
//!
//! - [`link`]: the camera datalink on its own thread (40 Hz ACK pump, mailbox, watchdog).
//! - [`decode`]: the codec latch, the keyframe skip and the ready-queue limit.
//! - [`gimbal`]: the stick curve and the stick stream the input thread owns.
//! - [`assists`], [`scopes`], [`luts`], [`prefs`], [`toggles`], [`appsettings`], [`zoom`],
//!   [`moves`], [`presets`], [`pad`], [`gesture`], [`hand`], [`homewifi`].
//!
//! And the vocabulary the Tauri app speaks to the Expo web build:
//!
//! - [`state`]: the mobile `CameraState` shape, built from the core's `Status`.
//! - [`command`]: the mobile `CameraController` calls as a serde enum, mapped onto
//!   [`opc_camera::Command`].
//! - [`effects`]: the mobile `PictureEffects`, mapped onto `opc_render::GradeOptions`.
//!
//! The shell's chrome-bound halves (`shell.rs`, `sheets.rs`, `library.rs`, `phone.rs`)
//! stay in `opc-monitor` for now; their decisions move here area by area.

pub mod appsettings;
pub mod assists;
pub mod command;
pub mod decode;
pub mod effects;
pub mod gesture;
pub mod gimbal;
pub mod hand;
pub mod homewifi;
pub mod input;
pub mod keys;
pub mod launch;
pub mod library;
pub mod link;
pub mod luts;
pub mod moves;
pub mod pad;
pub mod phone;
pub mod platform;
pub mod playback;
pub mod prefs;
pub mod presets;
pub mod scopes;
pub mod state;
pub mod toggles;
pub mod tracking;
pub mod vcam;
pub mod zoom;

pub use assists::{AssistOptions, AssistTool};
pub use luts::{LutChoice, LutMenu};
pub use pad::{PadAction, PadButton};
pub use prefs::{Part, Prefs};
pub use toggles::Toggles;
