//! The desktop viewfinder's keyboard, every key of §1.R of `docs/desktop-expo-port.md`.
//!
//! One table decides what each key is. Keys that touch the camera (record, the stick,
//! zoom stops, the countdown, presets, tracking, format steps, gimbal moves) are carried
//! out on the input thread by [`crate::input::LiveInput`], so the desktop semantics and
//! their tests live in Rust: `Space` starts and `R` stops (D7), `+`/`-` step the body's own
//! zoom stops, the arrows are a stick with diagonals and a 200 ms keepalive. Keys that
//! only change what the web draws (sheets, assists, the chrome, the library, a still,
//! `Esc`) come back to the web as a [`UiAction`]. `F11` toggles fullscreen in Rust (D1).
//!
//! The web sends `KeyboardEvent.key` names; case never changes what a key means.

use opc_ui::Key;
use serde::Serialize;

/// A key the viewfinder listens for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DesktopKey {
    Key(Key),
    F11,
}

/// `KeyboardEvent.key` → a key, or `None` for anything the viewfinder ignores.
pub fn parse(name: &str) -> Option<DesktopKey> {
    Some(DesktopKey::Key(match name {
        " " | "Space" | "Spacebar" => Key::Space,
        "Escape" | "Esc" => Key::Escape,
        "Tab" => Key::Tab,
        "ArrowLeft" | "Left" => Key::Left,
        "ArrowRight" | "Right" => Key::Right,
        "ArrowUp" | "Up" => Key::Up,
        "ArrowDown" | "Down" => Key::Down,
        "F11" => return Some(DesktopKey::F11),
        other => {
            let mut chars = other.chars();
            let first = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            Key::Char(first.to_ascii_lowercase())
        }
    }))
}

/// What the web does for a key: a sheet, a toggle, a route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiAction {
    /// `Tab`.
    ToggleSettings,
    /// `E`.
    ToggleExposure,
    /// `K`: the moves sheet (Motion Control and the presets).
    ToggleMoves,
    /// `A`: the assist toolbar.
    ToggleAssists,
    ToggleZebra,
    TogglePeaking,
    /// `L`: the cube.
    ToggleGrade,
    ToggleMirror,
    /// `H`: hide the chrome.
    ToggleChrome,
    /// `G`.
    Library,
    /// `S`: a graded still of the picture (the desktop meaning, not a camera photo).
    Still,
    /// A sheet closes first, then the viewfinder.
    Escape,
    /// `F11`, already carried out in Rust; the web may reflect it.
    Fullscreen,
}

/// Where a key goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The input thread carries it out.
    Input(Key),
    /// `V`: the gimbal's next mode, sent through the camera service so the commanded
    /// mode the state reports stays true.
    GimbalCycle,
    Ui(UiAction),
}

/// The table. `None` is a key the viewfinder does nothing with: nothing surprising.
pub fn route(key: DesktopKey) -> Option<Route> {
    let key = match key {
        DesktopKey::F11 => return Some(Route::Ui(UiAction::Fullscreen)),
        DesktopKey::Key(key) => key,
    };
    Some(match key {
        Key::Escape => Route::Ui(UiAction::Escape),
        Key::Tab => Route::Ui(UiAction::ToggleSettings),
        Key::Space | Key::Left | Key::Right | Key::Up | Key::Down => Route::Input(key),
        Key::Char(c) => match c.to_ascii_lowercase() {
            'e' => Route::Ui(UiAction::ToggleExposure),
            'k' => Route::Ui(UiAction::ToggleMoves),
            'a' => Route::Ui(UiAction::ToggleAssists),
            'z' => Route::Ui(UiAction::ToggleZebra),
            'p' => Route::Ui(UiAction::TogglePeaking),
            'l' => Route::Ui(UiAction::ToggleGrade),
            'm' => Route::Ui(UiAction::ToggleMirror),
            'h' => Route::Ui(UiAction::ToggleChrome),
            'g' => Route::Ui(UiAction::Library),
            's' => Route::Ui(UiAction::Still),
            'v' => Route::GimbalCycle,
            'r' | 't' | 'c' | 'f' | 'x' | '[' | ']' | '0' | '=' | '+' | '-' | '_' | '1'..='6' => {
                Route::Input(Key::Char(c.to_ascii_lowercase()))
            }
            _ => return None,
        },
    })
}

/// Whether the key belongs to the stick (held, with a keepalive).
pub fn is_arrow(key: Key) -> bool {
    matches!(key, Key::Left | Key::Right | Key::Up | Key::Down)
}

/// `V`: Follow → Tilt locked → FPV → Follow (Mimo's order). Direction lock, and any mode
/// the desktop does not cycle through, goes back to Follow. Names are the mobile
/// `GimbalMode` vocabulary.
pub fn next_gimbal_mode(current: &str) -> &'static str {
    match current {
        "follow" => "tilt-locked",
        "tilt-locked" => "fpv",
        _ => "follow",
    }
}

/// The key list for `--help`-style output and the web's key hints (B6).
pub const KEY_HELP: &[(&str, &str)] = &[
    ("Space", "Start recording"),
    ("R", "Stop recording"),
    ("T", "Countdown, or cancel it"),
    ("S", "Still of the picture"),
    ("Arrows", "Pan and tilt"),
    ("C", "Recentre"),
    ("F", "Flip"),
    ("V", "Follow · Tilt locked · FPV"),
    ("+ / -", "Next / previous zoom stop"),
    ("0", "Wide"),
    ("X", "Stop tracking"),
    ("[ / ]", "Resolution / frame rate"),
    ("1–6", "Gimbal preset"),
    ("G", "Library"),
    ("H", "Hide the chrome"),
    ("Tab", "Settings"),
    ("E", "Exposure"),
    ("K", "Moves"),
    ("A", "Assists"),
    ("Z P L M", "Zebra · Peaking · Cube · Mirror"),
    ("F11", "Fullscreen"),
    ("Esc", "Close a sheet, then the viewfinder"),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn routed(name: &str) -> Option<Route> {
        parse(name).and_then(route)
    }

    #[test]
    fn every_documented_key_has_a_meaning() {
        for name in [
            " ",
            "r",
            "t",
            "s",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "c",
            "+",
            "=",
            "-",
            "_",
            "0",
            "f",
            "v",
            "g",
            "x",
            "[",
            "]",
            "h",
            "Tab",
            "e",
            "k",
            "a",
            "z",
            "p",
            "l",
            "m",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "Escape",
            "F11",
        ] {
            assert!(routed(name).is_some(), "{name:?} does nothing");
        }
    }

    #[test]
    fn the_seven_keys_the_phones_lack_are_bound() {
        assert_eq!(routed("t"), Some(Route::Input(Key::Char('t'))));
        assert_eq!(routed("Tab"), Some(Route::Ui(UiAction::ToggleSettings)));
        assert_eq!(routed("e"), Some(Route::Ui(UiAction::ToggleExposure)));
        assert_eq!(routed("k"), Some(Route::Ui(UiAction::ToggleMoves)));
        assert_eq!(routed("a"), Some(Route::Ui(UiAction::ToggleAssists)));
        assert_eq!(routed("4"), Some(Route::Input(Key::Char('4'))));
        assert_eq!(routed("F11"), Some(Route::Ui(UiAction::Fullscreen)));
    }

    #[test]
    fn case_does_not_change_what_a_key_means() {
        assert_eq!(routed("Z"), routed("z"));
        assert_eq!(routed("R"), Some(Route::Input(Key::Char('r'))));
        assert_eq!(routed("V"), Some(Route::GimbalCycle));
    }

    #[test]
    fn an_unmapped_key_does_nothing() {
        assert_eq!(routed("q"), None);
        assert_eq!(routed("9"), None);
        assert_eq!(routed("Shift"), None);
        assert_eq!(routed(""), None);
    }

    #[test]
    fn v_cycles_follow_tilt_locked_and_fpv() {
        assert_eq!(next_gimbal_mode("follow"), "tilt-locked");
        assert_eq!(next_gimbal_mode("tilt-locked"), "fpv");
        assert_eq!(next_gimbal_mode("fpv"), "follow");
        assert_eq!(next_gimbal_mode("locked"), "follow");
    }
}
