//! The mobile `PictureEffects` fields `GradeOptions` predates, checked on the pixels.
//!
//! `Look` carries the display transform (`sourceColor`), the cube's intensity and input
//! exposure, the mono and vertical-flip views, solid zebra and the desqueeze. The phones'
//! order is exposure → display transform → cube by intensity → mono → false colour →
//! peaking → zebra; each test pins one link of it. Also the cover fit and the async
//! (virtual camera) render path.

use opc_decode::Picture;
use opc_render::{
    fit_in, Desqueeze, FeedRenderer, GradeOptions, Look, PictureFit, Rgba, Transfer, Zebra,
};

/// A picture from a per-pixel RGB function (0…1), stored as limited-range BT.709 4:2:0
/// (chroma taken from the top-left pixel of each 2×2 block).
struct Source {
    luma: Vec<u8>,
    cb: Vec<u8>,
    cr: Vec<u8>,
    width: u32,
    height: u32,
}

fn ycbcr(rgb: [f64; 3]) -> (u8, u8, u8) {
    let [r, g, b] = rgb;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let cb = (b - y) / 1.8556;
    let cr = (r - y) / 1.5748;
    let code = |v: f64| v.round().clamp(0.0, 255.0) as u8;
    (
        code(16.0 + 219.0 * y),
        code(128.0 + 224.0 * cb),
        code(128.0 + 224.0 * cr),
    )
}

impl Source {
    fn from_fn(width: u32, height: u32, color: impl Fn(u32, u32) -> [f64; 3]) -> Self {
        let mut luma = Vec::new();
        for y in 0..height {
            for x in 0..width {
                luma.push(ycbcr(color(x, y)).0);
            }
        }
        let (cw, ch) = (width.div_ceil(2), height.div_ceil(2));
        let mut cb = Vec::new();
        let mut cr = Vec::new();
        for y in 0..ch {
            for x in 0..cw {
                let (_, u, v) = ycbcr(color(x * 2, y * 2));
                cb.push(u);
                cr.push(v);
            }
        }
        Self {
            luma,
            cb,
            cr,
            width,
            height,
        }
    }

    fn flat(width: u32, height: u32, rgb: [f64; 3]) -> Self {
        Self::from_fn(width, height, |_, _| rgb)
    }

    fn picture(&self) -> Picture<'_> {
        Picture {
            width: self.width,
            height: self.height,
            is_keyframe: true,
            luma: &self.luma,
            chroma_blue: &self.cb,
            chroma_red: &self.cr,
            luma_stride: self.width as usize,
            chroma_stride: self.width.div_ceil(2) as usize,
        }
    }
}

fn renderer() -> Option<FeedRenderer> {
    match FeedRenderer::new() {
        Ok(renderer) => Some(renderer),
        Err(error) => {
            eprintln!("skipping: {error}");
            None
        }
    }
}

fn at(image: &Rgba, x: u32, y: u32) -> [f64; 3] {
    let (r, g, b, _) = image.pixel(x, y).expect("a pixel");
    [
        f64::from(r) / 255.0,
        f64::from(g) / 255.0,
        f64::from(b) / 255.0,
    ]
}

fn centre(image: &Rgba) -> [f64; 3] {
    at(image, image.width / 2, image.height / 2)
}

fn close(actual: [f64; 3], expected: [f64; 3], tolerance: f64) -> bool {
    actual
        .iter()
        .zip(expected)
        .all(|(a, e)| (a - e).abs() <= tolerance)
}

/// A lattice that inverts every channel: easy to recognise at any intensity.
fn inverting(size: u32) -> Vec<f32> {
    let mut out = Vec::new();
    let d = (size - 1) as f32;
    for b in 0..size {
        for g in 0..size {
            for r in 0..size {
                out.extend_from_slice(&[
                    1.0 - r as f32 / d,
                    1.0 - g as f32 / d,
                    1.0 - b as f32 / d,
                    1.0,
                ]);
            }
        }
    }
    out
}

#[test]
fn the_default_look_paints_what_the_shader_always_painted() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    let source = Source::flat(32, 32, [0.5, 0.5, 0.5]);
    let before = renderer
        .render(&source.picture(), (32, 32), GradeOptions::default())
        .expect("render");
    renderer.set_look(Look::default());
    let after = renderer
        .render(&source.picture(), (32, 32), GradeOptions::default())
        .expect("render");
    assert_eq!(before, after);
    assert!(
        close(centre(&after), [0.5; 3], 0.02),
        "{:?}",
        centre(&after)
    );
}

#[test]
fn input_exposure_brightens_the_signal_by_stops_of_its_own_curve() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    // 18% grey in Rec.709, one stop up is 36% scene light.
    let grey = Transfer::Rec709.encode(0.18);
    let source = Source::flat(32, 32, [grey; 3]);
    renderer.set_look(Look {
        exposure_stops: 1.0,
        ..Look::default()
    });
    let shown = renderer
        .render(&source.picture(), (32, 32), GradeOptions::default())
        .expect("render");
    let expected = Transfer::Rec709.encode(0.36);
    assert!(
        close(centre(&shown), [expected; 3], 0.02),
        "{:?} vs {expected}",
        centre(&shown)
    );
}

#[test]
fn a_log_display_transform_shows_scene_grey_as_display_grey() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    for curve in [
        Transfer::DLog,
        Transfer::DLog2,
        Transfer::DLogM,
        Transfer::Hlg,
    ] {
        let grey = curve.encode(0.18);
        let source = Source::flat(32, 32, [grey; 3]);
        renderer.set_look(Look {
            signal: curve,
            display: curve,
            ..Look::default()
        });
        let shown = renderer
            .render(&source.picture(), (32, 32), GradeOptions::default())
            .expect("render");
        let expected = opc_render::DisplayTransform::new(curve).map([grey; 3]);
        assert!(
            close(centre(&shown), expected, 0.025),
            "{curve:?}: {:?} vs {expected:?}",
            centre(&shown)
        );
        assert!(
            (centre(&shown)[1] - grey).abs() > 0.01 || curve == Transfer::Hlg,
            "{curve:?} was left as log"
        );
    }
}

#[test]
fn intensity_mixes_the_cube_over_the_display_transform() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    renderer.set_lut_rgba(9, &inverting(9)).expect("lattice");
    let source = Source::flat(32, 32, [0.25, 0.25, 0.25]);
    let full = renderer
        .render(&source.picture(), (32, 32), GradeOptions::default())
        .expect("render");
    assert!(close(centre(&full), [0.75; 3], 0.03), "{:?}", centre(&full));
    renderer.set_look(Look {
        lut_intensity: 0.5,
        ..Look::default()
    });
    let half = renderer
        .render(&source.picture(), (32, 32), GradeOptions::default())
        .expect("render");
    assert!(close(centre(&half), [0.5; 3], 0.03), "{:?}", centre(&half));
    renderer.set_look(Look {
        lut_intensity: 0.0,
        ..Look::default()
    });
    let none = renderer
        .render(&source.picture(), (32, 32), GradeOptions::default())
        .expect("render");
    assert!(close(centre(&none), [0.25; 3], 0.03), "{:?}", centre(&none));
}

#[test]
fn a_split_shows_the_cube_on_one_half_only() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    renderer.set_lut_rgba(9, &inverting(9)).expect("lattice");
    let source = Source::flat(64, 64, [0.25, 0.25, 0.25]);
    let across = renderer
        .render(
            &source.picture(),
            (64, 64),
            GradeOptions {
                split: true,
                ..GradeOptions::default()
            },
        )
        .expect("render");
    // Across: the top half is graded, the bottom is the signal.
    assert!(close(at(&across, 32, 8), [0.75; 3], 0.03));
    assert!(close(at(&across, 32, 56), [0.25; 3], 0.03));
    let down = renderer
        .render(
            &source.picture(),
            (64, 64),
            GradeOptions {
                split: true,
                split_vertical: true,
                ..GradeOptions::default()
            },
        )
        .expect("render");
    // Down the middle: the right half is graded.
    assert!(close(at(&down, 56, 32), [0.75; 3], 0.03));
    assert!(close(at(&down, 8, 32), [0.25; 3], 0.03));
}

#[test]
fn monochrome_is_the_luma_of_the_graded_picture() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    let source = Source::flat(32, 32, [0.8, 0.2, 0.2]);
    renderer.set_look(Look {
        monochrome: true,
        ..Look::default()
    });
    let shown = renderer
        .render(&source.picture(), (32, 32), GradeOptions::default())
        .expect("render");
    let [r, g, b] = centre(&shown);
    assert!((r - g).abs() < 0.02 && (g - b).abs() < 0.02, "{r} {g} {b}");
    let luma = 0.2126 * 0.8 + 0.7152 * 0.2 + 0.0722 * 0.2;
    assert!((g - luma).abs() < 0.04, "{g} vs {luma}");
}

#[test]
fn the_vertical_mirror_flips_top_to_bottom() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    let source = Source::from_fn(32, 32, |_, y| if y < 16 { [0.9; 3] } else { [0.1; 3] });
    let plain = renderer
        .render(&source.picture(), (32, 32), GradeOptions::default())
        .expect("render");
    assert!(at(&plain, 16, 4)[1] > 0.7 && at(&plain, 16, 28)[1] < 0.3);
    renderer.set_look(Look {
        mirror_vertical: true,
        ..Look::default()
    });
    let flipped = renderer
        .render(&source.picture(), (32, 32), GradeOptions::default())
        .expect("render");
    assert!(at(&flipped, 16, 4)[1] < 0.3, "{:?}", at(&flipped, 16, 4));
    assert!(at(&flipped, 16, 28)[1] > 0.7, "{:?}", at(&flipped, 16, 28));
}

#[test]
fn solid_zebra_paints_every_pixel_over_the_threshold() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    let source = Source::flat(64, 64, [0.95; 3]);
    let options = GradeOptions {
        zebra: Some(Zebra {
            highlight_color: [1.0, 0.0, 0.0, 1.0],
            ..Zebra::highlight(0.8)
        }),
        ..GradeOptions::default()
    };
    let striped = renderer
        .render(&source.picture(), (64, 64), options)
        .expect("render");
    let red = |image: &Rgba| {
        (0..64)
            .flat_map(|y| (0..64).map(move |x| (x, y)))
            .filter(|(x, y)| {
                let [r, g, _] = at(image, *x, *y);
                r > 0.9 && g < 0.1
            })
            .count()
    };
    let striped_count = red(&striped);
    assert!(
        striped_count > 0 && striped_count < 64 * 64,
        "{striped_count}"
    );
    renderer.set_look(Look {
        zebra_stripes: false,
        ..Look::default()
    });
    let solid = renderer
        .render(&source.picture(), (64, 64), options)
        .expect("render");
    assert_eq!(red(&solid), 64 * 64);
}

#[test]
fn a_desqueezed_picture_is_letterboxed_at_its_unsqueezed_shape() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    // A square source into a 2:1 raster: bars at both sides, until a 2× desqueeze fills it.
    let source = Source::flat(32, 32, [0.9; 3]);
    let plain = renderer
        .render(&source.picture(), (128, 64), GradeOptions::default())
        .expect("render");
    assert!(at(&plain, 4, 32)[1] < 0.05, "a bar at the left");
    renderer.set_look(Look {
        desqueeze: Desqueeze {
            factor: 2.0,
            vertical: false,
        },
        ..Look::default()
    });
    let wide = renderer
        .render(&source.picture(), (128, 64), GradeOptions::default())
        .expect("render");
    assert!(at(&wide, 4, 32)[1] > 0.8, "filled to the edge");
    assert_eq!(
        Desqueeze {
            factor: 1.33,
            vertical: false
        }
        .display_size((1920, 1080)),
        (2554, 1080)
    );
    assert_eq!(
        Desqueeze {
            factor: 2.0,
            vertical: true
        }
        .display_size((1920, 1080)),
        (1920, 2160)
    );
}

#[test]
fn a_cover_fit_fills_the_rectangle_and_crops_the_long_side() {
    // 16:9 into a square: contain bars top and bottom; cover overflows left and right.
    assert_eq!(
        fit_in((1600, 900), (0, 0, 900, 900), PictureFit::Contain),
        (0, 197, 900, 506)
    );
    assert_eq!(
        fit_in((1600, 900), (100, 50, 900, 900), PictureFit::Cover),
        (-250, 50, 1600, 900)
    );
    // Same shape: both fits are the rectangle.
    assert_eq!(
        fit_in((1280, 720), (10, 20, 640, 360), PictureFit::Cover),
        (10, 20, 640, 360)
    );
}

#[test]
fn the_async_render_returns_the_previous_frame_without_waiting() {
    let Some(mut renderer) = renderer() else {
        return;
    };
    let bright = Source::flat(64, 36, [0.9; 3]);
    let dark = Source::flat(64, 36, [0.1; 3]);
    let first = renderer
        .render_async(&bright.picture(), (128, 72), GradeOptions::default(), None)
        .expect("submit");
    assert!(first.is_none(), "nothing has finished yet");
    // Wait for the GPU the way a 30 Hz caller would, by time passing.
    let mut collected = None;
    for _ in 0..200 {
        std::thread::sleep(std::time::Duration::from_millis(5));
        if let Some(frame) = renderer
            .render_async(&dark.picture(), (128, 72), GradeOptions::default(), None)
            .expect("submit")
        {
            collected = Some(frame);
            break;
        }
    }
    let frame = collected.expect("the first frame came back");
    assert_eq!((frame.width, frame.height), (128, 72));
    assert!(
        centre(&frame)[1] > 0.8,
        "the bright one: {:?}",
        centre(&frame)
    );
    // The same picture through the synchronous path matches pixel for pixel.
    let still = renderer
        .render_picture(&bright.picture(), (128, 72), GradeOptions::default())
        .expect("render");
    assert_eq!(still, frame);
    // A clean look for this frame only does not change the renderer's own.
    renderer.set_look(Look {
        monochrome: true,
        ..Look::default()
    });
    let _ = renderer.render_async(
        &dark.picture(),
        (128, 72),
        GradeOptions::default(),
        Some(Look::default().clean()),
    );
    assert!(renderer.look().monochrome);
}

#[test]
fn the_live_window_and_offscreen_renders_do_not_rebuild_each_other() {
    let Ok(mut renderer) = FeedRenderer::headless_window(320, 180) else {
        return;
    };
    let source = Source::flat(64, 36, [0.5; 3]);
    for _ in 0..3 {
        let _ = renderer.present(&source.picture(), GradeOptions::default());
        let image = renderer
            .render_picture(&source.picture(), (1280, 720), GradeOptions::default())
            .expect("a vcam-sized frame");
        assert_eq!((image.width, image.height), (1280, 720));
        let _ = renderer.render_async(
            &source.picture(),
            (1280, 720),
            GradeOptions::default(),
            None,
        );
    }
    assert_eq!(renderer.surface_size(), Some((320, 180)));
}
