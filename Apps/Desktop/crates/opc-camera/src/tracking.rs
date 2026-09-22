//! What the body says about the subject it is following, read by the core.

/// A `0x02/0xA5` poll reply.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrackingPoll {
    /// Nothing is being followed.
    Idle,
    /// Locked on; with the subject's box as picture fractions when the body sent one.
    Locked(Option<(f32, f32, f32, f32)>),
}

/// Reads a poll reply through the core. `None` for a payload it does not recognise,
/// or without the core linked.
#[cfg(opc_core_linked)]
pub fn tracking_poll(payload: &[u8]) -> Option<TrackingPoll> {
    use opc_core_sys as sys;
    let mut out = [0.0_f32; 4];
    // Safety: the slice outlives the call and `out` has the four slots the core writes.
    let code = unsafe { sys::opc_tracking_poll(payload.as_ptr(), payload.len(), out.as_mut_ptr()) };
    match code {
        sys::OPC_TRACKING_IDLE => Some(TrackingPoll::Idle),
        sys::OPC_TRACKING_LOCKED => Some(TrackingPoll::Locked(None)),
        sys::OPC_TRACKING_LOCKED_BOX => {
            Some(TrackingPoll::Locked(Some((out[0], out[1], out[2], out[3]))))
        }
        _ => None,
    }
}

#[cfg(not(opc_core_linked))]
pub fn tracking_poll(_payload: &[u8]) -> Option<TrackingPoll> {
    None
}

/// A box on the sensor as picture fractions: top-left `x, y`, then `width, height`.
pub type Box4 = (f32, f32, f32, f32);

/// The core's tracking rules: the shortest side Mimo still SETs, how long an operator
/// clear ignores leftover pushes, the silence that means the body dropped the lock, and
/// the easing constants for the painted box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrackingRules {
    pub minimum_side: f64,
    pub clear_ignore_seconds: f64,
    pub push_silence_seconds: f64,
    pub position_time_constant: f64,
    pub size_time_constant: f64,
}

impl TrackingRules {
    /// The numbers from `TrackingBox`, `TrackingClearPolicy` and `TrackingBoxSmoothing`
    /// in the core, for a build without it.
    const CORE: Self = Self {
        minimum_side: 0.09,
        clear_ignore_seconds: 0.28,
        push_silence_seconds: 0.35,
        position_time_constant: 0.10,
        size_time_constant: 0.42,
    };
}

#[cfg(opc_core_linked)]
pub fn tracking_rules() -> TrackingRules {
    let mut out = opc_core_sys::OpcTrackingRules::default();
    // Safety: `out` is a record of the layout the core writes.
    if unsafe { opc_core_sys::opc_tracking_rules(&mut out) } != opc_core_sys::OPC_RELAY_OK {
        return TrackingRules::CORE;
    }
    TrackingRules {
        minimum_side: out.minimum_side,
        clear_ignore_seconds: out.clear_ignore_seconds,
        push_silence_seconds: out.push_silence_seconds,
        position_time_constant: out.position_time_constant,
        size_time_constant: out.size_time_constant,
    }
}

#[cfg(not(opc_core_linked))]
pub fn tracking_rules() -> TrackingRules {
    TrackingRules::CORE
}

/// Reads a `0x02/0x89` live push: where the body says the subject is, ~15 Hz while it
/// has one. `None` for anything else, or without the core linked.
#[cfg(opc_core_linked)]
pub fn tracking_live_push(payload: &[u8]) -> Option<Box4> {
    let mut out = [0.0_f32; 4];
    // Safety: the slice outlives the call and `out` has the four slots the core writes.
    let hit = unsafe {
        opc_core_sys::opc_tracking_live_push(payload.as_ptr(), payload.len(), out.as_mut_ptr())
    };
    (hit == 1).then_some((out[0], out[1], out[2], out[3]))
}

#[cfg(not(opc_core_linked))]
pub fn tracking_live_push(_payload: &[u8]) -> Option<Box4> {
    None
}

/// Eases the painted box toward the latest push: centre on the fast constant, size on
/// the slow one, so the subject stays tight while bounding-box flicker settles.
#[cfg(opc_core_linked)]
pub fn tracking_blend(from: Option<Box4>, toward: Box4, dt: f64) -> Box4 {
    let from = from.map(|b| [b.0, b.1, b.2, b.3]);
    let toward = [toward.0, toward.1, toward.2, toward.3];
    let mut out = toward;
    // Safety: every pointer is to a four-float array that outlives the call.
    let code = unsafe {
        opc_core_sys::opc_tracking_blend(
            from.as_ref().map_or(std::ptr::null(), |b| b.as_ptr()),
            toward.as_ptr(),
            dt,
            out.as_mut_ptr(),
        )
    };
    if code != opc_core_sys::OPC_RELAY_OK {
        return (toward[0], toward[1], toward[2], toward[3]);
    }
    (out[0], out[1], out[2], out[3])
}

#[cfg(not(opc_core_linked))]
pub fn tracking_blend(from: Option<Box4>, toward: Box4, dt: f64) -> Box4 {
    let Some(from) = from else {
        return toward;
    };
    if dt <= 0.0 || !dt.is_finite() {
        return toward;
    }
    let rules = TrackingRules::CORE;
    let p = (1.0 - (-dt / rules.position_time_constant.max(0.001)).exp()) as f32;
    let s = (1.0 - (-dt / rules.size_time_constant.max(0.001)).exp()) as f32;
    let centre = |b: Box4| (b.0 + b.2 / 2.0, b.1 + b.3 / 2.0);
    let (fx, fy) = centre(from);
    let (tx, ty) = centre(toward);
    let cx = fx + (tx - fx) * p;
    let cy = fy + (ty - fy) * p;
    let w = (from.2 + (toward.2 - from.2) * s).clamp(0.02, 1.0);
    let h = (from.3 + (toward.3 - from.3) * s).clamp(0.02, 1.0);
    (cx - w / 2.0, cy - h / 2.0, w, h)
}

/// The tighter box drawn at a search rect's centre until the body sends a subject.
#[cfg(opc_core_linked)]
pub fn tracking_subject_stand_in(search: Box4) -> Box4 {
    let search = [search.0, search.1, search.2, search.3];
    let mut out = search;
    // Safety: both pointers are to four-float arrays that outlive the call.
    let code =
        unsafe { opc_core_sys::opc_tracking_subject_stand_in(search.as_ptr(), out.as_mut_ptr()) };
    if code != opc_core_sys::OPC_RELAY_OK {
        return (search[0], search[1], search[2], search[3]);
    }
    (out[0], out[1], out[2], out[3])
}

#[cfg(not(opc_core_linked))]
pub fn tracking_subject_stand_in(search: Box4) -> Box4 {
    let width = (search.2 * 0.45).max(0.05).min(search.2);
    let height = (search.3 * 0.45).max(0.05).min(search.3);
    (
        search.0 + (search.2 - width) / 2.0,
        search.1 + (search.3 - height) / 2.0,
        width,
        height,
    )
}

/// Whether this body takes the tap-to-focus burst. Every Pocket does; the Nano does
/// not. Without the core linked every body is assumed to.
#[cfg(opc_core_linked)]
pub fn supports_tap_focus(model_id: i32) -> bool {
    // Safety: a plain value in.
    unsafe { opc_core_sys::opc_model_supports_tap_focus(model_id) != 0 }
}

#[cfg(not(opc_core_linked))]
pub fn supports_tap_focus(_model_id: i32) -> bool {
    true
}

/// Whether this body has AF-S / AF-C and a focus-track mode. Every Pocket does; the
/// Nano has neither. Without the core linked, the Nano's id is the one exception.
#[cfg(opc_core_linked)]
pub fn supports_focus_mode(model_id: i32) -> bool {
    // Safety: a plain value in.
    unsafe { opc_core_sys::opc_model_supports_focus_mode(model_id) != 0 }
}

#[cfg(not(opc_core_linked))]
pub fn supports_focus_mode(model_id: i32) -> bool {
    model_id != 0x0019
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stand_in_sits_at_the_centre_of_the_search_box() {
        let (x, y, w, h) = tracking_subject_stand_in((0.2, 0.2, 0.4, 0.4));
        assert!((w - 0.18).abs() < 1e-6 && (h - 0.18).abs() < 1e-6);
        assert!((x + w / 2.0 - 0.4).abs() < 1e-6 && (y + h / 2.0 - 0.4).abs() < 1e-6);
    }

    #[test]
    fn the_first_push_lands_and_later_ones_ease_in() {
        let first = tracking_blend(None, (0.1, 0.1, 0.2, 0.2), 0.05);
        assert_eq!(first, (0.1, 0.1, 0.2, 0.2));
        let eased = tracking_blend(Some(first), (0.5, 0.5, 0.2, 0.2), 0.05);
        assert!(eased.0 > 0.1 && eased.0 < 0.5, "part of the way there");
        let settled = tracking_blend(Some(first), (0.5, 0.5, 0.2, 0.2), 5.0);
        assert!(
            (settled.0 - 0.5).abs() < 1e-3,
            "long enough and it is there"
        );
    }
}
