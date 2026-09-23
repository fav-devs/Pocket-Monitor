//! The file reader on the checked-in test stream: the player's source.

use std::path::PathBuf;

use opc_decode::{FileReader, OwnedPicture};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/testsrc.h265")
}

#[test]
fn a_clip_opens_reports_its_shape_and_decodes_to_the_end() {
    let mut reader = FileReader::open(&fixture()).expect("the fixture opens");
    let info = reader.info();
    assert!(info.width > 0 && info.height > 0, "{info:?}");
    let mut frames = 0;
    let mut last_pts = -1;
    while let Some((picture, pts)) = reader.next_picture().expect("decodes") {
        assert_eq!((picture.width, picture.height), (info.width, info.height));
        assert!(pts >= last_pts, "presentation times go forwards");
        last_pts = pts;
        frames += 1;
    }
    assert!(frames > 1, "a clip has more than one picture");
    // A second read past the end stays at the end.
    assert!(reader.next_picture().unwrap().is_none());
}

#[test]
fn seeking_back_to_the_start_decodes_again() {
    let mut reader = FileReader::open(&fixture()).unwrap();
    let first = reader.next_picture().unwrap().unwrap().0;
    while reader.next_picture().unwrap().is_some() {}
    reader.seek(0).unwrap();
    let again = reader
        .next_picture()
        .unwrap()
        .expect("a picture after the seek")
        .0;
    assert_eq!((again.width, again.height), (first.width, first.height));
}

#[test]
fn a_missing_file_is_an_error_not_a_crash() {
    assert!(FileReader::open(&PathBuf::from("/nowhere/clip.mp4")).is_err());
}

#[test]
fn stills_convert_to_limited_range_video_levels() {
    let white = OwnedPicture::from_rgba(2, 2, &[255; 16]);
    let picture = white.picture();
    assert!(picture.luma.iter().all(|y| *y == 235), "{:?}", picture.luma);
    assert_eq!(picture.chroma_blue, [128]);
    let black = OwnedPicture::black(4, 2);
    assert_eq!(black.picture().luma, [16; 8]);
    assert_eq!(black.picture().chroma_size(), (2, 1));
}

fn tone_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/testsrc-tone.mkv")
}

/// The MKV carries the same pictures plus a 440 Hz tone (mono, 8 kHz PCM). Asked for
/// 48 kHz, the reader hands it over resampled and interleaved for two channels.
#[test]
fn a_clip_with_a_tone_hands_over_its_audio_beside_the_pictures() {
    let mut reader = FileReader::open_with_audio(&tone_fixture(), 48_000).expect("opens");
    let audio = reader.audio_info().expect("an audio track");
    assert_eq!((audio.sample_rate, audio.channels), (48_000, 2));
    assert!(
        reader.take_audio().0.is_empty(),
        "nothing before the first picture"
    );
    let mut pictures = 0;
    let mut samples = Vec::new();
    let mut first_pts = None;
    while reader.next_picture().expect("decodes").is_some() {
        pictures += 1;
        let (chunk, pts) = reader.take_audio();
        if !chunk.is_empty() && first_pts.is_none() {
            first_pts = Some(pts);
        }
        samples.extend(chunk);
    }
    assert!(pictures > 1);
    assert_eq!(first_pts, Some(0));
    // Twenty pictures at 25 fps is 0.8 s: 38 400 frames of two channels, near enough.
    assert!(
        samples.len() > 70_000 && samples.len() < 80_000,
        "{}",
        samples.len()
    );
    assert!(samples.iter().all(|s| s.abs() <= 1.0));
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
    assert!(rms > 0.1, "a tone, not silence: rms {rms}");
    let (left, right) = (samples[1000], samples[1001]);
    assert!((left - right).abs() < 1e-4, "mono goes to both channels");
    // A seek drops what was waiting, and audio comes back with the next picture.
    reader.seek(0).unwrap();
    assert!(reader.take_audio().0.is_empty());
    reader.next_picture().unwrap().unwrap();
    assert!(!reader.take_audio().0.is_empty());
}

#[test]
fn a_clip_without_audio_still_plays_silently() {
    let mut reader = FileReader::open_with_audio(&fixture(), 48_000).expect("opens");
    assert!(reader.audio_info().is_none());
    reader.next_picture().unwrap().unwrap();
    assert!(reader.take_audio().0.is_empty());
    let plain = FileReader::open(&tone_fixture()).expect("opens video only");
    assert!(plain.audio_info().is_none(), "audio only when asked for");
}
