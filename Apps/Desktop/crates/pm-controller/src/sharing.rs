//! Sharing this PC's camera preview with watchers (the old viewfinder's *Share this feed*,
//! `opc-monitor` `view.rs` `share_preview`, main af91c5b): the rules for when a share may
//! start, what stops it, and the words the operator reads. The host itself is
//! `opc_relay::host::Host`; the Tauri app feeds it from the session thread.
//!
//! The rules are the old window's, unchanged:
//!
//! - A share starts only on a live HEVC camera feed: not on a phone's feed, not while the
//!   library or the player has the camera in playback, not before the decoder has latched
//!   HEVC, and only once the link knows the camera's address (the host advertises on the
//!   interface that reaches it).
//! - It stops when the camera reconnects or disconnects, when the feed turns H.264, when
//!   media playback starts (the app's or the body's own), and when the relay falls behind
//!   or fails, each with its own line.
//! - It is view-only, has no passcode, takes up to four watchers, forwards the camera's own
//!   HEVC (no second live-view request, no re-encode: a new watcher waits for the next
//!   camera keyframe) and starts off at every launch.

use std::net::SocketAddr;

use serde::Serialize;

/// What the readout says while the share runs.
pub const ACTIVE: &str = "On · View only";
/// What it says when the operator turned it off, or it never ran.
pub const OFF: &str = "Off";
pub const NEEDS_HEVC: &str = "Open a live HEVC camera feed to share it";
pub const NEEDS_CAMERA: &str = "Open a live camera feed to share it";
pub const RECONNECTED: &str = "Sharing stopped when the camera reconnected";
pub const DISCONNECTED: &str = "Sharing stopped when the camera disconnected";
pub const PLAYBACK: &str = "Sharing stopped for camera playback";
pub const FEED_CHANGED: &str = "Sharing stopped when the live HEVC feed changed";
pub const FELL_BEHIND: &str = "Sharing stopped because the relay fell behind";

/// The host could not be started.
pub fn could_not_start(error: impl std::fmt::Display) -> String {
    format!("Could not start sharing: {error}")
}

/// The host stopped by itself and said why.
pub fn stopped_by(error: impl std::fmt::Display) -> String {
    format!("Sharing stopped: {error}")
}

/// The host refused a picture: its queue was full, or it had already failed.
pub fn refused(error: Option<String>) -> String {
    error.map_or_else(|| FELL_BEHIND.to_string(), stopped_by)
}

/// What a share-preview request looks at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Feed {
    /// The picture is a phone's shared feed, not this PC's camera.
    pub watching_phone: bool,
    /// The library, the player or the resume loop has the camera in playback.
    pub media_active: bool,
    /// The link is live (the first picture has been shown).
    pub live: bool,
    /// The decoder latched HEVC.
    pub hevc: bool,
    /// Where the open link reaches the camera.
    pub camera: Option<SocketAddr>,
}

/// Whether a share may start, and on which camera's interface. The refusal is the line the
/// readout shows instead.
pub fn may_start(feed: &Feed) -> Result<SocketAddr, &'static str> {
    if feed.watching_phone || feed.media_active || !feed.live || !feed.hevc {
        return Err(NEEDS_HEVC);
    }
    feed.camera.ok_or(NEEDS_CAMERA)
}

/// What one access unit from the camera does to a running share: `Some(reason)` stops
/// it before the unit is offered.
pub fn picture_stops(media_active: bool, unit_is_h264: bool) -> Option<&'static str> {
    (media_active || unit_is_h264).then_some(FEED_CHANGED)
}

/// A status report from the body: playback on the camera stops the share.
pub fn status_stops(in_playback: bool) -> Option<&'static str> {
    in_playback.then_some(PLAYBACK)
}

/// `sharing://status`, and what `sharing_set` / `sharing_state` answer. Never carries
/// anything about the watchers but how many there are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingStatus {
    /// The host is running.
    pub active: bool,
    /// [`ACTIVE`], [`OFF`], or why it is not running.
    pub status: String,
    /// Watchers connected right now.
    pub watchers: usize,
    /// The share stopped by itself (not the operator's Off): the web shows `status` as a
    /// notice.
    pub stopped: bool,
}

impl Default for SharingStatus {
    fn default() -> Self {
        Self {
            active: false,
            status: OFF.to_string(),
            watchers: 0,
            stopped: false,
        }
    }
}

impl SharingStatus {
    pub fn running(watchers: usize) -> Self {
        Self {
            active: true,
            status: ACTIVE.to_string(),
            watchers,
            stopped: false,
        }
    }

    /// Not running, because of `reason`. A reason other than [`OFF`] or a refused start
    /// is a stop the operator did not ask for.
    pub fn idle(reason: &str, stopped: bool) -> Self {
        Self {
            active: false,
            status: reason.to_string(),
            watchers: 0,
            stopped: stopped && reason != OFF,
        }
    }
}

/// The live-view notice for a stop the operator did not ask for, in the notices' capitals.
pub fn notice(status: &SharingStatus) -> Option<String> {
    status.stopped.then(|| status.status.to_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_hevc() -> Feed {
        Feed {
            watching_phone: false,
            media_active: false,
            live: true,
            hevc: true,
            camera: Some("192.168.2.1:9004".parse().unwrap()),
        }
    }

    #[test]
    fn a_share_starts_only_on_a_live_hevc_camera_feed() {
        assert_eq!(
            may_start(&live_hevc()),
            Ok("192.168.2.1:9004".parse().unwrap())
        );
        for feed in [
            Feed {
                watching_phone: true,
                ..live_hevc()
            },
            Feed {
                media_active: true,
                ..live_hevc()
            },
            Feed {
                live: false,
                ..live_hevc()
            },
            Feed {
                hevc: false,
                ..live_hevc()
            },
        ] {
            assert_eq!(may_start(&feed), Err(NEEDS_HEVC), "{feed:?}");
        }
        assert_eq!(
            may_start(&Feed {
                camera: None,
                ..live_hevc()
            }),
            Err(NEEDS_CAMERA)
        );
    }

    #[test]
    fn h264_or_playback_stops_a_running_share() {
        assert_eq!(picture_stops(false, false), None);
        assert_eq!(picture_stops(false, true), Some(FEED_CHANGED));
        assert_eq!(picture_stops(true, false), Some(FEED_CHANGED));
        assert_eq!(status_stops(false), None);
        assert_eq!(status_stops(true), Some(PLAYBACK));
    }

    #[test]
    fn a_refused_picture_says_why_or_that_the_relay_fell_behind() {
        assert_eq!(refused(None), FELL_BEHIND);
        assert_eq!(
            refused(Some("Broken pipe".into())),
            "Sharing stopped: Broken pipe"
        );
        assert_eq!(
            could_not_start("no route"),
            "Could not start sharing: no route"
        );
    }

    #[test]
    fn only_a_stop_the_operator_did_not_ask_for_is_a_notice() {
        assert_eq!(notice(&SharingStatus::running(2)), None);
        assert_eq!(notice(&SharingStatus::idle(OFF, true)), None);
        assert_eq!(notice(&SharingStatus::idle(NEEDS_HEVC, false)), None);
        assert_eq!(
            notice(&SharingStatus::idle(DISCONNECTED, true)).as_deref(),
            Some("SHARING STOPPED WHEN THE CAMERA DISCONNECTED")
        );
        let json = serde_json::to_value(SharingStatus::running(3)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "active": true,
                "status": "On · View only",
                "watchers": 3,
                "stopped": false
            })
        );
    }
}
