//! Capture settings as the core rules them: shooting modes, video formats, the
//! exposure ladders and the colour wheel.
//!
//! Every list a sheet offers comes from here, so the desktop shows a Pocket 3 its
//! documented fallback tables, sends Photo as that body's own byte, and never invents a
//! ladder Mimo does not offer. With the core linked each call goes through the facade;
//! without it, a copy of the same tables stands in so the sheets can be tested on a
//! machine with no Swift toolchain. The two are kept in step by hand: a number here is
//! only ever a number from `Sources/OpenPocketViewCore`.

/// A `[res][fps]` pair as the body's `0x02/0x18` catalogue names it.
pub type Format = (u8, u8);

/// Shooting-mode bytes the core tables, as `0x02/0x80 @57` reports them.
pub mod mode {
    pub const SLOW_MO: u8 = 0x00;
    pub const VIDEO: u8 = 0x01;
    pub const TIME_LAPSE: u8 = 0x02;
    pub const PHOTO: u8 = 0x17;
    pub const HYPER_LAPSE: u8 = 0x0A;
    pub const LIVE_PHOTO: u8 = 0x4D;
    pub const SUPER_NIGHT: u8 = 0x28;
    /// Pocket 3 / Nano Photo, which the core folds onto [`PHOTO`].
    pub const PHOTO_POCKET3_NANO: u8 = 0x05;
}

/// ISO indices (`0x02/0x2A`) as the core tables them.
pub mod iso {
    pub const AUTO: u8 = 0x00;
}

/// Colour modes by their semantic id (the Pocket 4 wire byte).
pub mod color {
    pub const NORMAL: u8 = 0x3F;
    pub const HDR: u8 = 0x3C;
    pub const D_LOG: u8 = 0x17;
    pub const D_LOG2: u8 = 0x41;
    pub const NORMAL_10: u8 = 0x3D;
    pub const D_LOG_M: u8 = 0x00;
}

/// Reads text the facade emits, sizing the buffer with a probing call.
#[cfg(opc_core_linked)]
fn text(call: impl Fn(*mut u8, usize) -> i64) -> Option<String> {
    let needed = call(std::ptr::null_mut(), 0);
    if needed <= 0 {
        return None;
    }
    let mut bytes = vec![0u8; needed as usize];
    let written = call(bytes.as_mut_ptr(), bytes.len());
    (written == needed).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

/// Reads a list of ints the facade emits, sizing the buffer with a probing call.
#[cfg(opc_core_linked)]
fn ints(call: impl Fn(*mut i32, usize) -> i32) -> Vec<i32> {
    let needed = call(std::ptr::null_mut(), 0);
    if needed <= 0 {
        return Vec::new();
    }
    let mut out = vec![0i32; needed as usize];
    let written = call(out.as_mut_ptr(), out.len());
    if written != needed {
        return Vec::new();
    }
    out
}

// ---- Shooting modes ----------------------------------------------------------------

/// The `0x02/0xE1` byte this body takes for a tabled mode, or `None` for a byte the
/// core does not table. Photo is `0x05` on a Pocket 3 or Nano and `0x17` on a Pocket 4.
#[cfg(opc_core_linked)]
pub fn mode_wire_byte(raw: u8, model_id: i32) -> Option<u8> {
    // Safety: plain values in.
    let byte = unsafe { opc_core_sys::opc_shooting_mode_wire_byte(i32::from(raw), model_id) };
    u8::try_from(byte).ok()
}

#[cfg(not(opc_core_linked))]
pub fn mode_wire_byte(raw: u8, model_id: i32) -> Option<u8> {
    let tabled = matches!(
        raw,
        mode::SLOW_MO
            | mode::VIDEO
            | mode::TIME_LAPSE
            | mode::PHOTO
            | mode::HYPER_LAPSE
            | mode::LIVE_PHOTO
            | mode::SUPER_NIGHT
            | mode::PHOTO_POCKET3_NANO
    );
    if !tabled {
        return None;
    }
    if raw == mode::PHOTO || raw == mode::PHOTO_POCKET3_NANO {
        return Some(
            if fallback::is_pocket3(model_id) || fallback::is_nano(model_id) {
                mode::PHOTO_POCKET3_NANO
            } else {
                mode::PHOTO
            },
        );
    }
    Some(raw)
}

/// Whether a reported mode is a stills mode: Photo or Live Photo.
#[cfg(opc_core_linked)]
pub fn mode_is_photo(raw: u8) -> bool {
    // Safety: a plain value in.
    unsafe { opc_core_sys::opc_shooting_mode_is_photo(i32::from(raw)) == 1 }
}

#[cfg(not(opc_core_linked))]
pub fn mode_is_photo(raw: u8) -> bool {
    matches!(
        raw,
        mode::PHOTO | mode::PHOTO_POCKET3_NANO | mode::LIVE_PHOTO
    )
}

/// Whether start/stop in this mode is the Pocket 3 shutter trigger rather than record.
#[cfg(opc_core_linked)]
pub fn mode_uses_shutter_trigger(raw: u8, model_id: i32) -> bool {
    // Safety: plain values in.
    unsafe { opc_core_sys::opc_shooting_mode_uses_shutter_trigger(i32::from(raw), model_id) == 1 }
}

#[cfg(not(opc_core_linked))]
pub fn mode_uses_shutter_trigger(raw: u8, model_id: i32) -> bool {
    raw == mode::TIME_LAPSE && fallback::is_pocket3(model_id)
}

/// The mode's name as this body calls it: `Low-Light` on a Pocket 3, `SuperNight`
/// elsewhere. Empty for a byte the core does not table.
#[cfg(opc_core_linked)]
pub fn mode_label(raw: u8, model_id: i32) -> String {
    text(|out, capacity| {
        // Safety: the core writes at most `capacity` bytes into `out`.
        unsafe { opc_core_sys::opc_shooting_mode_label(i32::from(raw), model_id, out, capacity) }
    })
    .unwrap_or_default()
}

#[cfg(not(opc_core_linked))]
pub fn mode_label(raw: u8, model_id: i32) -> String {
    match raw {
        mode::SLOW_MO => "SlowMo",
        mode::VIDEO => "Video",
        mode::TIME_LAPSE => "TimeLapse",
        mode::PHOTO | mode::PHOTO_POCKET3_NANO => "Photo",
        mode::LIVE_PHOTO => "Live Photo",
        mode::HYPER_LAPSE => "HyperLapse",
        mode::SUPER_NIGHT if fallback::is_pocket3(model_id) => "Low-Light",
        mode::SUPER_NIGHT => "SuperNight",
        _ => "",
    }
    .to_string()
}

// ---- Video formats -------------------------------------------------------------------

/// Frames per second for a `0x02/0x18` rate index, from the core's table.
#[cfg(opc_core_linked)]
pub fn frame_rate_fps(index: u8) -> Option<u32> {
    // Safety: a plain value in.
    let fps = unsafe { opc_core_sys::opc_frame_rate_fps(i32::from(index)) };
    (fps > 0).then_some(fps as u32)
}

#[cfg(not(opc_core_linked))]
pub fn frame_rate_fps(index: u8) -> Option<u32> {
    Some(match index {
        0x01 => 24,
        0x02 => 25,
        0x03 => 30,
        0x04 => 48,
        0x05 => 50,
        0x06 => 60,
        0x07 => 120,
        0x08 => 240,
        0x0A => 100,
        0x0B => 96,
        0x13 => 200,
        0x1D => 15,
        _ => return None,
    })
}

/// The resolution's name with its aspect when not 16:9: `1080p`, `2.7K 4:3`, `3K 1:1`.
#[cfg(opc_core_linked)]
pub fn resolution_label(code: u8) -> String {
    text(|out, capacity| {
        // Safety: the core writes at most `capacity` bytes into `out`.
        unsafe { opc_core_sys::opc_resolution_label(i32::from(code), out, capacity) }
    })
    .unwrap_or_else(|| format!("0x{code:02X}"))
}

#[cfg(not(opc_core_linked))]
pub fn resolution_label(code: u8) -> String {
    let size = match code {
        0x0A | 0x0C | 0x42 | 0x69 => "1080p",
        0x2D | 0x43 | 0x5F => "2.7K",
        0x10 | 0x67 | 0x7D => "4K",
        0x6A => "2160p",
        0x6B | 0x6C => "3K",
        _ => return format!("0x{code:02X}"),
    };
    match code {
        0x0C | 0x5F | 0x67 => format!("{size} 4:3"),
        0x69 | 0x6A | 0x6B | 0x7D => format!("{size} 1:1"),
        0x42 | 0x43 | 0x6C => format!("{size} 9:16"),
        _ => size.to_string(),
    }
}

/// The top-deck chip for a pair: `4K · 25p`.
#[cfg(opc_core_linked)]
pub fn format_chip(format: Format) -> String {
    text(|out, capacity| {
        // Safety: the core writes at most `capacity` bytes into `out`.
        unsafe {
            opc_core_sys::opc_format_chip_label(
                i32::from(format.0),
                i32::from(format.1),
                out,
                capacity,
            )
        }
    })
    .unwrap_or_default()
}

#[cfg(not(opc_core_linked))]
pub fn format_chip(format: Format) -> String {
    let rate = frame_rate_fps(format.1)
        .map(|fps| format!("{fps}p"))
        .unwrap_or_else(|| format!("{:02X}p", format.1));
    format!("{} · {rate}", resolution_label(format.0))
}

/// The pairs the FORMAT sheet offers: the body's `camcap_video_format` when it sent
/// one, else the documented Pocket 3 table for this shooting mode, else nothing.
#[cfg(opc_core_linked)]
pub fn format_picker(available: &[Format], model_id: i32, shooting_mode: i32) -> Vec<Format> {
    let flat = flatten(available);
    let call = |out: *mut i32, capacity: usize| {
        // Safety: `flat` outlives the call; the core writes at most `capacity` ints.
        unsafe {
            opc_core_sys::opc_format_picker(
                flat.as_ptr(),
                available.len(),
                model_id,
                shooting_mode,
                out,
                capacity,
            )
        }
    };
    // The probe reports pairs; the buffer holds two ints per pair.
    let pairs = call(std::ptr::null_mut(), 0);
    if pairs <= 0 {
        return Vec::new();
    }
    let mut buffer = vec![0i32; pairs as usize * 2];
    if call(buffer.as_mut_ptr(), buffer.len()) != pairs {
        return Vec::new();
    }
    buffer
        .chunks(2)
        .map(|pair| (pair[0] as u8, pair[1] as u8))
        .collect()
}

#[cfg(not(opc_core_linked))]
pub fn format_picker(available: &[Format], model_id: i32, shooting_mode: i32) -> Vec<Format> {
    if !available.is_empty() {
        return available.to_vec();
    }
    if !fallback::is_pocket3(model_id) {
        return Vec::new();
    }
    let video_rates = [0x01u8, 0x02, 0x03, 0x04, 0x05, 0x06];
    match u8::try_from(shooting_mode).ok() {
        Some(mode::VIDEO) => [0x0Au8, 0x2D, 0x10, 0x69, 0x6A, 0x6B]
            .iter()
            .flat_map(|res| video_rates.iter().map(move |rate| (*res, *rate)))
            .collect(),
        Some(mode::SLOW_MO) => vec![
            (0x10, 0x0A),
            (0x10, 0x07),
            (0x2D, 0x07),
            (0x0A, 0x07),
            (0x0A, 0x08),
        ],
        Some(mode::SUPER_NIGHT) => [0x0Au8, 0x10]
            .iter()
            .flat_map(|res| [0x01u8, 0x02, 0x03].iter().map(move |rate| (*res, *rate)))
            .collect(),
        _ => Vec::new(),
    }
}

/// Whether the operator may SET this pair: it has to be one the picker lists.
pub fn format_allows_set(
    format: Format,
    available: &[Format],
    model_id: i32,
    shooting_mode: i32,
) -> bool {
    format_picker(available, model_id, shooting_mode).contains(&format)
}

#[cfg(opc_core_linked)]
fn flatten(pairs: &[Format]) -> Vec<i32> {
    pairs
        .iter()
        .flat_map(|(res, fps)| [i32::from(*res), i32::from(*fps)])
        .collect()
}

// ---- Exposure ladders ----------------------------------------------------------------

/// The ISO wheel: the body's `camcap_iso` list when it published one, else the indices
/// Mimo offers in this colour, Auto first where the colour has it.
#[cfg(opc_core_linked)]
pub fn iso_indices(color_mode: u8, available: &[u8]) -> Vec<u8> {
    let published: Vec<i32> = available.iter().map(|index| i32::from(*index)).collect();
    ints(|out, capacity| {
        // Safety: `published` outlives the call; the core writes at most `capacity` ints.
        unsafe {
            opc_core_sys::opc_iso_indices(
                i32::from(color_mode),
                published.as_ptr(),
                published.len(),
                out,
                capacity,
            )
        }
    })
    .into_iter()
    .map(|index| index as u8)
    .collect()
}

#[cfg(not(opc_core_linked))]
pub fn iso_indices(color_mode: u8, available: &[u8]) -> Vec<u8> {
    if !available.is_empty() {
        return available.to_vec();
    }
    match color_mode {
        color::D_LOG2 => vec![0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
        color::D_LOG => vec![0x00, 0x05, 0x06, 0x07, 0x08, 0x09],
        _ => vec![0x00, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B],
    }
}

/// The ISO number for an index, `Some(0)` for Auto, `None` when not tabled.
#[cfg(opc_core_linked)]
pub fn iso_index_value(index: u8) -> Option<u32> {
    // Safety: a plain value in.
    let value = unsafe { opc_core_sys::opc_iso_index_value(i32::from(index)) };
    (value >= 0).then_some(value as u32)
}

#[cfg(not(opc_core_linked))]
pub fn iso_index_value(index: u8) -> Option<u32> {
    Some(match index {
        0x00 => 0,
        0x03 => 100,
        0x04 => 200,
        0x05 => 400,
        0x06 => 800,
        0x07 => 1600,
        0x08 => 3200,
        0x09 => 6400,
        0x0A => 12800,
        0x0B => 25600,
        _ => return None,
    })
}

/// The wheel label for an ISO index: the number, or `Auto`.
pub fn iso_index_label(index: u8) -> String {
    match iso_index_value(index) {
        Some(0) => "Auto".to_string(),
        Some(value) => value.to_string(),
        None => format!("0x{index:02X}"),
    }
}

/// The Auto ISO floor in this colour on this body, or `None` when the colour has no
/// Auto ISO (D-Log2).
#[cfg(opc_core_linked)]
pub fn iso_auto_base(color_mode: u8, model_id: i32) -> Option<u32> {
    // Safety: plain values in.
    let base = unsafe { opc_core_sys::opc_iso_auto_base(i32::from(color_mode), model_id) };
    (base > 0).then_some(base as u32)
}

#[cfg(not(opc_core_linked))]
pub fn iso_auto_base(color_mode: u8, model_id: i32) -> Option<u32> {
    match color_mode {
        color::D_LOG2 => None,
        color::D_LOG => Some(400),
        _ => Some(fallback::iso_auto_floor(model_id)),
    }
}

/// The `0x02/0x8E` pid `0x000F` ceiling codes this colour accepts.
#[cfg(opc_core_linked)]
pub fn iso_auto_limits(color_mode: u8) -> Vec<u8> {
    ints(|out, capacity| {
        // Safety: the core writes at most `capacity` ints into `out`.
        unsafe { opc_core_sys::opc_iso_auto_limits(i32::from(color_mode), out, capacity) }
    })
    .into_iter()
    .map(|limit| limit as u8)
    .collect()
}

#[cfg(not(opc_core_linked))]
pub fn iso_auto_limits(color_mode: u8) -> Vec<u8> {
    match color_mode {
        color::D_LOG2 => Vec::new(),
        color::D_LOG => vec![0x04, 0x05, 0x06, 0x07],
        _ => vec![0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09],
    }
}

/// The label for a ceiling code in this colour on this body: `50–1600`.
#[cfg(opc_core_linked)]
pub fn iso_auto_limit_label(limit: u8, color_mode: u8, model_id: i32) -> String {
    text(|out, capacity| {
        // Safety: the core writes at most `capacity` bytes into `out`.
        unsafe {
            opc_core_sys::opc_iso_auto_limit_label(
                i32::from(limit),
                i32::from(color_mode),
                model_id,
                out,
                capacity,
            )
        }
    })
    .unwrap_or_default()
}

#[cfg(not(opc_core_linked))]
pub fn iso_auto_limit_label(limit: u8, color_mode: u8, model_id: i32) -> String {
    let Some(base) = iso_auto_base(color_mode, model_id) else {
        return String::new();
    };
    if !(0x02..=0x09).contains(&limit) {
        return String::new();
    }
    let ceiling = 100u32 << (limit - 1);
    format!("{base}–{ceiling}")
}

/// The shutter wheel: the body's `camcap_shutter` list when it published one, else the
/// documented video ladder with the live 1/N merged in so it stays visible.
#[cfg(opc_core_linked)]
pub fn shutter_wheel(available: &[i32], current: Option<i32>) -> Vec<i32> {
    ints(|out, capacity| {
        // Safety: `available` outlives the call; the core writes at most `capacity` ints.
        unsafe {
            opc_core_sys::opc_shutter_wheel(
                available.as_ptr(),
                available.len(),
                current.unwrap_or(0),
                out,
                capacity,
            )
        }
    })
}

#[cfg(not(opc_core_linked))]
pub fn shutter_wheel(available: &[i32], current: Option<i32>) -> Vec<i32> {
    if !available.is_empty() {
        return available.to_vec();
    }
    let mut ladder = vec![
        8000, 6400, 4000, 3200, 2000, 1600, 1000, 800, 500, 400, 250, 200, 125, 120, 100, 60, 50,
        48, 40, 30, 25, 24,
    ];
    if let Some(current) = current.filter(|denom| (1..=16_000).contains(denom)) {
        if !ladder.contains(&current) {
            match ladder.iter().position(|denom| *denom < current) {
                Some(index) => ladder.insert(index, current),
                None => ladder.push(current),
            }
        }
    }
    ladder
}

/// The shutter-angle stops the phones offer, in degrees.
#[cfg(opc_core_linked)]
pub fn shutter_angles() -> Vec<f64> {
    // Safety: a probe with a null destination only reports the count.
    let needed = unsafe { opc_core_sys::opc_shutter_angles(std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Vec::new();
    }
    let mut out = vec![0.0f64; needed as usize];
    // Safety: `out` has exactly the capacity the core asked for.
    let written = unsafe { opc_core_sys::opc_shutter_angles(out.as_mut_ptr(), out.len()) };
    if written != needed {
        return Vec::new();
    }
    out
}

#[cfg(not(opc_core_linked))]
pub fn shutter_angles() -> Vec<f64> {
    vec![
        5.6, 11.2, 22.5, 45.0, 72.0, 86.4, 90.0, 108.0, 144.0, 172.0, 180.0, 216.0, 288.0, 346.0,
        360.0,
    ]
}

/// The 1/N that gives `degrees` at `fps`, snapped to the body's published list when it
/// sent one. An unknown rate counts as 24, as on the phones.
#[cfg(opc_core_linked)]
pub fn shutter_angle_denom(degrees: f64, fps: i32, available: &[i32]) -> i32 {
    // Safety: `available` outlives the call.
    unsafe {
        opc_core_sys::opc_shutter_angle_denom(degrees, fps, available.as_ptr(), available.len())
    }
}

#[cfg(not(opc_core_linked))]
pub fn shutter_angle_denom(degrees: f64, fps: i32, available: &[i32]) -> i32 {
    let rate = f64::from(effective_fps(fps));
    let ideal = ((360.0 * rate / degrees.max(0.1)).round() as i32).clamp(1, 16_000);
    available
        .iter()
        .copied()
        .min_by_key(|denom| (denom - ideal).abs())
        .unwrap_or(ideal)
}

/// The angle a 1/N reads as at `fps`, snapped to the phones' stops: `180°`.
#[cfg(opc_core_linked)]
pub fn shutter_angle_label(denom: i32, fps: i32) -> String {
    text(|out, capacity| {
        // Safety: the core writes at most `capacity` bytes into `out`.
        unsafe { opc_core_sys::opc_shutter_angle_label(denom, fps, out, capacity) }
    })
    .unwrap_or_default()
}

#[cfg(not(opc_core_linked))]
pub fn shutter_angle_label(denom: i32, fps: i32) -> String {
    let degrees = if denom > 0 {
        360.0 * f64::from(effective_fps(fps)) / f64::from(denom)
    } else {
        180.0
    };
    let nearest = shutter_angles()
        .into_iter()
        .min_by(|a, b| (a - degrees).abs().total_cmp(&(b - degrees).abs()))
        .unwrap_or(180.0);
    angle_label(nearest)
}

#[cfg(not(opc_core_linked))]
fn effective_fps(fps: i32) -> i32 {
    if (8..=240).contains(&fps) {
        fps
    } else {
        24
    }
}

/// `180°`, or `86.4°` when the stop is not whole.
pub fn angle_label(degrees: f64) -> String {
    if (degrees - degrees.round()).abs() < 0.05 {
        format!("{}°", degrees.round() as i32)
    } else {
        format!("{degrees:.1}°")
    }
}

/// EV as the operator reads it: `0.0`, `+1.0`, `−1.3` (a proper minus sign).
#[cfg(opc_core_linked)]
pub fn ev_label(thirds: i32) -> String {
    text(|out, capacity| {
        // Safety: the core writes at most `capacity` bytes into `out`.
        unsafe { opc_core_sys::opc_ev_label(thirds, out, capacity) }
    })
    .unwrap_or_default()
}

#[cfg(not(opc_core_linked))]
pub fn ev_label(thirds: i32) -> String {
    let thirds = thirds.clamp(-9, 9);
    if thirds == 0 {
        return "0.0".to_string();
    }
    let sign = if thirds > 0 { "+" } else { "\u{2212}" };
    let magnitude = thirds.unsigned_abs();
    let fraction = [".0", ".3", ".7"][(magnitude % 3) as usize];
    format!("{sign}{}{fraction}", magnitude / 3)
}

// ---- Colour --------------------------------------------------------------------------

/// The colour wheel for this body in Mimo's order, subset to what the body published
/// when it published anything. Semantic ids, not the Pocket 3 / Nano wire bytes.
#[cfg(opc_core_linked)]
pub fn color_modes(model_id: i32, available: &[u8]) -> Vec<u8> {
    let published: Vec<i32> = available.iter().map(|mode| i32::from(*mode)).collect();
    ints(|out, capacity| {
        // Safety: `published` outlives the call; the core writes at most `capacity` ints.
        unsafe {
            opc_core_sys::opc_color_modes(
                model_id,
                published.as_ptr(),
                published.len(),
                out,
                capacity,
            )
        }
    })
    .into_iter()
    .map(|mode| mode as u8)
    .collect()
}

#[cfg(not(opc_core_linked))]
pub fn color_modes(model_id: i32, available: &[u8]) -> Vec<u8> {
    let order: Vec<u8> = if fallback::is_nano(model_id) {
        vec![color::NORMAL, color::NORMAL_10, color::D_LOG_M]
    } else if fallback::is_pocket4_pro(model_id) {
        vec![color::NORMAL, color::HDR, color::D_LOG, color::D_LOG2]
    } else if fallback::is_pocket3(model_id) {
        vec![color::NORMAL, color::HDR, color::D_LOG_M]
    } else {
        vec![color::NORMAL, color::HDR, color::D_LOG]
    };
    if available.is_empty() {
        return order;
    }
    let ranked: Vec<u8> = order
        .iter()
        .copied()
        .filter(|mode| available.contains(mode))
        .collect();
    if ranked.is_empty() {
        order
    } else {
        ranked
    }
}

/// The colour's name on this body: `Normal 8-bit` on a Nano, `D-Log M` on a Pocket 3.
#[cfg(opc_core_linked)]
pub fn color_mode_label(mode: u8, model_id: i32) -> String {
    text(|out, capacity| {
        // Safety: the core writes at most `capacity` bytes into `out`.
        unsafe { opc_core_sys::opc_color_mode_label(i32::from(mode), model_id, out, capacity) }
    })
    .unwrap_or_default()
}

#[cfg(not(opc_core_linked))]
pub fn color_mode_label(mode: u8, model_id: i32) -> String {
    match mode {
        color::NORMAL if fallback::is_nano(model_id) => "Normal 8-bit",
        color::NORMAL => "Normal",
        color::HDR => "HDR",
        color::D_LOG => "D-Log",
        color::D_LOG2 => "D-Log2",
        color::NORMAL_10 => "Normal 10-bit",
        color::D_LOG_M if fallback::is_pocket3(model_id) => "D-Log M",
        color::D_LOG_M => "D-Log M 10-bit",
        _ => "",
    }
    .to_string()
}

/// Body identities by BLE model id, for the stand-in tables. The core resolves these
/// from the id and the advertised name; the stand-in only knows the ids.
#[cfg(not(opc_core_linked))]
mod fallback {
    pub fn is_pocket3(model_id: i32) -> bool {
        model_id == 0x0020
    }

    pub fn is_pocket4(model_id: i32) -> bool {
        model_id == 0x0021
    }

    pub fn is_pocket4_pro(model_id: i32) -> bool {
        model_id == 0x0022
    }

    pub fn is_nano(model_id: i32) -> bool {
        model_id == 0x0019
    }

    /// Rec.709 Auto ISO floor: Pocket 3 and Pocket 4 start at 50, everyone else at 100.
    pub fn iso_auto_floor(model_id: i32) -> u32 {
        if is_pocket3(model_id) || is_pocket4(model_id) {
            50
        } else {
            100
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chip_reads_size_and_rate_the_way_the_phones_do() {
        assert_eq!(format_chip((0x10, 0x02)), "4K · 25p");
        assert_eq!(format_chip((0x6B, 0x06)), "3K 1:1 · 60p");
        assert_eq!(frame_rate_fps(0x13), Some(200));
    }

    #[test]
    fn a_pocket_3_gets_its_documented_video_table_when_the_body_sent_none() {
        let video = format_picker(&[], 0x20, i32::from(mode::VIDEO));
        assert!(video.contains(&(0x10, 0x02)), "4K 25 is documented");
        assert!(
            !video.contains(&(0x42, 0x02)),
            "no portrait SET was ever accepted"
        );
        let slow = format_picker(&[], 0x20, i32::from(mode::SLOW_MO));
        assert_eq!(slow.len(), 5);
        assert!(format_allows_set(
            (0x0A, 0x08),
            &[],
            0x20,
            i32::from(mode::SLOW_MO)
        ));
        assert!(!format_allows_set(
            (0x10, 0x08),
            &[],
            0x20,
            i32::from(mode::SLOW_MO)
        ));
    }

    #[test]
    fn other_bodies_never_get_an_invented_table() {
        assert!(format_picker(&[], 0x22, i32::from(mode::VIDEO)).is_empty());
        assert!(!format_allows_set(
            (0x10, 0x02),
            &[],
            0x22,
            i32::from(mode::VIDEO)
        ));
        // What the body published always wins.
        assert_eq!(
            format_picker(&[(0x10, 0x03)], 0x20, i32::from(mode::VIDEO)),
            vec![(0x10, 0x03)]
        );
    }

    #[test]
    fn photo_goes_out_as_the_body_s_own_byte() {
        assert_eq!(mode_wire_byte(mode::PHOTO, 0x20), Some(0x05), "Pocket 3");
        assert_eq!(mode_wire_byte(mode::PHOTO, 0x19), Some(0x05), "Nano");
        assert_eq!(
            mode_wire_byte(mode::PHOTO, 0x22),
            Some(0x17),
            "Pocket 4 Pro"
        );
        assert_eq!(mode_wire_byte(0x0C, 0x22), None, "Pano is not tabled");
        assert!(mode_is_photo(mode::LIVE_PHOTO));
        assert!(!mode_is_photo(mode::SUPER_NIGHT), "Low-Light is video");
        assert_eq!(mode_label(mode::SUPER_NIGHT, 0x20), "Low-Light");
        assert_eq!(mode_label(mode::SUPER_NIGHT, 0x22), "SuperNight");
    }

    #[test]
    fn the_iso_ladder_follows_the_colour() {
        let normal = iso_indices(color::NORMAL, &[]);
        assert_eq!(normal[0], iso::AUTO);
        assert_eq!(normal.len(), 10);
        let dlog2 = iso_indices(color::D_LOG2, &[]);
        assert!(!dlog2.contains(&iso::AUTO), "D-Log2 has no Auto ISO");
        assert_eq!(
            iso_indices(color::D_LOG, &[]),
            [0x00, 0x05, 0x06, 0x07, 0x08, 0x09]
        );
        assert_eq!(iso_indices(color::NORMAL, &[0x03, 0x04]), [0x03, 0x04]);
        assert_eq!(iso_index_label(0x00), "Auto");
        assert_eq!(iso_index_label(0x07), "1600");
    }

    #[test]
    fn auto_iso_labels_start_at_the_body_s_floor() {
        assert_eq!(iso_auto_limit_label(0x05, color::NORMAL, 0x20), "50–1600");
        assert_eq!(iso_auto_limit_label(0x05, color::NORMAL, 0x22), "100–1600");
        assert_eq!(iso_auto_limit_label(0x04, color::D_LOG, 0x22), "400–800");
        assert_eq!(iso_auto_limits(color::D_LOG2), Vec::<u8>::new());
        assert_eq!(iso_auto_base(color::D_LOG2, 0x22), None);
    }

    #[test]
    fn the_shutter_wheel_keeps_the_live_value_visible() {
        let wheel = shutter_wheel(&[], Some(90));
        assert_eq!(wheel.len(), 23);
        let at = wheel.iter().position(|d| *d == 90).expect("merged in");
        assert!(wheel[at - 1] > 90 && wheel[at + 1] < 90, "in camera order");
        assert_eq!(shutter_wheel(&[50, 100], Some(90)), [50, 100]);
    }

    #[test]
    fn shutter_angles_convert_at_the_rate_and_snap_to_the_body_s_list() {
        assert_eq!(shutter_angles().len(), 15);
        assert_eq!(shutter_angle_denom(180.0, 25, &[]), 50);
        assert_eq!(shutter_angle_denom(180.0, 0, &[]), 48, "unknown rate is 24");
        assert_eq!(
            shutter_angle_denom(180.0, 25, &[48, 60]),
            48,
            "nearest published"
        );
        assert_eq!(shutter_angle_label(50, 25), "180°");
        assert_eq!(shutter_angle_label(100, 25), "90°");
        assert_eq!(angle_label(86.4), "86.4°");
    }

    #[test]
    fn ev_reads_with_a_real_minus_sign() {
        assert_eq!(ev_label(0), "0.0");
        assert_eq!(ev_label(3), "+1.0");
        assert_eq!(ev_label(-4), "\u{2212}1.3");
        assert_eq!(ev_label(2), "+0.7");
    }

    #[test]
    fn the_colour_wheel_is_the_body_s_own() {
        assert_eq!(color_modes(0x22, &[]), [0x3F, 0x3C, 0x17, 0x41]);
        assert_eq!(color_modes(0x21, &[]), [0x3F, 0x3C, 0x17]);
        assert_eq!(color_modes(0x20, &[]), [0x3F, 0x3C, 0x00]);
        assert_eq!(color_modes(0x19, &[]), [0x3F, 0x3D, 0x00]);
        // The body may subset its wheel, never extend it.
        assert_eq!(color_modes(0x22, &[0x17, 0x41]), [0x17, 0x41]);
        assert_eq!(color_modes(0x21, &[0x41]), [0x3F, 0x3C, 0x17]);
        assert_eq!(color_mode_label(0x00, 0x20), "D-Log M");
        assert_eq!(color_mode_label(0x3F, 0x19), "Normal 8-bit");
    }
}
