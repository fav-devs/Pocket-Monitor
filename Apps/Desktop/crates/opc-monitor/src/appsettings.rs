//! What the home screen remembers about how the app itself behaves, apart from the
//! camera and viewfinder settings in [`crate::prefs`].

use std::path::{Path, PathBuf};

use crate::gesture::GestureMap;

/// Where gestures are read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GestureSource {
    /// The picture coming from the camera itself.
    CameraFeed,
    /// A webcam on this PC.
    Webcam,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppSettings {
    /// Webcam gestures on whenever the viewfinder opens.
    pub gestures: bool,
    /// Skip the home screen and open the remembered camera straight away at launch.
    pub open_camera_at_launch: bool,
    /// What each webcam gesture does.
    pub gesture_map: GestureMap,
    pub gesture_source: GestureSource,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            gestures: false,
            open_camera_at_launch: false,
            gesture_map: GestureMap::default(),
            gesture_source: GestureSource::CameraFeed,
        }
    }
}

const HEADER: &str = "openpocketcine-desktop-app-v1";

impl AppSettings {
    pub fn to_text(&self) -> String {
        format!(
            "{HEADER}\ngestures={}\nopen_camera_at_launch={}\ngesture_source={}\n{}",
            u8::from(self.gestures),
            u8::from(self.open_camera_at_launch),
            match self.gesture_source {
                GestureSource::CameraFeed => "camera",
                GestureSource::Webcam => "webcam",
            },
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
        for line in lines {
            match line.split_once('=') {
                Some(("gestures", value)) => settings.gestures = value == "1",
                Some(("open_camera_at_launch", value)) => {
                    settings.open_camera_at_launch = value == "1"
                }
                Some(("gesture_source", value)) => {
                    settings.gesture_source = if value == "webcam" {
                        GestureSource::Webcam
                    } else {
                        GestureSource::CameraFeed
                    }
                }
                _ => settings.gesture_map.read_line(line),
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
    std::fs::read_to_string(path()).map_or_else(|_| AppSettings::default(), |t| AppSettings::parse(&t))
}

pub fn save(settings: &AppSettings) {
    let path = path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, settings.to_text());
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
        };
        assert_eq!(AppSettings::parse(&settings.to_text()), settings);
        assert_eq!(AppSettings::parse("junk"), AppSettings::default());
        assert_eq!(AppSettings::parse(""), AppSettings::default());
    }

    #[test]
    fn the_pocket_3_is_named() {
        assert_eq!(model_label(Some(0x20)), "Osmo Pocket 3");
        assert_eq!(model_label(None), "DJI camera");
    }
}
