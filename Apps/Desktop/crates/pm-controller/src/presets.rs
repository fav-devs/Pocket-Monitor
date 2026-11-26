//! Gimbal presets: named poses the operator saves from the live attitude and recalls
//! with one key or chip, each as a single timed move.
//!
//! A recall is one native timed target (`0x04/0x14`), the same command a programmed
//! leg uses, so the firmware does the easing and the route is the one `can_send`
//! has already proven stays clear of the missing pan sector.

use std::path::{Path, PathBuf};

use crate::moves::Waypoint;

/// How many slots there are; keys 1..=SLOTS recall them.
pub const SLOTS: usize = 6;
pub const DEFAULT_SECONDS: f64 = 2.0;
pub const RECALL_SECONDS: [f64; 6] = [0.5, 1.0, 2.0, 4.0, 8.0, 15.0];

const HEADER: &str = "openpocketcine-desktop-gimbal-presets-v1";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Presets {
    pub slots: [Option<Waypoint>; SLOTS],
    /// How long a recall takes.
    pub seconds: f64,
}

impl Default for Presets {
    fn default() -> Self {
        Self {
            slots: [None; SLOTS],
            seconds: DEFAULT_SECONDS,
        }
    }
}

impl Presets {
    pub fn to_text(&self) -> String {
        let mut out = format!("{HEADER}\nseconds={}\n", self.seconds);
        for (index, slot) in self.slots.iter().enumerate() {
            if let Some(pose) = slot {
                out.push_str(&format!(
                    "slot{}={},{},{}\n",
                    index + 1,
                    pose.yaw,
                    pose.pitch,
                    pose.native_pitch
                ));
            }
        }
        out
    }

    /// Reads [`Self::to_text`]; None for anything else. A slot that is not a reachable
    /// pose is dropped rather than trusted.
    pub fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        if lines.next()? != HEADER {
            return None;
        }
        let mut presets = Self::default();
        for line in lines {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            if key == "seconds" {
                if let Ok(seconds) = value.parse::<f64>() {
                    if seconds.is_finite() {
                        presets.seconds = seconds.clamp(0.5, 25.0);
                    }
                }
            } else if let Some(number) = key.strip_prefix("slot") {
                let Ok(number) = number.parse::<usize>() else {
                    continue;
                };
                let parts: Vec<f64> = value
                    .split(',')
                    .filter_map(|part| part.parse().ok())
                    .collect();
                if (1..=SLOTS).contains(&number) && parts.len() == 3 {
                    let pose = Waypoint {
                        yaw: parts[0],
                        pitch: parts[1],
                        native_pitch: parts[2],
                    };
                    if pose.is_reachable() {
                        presets.slots[number - 1] = Some(pose);
                    }
                }
            }
        }
        Some(presets)
    }
}

/// Where presets live: next to the settings file.
pub fn path_beside(prefs: &Path) -> PathBuf {
    prefs.with_file_name("desktop-gimbal-presets-v1.txt")
}

pub fn load(path: &Path) -> Option<Presets> {
    Presets::parse(&std::fs::read_to_string(path).ok()?)
}

pub fn save(path: &Path, presets: &Presets) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, presets.to_text())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pose(yaw: f64) -> Waypoint {
        Waypoint {
            yaw,
            pitch: -5.5,
            native_pitch: 12.25,
        }
    }

    #[test]
    fn presets_survive_the_file_and_refuse_strangers() {
        let mut presets = Presets::default();
        presets.slots[0] = Some(pose(10.5));
        presets.slots[5] = Some(pose(200.0));
        presets.seconds = 4.0;
        assert_eq!(Presets::parse(&presets.to_text()), Some(presets));
        assert_eq!(Presets::parse("something else\n"), None);
    }

    #[test]
    fn bad_slots_are_dropped_and_the_time_is_bounded() {
        let text =
            format!("{HEADER}\nseconds=9999\nslot1=nan,0,0\nslot2=1,2\nslot9=1,2,3\nslot3=5,6,7\n");
        let presets = Presets::parse(&text).unwrap();
        assert_eq!(presets.seconds, 25.0);
        assert_eq!(presets.slots[0], None);
        assert_eq!(presets.slots[1], None);
        assert_eq!(
            presets.slots[2],
            Some(Waypoint {
                yaw: 5.0,
                pitch: 6.0,
                native_pitch: 7.0
            })
        );
    }
}
