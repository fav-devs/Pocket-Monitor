//! The game controller, read in Rust with gilrs at the input thread's rate (§1.S).
//!
//! Not the browser Gamepad API: the web view stops polling when unfocused or throttled,
//! and a held stick must keep streaming (and must rest when the pad goes). The buttons go
//! through the phones' map in `pm_controller::pad`; the left stick and the triggers are
//! read as levels every tick, so a held throw keeps the 200 ms keepalive fed and the
//! triggers hold-to-zoom. What the web shows (connected, name, sticks, buttons) goes out
//! as `gamepad://state` in the mobile `GamepadState` shape, for display only — Rust has
//! already applied it. The old desktop has no rumble, so neither does this.

use opc_camera::Command;
use pm_controller::input::LiveInput;
use pm_controller::link::log_line;
use serde_json::{json, Value};

/// The first connected controller, polled on the input thread.
pub struct Pad {
    gilrs: Option<gilrs::Gilrs>,
    connected: bool,
}

impl Pad {
    pub fn new() -> Self {
        let gilrs = gilrs::Gilrs::new()
            .map_err(|error| log_line("input", format_args!("no game controller support: {error}")))
            .ok();
        Self {
            gilrs,
            connected: false,
        }
    }

    /// Events (buttons, plug and unplug), then the levels. Returns the commands, and the
    /// display state for `gamepad://state`.
    pub fn poll(&mut self, live: &mut LiveInput, now: f64) -> (Vec<Command>, Option<Value>) {
        let Some(gilrs) = self.gilrs.as_mut() else {
            return (Vec::new(), None);
        };
        let mut out = Vec::new();
        while let Some(gilrs::Event { id, event, .. }) = gilrs.next_event() {
            match event {
                gilrs::EventType::Connected => {
                    log_line(
                        "input",
                        format_args!("game controller connected: {}", gilrs.gamepad(id).name()),
                    );
                }
                gilrs::EventType::Disconnected => {
                    log_line("input", "game controller disconnected");
                }
                gilrs::EventType::ButtonPressed(button, _) => {
                    if let Some(button) = crate::input::pad_button(button) {
                        out.extend(live.pad_button(button, now));
                    }
                }
                _ => {}
            }
        }
        let first = gilrs.gamepads().find(|(_, pad)| pad.is_connected());
        let Some((_, gamepad)) = first else {
            if self.connected {
                self.connected = false;
                out.extend(live.pad_connected(false, now));
            }
            return (out, Some(json!({ "connected": false })));
        };
        if !self.connected {
            self.connected = true;
            out.extend(live.pad_connected(true, now));
        }
        let axis = |axis: gilrs::Axis| f64::from(gamepad.value(axis));
        let trigger = |button: gilrs::Button| {
            f64::from(gamepad.button_data(button).map_or(0.0, |data| data.value()))
        };
        let (x, y) = (axis(gilrs::Axis::LeftStickX), axis(gilrs::Axis::LeftStickY));
        let (l2, r2) = (
            trigger(gilrs::Button::LeftTrigger2),
            trigger(gilrs::Button::RightTrigger2),
        );
        out.extend(live.pad_axes(x, y, l2, r2, now));
        let pressed = |button: gilrs::Button| gamepad.is_pressed(button);
        // Rounded so a resting stick's noise does not count as a change.
        let round = |value: f64| (value * 100.0).round() / 100.0;
        let state = json!({
            "connected": true,
            "name": gamepad.name(),
            "leftX": round(x),
            "leftY": round(y),
            "rightX": round(axis(gilrs::Axis::RightStickX)),
            "rightY": round(axis(gilrs::Axis::RightStickY)),
            "l2": round(l2),
            "r2": round(r2),
            "buttons": {
                "a": pressed(gilrs::Button::South),
                "b": pressed(gilrs::Button::East),
                "x": pressed(gilrs::Button::West),
                "y": pressed(gilrs::Button::North),
                "l1": pressed(gilrs::Button::LeftTrigger),
                "r1": pressed(gilrs::Button::RightTrigger),
                "up": pressed(gilrs::Button::DPadUp),
                "down": pressed(gilrs::Button::DPadDown),
                "left": pressed(gilrs::Button::DPadLeft),
                "right": pressed(gilrs::Button::DPadRight),
                "menu": pressed(gilrs::Button::Start),
            },
        });
        (out, Some(state))
    }
}
