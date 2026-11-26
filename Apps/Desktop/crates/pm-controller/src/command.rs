//! The mobile `CameraController` / `GimbalController` calls as one serde enum, and what
//! each becomes on the wire.
//!
//! The web sends `camera_command` with one [`CameraCommand`]; this resolves it against
//! the body's own lists (the core's ladders, via `opc_camera::capture`) into
//! [`opc_camera::Command`]s, the same commands the Slint shell's sheets send. Nothing
//! here writes the socket: the caller queues the result onto the camera thread, where
//! the SET mailbox coalesces (latest wins per opcode, 300 ms retransmit).
//!
//! A call the desktop cannot honour yet returns [`Refused`] with operator copy, never a
//! guess. Phase 1 refusals are listed in `docs/desktop-expo-port.md` (Phase 1 status).

use opc_camera::capture::{self, color};
use opc_camera::{Command, Status};
use serde::Deserialize;

use crate::gimbal::GimbalMode;
use crate::state::{color_mode_code, SHOOTING_MODES};
use crate::zoom::{Hop, ZoomPolicy};

/// `number | 'auto'`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum OrAuto {
    Value(f64),
    Auto(AutoWord),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoWord {
    Auto,
}

/// One controller call, as the web's `DesktopCameraSession` sends it:
/// `{ "type": "setIso", "iso": 400 }`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CameraCommand {
    StartRecording {
        #[serde(default)]
        countdown: bool,
    },
    StopRecording,
    CapturePhoto,
    SetShootingMode {
        mode: String,
    },
    SetExposureMode {
        mode: String,
    },
    SetIso {
        iso: OrAuto,
    },
    SetIsoLimit {
        iso: f64,
    },
    SetShutter {
        denom: OrAuto,
    },
    SetEv {
        ev: f64,
    },
    SetAperture {
        f_number: f64,
    },
    SetWhiteBalance {
        #[serde(default)]
        preset: Option<String>,
        #[serde(default)]
        kelvin: Option<i32>,
        #[serde(default)]
        tint: Option<i32>,
    },
    SetFormat {
        #[serde(default)]
        resolution: Option<String>,
        #[serde(default)]
        fps: Option<u32>,
        #[serde(default)]
        color_mode: Option<String>,
        #[serde(default)]
        codec: Option<String>,
        #[serde(default)]
        bitrate: Option<String>,
    },
    SetFocusMode {
        mode: String,
    },
    FocusAt {
        x: f32,
        y: f32,
    },
    SetManualFocus {
        position: f64,
    },
    SetZoom {
        factor: f64,
    },
    ZoomBy {
        rate: f64,
    },
    StartTracking {
        x: f64,
        y: f64,
        #[serde(default)]
        width: Option<f64>,
        #[serde(default)]
        height: Option<f64>,
    },
    StopTracking,
    SetAudio {
        #[serde(default)]
        channel: Option<String>,
        #[serde(default)]
        wind_reduction: Option<bool>,
        #[serde(default)]
        directional: Option<String>,
        #[serde(default)]
        vocal_boost: Option<bool>,
    },
    GimbalRecenter,
    GimbalFlip,
    GimbalSetMode {
        mode: String,
    },
    GimbalSetSpeed {
        speed: String,
    },
    GimbalLevel,
}

/// Why a call was not sent, as operator copy for a notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refused {}

fn refuse<T>(text: &str) -> Result<T, Refused> {
    Err(Refused(text.to_string()))
}

/// Commands to send now, and optionally more after a delay (the tap-focus tail goes
/// 0.4 s after its region SET when no ACK has been seen — the shell's `TAP_ACK_GRACE`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Plan {
    pub now: Vec<Command>,
    pub later: Option<(f64, Vec<Command>)>,
    /// The gimbal mode commanded, for the state's tilt-locked readout.
    pub gimbal_mode: Option<GimbalMode>,
    pub gimbal_speed: Option<u8>,
}

impl Plan {
    fn send(commands: Vec<Command>) -> Self {
        Self {
            now: commands,
            ..Self::default()
        }
    }
}

/// The tap-focus grace: the hint and commit go this long after the region SET.
pub const TAP_ACK_GRACE: f64 = 0.4;

/// What a call needs to know about the body.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    pub status: &'a Status,
    pub model_id: Option<i32>,
    /// A tracking box is out: a tap first stops it, as on the phones.
    pub tracking: bool,
    pub zoom: &'a dyn ZoomPolicy,
}

fn iso_color(status: &Status) -> u8 {
    let photo = status
        .shooting_mode
        .and_then(|code| u8::try_from(code).ok())
        .is_some_and(capture::mode_is_photo);
    if photo {
        color::NORMAL
    } else {
        status.color_mode.unwrap_or(color::NORMAL)
    }
}

/// The `<lo>–<hi>` label's ceiling.
fn ceiling_of(label: &str) -> Option<f64> {
    label
        .rsplit(['–', '-'])
        .next()
        .and_then(|value| value.trim().parse().ok())
}

/// The call on the wire, against what the body says it has.
pub fn plan(command: &CameraCommand, context: Context<'_>) -> Result<Plan, Refused> {
    let status = context.status;
    let model = context.model_id.unwrap_or(-1);
    let model_id = context.model_id.unwrap_or(0);
    let photo_mode = status
        .shooting_mode
        .and_then(|code| u8::try_from(code).ok())
        .is_some_and(capture::mode_is_photo);
    Ok(match command {
        // In a stills mode the record control takes a picture, as on the desktop.
        CameraCommand::StartRecording { .. } => Plan::send(vec![if photo_mode {
            Command::ShootPhoto
        } else {
            Command::RecordStart
        }]),
        CameraCommand::StopRecording => Plan::send(vec![Command::RecordStop]),
        CameraCommand::CapturePhoto => Plan::send(vec![Command::ShootPhoto]),
        CameraCommand::SetShootingMode { mode } => {
            if status.is_recording {
                return refuse("STOP RECORDING TO CHANGE MODE");
            }
            let Some((_, code)) = SHOOTING_MODES.iter().find(|(name, _)| name == mode) else {
                return refuse("THIS CAMERA HAS NO SUCH MODE");
            };
            let Some(byte) = capture::mode_wire_byte(*code, model) else {
                return refuse("THIS CAMERA HAS NO SUCH MODE");
            };
            Plan::send(vec![Command::SetShootingMode(byte)])
        }
        CameraCommand::SetExposureMode { mode } => {
            Plan::send(vec![Command::SetExpoMode(if mode == "manual" {
                0x04
            } else {
                0x01
            })])
        }
        CameraCommand::SetIso { iso } => {
            let indices = capture::iso_indices(iso_color(status), &status.available_iso);
            let index = match iso {
                OrAuto::Auto(_) => indices
                    .iter()
                    .copied()
                    .find(|index| *index == capture::iso::AUTO),
                OrAuto::Value(value) => indices
                    .iter()
                    .copied()
                    .filter(|index| *index != capture::iso::AUTO)
                    .filter_map(|index| {
                        capture::iso_index_value(index).map(|iso| (index, f64::from(iso)))
                    })
                    .min_by(|a, b| (a.1 - value).abs().total_cmp(&(b.1 - value).abs()))
                    .map(|(index, _)| index),
            };
            match index {
                Some(index) => Plan::send(vec![Command::SetIsoIndex(index)]),
                None => return refuse("THIS COLOUR HAS NO SUCH ISO"),
            }
        }
        CameraCommand::SetIsoLimit { iso } => {
            let color = iso_color(status);
            let limit = capture::iso_auto_limits(color)
                .into_iter()
                .filter_map(|limit| {
                    ceiling_of(&capture::iso_auto_limit_label(limit, color, model))
                        .map(|ceiling| (limit, ceiling))
                })
                .min_by(|a, b| (a.1 - iso).abs().total_cmp(&(b.1 - iso).abs()));
            match limit {
                Some((limit, _)) => Plan::send(vec![Command::SetIsoLimit(limit)]),
                None => return refuse("THIS COLOUR HAS NO ISO MAX"),
            }
        }
        CameraCommand::SetShutter { denom } => match denom {
            // The body has no auto shutter outside Auto exposure.
            OrAuto::Auto(_) => Plan::send(vec![Command::SetExpoMode(0x01)]),
            OrAuto::Value(value) => {
                let wheel =
                    capture::shutter_wheel(&status.available_shutter, status.shutter_denominator);
                let Some(denom) = wheel.iter().copied().min_by(|a, b| {
                    (f64::from(*a) - value)
                        .abs()
                        .total_cmp(&(f64::from(*b) - value).abs())
                }) else {
                    return refuse("THE CAMERA HAS NOT LISTED ITS SHUTTERS");
                };
                Plan::send(vec![Command::SetShutter(denom)])
            }
        },
        CameraCommand::SetEv { ev } => Plan::send(vec![Command::SetEv(
            ((ev * 3.0).round() as i32).clamp(-9, 9),
        )]),
        CameraCommand::SetAperture { .. } => return refuse("THIS CAMERA HAS A FIXED APERTURE"),
        CameraCommand::SetWhiteBalance {
            preset,
            kelvin,
            tint,
        } => {
            // A preset changes the temperature, not the tint the operator dialled in.
            let tint = tint
                .or(status.white_balance_tint)
                .unwrap_or(0)
                .clamp(-100, 100);
            let kelvin = kelvin.or(match preset.as_deref() {
                Some("auto") => Some(0),
                Some("daylight") => Some(5600),
                Some("cloudy") => Some(6500),
                Some("incandescent") => Some(3200),
                Some("fluorescent") => Some(4000),
                // `custom` or tint alone: keep the temperature the body reports.
                _ => status.white_balance_kelvin,
            });
            Plan::send(vec![match kelvin {
                Some(kelvin) if kelvin > 0 => Command::SetWhiteBalanceCustom {
                    kelvin: kelvin.clamp(2000, 10000),
                    tint,
                },
                _ => Command::SetWhiteBalanceAuto { tint },
            }])
        }
        CameraCommand::SetFormat {
            resolution,
            fps,
            color_mode,
            codec,
            bitrate,
        } => {
            if codec.is_some() || bitrate.is_some() {
                return refuse("CODEC AND BITRATE ARE SET ON THE CAMERA");
            }
            let mut out = Vec::new();
            if let Some(name) = color_mode {
                if status.is_recording {
                    return refuse("STOP RECORDING TO CHANGE COLOUR");
                }
                let Some(mode) = color_mode_code(name) else {
                    return refuse("THIS CAMERA HAS NO SUCH COLOUR");
                };
                out.push(Command::SetColorMode { mode, model_id });
            }
            if resolution.is_some() || fps.is_some() {
                let listed = capture::format_picker(
                    &status.available_formats,
                    model,
                    status.shooting_mode.unwrap_or(-1),
                );
                let size_of = |code: u8| {
                    capture::resolution_label(code)
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .to_string()
                };
                let want_size = resolution
                    .clone()
                    .or_else(|| status.video_resolution.map(size_of));
                let want_fps =
                    fps.or_else(|| status.video_frame_rate.and_then(capture::frame_rate_fps));
                let matching: Vec<(u8, u8)> = listed
                    .iter()
                    .copied()
                    .filter(|(res, _)| {
                        want_size
                            .as_deref()
                            .is_none_or(|size| size_of(*res) == size)
                    })
                    .collect();
                // A new size keeps the rate when the body offers it there.
                let pick = matching
                    .iter()
                    .copied()
                    .find(|(_, rate)| capture::frame_rate_fps(*rate) == want_fps)
                    .or_else(|| matching.first().copied().filter(|_| fps.is_none()));
                let Some((resolution, frame_rate)) = pick else {
                    return refuse("THE CAMERA DOES NOT OFFER THAT FORMAT");
                };
                out.push(Command::SetVideoFormat {
                    resolution,
                    frame_rate,
                });
            }
            Plan::send(out)
        }
        CameraCommand::SetFocusMode { mode } => match mode.as_str() {
            "afs" => Plan::send(vec![Command::SetFocusMode(0x01)]),
            "afc" => Plan::send(vec![Command::SetFocusMode(0x02)]),
            _ => return refuse("MANUAL FOCUS IS NOT ON THE DESKTOP YET"),
        },
        CameraCommand::FocusAt { x, y } => {
            if !opc_camera::supports_tap_focus(model) {
                return refuse("THIS CAMERA HAS NO TAP FOCUS");
            }
            let [prepare, point, hint, commit] = Command::tap_focus(*x, *y);
            let mut now = Vec::new();
            if context.tracking {
                now.push(Command::TrackClear);
            }
            now.extend([prepare, point]);
            Plan {
                now,
                later: Some((TAP_ACK_GRACE, vec![hint, commit])),
                ..Plan::default()
            }
        }
        CameraCommand::SetManualFocus { .. } => {
            return refuse("MANUAL FOCUS IS NOT ON THE DESKTOP YET")
        }
        CameraCommand::SetZoom { factor } => {
            match context
                .zoom
                .hop(*factor, status.color_mode, status.is_recording)
            {
                Hop::None => Plan::send(vec![Command::ZoomJump(factor.max(1.0))]),
                Hop::Blocked => return refuse("ZOOM IS LOCKED WHILE ROLLING IN D-LOG2"),
                // The hop holds the write until the body reports the colour change;
                // that wait lives in the shell's `ZoomRules` and is not wired here yet.
                Hop::Color(_) => return refuse("D-LOG2 ZOOM HOP IS NOT ON THE DESKTOP YET"),
            }
        }
        CameraCommand::ZoomBy { rate } => {
            if rate.abs() < 1e-3 {
                Plan::send(vec![Command::ZoomStop])
            } else {
                return refuse("CONTINUOUS ZOOM IS NOT ON THE DESKTOP YET");
            }
        }
        CameraCommand::StartTracking {
            x,
            y,
            width,
            height,
        } => {
            let rules = opc_camera::tracking_rules();
            let (Some(width), Some(height)) = (*width, *height) else {
                return refuse("DRAG A BOX AROUND THE SUBJECT");
            };
            if width < rules.minimum_side || height < rules.minimum_side {
                return refuse("FRAME TOO SMALL");
            }
            // The wire is centre and size, as Mimo sends it.
            Plan::send(vec![Command::TrackSet {
                id: 1,
                x: (x + width / 2.0) as f32,
                y: (y + height / 2.0) as f32,
                width: width as f32,
                height: height as f32,
            }])
        }
        CameraCommand::StopTracking => Plan::send(vec![Command::TrackClear]),
        CameraCommand::SetAudio {
            channel,
            wind_reduction,
            directional,
            vocal_boost,
        } => {
            let mut out = Vec::new();
            if let Some(channel) = channel {
                out.push(Command::SetAudioChannel(if channel == "mono" {
                    0x01
                } else {
                    0x02
                }));
            }
            if let Some(on) = vocal_boost {
                out.push(Command::SetVocalBoost(u8::from(*on)));
            }
            if wind_reduction.is_some() || directional.is_some() {
                // Both ride the body's own DSP blob, read with `0x02/0xA0` first.
                let Some(blob) = status.audio_dsp_blob else {
                    out.push(Command::AudioDspGet);
                    if out.len() == 1 {
                        return refuse("READING THE CAMERA'S AUDIO SETTINGS · TRY AGAIN");
                    }
                    return Ok(Plan::send(out));
                };
                if let Some(on) = wind_reduction {
                    out.push(Command::AudioWind { on: *on, blob });
                }
                if let Some(direction) = directional {
                    let mode = match direction.as_str() {
                        "off" => 0xDA,
                        "front" => 0x3A,
                        "surround" => 0xBA,
                        _ => return refuse("THIS CAMERA HAS NO REAR-ONLY AUDIO"),
                    };
                    out.push(Command::AudioDirectional { mode, blob });
                }
            }
            Plan::send(out)
        }
        CameraCommand::GimbalRecenter | CameraCommand::GimbalLevel => {
            Plan::send(vec![Command::GimbalRecenter])
        }
        CameraCommand::GimbalFlip => Plan::send(vec![Command::GimbalFlip]),
        CameraCommand::GimbalSetMode { mode } => {
            let gimbal = match mode.as_str() {
                "follow" => GimbalMode::Follow,
                "tilt-locked" => GimbalMode::TiltLocked,
                "fpv" => GimbalMode::Fpv,
                "locked" => GimbalMode::DirectionLock,
                _ => return refuse("THIS GIMBAL HAS NO SUCH MODE"),
            };
            Plan {
                now: gimbal.commands(),
                gimbal_mode: Some(gimbal),
                ..Plan::default()
            }
        }
        CameraCommand::GimbalSetSpeed { speed } => {
            let code = match speed.as_str() {
                "slow" => 0x02,
                "fast" => 0x00,
                _ => 0x01,
            };
            Plan {
                now: vec![Command::GimbalSpeed(code)],
                gimbal_speed: Some(code),
                ..Plan::default()
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zoom::Assumed;

    fn context(status: &Status) -> Context<'_> {
        Context {
            status,
            model_id: Some(0x20),
            tracking: false,
            zoom: &Assumed,
        }
    }

    fn parse(json: &str) -> CameraCommand {
        serde_json::from_str(json).expect("valid command")
    }

    #[test]
    fn the_web_vocabulary_parses() {
        assert_eq!(
            parse(r#"{"type":"setIso","iso":"auto"}"#),
            CameraCommand::SetIso {
                iso: OrAuto::Auto(AutoWord::Auto)
            }
        );
        assert_eq!(
            parse(r#"{"type":"setWhiteBalance","kelvin":5600}"#),
            CameraCommand::SetWhiteBalance {
                preset: None,
                kelvin: Some(5600),
                tint: None
            }
        );
        assert_eq!(
            parse(r#"{"type":"setFormat","colorMode":"dlog-m"}"#),
            CameraCommand::SetFormat {
                resolution: None,
                fps: None,
                color_mode: Some("dlog-m".to_string()),
                codec: None,
                bitrate: None
            }
        );
        assert_eq!(
            parse(r#"{"type":"gimbalRecenter"}"#),
            CameraCommand::GimbalRecenter
        );
    }

    #[test]
    fn record_takes_a_picture_in_a_stills_mode() {
        let mut status = Status::default();
        let start = CameraCommand::StartRecording { countdown: false };
        assert_eq!(
            plan(&start, context(&status)).unwrap().now,
            vec![Command::RecordStart]
        );
        status.shooting_mode = Some(i32::from(capture::mode::PHOTO_POCKET3_NANO));
        assert_eq!(
            plan(&start, context(&status)).unwrap().now,
            vec![Command::ShootPhoto]
        );
    }

    #[test]
    fn iso_and_shutter_snap_to_the_bodys_ladders() {
        let status = Status {
            available_shutter: vec![25, 50, 100, 200],
            ..Status::default()
        };
        let iso = plan(
            &CameraCommand::SetIso {
                iso: OrAuto::Value(420.0),
            },
            context(&status),
        )
        .unwrap();
        assert_eq!(iso.now.len(), 1);
        assert!(
            matches!(iso.now[0], Command::SetIsoIndex(index) if capture::iso_index_value(index) == Some(400))
        );
        let shutter = plan(
            &CameraCommand::SetShutter {
                denom: OrAuto::Value(60.0),
            },
            context(&status),
        )
        .unwrap();
        assert_eq!(shutter.now, vec![Command::SetShutter(50)]);
        let ev = plan(&CameraCommand::SetEv { ev: -0.7 }, context(&status)).unwrap();
        assert_eq!(ev.now, vec![Command::SetEv(-2)]);
    }

    #[test]
    fn white_balance_keeps_the_tint_and_presets_land_on_kelvin() {
        let status = Status {
            white_balance_tint: Some(20),
            ..Status::default()
        };
        let daylight = plan(
            &CameraCommand::SetWhiteBalance {
                preset: Some("daylight".into()),
                kelvin: None,
                tint: None,
            },
            context(&status),
        )
        .unwrap();
        assert_eq!(
            daylight.now,
            vec![Command::SetWhiteBalanceCustom {
                kelvin: 5600,
                tint: 20
            }]
        );
        let auto = plan(
            &CameraCommand::SetWhiteBalance {
                preset: Some("auto".into()),
                kelvin: None,
                tint: None,
            },
            context(&status),
        )
        .unwrap();
        assert_eq!(auto.now, vec![Command::SetWhiteBalanceAuto { tint: 20 }]);
    }

    #[test]
    fn mode_and_colour_changes_wait_for_the_take_to_end() {
        let status = Status {
            is_recording: true,
            ..Status::default()
        };
        assert!(plan(
            &CameraCommand::SetShootingMode {
                mode: "photo".into()
            },
            context(&status)
        )
        .is_err());
        assert!(plan(
            &CameraCommand::SetFormat {
                resolution: None,
                fps: None,
                color_mode: Some("dlog".into()),
                codec: None,
                bitrate: None
            },
            context(&status)
        )
        .is_err());
    }

    #[test]
    fn a_tap_focuses_in_two_halves_and_a_box_is_sent_as_centre_and_size() {
        let status = Status::default();
        let mut tracking = context(&status);
        tracking.tracking = true;
        let tap = plan(&CameraCommand::FocusAt { x: 0.25, y: 0.5 }, tracking).unwrap();
        assert_eq!(tap.now[0], Command::TrackClear);
        assert_eq!(tap.now.len(), 3);
        let (delay, tail) = tap.later.expect("hint and commit");
        assert!((delay - TAP_ACK_GRACE).abs() < 1e-9);
        assert_eq!(tail.len(), 2);

        let small = CameraCommand::StartTracking {
            x: 0.1,
            y: 0.1,
            width: Some(0.05),
            height: Some(0.2),
        };
        assert_eq!(
            plan(&small, context(&status)),
            Err(Refused("FRAME TOO SMALL".into()))
        );
        let good = CameraCommand::StartTracking {
            x: 0.1,
            y: 0.2,
            width: Some(0.2),
            height: Some(0.4),
        };
        match plan(&good, context(&status)).unwrap().now[0] {
            Command::TrackSet {
                x,
                y,
                width,
                height,
                ..
            } => {
                assert!((x - 0.2).abs() < 1e-6 && (y - 0.4).abs() < 1e-6);
                assert!((width - 0.2).abs() < 1e-6 && (height - 0.4).abs() < 1e-6);
            }
            ref other => panic!("not a box: {other:?}"),
        }
    }

    #[test]
    fn zoom_in_dlog2_is_refused_until_the_hop_is_wired() {
        let status = Status {
            color_mode: Some(color::D_LOG2),
            ..Status::default()
        };
        assert!(plan(&CameraCommand::SetZoom { factor: 2.0 }, context(&status)).is_err());
        let normal = Status::default();
        assert_eq!(
            plan(&CameraCommand::SetZoom { factor: 2.0 }, context(&normal))
                .unwrap()
                .now,
            vec![Command::ZoomJump(2.0)]
        );
    }

    #[test]
    fn gimbal_modes_send_the_shells_frames() {
        let status = Status::default();
        let tilt = plan(
            &CameraCommand::GimbalSetMode {
                mode: "tilt-locked".into(),
            },
            context(&status),
        )
        .unwrap();
        assert_eq!(tilt.now, GimbalMode::TiltLocked.commands());
        assert_eq!(tilt.gimbal_mode, Some(GimbalMode::TiltLocked));
    }
}
