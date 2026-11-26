//! The command line of the Tauri app (`docs/desktop-expo-port.md` §1.B): every flag the
//! old `opc-monitor` took, read before the window opens, and handed to the web as its
//! first route through `launch_args`.
//!
//! Pure: no window, no files. The Tauri binary prints, runs the headless harness or
//! opens the window from what [`parse`] decides.

use serde::Serialize;

/// The product name the window, the dialogs and `version` use.
pub const PRODUCT: &str = "Pocket Monitor";

pub const USAGE: &str = "\
Pocket Monitor desktop

USAGE:
    pocket-monitor                      the home screen (or the remembered camera, when
                                        Settings > Open my camera at launch is on)
    pocket-monitor view [--camera HOST[:PORT]] [--model ID] [--look NAME | --lut FILE]
                        [--still PATH]
    pocket-monitor view --phone NAME [--phone-at IP:PORT] [--passcode P]
    pocket-monitor watch [NAME] [--phone-at IP:PORT] [--passcode P]
    pocket-monitor home | setup | demo
    pocket-monitor headless scan [--seconds N] | pair | station --ssid NAME
    pocket-monitor keys
    pocket-monitor version

`view` with no --camera looks for the camera the way a plain launch does: the camera
remembered by address, then the camera on your home Wi-Fi, then the camera's own Wi-Fi
through its saved Windows profile, then Bluetooth pairing. `setup` goes straight to
pairing. `--camera` points the link somewhere else (a LAN camera, a capture, a fake
camera); a LAN address is remembered for the next launch.
`watch` takes the feed a phone running Pocket Monitor is sharing; without a NAME it opens
the list of phones sharing. The passcode may also come from OPC_PHONE_PASSCODE.
`headless` runs Bluetooth without a window; `station` reads the network password from
OPC_WIFI_PASSWORD so it never lands in a command line or a log.
`--gestures` (or OPC_GESTURES=1) turns webcam gestures on.
Environment: OPC_WEBCAM picks a webcam, OPC_DUMP_STREAM=PATH writes every access unit
as Annex-B, PM_CAMERA=HOST[:PORT] is --camera, PM_PICTURE_HOST=toplevel draws the
picture on the window itself.";

pub const KEYS: &str = "\
Viewfinder keys

  Space        start recording            T      countdown, or cancel it
  R            stop recording             S      write a still
  Arrows       pan and tilt               C      recentre the gimbal
  + / -        next / previous zoom stop  F      flip to selfie and back
  0            back to wide               V      cycle gimbal mode
  [ / ]        step resolution / rate     G      open the library
  1 - 6        recall a gimbal preset     X      stop tracking
  Tab          settings                   E      exposure
  A            assist toolbar             K      programmed moves
  F11          fullscreen                 Esc    close a sheet, then the viewfinder

  Z zebra      P peaking      L colour cube      M mirror      H hide the chrome

  Drag         track what you drew around (mouse or one finger)
  Click        focus there

Two arrows at once pan diagonally. The gimbal keeps moving while a key is held and
rests the moment it comes up, or when the window loses focus.";

/// Where the web starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Route {
    /// The cameras the app knows (A1).
    #[default]
    Home,
    /// The viewfinder: `camera` when given, otherwise the launch chain (A3).
    Viewfinder,
    /// Bluetooth pairing, every shortcut skipped (B4 `setup`).
    Setup,
    /// A phone's shared feed, or the list of phones sharing (B3).
    Watch,
    /// The demo camera (A16).
    Demo,
}

/// What the command line asked for (B1–B8).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    pub route: Route,
    /// `--camera HOST[:PORT]` (or `PM_CAMERA`): link this address, no shortcuts.
    pub camera: Option<String>,
    /// `--model ID`, decimal or `0x` hex.
    pub model: Option<i32>,
    /// `--look NAME`: a built-in look at 33³.
    pub look: Option<String>,
    /// `--lut FILE`: a `.cube` read through the core.
    pub lut: Option<String>,
    /// `--still PATH`: where `S` writes.
    pub still: Option<String>,
    /// `--phone NAME` / `watch NAME`.
    pub phone: Option<String>,
    /// `--phone-at IP:PORT`.
    pub phone_at: Option<String>,
    /// `--passcode P` or `OPC_PHONE_PASSCODE`. Kept in the backend: never sent to the web.
    #[serde(skip)]
    pub passcode: Option<String>,
    /// Whether a passcode was given, for the web to skip asking.
    pub has_passcode: bool,
    /// `--gestures` or `OPC_GESTURES`.
    pub gestures: bool,
    /// Kept for the phase-1 web: the same as `route == demo`.
    pub demo: bool,
}

/// What the process does.
#[derive(Debug, Clone, PartialEq)]
pub enum Launch {
    /// Open the window.
    Window(LaunchArgs),
    /// Print this and exit successfully (`keys`, `version`, `--help`).
    Print(String),
    /// The no-window Bluetooth harness, with its arguments (B5).
    Headless(Vec<String>),
    /// Say this and exit with a failure (an unknown command, a bad flag).
    Fail(String),
}

/// The environment [`parse`] reads, so tests can supply their own.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub pm_camera: Option<String>,
    pub opc_gestures: bool,
    pub opc_phone_passcode: Option<String>,
}

impl Env {
    pub fn current() -> Self {
        Self {
            pm_camera: std::env::var("PM_CAMERA").ok().filter(|v| !v.is_empty()),
            opc_gestures: std::env::var("OPC_GESTURES").is_ok_and(|v| !v.is_empty() && v != "0"),
            opc_phone_passcode: std::env::var("OPC_PHONE_PASSCODE")
                .ok()
                .filter(|v| !v.is_empty()),
        }
    }
}

/// `--name value`.
pub fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|argument| argument == &format!("--{name}"))
        .and_then(|at| args.get(at + 1))
        .map(String::as_str)
}

/// A model id, decimal (`32`, the old flag) or hex (`0x20`).
pub fn parse_model(text: &str) -> Option<i32> {
    match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        Some(hex) => i32::from_str_radix(hex, 16).ok(),
        None => text.parse().ok(),
    }
}

/// `HOST:PORT` or a bare IPv4 address (port 9004). The link takes either.
fn valid_camera(text: &str) -> bool {
    text.parse::<std::net::SocketAddr>().is_ok() || text.parse::<std::net::Ipv4Addr>().is_ok()
}

fn view_args(args: &[String], env: &Env, mut out: LaunchArgs) -> Result<LaunchArgs, String> {
    out.route = Route::Viewfinder;
    if let Some(name) = flag(args, "phone") {
        out.route = Route::Watch;
        out.phone = Some(name.to_string());
    }
    if let Some(at) = flag(args, "phone-at") {
        if at.parse::<std::net::SocketAddr>().is_err() {
            return Err(format!("`{at}` is not an ip:port"));
        }
        out.phone_at = Some(at.to_string());
    }
    out.passcode = flag(args, "passcode")
        .map(str::to_string)
        .or_else(|| env.opc_phone_passcode.clone());
    out.has_passcode = out.passcode.is_some();
    if out.route == Route::Viewfinder {
        if args.iter().any(|argument| argument == "--setup") {
            out.route = Route::Setup;
        }
        out.camera = flag(args, "camera")
            .map(str::to_string)
            .or_else(|| env.pm_camera.clone());
        if let Some(camera) = out.camera.as_deref() {
            if !valid_camera(camera) {
                return Err(format!("`{camera}` is not a host:port"));
            }
        }
    }
    if let Some(model) = flag(args, "model") {
        out.model = Some(parse_model(model).ok_or_else(|| format!("`{model}` is not a model id"))?);
    }
    if flag(args, "look").is_some() && flag(args, "lut").is_some() {
        return Err("give --look or --lut, not both".to_string());
    }
    out.look = flag(args, "look").map(str::to_string);
    out.lut = flag(args, "lut").map(str::to_string);
    out.still = flag(args, "still").map(str::to_string);
    Ok(out)
}

/// What the process should do for `args` (without the program name). `open_at_launch`
/// is the home screen's *Open my camera straight away* setting (A2, A3).
pub fn parse(args: &[String], env: &Env, open_at_launch: bool) -> Launch {
    let gestures = env.opc_gestures || args.iter().any(|argument| argument == "--gestures");
    let rest: Vec<String> = args
        .iter()
        .filter(|argument| *argument != "--gestures")
        .cloned()
        .collect();
    let base = LaunchArgs {
        gestures,
        ..LaunchArgs::default()
    };
    let window = |result: Result<LaunchArgs, String>| match result {
        Ok(args) => Launch::Window(args),
        Err(message) => Launch::Fail(message),
    };
    match rest.first().map(String::as_str) {
        None => {
            if env.pm_camera.is_some() {
                window(view_args(&rest, env, base))
            } else if open_at_launch {
                Launch::Window(LaunchArgs {
                    route: Route::Viewfinder,
                    ..base
                })
            } else {
                Launch::Window(base)
            }
        }
        Some("home") => Launch::Window(base),
        Some("demo") => Launch::Window(LaunchArgs {
            route: Route::Demo,
            demo: true,
            ..base
        }),
        Some("setup" | "--setup") => Launch::Window(LaunchArgs {
            route: Route::Setup,
            ..base
        }),
        Some("view") => window(view_args(&rest[1..], env, base)),
        Some("watch") => {
            let name = rest.get(1).filter(|word| !word.starts_with("--")).cloned();
            let skip = if name.is_some() { 2 } else { 1 };
            window(view_args(&rest[skip..], env, base).map(|mut out| {
                out.route = Route::Watch;
                out.camera = None;
                if name.is_some() {
                    out.phone = name;
                }
                out
            }))
        }
        Some("headless") => Launch::Headless(rest[1..].to_vec()),
        Some("keys") => Launch::Print(KEYS.to_string()),
        Some("version" | "--version") => {
            Launch::Print(format!("pocket-monitor {}", env!("CARGO_PKG_VERSION")))
        }
        Some("--help" | "-h" | "help") => Launch::Print(USAGE.to_string()),
        // Phase 1 took `pocket-monitor --camera HOST --model ID` without `view`.
        Some(first) if first.starts_with("--") => window(view_args(&rest, env, base)),
        Some(other) => Launch::Fail(format!("unknown command `{other}`\n\n{USAGE}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_string).collect()
    }

    fn window(text: &str) -> LaunchArgs {
        match parse(&words(text), &Env::default(), false) {
            Launch::Window(args) => args,
            other => panic!("{text}: {other:?}"),
        }
    }

    #[test]
    fn a_plain_launch_opens_home_or_the_remembered_camera() {
        assert_eq!(window("").route, Route::Home);
        match parse(&[], &Env::default(), true) {
            Launch::Window(args) => assert_eq!(args.route, Route::Viewfinder),
            other => panic!("{other:?}"),
        }
        assert_eq!(window("home").route, Route::Home);
        assert_eq!(window("demo").route, Route::Demo);
        assert!(window("demo").demo);
        assert_eq!(window("setup").route, Route::Setup);
        assert_eq!(window("view --setup").route, Route::Setup);
    }

    #[test]
    fn view_takes_every_old_flag() {
        let args = window("view --camera 10.0.0.5:9004 --model 32 --look Contrast --still a.png");
        assert_eq!(args.route, Route::Viewfinder);
        assert_eq!(args.camera.as_deref(), Some("10.0.0.5:9004"));
        assert_eq!(args.model, Some(0x20));
        assert_eq!(args.look.as_deref(), Some("Contrast"));
        assert_eq!(args.still.as_deref(), Some("a.png"));
        assert_eq!(window("view --model 0x22").model, Some(0x22));
        assert_eq!(
            window("view --camera 10.0.0.5").camera.as_deref(),
            Some("10.0.0.5")
        );
        assert_eq!(
            window("--camera 192.168.2.1:9004 --model 0x20").route,
            Route::Viewfinder
        );
        assert_eq!(
            window("view --lut mine.cube").lut.as_deref(),
            Some("mine.cube")
        );
    }

    #[test]
    fn bad_flags_fail_with_the_old_copy() {
        let fails = |text: &str| match parse(&words(text), &Env::default(), false) {
            Launch::Fail(message) => message,
            other => panic!("{text}: {other:?}"),
        };
        assert_eq!(
            fails("view --camera nowhere"),
            "`nowhere` is not a host:port"
        );
        assert_eq!(fails("view --model pocket"), "`pocket` is not a model id");
        assert!(fails("frobnicate").starts_with("unknown command `frobnicate`"));
        assert!(fails("view --phone A --phone-at x").contains("not an ip:port"));
        assert!(fails("view --look A --lut b.cube").contains("not both"));
    }

    #[test]
    fn a_phone_is_watched_and_its_passcode_stays_in_the_backend() {
        let args = window("watch Studio --passcode 1234");
        assert_eq!(args.route, Route::Watch);
        assert_eq!(args.phone.as_deref(), Some("Studio"));
        assert_eq!(args.passcode.as_deref(), Some("1234"));
        let json = serde_json::to_value(&args).unwrap();
        assert!(json.get("passcode").is_none(), "{json}");
        assert_eq!(json["hasPasscode"], true);
        assert_eq!(json["route"], "watch");
        let listed = window("watch");
        assert_eq!((listed.route, listed.phone), (Route::Watch, None));
        let view = window("view --phone Studio --phone-at 10.0.0.8:4000");
        assert_eq!(view.route, Route::Watch);
        assert_eq!(view.phone_at.as_deref(), Some("10.0.0.8:4000"));
        let env = Env {
            opc_phone_passcode: Some("9999".into()),
            ..Env::default()
        };
        match parse(&words("watch Studio"), &env, false) {
            Launch::Window(args) => assert_eq!(args.passcode.as_deref(), Some("9999")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn print_commands_and_the_headless_harness() {
        assert_eq!(
            parse(&words("keys"), &Env::default(), false),
            Launch::Print(KEYS.into())
        );
        assert_eq!(
            parse(&words("--help"), &Env::default(), false),
            Launch::Print(USAGE.into())
        );
        assert_eq!(
            parse(&words("-h"), &Env::default(), false),
            Launch::Print(USAGE.into())
        );
        for version in ["version", "--version"] {
            match parse(&words(version), &Env::default(), false) {
                Launch::Print(text) => assert!(text.starts_with("pocket-monitor ")),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(
            parse(&words("headless scan --seconds 4"), &Env::default(), false),
            Launch::Headless(words("scan --seconds 4"))
        );
    }

    #[test]
    fn gestures_come_from_the_flag_anywhere_or_the_environment() {
        assert!(window("view --gestures").gestures);
        assert!(window("--gestures").gestures);
        assert_eq!(window("--gestures").route, Route::Home);
        assert!(!window("view").gestures);
        let env = Env {
            opc_gestures: true,
            ..Env::default()
        };
        match parse(&[], &env, false) {
            Launch::Window(args) => assert!(args.gestures),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn pm_camera_is_the_camera_flag() {
        let env = Env {
            pm_camera: Some("10.0.0.9:9004".into()),
            ..Env::default()
        };
        match parse(&[], &env, false) {
            Launch::Window(args) => {
                assert_eq!(args.route, Route::Viewfinder);
                assert_eq!(args.camera.as_deref(), Some("10.0.0.9:9004"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_key_list_names_every_key_the_viewfinder_takes() {
        for key in [
            "Space", "Tab", "F11", "1 - 6", "Esc", " E ", " K ", " A ", " T ",
        ] {
            assert!(KEYS.contains(key), "{key}");
        }
    }
}
