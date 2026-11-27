//! The desktop app's scope samples for the web view: one compact binary message per tick
//! on the `scope://samples` channel (`docs/desktop-expo-port.md` §3.5).
//!
//! The Rust side reads the decoded camera signal (never the graded picture) on its own
//! thread and does everything that needs the core: the plot level of each code (the
//! core's `ScopeDisplayScale` table for the body's colour mode and ISO), the traffic
//! lights and the ND / EV reading. The web draws the plates from the grids and keeps its
//! own graticules, trails and palette, so a desktop plate looks like the phones'.
//!
//! Message layout, little-endian, version 1:
//!
//! | Offset | Size | Field |
//! | --- | --- | --- |
//! | 0 | 4 | magic `PMSC` |
//! | 4 | 1 | version (1) |
//! | 5 | 1 | blocks present, bit flags ([`BLOCK_WAVE_LUMA`] …) |
//! | 6 | 2 | waveform columns ([`WAVE_COLUMNS`]) |
//! | 8 | 2 | waveform rows ([`WAVE_LEVELS`]) |
//! | 10 | 2 | vectorscope bins per side ([`VECTOR_BINS`]) |
//! | 12 | 4 | sequence |
//! | 16 | 4 | pixels read |
//! | 20 | 4 | f32 18 % grey on the WAVE IRE axis |
//! | 24 | 4 | f32 picture stops vs 18 % grey (NaN when unknown) |
//! | 28 | 12 | lights: red, green, blue × (u8 clip, u8 crush, u16 level × 65535) |
//! | 40 | 1 | i8 ND stops to reach for (−1 when unknown) |
//! | 41 | 1 | lights valid (1) |
//! | 42 | 6 | reserved |
//! | 48 | … | blocks, in flag order |
//!
//! Blocks: each waveform grid is `WAVE_LEVELS × WAVE_COLUMNS` u8 saturating counts,
//! row-major, **row 0 at IRE 0** and the last row at IRE 100 (codes past the clip line sit
//! on 100, as the phones clamp them). The histogram block is four 256-bucket u16 arrays
//! (luma, red, green, blue) already on the WAVE IRE axis (bucket `i` is IRE `i / 255 ×
//! 100`), counts conserved. The vector block is `VECTOR_BINS²` u8 log densities (0 = none,
//! 255 = the peak bin), row 0 at the top (+Cr up), through the source's display
//! transform so log chroma does not collapse onto the centre.
//!
//! Sizes: a WAVE RGB plate is 48 KiB a tick, everything on is about 82 KiB; at the
//! rates the scope thread keeps (15 Hz with up to two trace plates, 10 Hz with more) that
//! stays under 0.85 MB/s.

use opc_decode::Picture;
use opc_render::DisplayTransform;

use super::{LightsReading, NdReading, ScopeScale, CLIP_LEVEL, CRUSH_LEVEL, HIST};

pub const MAGIC: &[u8; 4] = b"PMSC";
pub const VERSION: u8 = 1;
pub const HEADER: usize = 48;
pub const WAVE_COLUMNS: usize = 128;
pub const WAVE_LEVELS: usize = 128;
pub const VECTOR_BINS: usize = 128;

pub const BLOCK_WAVE_LUMA: u8 = 1;
pub const BLOCK_WAVE_RED: u8 = 2;
pub const BLOCK_WAVE_GREEN: u8 = 4;
pub const BLOCK_WAVE_BLUE: u8 = 8;
pub const BLOCK_HISTOGRAM: u8 = 16;
pub const BLOCK_VECTOR: u8 = 32;

/// About this many pixels are read across and down: enough for the plates, cheap enough
/// for every tick (≈ 36 k samples).
const READ_COLUMNS: u32 = 256;
const READ_ROWS: u32 = 144;

/// What the plates on screen need. Built from `scopes_configure`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TapRequest {
    /// WAVE in luma, or PARADE in YRGB.
    pub wave_luma: bool,
    /// WAVE in RGB, or PARADE.
    pub wave_rgb: bool,
    pub histogram: bool,
    pub vector: bool,
    /// The vectorscope's zoom: 1, 2 or 4.
    pub vector_gain: f32,
    pub lights: bool,
    /// The fraction of the picture in the clip / crush zone before a lamp lights
    /// (`crushClipThreshold`: compensation stops / 10).
    pub lights_threshold: f64,
    /// ND chip or EV meter.
    pub nd: bool,
}

impl TapRequest {
    pub fn any(&self) -> bool {
        self.wave_luma || self.wave_rgb || self.histogram || self.vector || self.lights || self.nd
    }

    /// How many plates draw traces, for the rate the phones keep (25 Hz with one or two,
    /// 10 Hz with three or more; the desktop caps at 15).
    pub fn trace_plates(&self) -> usize {
        [self.wave_luma || self.wave_rgb, self.histogram, self.vector]
            .into_iter()
            .filter(|on| *on)
            .count()
            + usize::from(self.wave_luma && self.wave_rgb)
    }

    /// The tick for this request: 15 Hz, or 10 Hz with three or more trace plates.
    pub fn interval(&self) -> std::time::Duration {
        if self.trace_plates() >= 3 {
            std::time::Duration::from_millis(100)
        } else {
            std::time::Duration::from_micros(66_667)
        }
    }

    fn blocks(&self) -> u8 {
        let mut flags = 0;
        if self.wave_luma {
            flags |= BLOCK_WAVE_LUMA;
        }
        if self.wave_rgb {
            flags |= BLOCK_WAVE_RED | BLOCK_WAVE_GREEN | BLOCK_WAVE_BLUE;
        }
        if self.histogram {
            flags |= BLOCK_HISTOGRAM;
        }
        if self.vector {
            flags |= BLOCK_VECTOR;
        }
        flags
    }
}

/// One tick's counts, before encoding.
#[derive(Debug, Clone)]
pub struct Tap {
    /// Native-code histograms: luma (the decoder's Y), red, green, blue.
    pub luma: [u32; HIST],
    pub red: [u32; HIST],
    pub green: [u32; HIST],
    pub blue: [u32; HIST],
    /// `WAVE_LEVELS × WAVE_COLUMNS` per channel, empty when not asked for.
    pub wave: [Vec<u8>; 4],
    /// `VECTOR_BINS²` raw counts, empty when not asked for.
    pub vector: Vec<u32>,
    pub pixels: u32,
}

/// Limited-range BT.709 to 8-bit RGB, the way the feed pass converts the planes.
fn rgb(y: u8, u: u8, v: u8) -> [u8; 3] {
    let y = (f32::from(y) - 16.0) * (255.0 / 219.0);
    let u = (f32::from(u) - 128.0) * (255.0 / 224.0);
    let v = (f32::from(v) - 128.0) * (255.0 / 224.0);
    let code = |value: f32| value.round().clamp(0.0, 255.0) as u8;
    [
        code(y + 1.5748 * v),
        code(y - 0.1873 * u - 0.4681 * v),
        code(y + 1.8556 * u),
    ]
}

/// The WAVE row (0 = IRE 0) of each native code on this scale.
pub fn wave_rows(scale: &ScopeScale) -> [u8; HIST] {
    let mut rows = [0u8; HIST];
    for (code, row) in rows.iter_mut().enumerate() {
        let ire = ((scale.level[code] - CRUSH_LEVEL) / (CLIP_LEVEL - CRUSH_LEVEL)).clamp(0.0, 1.0);
        *row = (ire * (WAVE_LEVELS - 1) as f32).round() as u8;
    }
    rows
}

/// `chroma709` → the vectorscope bin (`vectorBin` on the phones), or `None` off the scope.
fn vector_bin(rgb: [f64; 3], gain: f64) -> Option<(usize, usize)> {
    let [r, g, b] = rgb;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let x = (b - y) / 1.8556 * gain + 0.5;
    let v = (r - y) / 1.5748 * gain + 0.5;
    if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&v) {
        return None;
    }
    let last = (VECTOR_BINS - 1) as f64;
    let column = (x * last).round() as usize;
    // Row 0 at the top: +Cr up.
    let row = VECTOR_BINS - 1 - (v * last).round() as usize;
    Some((column, row))
}

impl Tap {
    /// Reads a decoded picture for `request`. `display` is the source's display transform
    /// (the vectorscope's input; identity for Rec.709).
    pub fn read(
        picture: &Picture<'_>,
        scale: &ScopeScale,
        display: &DisplayTransform,
        request: &TapRequest,
    ) -> Self {
        let mut out = Self {
            luma: [0; HIST],
            red: [0; HIST],
            green: [0; HIST],
            blue: [0; HIST],
            wave: Default::default(),
            vector: Vec::new(),
            pixels: 0,
        };
        if picture.width == 0 || picture.height == 0 {
            return out;
        }
        let cells = WAVE_COLUMNS * WAVE_LEVELS;
        if request.wave_luma {
            out.wave[0] = vec![0; cells];
        }
        if request.wave_rgb {
            for channel in 1..4 {
                out.wave[channel] = vec![0; cells];
            }
        }
        if request.vector {
            out.vector = vec![0; VECTOR_BINS * VECTOR_BINS];
        }
        let rows = wave_rows(scale);
        let gain = f64::from(request.vector_gain.clamp(1.0, 4.0));
        // The display transform per code, so the vectorscope costs a table read, not a
        // pow, per channel (it is per channel up to the matrix).
        let decoded: Option<Vec<f64>> = (!display.is_identity() && request.vector).then(|| {
            (0..HIST)
                .map(|code| display.transfer.decode(code as f64 / 255.0))
                .collect()
        });

        let step_x = (picture.width / READ_COLUMNS).max(1) as usize;
        let step_y = (picture.height / READ_ROWS).max(1) as usize;
        let (chroma_w, chroma_h) = picture.chroma_size();
        let width = picture.width as usize;
        for y in (0..picture.height as usize).step_by(step_y) {
            let Some(luma_row) = picture.luma.get(y * picture.luma_stride..) else {
                break;
            };
            let chroma_row = (y / 2).min(chroma_h as usize - 1) * picture.chroma_stride;
            for x in (0..width).step_by(step_x) {
                let Some(&code) = luma_row.get(x) else {
                    break;
                };
                let cx = (x / 2).min(chroma_w as usize - 1);
                let (Some(&u), Some(&v)) = (
                    picture.chroma_blue.get(chroma_row + cx),
                    picture.chroma_red.get(chroma_row + cx),
                ) else {
                    continue;
                };
                let [r, g, b] = rgb(code, u, v);
                out.luma[code as usize] += 1;
                out.red[r as usize] += 1;
                out.green[g as usize] += 1;
                out.blue[b as usize] += 1;
                out.pixels += 1;
                let column = x * WAVE_COLUMNS / width;
                for (channel, value) in [code, r, g, b].into_iter().enumerate() {
                    if let Some(grid) = out.wave.get_mut(channel).filter(|grid| !grid.is_empty()) {
                        let cell = &mut grid[rows[value as usize] as usize * WAVE_COLUMNS + column];
                        *cell = cell.saturating_add(1);
                    }
                }
                if request.vector {
                    let shown = match &decoded {
                        Some(table) => {
                            let m = &display.matrix;
                            let l = [table[r as usize], table[g as usize], table[b as usize]];
                            let row = |at: usize| {
                                (m[at] * l[0] + m[at + 1] * l[1] + m[at + 2] * l[2]).max(0.0)
                            };
                            [
                                display.tone.display_code(row(0)),
                                display.tone.display_code(row(3)),
                                display.tone.display_code(row(6)),
                            ]
                        }
                        None => [
                            f64::from(r) / 255.0,
                            f64::from(g) / 255.0,
                            f64::from(b) / 255.0,
                        ],
                    };
                    if let Some((column, row)) = vector_bin(shown, gain) {
                        out.vector[row * VECTOR_BINS + column] += 1;
                    }
                }
            }
        }
        out
    }
}

/// Native-code counts onto the WAVE IRE axis, conserving the total (`remapHistogram`).
pub fn ire_histogram(bins: &[u32; HIST], scale: &ScopeScale) -> [u16; HIST] {
    let mut out = [0u32; HIST];
    for (code, count) in bins.iter().enumerate() {
        let ire = ((scale.level[code] - CRUSH_LEVEL) / (CLIP_LEVEL - CRUSH_LEVEL)).clamp(0.0, 1.0);
        out[(ire * 255.0).round() as usize] += count;
    }
    out.map(|count| u16::try_from(count).unwrap_or(u16::MAX))
}

/// The readings the meters show, from the core.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Readings {
    pub lights: Option<LightsReading>,
    pub nd: Option<NdReading>,
}

/// Encodes one tick (layout in the module docs).
pub fn encode(
    tap: &Tap,
    scale: &ScopeScale,
    request: &TapRequest,
    readings: &Readings,
    sequence: u32,
) -> Vec<u8> {
    let blocks = request.blocks();
    let mut out = Vec::with_capacity(HEADER + 4 * WAVE_COLUMNS * WAVE_LEVELS + 2048);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.push(blocks);
    out.extend_from_slice(&(WAVE_COLUMNS as u16).to_le_bytes());
    out.extend_from_slice(&(WAVE_LEVELS as u16).to_le_bytes());
    out.extend_from_slice(&(VECTOR_BINS as u16).to_le_bytes());
    out.extend_from_slice(&sequence.to_le_bytes());
    out.extend_from_slice(&tap.pixels.to_le_bytes());
    out.extend_from_slice(&scale.grey_ire.to_le_bytes());
    let stops = readings
        .nd
        .as_ref()
        .map_or(f32::NAN, |nd| nd.picture_stops as f32);
    out.extend_from_slice(&stops.to_le_bytes());
    let lights = readings.lights.unwrap_or_default();
    for light in [lights.red, lights.green, lights.blue] {
        out.push(u8::from(light.clip));
        out.push(u8::from(light.crush));
        let level = (light.level.clamp(0.0, 1.0) * 65535.0).round() as u16;
        out.extend_from_slice(&level.to_le_bytes());
    }
    let nd_stops = readings
        .nd
        .as_ref()
        .map_or(-1, |nd| nd.nd_stops.clamp(-1, 127) as i8);
    out.push(nd_stops as u8);
    out.push(u8::from(readings.lights.is_some()));
    out.resize(HEADER, 0);

    let cells = WAVE_COLUMNS * WAVE_LEVELS;
    for (flag, channel) in [
        (BLOCK_WAVE_LUMA, 0),
        (BLOCK_WAVE_RED, 1),
        (BLOCK_WAVE_GREEN, 2),
        (BLOCK_WAVE_BLUE, 3),
    ] {
        if blocks & flag != 0 {
            let grid = &tap.wave[channel];
            if grid.len() == cells {
                out.extend_from_slice(grid);
            } else {
                out.resize(out.len() + cells, 0);
            }
        }
    }
    if blocks & BLOCK_HISTOGRAM != 0 {
        for bins in [&tap.luma, &tap.red, &tap.green, &tap.blue] {
            for count in ire_histogram(bins, scale) {
                out.extend_from_slice(&count.to_le_bytes());
            }
        }
    }
    if blocks & BLOCK_VECTOR != 0 {
        let peak = tap.vector.iter().copied().max().unwrap_or(0);
        let log_peak = (1.0 + f64::from(peak)).ln();
        if tap.vector.len() == VECTOR_BINS * VECTOR_BINS && peak > 0 {
            out.extend(tap.vector.iter().map(|count| {
                if *count == 0 {
                    0
                } else {
                    ((1.0 + f64::from(*count)).ln() / log_peak * 255.0)
                        .round()
                        .clamp(1.0, 255.0) as u8
                }
            }));
        } else {
            out.resize(out.len() + VECTOR_BINS * VECTOR_BINS, 0);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use opc_render::Transfer;

    struct Flat {
        luma: Vec<u8>,
        cb: Vec<u8>,
        cr: Vec<u8>,
        width: u32,
        height: u32,
    }

    impl Flat {
        fn new(width: u32, height: u32, y: u8, cb: u8, cr: u8) -> Self {
            let chroma = (width.div_ceil(2) * height.div_ceil(2)) as usize;
            Self {
                luma: vec![y; (width * height) as usize],
                cb: vec![cb; chroma],
                cr: vec![cr; chroma],
                width,
                height,
            }
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

    fn everything() -> TapRequest {
        TapRequest {
            wave_luma: true,
            wave_rgb: true,
            histogram: true,
            vector: true,
            vector_gain: 1.0,
            lights: true,
            lights_threshold: 0.0,
            nd: true,
        }
    }

    fn rec709() -> DisplayTransform {
        DisplayTransform::new(Transfer::Rec709)
    }

    #[test]
    fn a_flat_grey_lands_on_one_wave_row_and_the_vector_centre() {
        let flat = Flat::new(320, 180, 126, 128, 128);
        let scale = ScopeScale::default();
        let request = everything();
        let tap = Tap::read(&flat.picture(), &scale, &rec709(), &request);
        assert!(tap.pixels > 30_000, "{}", tap.pixels);
        assert_eq!(tap.luma[126], tap.pixels);
        let rows = wave_rows(&scale);
        let row = rows[126] as usize;
        let lit: Vec<usize> = (0..WAVE_LEVELS)
            .filter(|r| {
                tap.wave[0][r * WAVE_COLUMNS..(r + 1) * WAVE_COLUMNS]
                    .iter()
                    .any(|c| *c > 0)
            })
            .collect();
        assert_eq!(lit, vec![row]);
        // Every column across the picture has samples.
        assert!(tap.wave[0][row * WAVE_COLUMNS..(row + 1) * WAVE_COLUMNS]
            .iter()
            .all(|count| *count > 0));
        let centre = (VECTOR_BINS - 1) / 2;
        let at = |r: usize, c: usize| tap.vector[r * VECTOR_BINS + c];
        let near: u32 = (centre..=centre + 1)
            .flat_map(|r| (centre..=centre + 1).map(move |c| (r, c)))
            .map(|(r, c)| at(r, c))
            .sum();
        assert_eq!(near, tap.pixels, "neutral chroma sits at the centre");
    }

    #[test]
    fn the_wave_axis_puts_black_at_the_bottom_and_white_at_the_top() {
        let scale = ScopeScale::default();
        let rows = wave_rows(&scale);
        assert_eq!(rows[0], 0);
        assert_eq!(rows[255] as usize, WAVE_LEVELS - 1);
        assert!(rows.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn a_red_picture_reads_up_and_left_of_centre_on_the_vectorscope() {
        // Limited-range BT.709 75 % red: Y 63, Cb 102, Cr 240.
        let flat = Flat::new(64, 36, 63, 102, 240);
        let tap = Tap::read(
            &flat.picture(),
            &ScopeScale::default(),
            &rec709(),
            &everything(),
        );
        let (index, _) = tap
            .vector
            .iter()
            .enumerate()
            .max_by_key(|(_, count)| **count)
            .expect("bins");
        let (row, column) = (index / VECTOR_BINS, index % VECTOR_BINS);
        assert!(row < VECTOR_BINS / 2, "+Cr is up: row {row}");
        assert!(column < VECTOR_BINS / 2, "red has −Cb: column {column}");
        // Zoom pushes it further out, or off the scope.
        let zoomed = Tap::read(
            &flat.picture(),
            &ScopeScale::default(),
            &rec709(),
            &TapRequest {
                vector_gain: 4.0,
                ..everything()
            },
        );
        assert!(zoomed.vector.iter().sum::<u32>() < tap.vector.iter().sum::<u32>());
    }

    #[test]
    fn the_message_has_the_documented_shape() {
        let flat = Flat::new(128, 72, 200, 128, 128);
        let scale = ScopeScale::default();
        let request = everything();
        let tap = Tap::read(&flat.picture(), &scale, &rec709(), &request);
        let readings = Readings {
            lights: Some(LightsReading::default()),
            nd: NdReading::parse("2.3\t2\tND4\t+2.3"),
        };
        let bytes = encode(&tap, &scale, &request, &readings, 7);
        let cells = WAVE_COLUMNS * WAVE_LEVELS;
        assert_eq!(&bytes[0..4], MAGIC);
        assert_eq!(bytes[4], VERSION);
        assert_eq!(bytes[5], 0b11_1111);
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 7);
        assert_eq!(
            u32::from_le_bytes(bytes[16..20].try_into().unwrap()),
            tap.pixels
        );
        let stops = f32::from_le_bytes(bytes[24..28].try_into().unwrap());
        assert!((stops - 2.3).abs() < 1e-6);
        assert_eq!(bytes[40] as i8, 2);
        assert_eq!(bytes[41], 1);
        assert_eq!(
            bytes.len(),
            HEADER + 4 * cells + 4 * 256 * 2 + VECTOR_BINS * VECTOR_BINS
        );
        // The histogram conserves the count.
        let histo = HEADER + 4 * cells;
        let luma: u32 = (0..256)
            .map(|i| {
                u32::from(u16::from_le_bytes([
                    bytes[histo + i * 2],
                    bytes[histo + i * 2 + 1],
                ]))
            })
            .sum();
        assert_eq!(luma, tap.pixels);
        // The vector peak is 255.
        assert_eq!(
            bytes[bytes.len() - VECTOR_BINS * VECTOR_BINS..]
                .iter()
                .max(),
            Some(&255)
        );
        // A WAVE RGB plate alone is three grids.
        let rgb_only = TapRequest {
            wave_rgb: true,
            ..TapRequest::default()
        };
        let tap = Tap::read(&flat.picture(), &scale, &rec709(), &rgb_only);
        assert_eq!(
            encode(&tap, &scale, &rgb_only, &Readings::default(), 0).len(),
            HEADER + 3 * cells
        );
    }

    #[test]
    fn the_rate_follows_the_phones_budget() {
        let one = TapRequest {
            wave_rgb: true,
            ..TapRequest::default()
        };
        assert_eq!(one.interval().as_millis(), 66);
        let three = TapRequest {
            wave_rgb: true,
            histogram: true,
            vector: true,
            ..TapRequest::default()
        };
        assert_eq!(three.interval().as_millis(), 100);
        assert!(!TapRequest::default().any());
    }

    #[test]
    fn a_log_source_spreads_its_chroma_through_the_display_transform() {
        // A mildly saturated D-Log patch: flat log chroma is small, the display transform
        // pushes it out from the centre the way the phones' VECTOR shows it.
        let flat = Flat::new(64, 36, 110, 120, 140);
        let scale = ScopeScale::default();
        let spread = |display: DisplayTransform| {
            let tap = Tap::read(&flat.picture(), &scale, &display, &everything());
            let (index, _) = tap
                .vector
                .iter()
                .enumerate()
                .max_by_key(|(_, count)| **count)
                .expect("bins");
            let centre = (VECTOR_BINS / 2) as f64;
            let (row, column) = ((index / VECTOR_BINS) as f64, (index % VECTOR_BINS) as f64);
            ((row - centre).powi(2) + (column - centre).powi(2)).sqrt()
        };
        assert!(spread(DisplayTransform::new(Transfer::DLog)) > spread(rec709()));
    }
}
