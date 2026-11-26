//! The live decode policy: which access units reach libavcodec, when the decoder is
//! built, and what a stalled window is allowed to skip.
//!
//! Moved out of `opc-monitor`'s `view.rs` so the old window (decode inside `draw`) and the
//! Tauri app (decode on its own thread, handing pictures to the render thread) run one
//! policy. The numbers are the measured ones from the Windows builds: a backlog over
//! [`BACKLOG_LIMIT`] access units skips to the newest keyframe; more than
//! [`READY_LIMIT`] decoded pictures waiting drops the oldest.

use opc_decode::{Codec, Decoder, OwnedPicture};

use crate::link::diagnostic;

/// A backlog longer than this means the consumer stalled. Predicted pictures cannot be
/// thinned — they need the ones before them — so the only safe skip is to a keyframe.
pub const BACKLOG_LIMIT: usize = 30;
/// Decoded pictures that may wait to be shown before the oldest are skipped.
pub const READY_LIMIT: usize = 3;

/// One access unit, with its keyframe flag read once on arrival.
#[derive(Debug)]
pub struct Unit {
    pub keyframe: bool,
    pub bytes: Vec<u8>,
}

/// What one [`LiveDecoder::decode`] call came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Decoded {
    /// No unit with parameter sets yet, so no decoder; everything waiting was dropped.
    Waiting,
    /// The codec was latched but its decoder could not be built.
    CreateFailed(String),
    /// The decoder ran. `Some` carries a failure after the first picture, which the
    /// caller reports (Failed phase, `note_decoder_failed`).
    Ran(Option<String>),
}

/// The codec latch, the pending units and the decoder.
#[derive(Default)]
pub struct LiveDecoder {
    decoder: Option<Decoder>,
    pending: Vec<Unit>,
}

impl std::fmt::Debug for LiveDecoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveDecoder")
            .field("codec", &self.codec())
            .field("pending", &self.pending.len())
            .finish()
    }
}

impl LiveDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The codec the decoder was built for, once one has been.
    pub fn codec(&self) -> Option<Codec> {
        self.decoder.as_ref().map(Decoder::codec)
    }

    /// Units waiting for the next [`decode`](Self::decode).
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    /// Queues one access unit from the camera or a phone. Keyframes are marked from the
    /// first coded slice only; `OPC_DUMP_STREAM` gets every unit.
    pub fn push(&mut self, bytes: Vec<u8>) {
        let keyframe = is_keyframe(&bytes);
        dump_unit(&bytes);
        self.pending.push(Unit { keyframe, bytes });
    }

    /// The watchdog says the decoder is wedged: build a fresh one of the same codec
    /// (HEVC when none was latched). Everything queued was for the old decoder's state.
    pub fn rebuild(&mut self) -> Result<(), String> {
        let codec = self.codec().unwrap_or(Codec::Hevc);
        match Decoder::new(codec) {
            Ok(decoder) => {
                self.decoder = Some(decoder);
                self.pending.clear();
                Ok(())
            }
            Err(error) => {
                self.decoder = None;
                Err(error.to_string())
            }
        }
    }

    /// Decodes everything waiting, handing each picture to `sink` in order.
    ///
    /// `had_picture` is whether the consumer is already showing a picture: before the
    /// first one, a rejected unit is the expected mid-stream join race and is flushed,
    /// not reported.
    pub fn decode(&mut self, had_picture: bool, mut sink: impl FnMut(OwnedPicture)) -> Decoded {
        if self.decoder.is_none() {
            // Joining mid-stream, the first units are plain slices that name no codec.
            // Guessing HEVC for them built a decoder that never produced a picture from
            // an AVC stream, so wait for the first unit that carries parameter sets.
            let Some(at) = self
                .pending
                .iter()
                .position(|unit| codec_of(&unit.bytes).is_some())
            else {
                self.pending.clear();
                return Decoded::Waiting;
            };
            self.pending.drain(..at);
            let Some(unit) = self.pending.first() else {
                return Decoded::Waiting;
            };
            let codec = codec_of(&unit.bytes).unwrap_or(Codec::Hevc);
            match Decoder::new(codec) {
                Ok(decoder) => {
                    diagnostic(format_args!("created {codec:?} decoder"));
                    self.decoder = Some(decoder);
                }
                Err(error) => {
                    return Decoded::CreateFailed(format!("could not create {codec:?}: {error}"));
                }
            }
        }
        let Some(decoder) = self.decoder.as_mut() else {
            return Decoded::Waiting;
        };
        if self.pending.len() > BACKLOG_LIMIT {
            if let Some(at) = self.pending.iter().rposition(|unit| unit.keyframe) {
                self.pending.drain(..at);
                decoder.flush();
            }
        }
        let mut failure = None;
        let mut first = !had_picture;
        for unit in self.pending.drain(..) {
            if let Err(error) = decoder.send(&unit.bytes) {
                // Pocket 3 sends AVC parameter sets before its first coded slice.
                // FFmpeg records the SPS/PPS then returns EINVAL / "no frame" for
                // that configuration-only packet. It is startup, not a dead decoder.
                if decoder.codec() == Codec::H264 && is_h264_configuration(&unit.bytes) {
                    diagnostic("accepted AVC configuration packet; awaiting keyframe");
                    continue;
                }
                // Joining a Pocket 3 AVC stream is not frame-aligned. FFmpeg can
                // reject the tail of the access unit already in flight before the
                // first SPS/PPS + IDR reaches us. Do not turn that expected startup
                // race into a permanent red decoder error; clear it and wait for the
                // next keyframe, while the watchdog remains responsible for a real
                // no-picture timeout.
                if !had_picture {
                    diagnostic(format_args!(
                        "ignored initial {:?} access unit: {error}; awaiting keyframe",
                        decoder.codec()
                    ));
                    decoder.flush();
                    continue;
                }
                failure = Some(error.to_string());
                break;
            }
            loop {
                match decoder.receive() {
                    Ok(Some(picture)) => {
                        if first {
                            diagnostic(format_args!(
                                "decoded first picture {}x{} keyframe={}",
                                picture.width, picture.height, picture.is_keyframe
                            ));
                            first = false;
                        }
                        sink(OwnedPicture::copy_from(&picture));
                    }
                    Ok(None) => break,
                    Err(error) => {
                        failure = Some(error.to_string());
                        break;
                    }
                }
            }
            if failure.is_some() {
                break;
            }
        }
        Decoded::Ran(failure)
    }
}

/// Whether this access unit can be decoded on its own.
///
/// Only the first coded slice is read: that NAL's type is the picture's type, and the
/// parameter sets ahead of it say nothing about whether it is a refresh. Scanning past
/// it would be reading a whole megabyte a frame to learn nothing new.
pub fn is_keyframe(access_unit: &[u8]) -> bool {
    let mut index = 0;
    while index + 4 < access_unit.len() {
        let start = if access_unit[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if access_unit[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        let first = access_unit[index + start];
        if codec_of(access_unit) == Some(Codec::H264) {
            return (first & 0x1F) == 5; // AVC IDR
        }
        let nal_type = (first >> 1) & 0x3F;
        if nal_type <= 31 {
            // A coded slice. 16..=23 are BLA through RASL — the types that refresh.
            return (16..=23).contains(&nal_type);
        }
        index += start;
    }
    false
}

/// AVC SPS/PPS packets configure FFmpeg but do not contain a picture. Pocket 3 emits
/// them separately at first connect, and FFmpeg's H.264 decoder reports `no frame`.
pub fn is_h264_configuration(access_unit: &[u8]) -> bool {
    let mut index = 0;
    let mut configuration = false;
    while index + 4 < access_unit.len() {
        let start = if access_unit[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if access_unit[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        let Some(header) = access_unit.get(index + start) else {
            break;
        };
        match header & 0x1F {
            1..=5 => return false,
            7 | 8 => configuration = true,
            _ => {}
        }
        index += start;
    }
    configuration
}

/// With `OPC_DUMP_STREAM=<path>` set, appends every access unit to that file as a plain
/// Annex-B stream, so ffprobe and ffplay can look at what the camera really sends.
pub fn dump_unit(bytes: &[u8]) {
    use std::io::Write;
    static FILE: std::sync::OnceLock<Option<std::sync::Mutex<std::fs::File>>> =
        std::sync::OnceLock::new();
    let file = FILE.get_or_init(|| {
        let path = std::env::var_os("OPC_DUMP_STREAM")?;
        std::fs::File::create(path).ok().map(std::sync::Mutex::new)
    });
    if let Some(file) = file {
        if let Ok(mut file) = file.lock() {
            let _ = file.write_all(bytes);
        }
    }
}

/// The camera declares its codec in the first Annex-B NAL. Most Pockets send HEVC,
/// but this Pocket 3's live stream is AVC (`67` SPS / `65` IDR), so the decoder must
/// follow the bytes rather than a model assumption.
pub fn codec_of(access_unit: &[u8]) -> Option<Codec> {
    let mut index = 0;
    while index + 4 < access_unit.len() {
        let start = if access_unit[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if access_unit[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        let first = *access_unit.get(index + start)?;
        // AVC parameter sets, IDR and ordinary slices have these unambiguous headers.
        if matches!(first & 0x1F, 5 | 7 | 8) {
            return Some(Codec::H264);
        }
        // HEVC VPS/SPS/PPS use types 32, 33 and 34.
        if matches!((first >> 1) & 0x3F, 32..=34) {
            return Some(Codec::Hevc);
        }
        index += start;
    }
    None
}

/// A session id and an 8-aligned base sequence, fresh per connect. A fixed base can
/// wedge the camera, so this must not be a constant.
pub fn fresh_session() -> (u16, u16) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.subsec_nanos())
        .unwrap_or(1);
    let session_id = (nanos & 0xFFFF) as u16 | 1;
    let base_seq = ((nanos >> 8) & 0xFFF8) as u16;
    (session_id, base_seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEVC_VPS_IDR: &[u8] = &[0, 0, 0, 1, 0x40, 0x01, 0x0C, 0, 0, 0, 1, 0x26, 0x01, 0xAF];
    const HEVC_TRAIL: &[u8] = &[0, 0, 0, 1, 0x02, 0x01, 0xD0, 0x00];
    const AVC_SPS_PPS: &[u8] = &[0, 0, 0, 1, 0x67, 0x64, 0x00, 0, 0, 0, 1, 0x68, 0xEE, 0x3C];
    const AVC_IDR: &[u8] = &[0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x21];
    const AVC_SPS_IDR: &[u8] = &[0, 0, 0, 1, 0x67, 0x64, 0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00];

    #[test]
    fn the_codec_follows_the_parameter_sets() {
        assert_eq!(codec_of(HEVC_VPS_IDR), Some(Codec::Hevc));
        assert_eq!(codec_of(AVC_SPS_PPS), Some(Codec::H264));
        assert_eq!(codec_of(HEVC_TRAIL), None, "a plain slice names no codec");
    }

    #[test]
    fn keyframes_are_read_off_the_first_coded_slice() {
        assert!(is_keyframe(HEVC_VPS_IDR));
        assert!(!is_keyframe(HEVC_TRAIL));
        assert!(is_keyframe(AVC_IDR));
        // Moved verbatim from the viewfinder: for AVC the *first* NAL decides, so an IDR
        // behind its SPS is not marked. Kept as found; see the Phase 1 notes.
        assert!(!is_keyframe(AVC_SPS_IDR));
    }

    #[test]
    fn avc_configuration_only_packets_are_recognised() {
        assert!(is_h264_configuration(AVC_SPS_PPS));
        assert!(!is_h264_configuration(AVC_SPS_IDR));
    }

    #[test]
    fn units_before_any_parameter_set_are_dropped_without_a_decoder() {
        let mut live = LiveDecoder::new();
        live.push(HEVC_TRAIL.to_vec());
        live.push(HEVC_TRAIL.to_vec());
        assert_eq!(
            live.decode(false, |_| panic!("no picture")),
            Decoded::Waiting
        );
        assert_eq!(live.pending(), 0);
        assert_eq!(live.codec(), None);
    }

    #[test]
    fn a_fresh_session_is_odd_and_its_base_eight_aligned() {
        let (session, base) = fresh_session();
        assert_eq!(session & 1, 1);
        assert_eq!(base % 8, 0);
    }
}
