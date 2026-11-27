//! What the home screen remembers about how the app itself behaves, apart from the
//! camera and viewfinder settings in [`crate::prefs`].

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::gesture::GestureMap;

/// Where gestures are read from. The web names them `cameraFeed` and `webcam`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GestureSource {
    /// The picture coming from the camera itself.
    CameraFeed,
    /// A webcam on this PC.
    Webcam,
}

/// `desktop-app-v1.txt` (X3). The web reads and writes it through `app_settings_get/set`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Webcam gestures on whenever the viewfinder opens.
    pub gestures: bool,
    /// Skip the home screen and open the remembered camera straight away at launch.
    pub open_camera_at_launch: bool,
    /// What each webcam gesture does.
    pub gesture_map: GestureMap,
    pub gesture_source: GestureSource,
    /// Pinch-and-drag hand control of the gimbal and zoom.
    pub hand_control: bool,
    /// The stick is the right hand (the person's right) when true, the left when false.
    pub stick_is_right: bool,
    /// Start tracking a face by itself when one has been in view for a moment.
    pub auto_face_track: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            gestures: false,
            open_camera_at_launch: false,
            gesture_map: GestureMap::default(),
            gesture_source: GestureSource::CameraFeed,
            hand_control: true,
            stick_is_right: true,
            auto_face_track: false,
        }
    }
}

/// The file's first line: a format tag, not a name users see. Kept as it was so the old
/// viewfinder and this app read each other's files (and a migrated copy) unchanged.
const HEADER: &str = "openpocketcine-desktop-app-v1";
/// Which defaults the saved gesture map was made against. A map without this line came
/// from the first defaults, which put flip on a downward sweep (lowering a hand flipped
/// the camera), so it is dropped once and the new defaults apply.
const MAP_VERSION: &str = "gesture_map_version=3";

impl AppSettings {
    pub fn to_text(&self) -> String {
        format!(
            "{HEADER}\ngestures={}\nopen_camera_at_launch={}\ngesture_source={}\nhand_control={}\nstick_is_right={}\nauto_face_track={}\n{MAP_VERSION}\n{}",
            u8::from(self.gestures),
            u8::from(self.open_camera_at_launch),
            match self.gesture_source {
                GestureSource::CameraFeed => "camera",
                GestureSource::Webcam => "webcam",
            },
            u8::from(self.hand_control),
            u8::from(self.stick_is_right),
            u8::from(self.auto_face_track),
            self.gesture_map.to_lines()
        )
    }

    /// Reads [`Self::to_text`]; anything else gives the defaults.
    pub fn parse(text: &str) -> Self {
        let mut settings = Self::default();
        let mut lines = text.lines();
        if lines.next() != Some(HEADER) {
            return settings;
        }
        let current_map = text.lines().any(|line| line == MAP_VERSION);
        for line in lines {
            match line.split_once('=') {
                Some(("gestures", value)) => settings.gestures = value == "1",
                Some(("open_camera_at_launch", value)) => {
                    settings.open_camera_at_launch = value == "1"
                }
                Some(("hand_control", value)) => settings.hand_control = value == "1",
                Some(("stick_is_right", value)) => settings.stick_is_right = value == "1",
                Some(("auto_face_track", value)) => settings.auto_face_track = value == "1",
                Some(("gesture_source", value)) => {
                    settings.gesture_source = if value == "webcam" {
                        GestureSource::Webcam
                    } else {
                        GestureSource::CameraFeed
                    }
                }
                _ if current_map => settings.gesture_map.read_line(line),
                _ => {}
            }
        }
        settings
    }
}

/// Next to the settings file.
pub fn path_beside(prefs: &Path) -> PathBuf {
    prefs.with_file_name("desktop-app-v1.txt")
}

pub fn path() -> PathBuf {
    path_beside(&crate::prefs::path())
}

pub fn load() -> AppSettings {
    load_from(&path())
}

pub fn save(settings: &AppSettings) {
    let _ = save_to(&path(), settings);
}

pub fn load_from(path: &Path) -> AppSettings {
    std::fs::read_to_string(path)
        .map_or_else(|_| AppSettings::default(), |t| AppSettings::parse(&t))
}

pub fn save_to(path: &Path, settings: &AppSettings) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, settings.to_text())
}

/// The model's name as an operator knows it.
pub fn model_label(model_id: Option<i32>) -> &'static str {
    match model_id {
        Some(0x20) => "Osmo Pocket 3",
        Some(0x19) => "Osmo Nano",
        Some(0x21 | 0x22) => "Osmo Pocket 4",
        _ => "DJI camera",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_survive_the_file_and_strangers_get_defaults() {
        let settings = AppSettings {
            gestures: true,
            open_camera_at_launch: true,
            gesture_map: {
                let mut map = GestureMap::default();
                map.set(
                    crate::gesture::Gesture::Fist,
                    crate::gesture::GestureAction::Record,
                );
                map
            },
            gesture_source: GestureSource::Webcam,
            hand_control: false,
            stick_is_right: false,
            auto_face_track: true,
        };
        assert_eq!(AppSettings::parse(&settings.to_text()), settings);
        assert_eq!(AppSettings::parse("junk"), AppSettings::default());
        assert_eq!(AppSettings::parse(""), AppSettings::default());
    }

    #[test]
    fn a_map_saved_before_the_new_defaults_is_dropped() {
        let old = "openpocketcine-desktop-app-v1\ngestures=1\ngesture.swipe_down=flip\ngesture.two=flip\n";
        let settings = AppSettings::parse(old);
        assert!(settings.gestures, "the rest of the file is kept");
        assert_eq!(
            settings.gesture_map.get(crate::gesture::Gesture::SwipeDown),
            crate::gesture::GestureAction::Nothing
        );
    }

    #[test]
    fn the_pocket_3_is_named() {
        assert_eq!(model_label(Some(0x20)), "Osmo Pocket 3");
        assert_eq!(model_label(None), "DJI camera");
    }

    #[test]
    fn the_web_speaks_camel_case_and_a_missing_field_is_default() {
        let settings = AppSettings {
            gestures: true,
            gesture_source: GestureSource::Webcam,
            ..AppSettings::default()
        };
        let json = serde_json::to_value(settings).unwrap();
        assert_eq!(json["gestures"], true);
        assert_eq!(json["openCameraAtLaunch"], false);
        assert_eq!(json["gestureSource"], "webcam");
        assert_eq!(json["handControl"], true);
        assert_eq!(json["stickIsRight"], true);
        assert_eq!(json["autoFaceTrack"], false);
        assert_eq!(json["gestureMap"]["two"], "record");
        assert_eq!(json["gestureMap"]["swipe_left"], "previous_preset");
        assert_eq!(
            serde_json::from_value::<AppSettings>(json).unwrap(),
            settings
        );

        // An older web build sends only the first two: the rest keep their defaults.
        let back: AppSettings = serde_json::from_str(r#"{"openCameraAtLaunch":true}"#).unwrap();
        assert!(back.open_camera_at_launch && !back.gestures);
        assert!(back.hand_control && back.stick_is_right);
        assert_eq!(back.gesture_source, GestureSource::CameraFeed);
        assert_eq!(back.gesture_map, GestureMap::default());

        let back: AppSettings =
            serde_json::from_str(r#"{"gestureSource":"cameraFeed","gestureMap":{"fist":"flip"}}"#)
                .unwrap();
        assert_eq!(back.gesture_source, GestureSource::CameraFeed);
        assert_eq!(
            back.gesture_map.get(crate::gesture::Gesture::Fist),
            crate::gesture::GestureAction::Flip
        );
    }

    #[test]
    fn a_file_is_written_where_it_is_read() {
        let dir = std::env::temp_dir().join(format!("pm-appsettings-{}", std::process::id()));
        let file = dir.join("desktop-app-v1.txt");
        let mut settings = AppSettings {
            gestures: true,
            open_camera_at_launch: true,
            gesture_source: GestureSource::Webcam,
            auto_face_track: true,
            ..AppSettings::default()
        };
        settings.gesture_map.set(
            crate::gesture::Gesture::Palm,
            crate::gesture::GestureAction::Record,
        );
        save_to(&file, &settings).unwrap();
        assert_eq!(load_from(&file), settings);
        assert_eq!(load_from(&dir.join("missing.txt")), AppSettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
