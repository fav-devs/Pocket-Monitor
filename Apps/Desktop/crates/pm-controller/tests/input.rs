//! The live controls, driven with a fake clock: the `opc-monitor/tests/shell.rs` cases for
//! keys, the stick, the controller, zoom, tracking, tap focus, the countdown, programmed
//! moves, presets and gestures, ported to `pm_controller::input::LiveInput`.
//!
//! Pointers are in picture fractions as seen: the shell tests' 1280 × 720 window with a
//! 16:9 picture edge to edge, so (320, 180) is (0.25, 0.25).

use opc_camera::{Command, SetOutcome, Status, TrackingPoll};
use opc_ui::Key;
use pm_controller::gesture::{Gesture, GestureAction, GestureMap};
use pm_controller::gimbal::{stick_axes, DriveSource};
use pm_controller::input::LiveInput;
use pm_controller::keys::{self, Route};
use pm_controller::pad::PadButton;
use pm_controller::prefs::Prefs;
use pm_controller::tracking::PointerPhase;
use pm_controller::zoom::ZoomWrite;

const CENTRE: u16 = opc_ui::controls::STICK_CENTRE;

fn input() -> LiveInput {
    LiveInput::new(&Prefs::default())
}

fn rest() -> Command {
    Command::GimbalStick {
        axis0: CENTRE,
        axis1: CENTRE,
    }
}

fn drag(input: &mut LiveInput, from: (f64, f64), to: (f64, f64), now: f64) -> Vec<Command> {
    input.pointer(PointerPhase::Down, 1, from.0, from.1, now);
    input.pointer(PointerPhase::Move, 1, to.0, to.1, now);
    input.pointer(PointerPhase::Up, 1, to.0, to.1, now)
}

fn quarter(input: &mut LiveInput, now: f64) -> Vec<Command> {
    drag(input, (0.25, 0.25), (0.5, 0.5), now)
}

fn pose(yaw_tenth: i16, seq: u32) -> Status {
    Status {
        gimbal_yaw_tenth: Some(yaw_tenth),
        gimbal_pitch_tenth: Some(0),
        gimbal_native_pitch_tenth: Some(0),
        gimbal_attitude_seq: seq,
        ..Status::default()
    }
}

fn notices(input: &mut LiveInput) -> Vec<String> {
    input.take_notices().into_iter().map(|n| n.text).collect()
}

// ── Keys ─────────────────────────────────────────────────────────────────────

#[test]
fn space_rolls_and_r_stops() {
    let mut input = input();
    assert_eq!(
        input.key_down(Key::Space, false, 0.0),
        [Command::RecordStart]
    );
    assert_eq!(
        input.key_down(Key::Char('r'), false, 0.0),
        [Command::RecordStop]
    );
}

#[test]
fn the_timer_fires_once_and_then_leaves_the_camera_alone() {
    let mut input = input();
    assert!(
        input.key_down(Key::Char('t'), false, 0.0).is_empty(),
        "arming sends nothing"
    );
    assert_eq!(input.countdown(0.5), Some(3), "visible while it runs");
    assert!(input.tick(1.0).is_empty());
    assert!(input.tick(2.9).is_empty());
    assert_eq!(input.tick(3.0), [Command::RecordStart]);
    assert!(
        input.tick(3.1).is_empty(),
        "a fired countdown does not roll again"
    );
    assert_eq!(input.countdown(3.1), None);
}

#[test]
fn the_timer_can_be_cancelled_and_its_length_is_the_operators() {
    let mut input = input();
    input.key_down(Key::Char('t'), false, 0.0);
    input.key_down(Key::Char('t'), false, 1.0);
    assert!(
        input.tick(10.0).is_empty(),
        "a cancelled countdown never rolls"
    );
    input.set_countdown_seconds(10);
    input.countdown_toggle(20.0);
    assert!(input.tick(25.0).is_empty());
    assert_eq!(input.tick(30.0), [Command::RecordStart]);
}

#[test]
fn holding_an_arrow_pans_and_letting_go_stops() {
    let mut input = input();
    assert_eq!(input.key_down(Key::Right, false, 0.0).len(), 1);
    assert_eq!(input.key_up(Key::Right, 0.1), [rest()]);
}

#[test]
fn two_arrows_are_a_diagonal_and_opposites_cancel() {
    let mut input = input();
    input.key_down(Key::Right, false, 0.0);
    assert_eq!(
        input.key_down(Key::Up, false, 0.01),
        [stick_axes(1.0, 1.0, 4)]
    );
    input.key_up(Key::Up, 0.02);
    assert_eq!(input.key_down(Key::Left, false, 0.03), [rest()]);
    assert!(!input.is_resting() || input.stick_sent() == (0.0, 0.0));
}

#[test]
fn a_held_stick_is_kept_alive_and_a_resting_one_is_not() {
    let mut input = input();
    input.key_down(Key::Left, false, 0.0);
    assert!(input.tick(0.1).is_empty(), "too soon to repeat");
    input.key_down(Key::Left, true, 0.15);
    assert_eq!(input.tick(0.21).len(), 1, "the stick is kept alive");
    input.key_up(Key::Left, 0.3);
    assert!(input.tick(5.0).is_empty(), "a stick at rest is not re-sent");
}

#[test]
fn a_repeat_of_a_key_already_down_does_not_flood_the_camera() {
    let mut input = input();
    assert_eq!(input.key_down(Key::Up, false, 0.0).len(), 1);
    for _ in 0..20 {
        assert!(input.key_down(Key::Up, true, 0.0).is_empty());
        assert!(input.key_down(Key::Up, false, 0.0).is_empty());
    }
    assert!(
        input.key_down(Key::Space, true, 0.0).is_empty(),
        "a repeated Space does not roll twice"
    );
}

#[test]
fn arrows_held_while_the_web_goes_silent_rest_within_250_ms() {
    let mut input = input();
    input.key_down(Key::Right, false, 0.0);
    assert!(
        input.tick(0.2).iter().all(|c| *c != rest()),
        "the keepalive"
    );
    assert_eq!(
        input.tick(0.26),
        [rest()],
        "no heartbeat: a hung web view rests the gimbal"
    );
    assert!(
        input.key_up(Key::Right, 0.3).is_empty(),
        "the late key-up sends nothing more"
    );
}

#[test]
fn v_cycles_the_gimbal_mode_without_opening_a_sheet() {
    use pm_controller::gimbal::GimbalMode;
    assert_eq!(
        keys::parse("v").and_then(keys::route),
        Some(Route::GimbalCycle)
    );
    assert_eq!(keys::next_gimbal_mode("follow"), "tilt-locked");
    assert_eq!(
        GimbalMode::TiltLocked.commands(),
        [Command::GimbalFollow, Command::GimbalTiltLock(1)],
        "V moves Follow to Tilt Locked"
    );
    assert_eq!(keys::next_gimbal_mode("tilt-locked"), "fpv");
    assert_eq!(GimbalMode::Fpv.commands(), [Command::GimbalFpv]);
}

#[test]
fn the_ui_keys_stay_out_of_the_camera() {
    let mut input = input();
    for c in ['z', 'p', 'l', 'm', 'h', 'e', 'k', 'a', 'g', 's'] {
        assert!(
            matches!(
                keys::parse(&c.to_string()).and_then(keys::route),
                Some(Route::Ui(_))
            ),
            "{c} is the web's"
        );
        assert!(
            input.key_down(Key::Char(c), false, 0.0).is_empty(),
            "{c} sends nothing"
        );
    }
    assert!(matches!(
        keys::parse("Tab").and_then(keys::route),
        Some(Route::Ui(_))
    ));
    assert!(matches!(
        keys::parse("Escape").and_then(keys::route),
        Some(Route::Ui(_))
    ));
}

#[test]
fn the_format_keys_only_ask_for_what_the_body_says_it_has() {
    let mut input = input();
    assert!(
        input.key_down(Key::Char('['), false, 0.0).is_empty(),
        "nothing listed: no guess"
    );
    assert!(input.key_down(Key::Char(']'), false, 0.0).is_empty());
    input.set_status(
        Status {
            available_formats: vec![(1, 24), (1, 60), (2, 24)],
            video_resolution: Some(1),
            video_frame_rate: Some(24),
            ..Status::default()
        },
        0.0,
    );
    assert_eq!(
        input.key_down(Key::Char(']'), false, 0.0),
        [Command::SetVideoFormat {
            resolution: 1,
            frame_rate: 60
        }]
    );
    assert_eq!(
        input.key_down(Key::Char('['), false, 0.0),
        [Command::SetVideoFormat {
            resolution: 2,
            frame_rate: 24
        }]
    );
}

// ── Zoom ─────────────────────────────────────────────────────────────────────

#[test]
fn zoom_follows_the_body_rather_than_fighting_it() {
    let mut input = input();
    input.set_model(Some(0x22));
    input.set_status(
        Status {
            zoom_hundredths: Some(400),
            ..Status::default()
        },
        0.0,
    );
    assert_eq!(
        input.key_down(Key::Char('='), false, 0.0),
        [Command::ZoomJump(6.0)]
    );
    assert_eq!(
        input.key_down(Key::Char('-'), false, 0.0),
        [Command::ZoomJump(3.0)]
    );
    assert_eq!(
        input.key_down(Key::Char('0'), false, 0.0),
        [Command::ZoomJump(1.0)]
    );
    assert_eq!(input.zoom_stops(), [1.0, 3.0, 6.0, 12.0]);
}

#[cfg(not(opc_core_linked))]
#[test]
fn a_zoom_out_of_dlog2_hops_the_colour_first_and_puts_it_back_at_wide() {
    let mut input = input();
    input.set_model(Some(0x20));
    input.set_status(
        Status {
            color_mode: Some(0x41),
            ..Status::default()
        },
        0.0,
    );
    assert_eq!(
        input.key_down(Key::Char('='), false, 0.0),
        [Command::SetColorMode {
            mode: 0x17,
            model_id: 0x20
        }]
    );
    assert!(!notices(&mut input).is_empty(), "the operator is told why");
    assert!(input.tick(0.5).is_empty(), "nothing until the hop lands");
    let released = input.set_status(
        Status {
            color_mode: Some(0x17),
            ..Status::default()
        },
        0.6,
    );
    assert_eq!(released, [Command::ZoomJump(3.0)]);
    assert_eq!(
        input.key_down(Key::Char('0'), false, 1.0),
        [
            Command::ZoomJump(1.0),
            Command::SetColorMode {
                mode: 0x41,
                model_id: 0x20
            }
        ]
    );
}

#[test]
fn rolling_in_dlog2_refuses_the_zoom_and_says_so() {
    let mut input = input();
    input.set_model(Some(0x20));
    input.set_status(
        Status {
            color_mode: Some(0x41),
            is_recording: true,
            ..Status::default()
        },
        0.0,
    );
    assert!(input.key_down(Key::Char('='), false, 0.0).is_empty());
    assert_eq!(notices(&mut input), ["ZOOM LOCKED · D-LOG2 WHILE ROLLING"]);
}

#[test]
fn the_dial_clamps_to_the_bodys_range_and_zoom_by_streams_at_20_hz() {
    let mut input = input();
    input.set_model(Some(0x22));
    input.set_status(Status::default(), 0.0);
    assert_eq!(
        input.zoom_write(ZoomWrite::Slider(40.0), 0.0),
        [Command::ZoomFactor(12.0)]
    );
    input.set_status(
        Status {
            zoom_hundredths: Some(100),
            ..Status::default()
        },
        0.0,
    );
    input.zoom_rate(1.0);
    let mut writes = Vec::new();
    let mut t = 0.0;
    while t < 1.0 {
        t += 0.01;
        writes.extend(input.tick(t));
    }
    assert!(
        (15..=21).contains(&writes.len()),
        "about 20 dial writes a second, not 100: {}",
        writes.len()
    );
    assert!(writes
        .iter()
        .all(|c| matches!(c, Command::ZoomFactor(f) if *f > 1.0)));
    input.zoom_rate(0.0);
    assert!(input.tick(1.2).is_empty(), "0 stops");
}

// ── The game controller ──────────────────────────────────────────────────────

#[test]
fn a_controller_drives_on_the_phones_map() {
    let mut input = input();
    input.set_model(Some(0x22));
    input.set_status(Status::default(), 0.0);
    assert_eq!(input.pad_button(PadButton::A, 0.0), [Command::RecordStart]);
    input.set_status(
        Status {
            is_recording: true,
            ..Status::default()
        },
        0.1,
    );
    assert_eq!(
        input.pad_button(PadButton::A, 0.1),
        [Command::RecordStop],
        "A toggles"
    );
    assert_eq!(
        input.pad_button(PadButton::B, 0.2),
        [Command::GimbalRecenter]
    );
    assert_eq!(input.pad_button(PadButton::X, 0.2), [Command::GimbalFlip]);
    assert_eq!(
        input.pad_button(PadButton::RightShoulder, 0.3),
        [Command::ZoomJump(3.0)]
    );
    assert_eq!(
        input.pad_button(PadButton::LeftShoulder, 0.3),
        [Command::ZoomJump(1.0)]
    );
    input.set_status(
        Status {
            iso_index: Some(0x05),
            shutter_denominator: Some(60),
            available_shutter: vec![25, 50, 60, 100],
            ..Status::default()
        },
        0.4,
    );
    assert_eq!(
        input.pad_button(PadButton::DpadUp, 0.5),
        [Command::SetIsoIndex(0x06)]
    );
    assert_eq!(
        input.pad_button(PadButton::DpadLeft, 0.6),
        [Command::SetShutter(50)],
        "open is a longer exposure"
    );
    // The stick goes through the core's curve with the operator's sensitivity.
    assert_eq!(
        input.pad_axes(1.0, 0.0, 0.0, 0.0, 0.7),
        [stick_axes(1.0, 0.0, 4)]
    );
    assert!(
        input.pad_axes(1.0, 0.0, 0.0, 0.0, 0.71).is_empty(),
        "an unchanged stick waits"
    );
    assert_eq!(
        input.pad_axes(0.0, 0.0, 0.0, 0.0, 0.9),
        [rest()],
        "letting go rests once"
    );
    assert!(input.pad_axes(0.0, 0.0, 0.0, 0.0, 1.0).is_empty());
    // Off in the Controls tab, or off the viewfinder: nothing.
    input.set_gamepad(false, 1.1);
    assert!(input.pad_button(PadButton::A, 1.1).is_empty());
    assert!(input.pad_axes(1.0, 0.0, 0.0, 0.0, 1.2).is_empty());
}

#[test]
fn y_clears_tracking_and_an_unplug_rests_the_stick() {
    let mut input = input();
    quarter(&mut input, 0.0);
    assert_eq!(input.pad_button(PadButton::Y, 0.1), [Command::TrackClear]);
    input.pad_axes(0.0, 1.0, 0.0, 0.0, 0.2);
    assert_eq!(input.pad_connected(false, 0.3), [rest()]);
}

#[test]
fn the_triggers_hold_to_zoom() {
    let mut input = input();
    input.set_model(Some(0x22));
    input.set_status(Status::default(), 0.0);
    let mut writes = Vec::new();
    let mut t = 0.0;
    while t < 0.5 {
        t += 0.01;
        writes.extend(input.pad_axes(0.0, 0.0, 0.0, 1.0, t));
        writes.extend(input.tick(t));
    }
    assert!(!writes.is_empty() && writes.iter().all(|c| matches!(c, Command::ZoomFactor(_))));
}

#[test]
fn direction_lock_keeps_only_the_dominant_axis_on_the_controller() {
    let mut input = input();
    input.set_direction_lock(true);
    assert_eq!(
        input.pad_axes(0.9, 0.3, 0.0, 0.0, 0.0),
        [stick_axes(0.9, 0.0, 4)]
    );
}

// ── The stick from the web ───────────────────────────────────────────────────

#[test]
fn the_all_axes_lock_rests_and_ignores_the_stick() {
    let mut input = input();
    input.drive(0.5, 0.0, DriveSource::Touch, 0.0);
    assert_eq!(input.lock_all_axes(true, 0.1), [rest()]);
    assert!(input.drive(0.5, 0.0, DriveSource::Touch, 0.2).is_empty());
    assert!(input.key_down(Key::Left, false, 0.3).is_empty());
    input.lock_all_axes(false, 0.4);
    assert_eq!(input.drive(0.5, 0.0, DriveSource::Touch, 0.5).len(), 1);
}

#[test]
fn with_the_ramp_on_a_throw_eases_in_and_eases_back_to_rest() {
    let mut input = input();
    input.set_feel(4, 0.35);
    let first = input.key_down(Key::Right, false, 1.0);
    let pan = |c: &Command| match c {
        Command::GimbalStick { axis0, axis1 } => (*axis0, *axis1),
        other => panic!("expected a stick, got {other:?}"),
    };
    let start = pan(first.last().expect("a first step"));
    assert_ne!(
        start,
        pan(&stick_axes(1.0, 0.0, 4)),
        "the first step is a fraction"
    );
    let mut t = 1.0;
    let mut last = start;
    while t < 4.0 {
        t += 0.01;
        if (t * 100.0) as i64 % 10 == 0 {
            input.key_down(Key::Right, true, t);
        }
        if let Some(c) = input.tick(t).last() {
            last = pan(c);
        }
    }
    assert_eq!(
        last,
        pan(&stick_axes(1.0, 0.0, 4)),
        "held long enough, the full throw"
    );
    input.key_up(Key::Right, t);
    let mut rested = false;
    while t < 8.0 {
        t += 0.01;
        if input.tick(t).last() == Some(&rest()) {
            rested = true;
        }
    }
    assert!(rested, "the stick ends centred");
    assert!(input.tick(9.0).is_empty(), "nothing more once rested");
}

// ── Tracking and tap focus ───────────────────────────────────────────────────

fn track_set(commands: &[Command]) -> (f32, f32, f32, f32) {
    match commands.first() {
        Some(Command::TrackSet {
            x,
            y,
            width,
            height,
            ..
        }) => (*x, *y, *width, *height),
        other => panic!("expected a box, got {other:?}"),
    }
}

#[test]
fn a_drag_becomes_a_box_in_the_picture_the_operator_pointed_at() {
    let mut input = input();
    let (x, y, w, h) = track_set(&quarter(&mut input, 0.0));
    // The wire carries the centre of the box, as Mimo sends it.
    assert!((x - 0.375).abs() < 0.01 && (y - 0.375).abs() < 0.01);
    assert!((w - 0.25).abs() < 0.01 && (h - 0.25).abs() < 0.01);
    assert_eq!(input.tracker.view().status, "searching");
}

#[test]
fn a_drag_on_a_mirrored_picture_points_at_the_same_thing() {
    let mut input = input();
    input.tracker.set_mirror(true);
    let (x, _, w, _) = track_set(&quarter(&mut input, 0.0));
    assert!((x - 0.625).abs() < 0.01, "mirrored x was {x}");
    assert!((w - 0.25).abs() < 0.01);
    let seen = input.tracker.view().seen.expect("the committed box");
    assert!((seen.x - 0.25).abs() < 1e-9, "drawn where it was dragged");
}

#[test]
fn a_click_focuses_where_it_landed_and_leaves_tracking_alone() {
    let mut input = input();
    let first = drag(&mut input, (0.5, 0.5), (0.5005, 0.5005), 0.0);
    assert_eq!(first.len(), 2, "the first half of Mimo's burst");
    assert_eq!(first[0], Command::TapFocusPrepare);
    assert!(
        matches!(first[1], Command::TapFocusPoint { x, y } if (x - 0.5).abs() < 0.01 && (y - 0.5).abs() < 0.01)
    );
    assert!(input.tracker.view().focus.is_some(), "the reticle");
    let tail = input.note_set(&SetOutcome::Acked {
        command: Command::TapFocusPoint { x: 0.5, y: 0.5 },
        late: false,
    });
    assert_eq!(tail[0], Command::TapFocusHint);
    assert!(matches!(tail[1], Command::TapFocusCommit { .. }));
    assert!(input.tick(0.5).is_empty(), "sent once");
    assert!(input.tracker.view().focus.is_some());
    input.tick(1.6);
    assert!(
        input.tracker.view().focus.is_none(),
        "the reticle goes after 1.5 s"
    );
}

#[test]
fn a_tap_the_body_never_answers_still_finishes() {
    let mut input = input();
    drag(&mut input, (0.5, 0.5), (0.5, 0.5), 0.0);
    assert!(
        input.tick(0.2).is_empty(),
        "still waiting on the region ACK"
    );
    let tail = input.tick(0.4);
    assert_eq!(tail[0], Command::TapFocusHint);
}

#[test]
fn a_click_on_a_mirrored_picture_focuses_on_the_same_thing() {
    let mut input = input();
    input.tracker.set_mirror(true);
    let sent = drag(&mut input, (0.25, 0.5), (0.25, 0.5), 0.0);
    assert!(matches!(sent[1], Command::TapFocusPoint { x, .. } if (x - 0.75).abs() < 0.01));
}

#[test]
fn a_box_smaller_than_the_body_locks_is_refused_with_a_note() {
    let mut input = input();
    let sent = drag(&mut input, (0.47, 0.42), (0.5, 0.47), 0.0);
    assert!(sent.is_empty(), "nothing goes to the body: {sent:?}");
    assert!(!input.tracker.is_tracking());
    assert_eq!(notices(&mut input), ["FRAME TOO SMALL"]);
}

#[test]
fn a_box_is_polled_until_the_body_locks_and_then_until_it_lets_go() {
    let mut input = input();
    quarter(&mut input, 0.0);
    assert!(input.tick(0.1).is_empty(), "not yet");
    assert_eq!(input.tick(0.5), [Command::TrackPoll]);
    assert!(input.tick(0.6).is_empty(), "one poll per half second");
    for i in 0..5 {
        input.tracking_reply(TrackingPoll::Idle, 0.5 + f64::from(i));
        assert!(input.tracker.is_tracking());
    }
    input.tracking_reply(TrackingPoll::Idle, 6.0);
    assert!(!input.tracker.is_tracking(), "six idle answers: given up");

    quarter(&mut input, 10.0);
    input.tracking_reply(TrackingPoll::Locked(Some((0.3, 0.3, 0.2, 0.2))), 10.5);
    assert!(input.tracker.is_locked());
    assert_eq!(input.tracker.view().status, "tracking");
    input.tick(12.5);
    assert!(
        input.tracker.is_tracking(),
        "a lock keeps the box past 1.5 s"
    );
    input.tracking_reply(TrackingPoll::Idle, 13.0);
    assert!(
        !input.tracker.is_tracking(),
        "the first idle after a lock is the subject gone"
    );

    quarter(&mut input, 20.0);
    let sent = drag(&mut input, (0.15, 0.27), (0.15, 0.27), 20.5);
    assert_eq!(
        sent[0],
        Command::TrackClear,
        "a click while tracking clears first"
    );
    assert_eq!(sent.len(), 3);
    assert!(!input.tracker.is_tracking());
}

#[test]
fn the_bodys_own_pushes_drive_the_box_and_silence_drops_it() {
    let mut input = input();
    quarter(&mut input, 0.0);
    input.tracker.push((0.3, 0.3, 0.2, 0.2), 0.2);
    assert!(input.tracker.is_locked());
    for i in 1..30 {
        let t = 0.2 + 0.07 * f64::from(i);
        input.tracker.push((0.3, 0.3, 0.2, 0.2), t);
        input.tick(t);
    }
    assert!(input.tracker.is_tracking());
    input.tick(2.5);
    assert!(input.tracker.is_tracking(), "not yet");
    input.tick(2.7);
    assert!(
        !input.tracker.is_tracking(),
        "silence means the body let go"
    );
}

#[test]
fn a_lock_started_on_the_body_becomes_a_box_here() {
    let mut input = input();
    input.tracker.push((0.4, 0.4, 0.2, 0.2), 1.0);
    assert!(input.tracker.is_tracking() && input.tracker.is_locked());
    let view = input.tracker.view();
    assert_eq!(view.status, "tracking");
    assert!(view.seen.is_some());
}

#[test]
fn a_clear_ignores_the_leftover_push_and_only_clears_what_is_out() {
    let mut input = input();
    assert!(
        input.key_down(Key::Char('x'), false, 0.0).is_empty(),
        "nothing out: nothing sent"
    );
    quarter(&mut input, 0.0);
    input.tracker.push((0.3, 0.3, 0.2, 0.2), 0.2);
    assert_eq!(
        input.key_down(Key::Char('x'), false, 1.0),
        [Command::TrackClear]
    );
    assert!(!input.tracker.is_tracking());
    assert!(
        input.tracker.view().seen.is_none(),
        "the box is off the screen"
    );
    input.tracker.push((0.3, 0.3, 0.2, 0.2), 1.1);
    assert!(!input.tracker.is_tracking(), "leftover push ignored");
    input.tracker.push((0.3, 0.3, 0.2, 0.2), 1.6);
    assert!(input.tracker.is_tracking());
}

#[test]
fn losing_the_link_drops_the_box() {
    let mut input = input();
    quarter(&mut input, 0.0);
    input.link_lost();
    assert!(!input.tracker.is_tracking());
}

#[test]
fn tracking_ids_never_repeat_and_never_reach_zero() {
    let mut input = input();
    let mut ids = Vec::new();
    for _ in 0..4 {
        if let Some(Command::TrackSet { id, .. }) =
            drag(&mut input, (0.1, 0.1), (0.4, 0.55), 0.0).first()
        {
            ids.push(*id);
        }
    }
    assert_eq!(ids.len(), 4);
    assert!(ids.iter().all(|id| *id != 0));
    let mut unique = ids.clone();
    unique.dedup();
    assert_eq!(unique.len(), 4, "{ids:?}");
}

#[test]
fn a_committed_box_stops_being_drawn_rather_than_lying_about_the_subject() {
    let mut input = input();
    quarter(&mut input, 0.0);
    assert!(input.tracker.view().seen.is_some());
    input.tick(2.0);
    assert!(input.tracker.view().seen.is_none());
}

#[test]
fn a_drag_that_starts_outside_the_picture_is_not_a_box() {
    let mut input = input();
    assert!(drag(&mut input, (0.5, -0.1), (0.7, 0.4), 0.0).is_empty());
}

#[test]
fn a_cancelled_drag_is_abandoned_rather_than_sent() {
    let mut input = input();
    input.pointer(PointerPhase::Down, 1, 0.25, 0.25, 0.0);
    input.pointer(PointerPhase::Move, 1, 0.5, 0.5, 0.0);
    assert!(input.tracker.view().drag.is_some(), "drawn while dragged");
    input.pointer(PointerPhase::Cancel, 1, 0.5, 0.5, 0.0);
    assert!(input.tracker.view().drag.is_none(), "gone once taken away");
    assert!(input.pointer(PointerPhase::Up, 1, 0.5, 0.5, 0.0).is_empty());
}

#[test]
fn a_second_finger_cannot_take_over_a_box_being_drawn() {
    let mut input = input();
    input.pointer(PointerPhase::Down, 1, 0.25, 0.25, 0.0);
    input.pointer(PointerPhase::Move, 1, 0.5, 0.5, 0.0);
    input.pointer(PointerPhase::Down, 2, 0.08, 0.14, 0.0);
    input.pointer(PointerPhase::Move, 2, 0.09, 0.15, 0.0);
    assert!(input
        .pointer(PointerPhase::Up, 2, 0.09, 0.15, 0.0)
        .is_empty());
    let (x, _, w, _) = track_set(&input.pointer(PointerPhase::Up, 1, 0.5, 0.5, 0.0));
    assert!((x - 0.375).abs() < 0.01 && (w - 0.25).abs() < 0.01);
}

#[test]
fn a_finger_that_lands_off_the_picture_does_not_lock_out_the_next_one() {
    let mut input = input();
    input.pointer(PointerPhase::Down, 1, 0.5, -0.05, 0.0);
    input.pointer(PointerPhase::Down, 2, 0.2, 0.2, 0.0);
    input.pointer(PointerPhase::Move, 2, 0.6, 0.6, 0.0);
    assert!(!input.pointer(PointerPhase::Up, 2, 0.6, 0.6, 0.0).is_empty());
}

#[test]
fn a_finger_released_frees_the_screen_and_strays_do_nothing() {
    let mut input = input();
    assert!(!quarter(&mut input, 0.0).is_empty());
    assert!(
        !quarter(&mut input, 1.0).is_empty(),
        "the next finger can draw"
    );
    assert!(input
        .pointer(PointerPhase::Move, 9, 0.1, 0.1, 2.0)
        .is_empty());
    assert!(input.pointer(PointerPhase::Up, 9, 0.2, 0.2, 2.0).is_empty());
    assert!(input
        .pointer(PointerPhase::Cancel, 9, 0.2, 0.2, 2.0)
        .is_empty());
}

#[test]
fn nothing_focuses_on_a_body_without_tap_focus() {
    let mut input = input();
    input.set_model(Some(0x19));
    if opc_camera::supports_tap_focus(0x19) {
        return; // without the core every body is assumed to focus
    }
    assert!(drag(&mut input, (0.5, 0.5), (0.5, 0.5), 0.0).is_empty());
}

// ── Programmed moves ─────────────────────────────────────────────────────────

#[test]
fn a_take_captures_points_from_the_live_pose_counts_down_and_sends_timed_targets() {
    let mut input = input();
    input.set_status(pose(100, 1), 0.0);
    input.move_set_point('a').expect("A");
    input.set_status(pose(600, 2), 0.0);
    input.move_set_point('b').expect("B");
    assert_eq!(input.program().a.map(|p| p.yaw), Some(10.0));
    assert_eq!(input.program().b.map(|p| p.yaw), Some(60.0));
    input.move_configure(Some([4.0, 5.0]), None);

    input.set_status(pose(0, 3), 1.0);
    assert!(input.move_start(1.0).is_empty());
    assert!(input.move_running());
    assert_eq!(input.view(1.5).program.status, "preparing");
    assert!(input.tick(2.0).is_empty(), "still counting down");

    let mut first = Vec::new();
    let mut t = 4.0;
    let mut seq = 10;
    while first.is_empty() && t < 5.0 {
        seq += 1;
        input.set_status(pose(0, seq), t);
        first = input.tick(t);
        t += 0.01;
    }
    assert!(
        matches!(
            first.as_slice(),
            [Command::GimbalTimedTarget { yaw_tenth: 100, .. }]
        ),
        "the approach targets A: {first:?}"
    );
    let cancel = input.key_down(Key::Left, false, t);
    assert!(cancel.contains(&Command::GimbalTimedStop), "{cancel:?}");
    assert!(!input.move_running());
    assert_eq!(input.view(t).program.status, "idle");
}

#[test]
fn a_take_with_stale_attitude_stops_itself() {
    let mut input = input();
    input.set_status(pose(100, 1), 0.0);
    input.move_set_point('a').unwrap();
    input.set_status(pose(600, 2), 0.0);
    input.move_set_point('b').unwrap();
    input.move_start(0.0);
    // The body stops reporting its attitude after the countdown.
    let mut stopped = false;
    let mut t = 3.0;
    while t < 4.0 {
        if input.tick(t).contains(&Command::GimbalTimedStop) {
            stopped = true;
            break;
        }
        t += 0.01;
    }
    assert!(stopped, "no fresh pose, no dispatch");
    let notices = notices(&mut input);
    input.tick(t + 0.1);
    let later = input.take_notices();
    assert!(
        notices
            .iter()
            .chain(later.iter().map(|n| &n.text))
            .any(|n| n.starts_with("MOVE STOPPED")),
        "{notices:?}"
    );
}

#[test]
fn a_take_needs_a_and_b() {
    let mut input = input();
    input.set_status(pose(100, 1), 0.0);
    assert!(input.move_start(0.0).is_empty());
    assert!(!input.move_running());
    assert_eq!(notices(&mut input), ["SET A AND B FIRST"]);
}

#[test]
fn leg_durations_snap_to_native_tenths() {
    let mut input = input();
    input.move_configure(Some([0.1, 4.04]), Some(2.0));
    assert_eq!(input.program().duration_ab, 0.5);
    assert_eq!(input.program().duration_bc, 4.0);
    assert_eq!(input.program().smoothness, 1.0);
}

// ── Presets and gestures ─────────────────────────────────────────────────────

#[test]
fn presets_are_saved_from_the_live_pose_and_recalled_by_key_or_swipe() {
    let dir = std::env::temp_dir().join(format!("pm-input-presets-{}", std::process::id()));
    let path = dir.join("desktop-gimbal-presets-v1.txt");
    let _ = std::fs::remove_file(&path);
    let mut input = input().with_presets_at(path.clone());
    input.set_status(pose(100, 1), 0.0);
    assert!(
        input.key_down(Key::Char('1'), false, 0.0).is_empty(),
        "an empty slot sends nothing"
    );
    input.preset_save(0).unwrap();
    input.set_status(pose(600, 2), 0.0);
    input.preset_save(1).unwrap();
    input.preset_seconds(4.0);
    input.set_status(pose(300, 3), 0.0);
    assert_eq!(
        input.key_down(Key::Char('1'), false, 1.0),
        [Command::GimbalTimedTarget {
            yaw_tenth: 100,
            native_pitch_tenth: 0,
            duration_tenths: 40
        }]
    );
    assert!(matches!(
        input.gesture(Gesture::SwipeRight, 5.0).as_slice(),
        [Command::GimbalTimedTarget { yaw_tenth: 600, .. }]
    ));
    // The default map leaves vertical sweeps alone: lowering a hand is not a flip.
    assert!(input.gesture(Gesture::SwipeUp, 9.0).is_empty());
    assert!(input.gesture(Gesture::SwipeDown, 9.5).is_empty());
    assert_eq!(
        input.gesture(Gesture::Fist, 10.0),
        [Command::GimbalRecenter]
    );
    assert_eq!(input.gesture(Gesture::Horns, 11.0), [Command::GimbalFlip]);
    // The operator's own map decides.
    let mut map = GestureMap::default();
    map.set(Gesture::SwipeUp, GestureAction::Recenter);
    map.set(Gesture::SwipeDown, GestureAction::Flip);
    input.set_gesture_map(map);
    assert_eq!(
        input.gesture(Gesture::SwipeUp, 12.0),
        [Command::GimbalRecenter]
    );
    assert_eq!(
        input.gesture(Gesture::SwipeDown, 13.0),
        [Command::GimbalFlip]
    );

    // Kept in the file: a fresh controller reads them back.
    let again = LiveInput::new(&Prefs::default()).with_presets_at(path.clone());
    assert_eq!(again.presets().slots[1].map(|p| p.yaw), Some(60.0));
    assert_eq!(again.presets().seconds, 4.0);
    input.preset_clear(1);
    let cleared = LiveInput::new(&Prefs::default()).with_presets_at(path.clone());
    assert_eq!(cleared.presets().slots[1], None);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_far_preset_goes_in_two_halves_and_a_palm_stops_it() {
    let mut input = input();
    input.set_status(pose(-400, 1), 0.0);
    input.preset_save(0).unwrap();
    input.preset_seconds(4.0);
    input.set_status(pose(1800, 2), 0.0);
    assert_eq!(
        input.key_down(Key::Char('1'), false, 1.0),
        [Command::GimbalTimedTarget {
            yaw_tenth: 700,
            native_pitch_tenth: 0,
            duration_tenths: 20
        }]
    );
    assert!(input.tick(1.5).is_empty());
    input.set_status(pose(700, 3), 3.4);
    assert!(input.tick(3.5).contains(&Command::GimbalTimedTarget {
        yaw_tenth: -400,
        native_pitch_tenth: 0,
        duration_tenths: 20
    }));

    input.set_status(pose(1800, 4), 10.0);
    input.key_down(Key::Char('1'), false, 10.0);
    let stop = input.gesture(Gesture::Palm, 10.5);
    assert!(stop.contains(&Command::GimbalTimedStop));
    input.set_status(pose(700, 5), 13.9);
    assert!(!input
        .tick(14.0)
        .iter()
        .any(|c| matches!(c, Command::GimbalTimedTarget { .. })));
}

#[test]
fn swipes_with_no_presets_say_so() {
    let mut input = input();
    assert!(input.gesture(Gesture::Point, 0.0).is_empty());
    assert_eq!(notices(&mut input), ["NO PRESETS SAVED"]);
}

#[test]
fn a_peace_sign_records_and_face_tracking_lets_go_or_says_why_not() {
    let mut input = input();
    assert_eq!(input.gesture(Gesture::Two, 0.0), [Command::RecordStart]);
    assert_eq!(notices(&mut input), ["GESTURE: RECORD"]);
    assert!(input.gesture(Gesture::FaceTrack, 1.0).is_empty());
    assert_eq!(
        notices(&mut input),
        ["FACE TRACKING NEEDS THE CAMERA'S PICTURE"]
    );
    let mut map = GestureMap::default();
    map.set(Gesture::Two, GestureAction::Nothing);
    input.set_gesture_map(map);
    assert!(input.gesture(Gesture::Two, 2.0).is_empty());
}

#[test]
fn the_view_carries_the_program_and_the_presets() {
    let mut input = input();
    input.set_status(pose(100, 1), 0.0);
    input.preset_save(2).unwrap();
    input.move_set_point('a').unwrap();
    let view = input.view(0.0);
    assert!(view.presets.slots[2].is_some());
    assert_eq!(view.program.a.map(|p| p.yaw), Some(10.0));
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["program"]["legSeconds"][0], 5.0);
    assert_eq!(json["lockedAllAxes"], false);
}

#[test]
fn an_unknown_body_keeps_the_lens_range_rather_than_pinning_zoom_to_one() {
    let mut input = input();
    assert_eq!(
        input.zoom_write(ZoomWrite::Jump(2.5), 0.0),
        [Command::ZoomJump(2.5)]
    );
    assert_eq!(
        input.zoom_write(ZoomWrite::Slider(40.0), 0.1),
        [Command::ZoomFactor(12.0)]
    );
}
