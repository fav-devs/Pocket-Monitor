//! The virtual camera's decisions (§1.W): which backend the Output setting means and
//! the grade it carries. No device, no GPU: the Tauri app's `vcam.rs` runs these.

use opc_render::GradeOptions;
use opc_vcam::Backend;

/// `Prefs::vcam`: 0 Off, 1 Camera device, 2 Stream.
pub fn backend(mode: u8, port: u16) -> Option<Backend> {
    match mode {
        1 => Some(Backend::Device),
        2 => Some(Backend::Stream { port }),
        _ => None,
    }
}

/// The web's word for a mode.
pub fn mode_name(mode: u8) -> &'static str {
    match mode {
        1 => "device",
        2 => "stream",
        _ => "off",
    }
}

pub fn mode_from_name(name: &str) -> Option<u8> {
    match name {
        "off" => Some(0),
        "device" => Some(1),
        "stream" => Some(2),
        _ => None,
    }
}

/// The grade the camera carries: as shown, or Clean (the LUT is the look and stays;
/// zebra, peaking and false colour go).
pub fn grade(shown: GradeOptions, clean: bool) -> GradeOptions {
    if clean {
        GradeOptions {
            zebra: None,
            peaking: None,
            false_color: false,
            ..shown
        }
    } else {
        shown
    }
}

/// The stream's address.
pub fn stream_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/stream")
}

#[cfg(test)]
mod tests {
    use super::*;
    use opc_render::Zebra;

    #[test]
    fn the_setting_names_a_backend() {
        assert_eq!(backend(0, 8890), None);
        assert_eq!(backend(1, 8890), Some(Backend::Device));
        assert_eq!(backend(2, 9000), Some(Backend::Stream { port: 9000 }));
        assert_eq!(mode_from_name(mode_name(2)), Some(2));
        assert_eq!(mode_from_name("webcam"), None);
        assert_eq!(stream_url(8890), "http://127.0.0.1:8890/stream");
    }

    #[test]
    fn clean_drops_the_assists_and_keeps_the_rest() {
        let shown = GradeOptions {
            mirror: true,
            zebra: Some(Zebra::highlight(0.9)),
            false_color: true,
            ..GradeOptions::default()
        };
        let clean = grade(shown, true);
        assert!(clean.mirror);
        assert!(clean.zebra.is_none() && !clean.false_color && clean.peaking.is_none());
        assert_eq!(grade(shown, false), shown);
    }
}
