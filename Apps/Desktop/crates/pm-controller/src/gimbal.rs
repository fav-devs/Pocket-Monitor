//! The gimbal stick on its own clock.
//!
//! `stick_axes` and `zoom_trigger_step` are the shell's (moved here from
//! `opc-monitor/src/shell.rs`, which now calls these). [`GimbalDrive`] is the state the
//! Tauri app's 100 Hz input thread owns (§3.3 of `docs/desktop-expo-port.md`): the web
//! posts a target throw and a heartbeat, and this decides what goes on the wire and when.
//!
//! - A changed throw goes out at once (without a ramp), as the shell's keys and pad do.
//! - A held throw is re-sent every [`STICK_REPEAT`] (200 ms), the body's keepalive.
//! - With the ramp on (Soft/Medium), the throw eases at 25 Hz ([`RAMP_STEP`]).
//! - Release rests the stick (eased when the ramp is on). A cancel, focus loss, window
//!   close or a drive heartbeat silent for [`HEARTBEAT_TIMEOUT`] rests it at once,
//!   whatever the web layer is doing.

use opc_camera::Command;
use opc_ui::RampFilter;
use serde::{Deserialize, Serialize};

use crate::pad::REST as PAD_REST;

/// The body's stick keepalive while a throw is held.
pub const STICK_REPEAT: f64 = 0.2;
/// The ramp's step: 25 Hz.
pub const RAMP_STEP: f64 = 0.04;
/// A drive with no heartbeat for this long is a hung or reloaded web view: rest.
pub const HEARTBEAT_TIMEOUT: f64 = 0.25;
/// The input thread's tick.
pub const INPUT_TICK_SECONDS: f64 = 0.01;

/// An analog stick onto the gimbal axes with the phones' curve and sensitivity ticks.
/// The Pocket 3's desktop UDP control direction is opposite to the on-screen and
/// controller coordinate system: right/up must therefore be negated at this desktop
/// boundary before the portable mapping encodes tilt/pan. Without the core, a plain
/// scaled throw stands in.
#[cfg(opc_core_linked)]
pub fn stick_axes(x: f64, y: f64, sensitivity: u8) -> Command {
    let mut out = [0_i32; 2];
    // Safety: `out` has the two slots the core writes.
    let status = unsafe {
        opc_core_sys::opc_gimbal_stick_axes(-x, -y, i32::from(sensitivity), out.as_mut_ptr())
    };
    if status != opc_core_sys::OPC_RELAY_OK {
        return opc_ui::stick_command(x, y);
    }
    Command::GimbalStick {
        axis0: u16::try_from(out[0]).unwrap_or(opc_ui::STICK_CENTRE),
        axis1: u16::try_from(out[1]).unwrap_or(opc_ui::STICK_CENTRE),
    }
}

#[cfg(not(opc_core_linked))]
pub fn stick_axes(x: f64, y: f64, sensitivity: u8) -> Command {
    let gain = f64::from(sensitivity.clamp(1, 5)) / 4.0;
    opc_ui::stick_command((-x * gain).clamp(-1.0, 1.0), (-y * gain).clamp(-1.0, 1.0))
}

/// Hold-to-zoom on the triggers at the phones' rate; three stops a second without the core.
#[cfg(opc_core_linked)]
pub fn zoom_trigger_step(current: f64, left: f64, right: f64, dt: f64, max: f64) -> f64 {
    // Safety: plain values in.
    unsafe { opc_core_sys::opc_zoom_trigger_step(current, left, right, dt, max) }
}

#[cfg(not(opc_core_linked))]
pub fn zoom_trigger_step(current: f64, left: f64, right: f64, dt: f64, max: f64) -> f64 {
    let axis = right.clamp(0.0, 1.0) - left.clamp(0.0, 1.0);
    let throw = if axis.abs() < PAD_REST {
        0.0
    } else {
        axis.signum() * (axis.abs() - PAD_REST) / (1.0 - PAD_REST)
    };
    (current + throw * 3.0 * dt).clamp(1.0, max.max(1.0))
}

/// The gimbal's live mode, as commanded. The body's GET cannot tell FPV from Tilt
/// locked, so the shell keeps what it last asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GimbalMode {
    Follow,
    TiltLocked,
    Fpv,
    /// The picture holds its heading while the body turns.
    DirectionLock,
}

impl GimbalMode {
    /// The SET frames for a mode, in the order the mobile shells send them.
    pub fn commands(self) -> Vec<Command> {
        match self {
            Self::Follow => vec![Command::GimbalFollow, Command::GimbalTiltLock(0)],
            Self::TiltLocked => vec![Command::GimbalFollow, Command::GimbalTiltLock(1)],
            Self::Fpv => vec![Command::GimbalFpv],
            Self::DirectionLock => vec![Command::GimbalDirectionLock],
        }
    }

    /// Mimo's order when the FOLLOW button cycles.
    pub fn next(self) -> Self {
        match self {
            Self::Follow => Self::TiltLocked,
            Self::TiltLocked => Self::Fpv,
            Self::Fpv | Self::DirectionLock => Self::Follow,
        }
    }
}

/// Who is driving: the arrow keys, a game controller, or the on-screen pad / touch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriveSource {
    Keys,
    Pad,
    Touch,
}

/// One stick write, with the throw it carries for the `stick tx` log line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StickSend {
    pub command: Command,
    pub x: f64,
    pub y: f64,
    pub rest: bool,
}

/// The stick stream. Pure: every call takes `now` in seconds, so the timing rules are
/// testable without a thread or a camera.
#[derive(Debug, Clone)]
pub struct GimbalDrive {
    sensitivity: u8,
    tau: f64,
    target: (f64, f64),
    source: Option<DriveSource>,
    heard_at: f64,
    ramp: RampFilter,
    ramp_ticked_at: f64,
    sent: (f64, f64),
    sent_at: f64,
}

impl GimbalDrive {
    /// `sensitivity` is the phones' 1…5 ticks; `tau` the ramp's time constant
    /// (`Prefs::ramp_tau`, 0 for off).
    pub fn new(sensitivity: u8, tau: f64) -> Self {
        Self {
            sensitivity: sensitivity.clamp(1, 5),
            tau: tau.max(0.0),
            target: (0.0, 0.0),
            source: None,
            heard_at: f64::NEG_INFINITY,
            ramp: RampFilter::default(),
            ramp_ticked_at: f64::NEG_INFINITY,
            sent: (0.0, 0.0),
            sent_at: f64::NEG_INFINITY,
        }
    }

    pub fn set_feel(&mut self, sensitivity: u8, tau: f64) {
        self.sensitivity = sensitivity.clamp(1, 5);
        self.tau = tau.max(0.0);
    }

    /// Who holds the stick now.
    pub fn source(&self) -> Option<DriveSource> {
        self.source
    }

    /// The throw last put on the wire.
    pub fn sent(&self) -> (f64, f64) {
        self.sent
    }

    pub fn is_resting(&self) -> bool {
        self.target == (0.0, 0.0) && self.sent == (0.0, 0.0)
    }

    /// A target throw in −1…1 (right and up positive), or a heartbeat repeating it.
    /// A throw inside the pad's rest zone is a release.
    pub fn drive(&mut self, x: f64, y: f64, source: DriveSource, now: f64) -> Option<StickSend> {
        let (x, y) = (clean(x), clean(y));
        if x.abs() < PAD_REST * 0.25 && y.abs() < PAD_REST * 0.25 {
            return self.release(Some(source), now);
        }
        self.source = Some(source);
        self.heard_at = now;
        self.target = (x, y);
        if self.tau <= 0.0 {
            if moved(self.sent, self.target) {
                return Some(self.send(x, y, now));
            }
            return None;
        }
        // One nominal frame of ease, so the first send is a fraction of the throw.
        self.ramp_ticked_at = self.ramp_ticked_at.max(now - RAMP_STEP);
        self.ramp_step(now)
    }

    /// The control that was driving let go. A release from someone else who is not
    /// driving is ignored, so letting go of the pad does not stop the keys.
    pub fn release(&mut self, source: Option<DriveSource>, now: f64) -> Option<StickSend> {
        if let (Some(driving), Some(released)) = (self.source, source) {
            if driving != released {
                return None;
            }
        }
        self.source = None;
        self.target = (0.0, 0.0);
        if self.tau <= 0.0 {
            return Some(self.send(0.0, 0.0, now));
        }
        self.ramp_ticked_at = self.ramp_ticked_at.max(now - RAMP_STEP);
        self.ramp_step(now).or_else(|| {
            // Already at rest: still say so, once, so a release always reaches the body.
            (self.sent == (0.0, 0.0)).then(|| self.send(0.0, 0.0, now))
        })
    }

    /// Rest now, no ease: cancel, focus loss, window close, heartbeat loss.
    pub fn rest_now(&mut self, now: f64) -> StickSend {
        self.source = None;
        self.target = (0.0, 0.0);
        self.ramp.reset();
        self.send(0.0, 0.0, now)
    }

    /// The clock moved on. Called by the input thread every tick.
    pub fn tick(&mut self, now: f64) -> Option<StickSend> {
        if self.source.is_some() && now - self.heard_at >= HEARTBEAT_TIMEOUT {
            return Some(self.rest_now(now));
        }
        if self.tau > 0.0 {
            let held = self.target != (0.0, 0.0);
            if (self.ramp_busy()
                || !self.ramp.is_settled_at_rest()
                || self.ramp != RampFilter::default())
                && now - self.ramp_ticked_at >= RAMP_STEP
            {
                return self.ramp_step(now);
            }
            if held && now - self.sent_at >= STICK_REPEAT {
                return Some(self.send(self.ramp.x, self.ramp.y, now));
            }
            return None;
        }
        if self.target != (0.0, 0.0) && now - self.sent_at >= STICK_REPEAT {
            let (x, y) = self.target;
            return Some(self.send(x, y, now));
        }
        None
    }

    fn send(&mut self, x: f64, y: f64, now: f64) -> StickSend {
        self.sent = (x, y);
        self.sent_at = now;
        StickSend {
            command: stick_axes(x, y, self.sensitivity),
            x,
            y,
            rest: x == 0.0 && y == 0.0,
        }
    }

    fn ramp_busy(&self) -> bool {
        (self.ramp.x - self.target.0).abs() > 0.005 || (self.ramp.y - self.target.1).abs() > 0.005
    }

    /// One step of the ramp toward the target; sends when the throw moved. The same
    /// arithmetic as the shell's `ramp_step`.
    fn ramp_step(&mut self, now: f64) -> Option<StickSend> {
        let dt = (now - self.ramp_ticked_at).clamp(0.0, 0.2);
        if dt <= 0.0 {
            // `RampFilter::tick` treats no time as a passthrough, which would jump the
            // throw; two events at the same instant wait for the next tick instead.
            return None;
        }
        self.ramp_ticked_at = now;
        let (tx, ty) = self.target;
        let before = self.ramp;
        let (mut x, mut y) = self.ramp.tick(tx, ty, self.tau, dt);
        if tx == 0.0 && ty == 0.0 && self.ramp.is_settled_at_rest() {
            self.ramp.reset();
            x = 0.0;
            y = 0.0;
        } else if (x - tx).abs() < 0.01 && (y - ty).abs() < 0.01 {
            self.ramp.x = tx;
            self.ramp.y = ty;
            x = tx;
            y = ty;
        }
        let moved = (x - before.x).abs() > 0.005 || (y - before.y).abs() > 0.005;
        let rested_now = x == 0.0 && y == 0.0 && (before.x != 0.0 || before.y != 0.0);
        (moved || rested_now).then(|| self.send(x, y, now))
    }
}

fn clean(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn moved(from: (f64, f64), to: (f64, f64)) -> bool {
    (from.0 - to.0).abs() > 0.005 || (from.1 - to.1).abs() > 0.005
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rest() -> Command {
        stick_axes(0.0, 0.0, 4)
    }

    #[test]
    fn a_throw_goes_out_at_once_and_is_kept_alive_every_200_ms() {
        let mut drive = GimbalDrive::new(4, 0.0);
        let first = drive.drive(1.0, 0.0, DriveSource::Keys, 0.0).expect("sent");
        assert!(!first.rest);
        assert_eq!(first.command, stick_axes(1.0, 0.0, 4));
        // Heartbeats with the same throw send nothing new...
        assert!(drive.drive(1.0, 0.0, DriveSource::Keys, 0.1).is_none());
        assert!(drive.tick(0.15).is_none());
        // ...but the keepalive does.
        drive.drive(1.0, 0.0, DriveSource::Keys, 0.19);
        let again = drive.tick(0.2).expect("keepalive");
        assert_eq!(again.command, first.command);
    }

    #[test]
    fn release_rests_at_once_without_a_ramp() {
        let mut drive = GimbalDrive::new(4, 0.0);
        drive.drive(0.5, 0.5, DriveSource::Touch, 0.0);
        let released = drive.release(Some(DriveSource::Touch), 0.05).expect("rest");
        assert!(released.rest);
        assert_eq!(released.command, rest());
        assert!(
            drive.tick(0.5).is_none(),
            "a rested stick sends nothing more"
        );
    }

    #[test]
    fn a_silent_heartbeat_rests_the_stick_within_250_ms() {
        let mut drive = GimbalDrive::new(4, 0.0);
        drive.drive(-1.0, 0.0, DriveSource::Pad, 0.0);
        assert!(
            drive.tick(0.24).is_some_and(|send| !send.rest),
            "keepalive at 200 ms"
        );
        let rested = drive.tick(0.25).expect("heartbeat lost");
        assert!(rested.rest);
        assert_eq!(drive.source(), None);
    }

    #[test]
    fn another_source_letting_go_does_not_stop_the_driver() {
        let mut drive = GimbalDrive::new(4, 0.0);
        drive.drive(1.0, 0.0, DriveSource::Keys, 0.0);
        assert!(drive.release(Some(DriveSource::Pad), 0.01).is_none());
        assert_eq!(drive.source(), Some(DriveSource::Keys));
    }

    #[test]
    fn a_drive_inside_the_rest_zone_is_a_release() {
        let mut drive = GimbalDrive::new(4, 0.0);
        drive.drive(1.0, 0.0, DriveSource::Touch, 0.0);
        assert!(drive
            .drive(0.0, 0.0, DriveSource::Touch, 0.02)
            .is_some_and(|s| s.rest));
    }

    #[test]
    fn with_the_ramp_on_a_throw_eases_in_at_25_hz_and_back_to_rest() {
        let mut drive = GimbalDrive::new(4, 0.18);
        let first = drive
            .drive(1.0, 0.0, DriveSource::Keys, 0.0)
            .expect("eases in");
        assert!(
            first.x > 0.0 && first.x < 1.0,
            "a fraction first: {}",
            first.x
        );
        let mut now = 0.0;
        let mut last = first.x;
        while now < 2.0 {
            now += INPUT_TICK_SECONDS;
            drive.drive(1.0, 0.0, DriveSource::Keys, now);
            if let Some(send) = drive.tick(now) {
                last = send.x;
            }
        }
        assert!((last - 1.0).abs() < 1e-9, "reaches the full throw: {last}");
        now += 0.005;
        let eased = drive.release(Some(DriveSource::Keys), now);
        assert!(
            eased.is_none_or(|send| !send.rest),
            "a ramped release eases"
        );
        let mut rested = false;
        for _ in 0..300 {
            now += INPUT_TICK_SECONDS;
            if drive.tick(now).is_some_and(|send| send.rest) {
                rested = true;
                break;
            }
        }
        assert!(rested, "eases back to rest and says so");
        assert!(drive.is_resting());
    }

    #[test]
    fn rest_now_skips_the_ease() {
        let mut drive = GimbalDrive::new(4, 0.35);
        drive.drive(1.0, 1.0, DriveSource::Pad, 0.0);
        let rested = drive.rest_now(0.01);
        assert!(rested.rest);
        assert!(drive.is_resting());
    }
}
