//! Gestures read from the camera's own picture: the operator stands in front of the lens.
//!
//! The old viewfinder's `FeedGestures` (`opc-monitor/src/view.rs`), without the window and
//! without the model thread. The MediaPipe hand models and the YuNet face finder run on
//! [`crate::handnet::HandWorker`]'s thread; whoever owns that worker offers it pictures at
//! [`OFFER_INTERVAL`] ([`FRAME_WIDTH`] across, faces at most every [`FACE_ASK_INTERVAL`]
//! while [`FeedReader::wants_faces`]) and hands its [`Update`]s to [`FeedReader::read`],
//! which turns them into what the live controls carry out: held poses, sweeps and the
//! open-close pulse as [`Gesture`]s, both hands' pinch-and-drag as [`Control`]s, how far a
//! held pose has got, and a face to track.
//!
//! The gimbal moving shifts the whole scene, so sweeps are ignored while it moves and for
//! a moment after; held poses and pinches do not depend on that.
//!
//! [`HandOverlay`] is what the hand view (key `Y`) draws over the picture: every hand's
//! landmarks and box, its pose and role, the pinches being held, and the faces seen, in
//! picture fractions before any mirroring.

use serde::Serialize;

use crate::facenet::Face;
use crate::gesture::{Gesture, GestureAction, GestureMap};
use crate::hand::{
    finger_reach, pinch_ratio, pose_of, Control, Controls, Grab, HandScene, HandView, Holder, Pose,
    Pulse, Role, Sweep, HOLD, PINCH_OFF,
};
use crate::handnet::{Hand, Update};
use crate::moves::Waypoint;

/// A picture is offered to the models about this often; one offered while they are still
/// busy is dropped.
pub const OFFER_INTERVAL: f64 = 1.0 / 20.0;
/// The models read the picture scaled to this many pixels across, in proportion.
pub const FRAME_WIDTH: usize = 480;
/// Faces are asked for at a few a second, not every frame.
pub const FACE_ASK_INTERVAL: f64 = 0.25;
/// Recording takes longer to hold than the rest, so it is never an accident.
pub const RECORD_HOLD: f64 = 2.5;
/// A face a gesture asked for is looked for this long before "NO FACE FOUND".
pub const FACE_WAIT: f64 = 3.0;
/// A face in view this long starts tracking by itself (auto face track).
pub const FACE_SETTLE: f64 = 1.5;
/// After a face a gesture asked for, none is started by itself for this long.
pub const FACE_REST_AFTER_ASKED: f64 = 20.0;
/// After one started by itself, none again for this long: stopping it by hand must not
/// start it again at once.
pub const FACE_REST_AFTER_AUTO: f64 = 30.0;
/// The gimbal turning more than this (degrees) between readings is the scene moving.
const POSE_MOVED: f64 = 0.3;
/// Sweeps are ignored this long after the gimbal moved.
const MOVING_HOLD: f64 = 1.0;
/// Faces in the hand view are dropped once this old.
const FACES_SHOWN_FOR: f64 = 0.6;

/// How long `gesture` has to be held, with this map: recording takes [`RECORD_HOLD`].
pub fn hold_seconds(map: &GestureMap, gesture: Gesture) -> f64 {
    if map.get(gesture) == GestureAction::Record {
        RECORD_HOLD
    } else {
        HOLD
    }
}

/// The box to give the camera for a face: the head with some shoulders, inside the
/// picture. Left, top, width, height as fractions of the picture.
pub fn face_box(face: &Face) -> (f64, f64, f64, f64) {
    let (cx, cy) = (
        f64::from(face.x + face.width / 2.0),
        f64::from(face.y + face.height / 2.0),
    );
    let (w, h) = (f64::from(face.width) * 2.0, f64::from(face.height) * 2.4);
    let x = (cx - w / 2.0).clamp(0.0, 1.0 - w.min(1.0));
    let y = (cy - h * 0.4).clamp(0.0, 1.0 - h.min(1.0));
    (x, y, w.min(1.0), h.min(1.0))
}

/// What the reader needs to know from the live controls each time.
#[derive(Debug, Clone, Copy)]
pub struct Tuning {
    /// What each gesture does, for how long each has to be held.
    pub map: GestureMap,
    pub stick_is_right: bool,
    /// Pinch-and-drag hand control is on.
    pub hand_control: bool,
    /// A gesture just asked for the face to be tracked.
    pub face_requested: bool,
    pub auto_face: bool,
    /// The camera already has something to follow.
    pub tracking: bool,
}

/// What one look came to.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Looked {
    pub gestures: Vec<Gesture>,
    pub controls: Vec<Control>,
    /// Seconds since the controls were last read, for the zoom rate.
    pub dt: f64,
    /// A held pose part-way to firing.
    pub progress: Option<(Gesture, f32)>,
    /// A face to track, as left, top, width, height of the picture.
    pub face: Option<(f64, f64, f64, f64)>,
    /// A face was asked for and none was found.
    pub no_face: bool,
}

/// The hands and faces in the camera's picture, as the live controls read them.
#[derive(Debug)]
pub struct FeedReader {
    holder: Holder,
    sweep: Sweep,
    pulse: Pulse,
    controls: Controls,
    last_read: f64,
    last_pose: Option<(f64, f64)>,
    moving_until: f64,
    /// What the hands were doing at the last reading.
    scene: Option<HandScene>,
    /// The faces at the last face reading, and when.
    faces: (Vec<Face>, f64),
    /// What the models run on and how long they take, for the hand view.
    status: String,
    provider: &'static str,
    /// A face is wanted until this time (a gesture asked for it).
    face_wanted_until: Option<f64>,
    /// When a face was first seen, for tracking one by itself.
    face_seen_since: Option<f64>,
    /// No face is started by itself before this time.
    face_rest_until: f64,
    wants_faces: bool,
}

impl Default for FeedReader {
    fn default() -> Self {
        Self::new()
    }
}

impl FeedReader {
    pub fn new() -> Self {
        Self {
            holder: Holder::default(),
            sweep: Sweep::new(true),
            pulse: Pulse::default(),
            controls: Controls::new(true),
            last_read: f64::NEG_INFINITY,
            last_pose: None,
            moving_until: 0.0,
            scene: None,
            faces: (Vec::new(), f64::NEG_INFINITY),
            status: "loading the hand model".to_string(),
            provider: "",
            face_wanted_until: None,
            face_seen_since: None,
            face_rest_until: 0.0,
            wants_faces: false,
        }
    }

    /// What the hand view says about the models: loading, "GPU 12 ms", or why not.
    pub fn status(&self) -> &str {
        &self.status
    }

    /// What the hands were doing at the last reading.
    pub fn scene(&self) -> Option<&HandScene> {
        self.scene.as_ref()
    }

    /// The faces the hand view shows at `now`.
    pub fn faces(&self, now: f64) -> &[Face] {
        if now - self.faces.1 <= FACES_SHOWN_FOR {
            &self.faces.0
        } else {
            &[]
        }
    }

    /// Whether the next offered picture should be searched for faces too.
    pub fn wants_faces(&self) -> bool {
        self.wants_faces
    }

    /// Whether a pinch holds a control.
    pub fn busy(&self) -> bool {
        self.controls.busy()
    }

    /// Lets go of every pinch, as when hand control or gestures are switched off.
    pub fn release(&mut self) -> Vec<Control> {
        self.controls.release()
    }

    /// One look at what the worker reported since the last call, at `now`. `pose` is the
    /// gimbal's live attitude, so sweeps made by the gimbal moving are not read.
    pub fn read(
        &mut self,
        updates: Vec<Update>,
        pose: Option<Waypoint>,
        now: f64,
        tuning: &Tuning,
    ) -> Looked {
        let mut looked = Looked::default();
        if let Some(pose) = pose {
            if let Some((yaw, pitch)) = self.last_pose {
                if (pose.yaw - yaw).abs() > POSE_MOVED || (pose.pitch - pitch).abs() > POSE_MOVED {
                    self.moving_until = now + MOVING_HOLD;
                }
            }
            self.last_pose = Some((pose.yaw, pose.pitch));
        }
        self.controls.stick_is_right = tuning.stick_is_right;
        if tuning.face_requested {
            self.face_wanted_until = Some(now + FACE_WAIT);
        }
        for update in updates {
            match update {
                Update::Ready(provider) => {
                    self.provider = provider;
                    self.status = provider.to_string();
                }
                Update::Failed(error) => {
                    self.status = format!("model failed: {error}");
                }
                Update::Seen { hands, faces, ms } => {
                    if !self.provider.is_empty() {
                        self.status = format!("{} {ms:.0} ms", self.provider);
                    }
                    self.reading(&hands, now, tuning, &mut looked);
                    if let Some(faces) = faces {
                        self.found_faces(&faces, now, tuning, &mut looked);
                    }
                }
            }
        }
        if !tuning.hand_control && self.controls.busy() {
            // Switched off mid-pinch: let go even with no new reading.
            looked.controls.extend(self.controls.release());
        }
        if let Some(until) = self.face_wanted_until {
            if now > until {
                self.face_wanted_until = None;
                looked.no_face = true;
            }
        }
        if !looked.gestures.is_empty() {
            // Putting the hand down afterwards must not read as a sweep.
            self.sweep.hold_off(now);
            self.holder.reset();
        }
        self.wants_faces = self.face_wanted_until.is_some()
            || (tuning.auto_face && !tuning.tracking && now >= self.face_rest_until);
        looked
    }

    /// The hands in one result: pinch controls, then poses and sweeps from a hand that
    /// is not holding a control.
    fn reading(&mut self, hands: &[Hand], now: f64, tuning: &Tuning, looked: &mut Looked) {
        let mut grabs = Vec::new();
        if tuning.hand_control {
            let reading = self.controls.feed(hands, now);
            looked.controls.extend(reading.controls);
            grabs = reading.grabs;
        } else if self.controls.busy() {
            looked.controls.extend(self.controls.release());
        }
        looked.dt = if self.last_read.is_finite() {
            (now - self.last_read).clamp(0.0, 0.1)
        } else {
            0.0
        };
        self.last_read = now;
        // Poses and sweeps come from a hand that is not pinching: the stick hand's if
        // both are free.
        let busy = self.controls.busy();
        let posing = hands
            .iter()
            .filter(|hand| !busy && pinch_ratio(hand) > PINCH_OFF)
            .min_by_key(|hand| u8::from(hand.right != tuning.stick_is_right));
        let swipe = self.sweep.feed(posing, now);
        if now >= self.moving_until {
            looked.gestures.extend(swipe);
        }
        let seen = posing.and_then(pose_of);
        if self.pulse.feed(seen, now) {
            looked.gestures.push(Gesture::FaceTrack);
            self.holder.reset();
        } else {
            let hold = seen.map_or(HOLD, |pose| hold_seconds(&tuning.map, pose.gesture()));
            if let Some(pose) = self.holder.feed(seen, now, hold) {
                looked.gestures.push(pose.gesture());
            }
        }
        let held = self.holder.progress(now);
        looked.progress = held
            .filter(|(_, fraction)| *fraction < 1.0)
            .map(|(pose, fraction)| (pose.gesture(), fraction));
        self.scene = Some(HandScene {
            hands: hands
                .iter()
                .map(|hand| HandView {
                    hand: hand.clone(),
                    pose: pose_of(hand),
                })
                .collect(),
            grabs,
            hold: held.map_or(0.0, |(_, fraction)| fraction),
        });
    }

    /// The faces in one result: the one a gesture asked for, or one seen for a moment.
    fn found_faces(&mut self, faces: &[Face], now: f64, tuning: &Tuning, looked: &mut Looked) {
        self.faces = (faces.to_vec(), now);
        let Some(face) = faces.first() else {
            self.face_seen_since = None;
            return;
        };
        if self.face_wanted_until.take().is_some() {
            looked.face = Some(face_box(face));
            looked.no_face = false;
            self.face_rest_until = now + FACE_REST_AFTER_ASKED;
            return;
        }
        if !tuning.auto_face || tuning.tracking {
            self.face_seen_since = None;
            return;
        }
        let since = *self.face_seen_since.get_or_insert(now);
        if now - since >= FACE_SETTLE && now >= self.face_rest_until {
            looked.face = Some(face_box(face));
            self.face_seen_since = None;
            self.face_rest_until = now + FACE_REST_AFTER_AUTO;
        }
    }
}

// ---- The hand view ------------------------------------------------------------------

/// A point or a box corner, rounded so an unchanged scene serialises the same.
fn round(value: f32) -> f32 {
    (value * 1000.0).round() / 1000.0
}

fn point((x, y): (f32, f32)) -> [f32; 2] {
    [round(x), round(y)]
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Stick => "stick",
        Role::Zoom => "zoom",
    }
}

fn pose_name(pose: Pose) -> &'static str {
    match pose {
        Pose::Fist => "fist",
        Pose::Point => "point",
        Pose::Two => "two",
        Pose::Horns => "horns",
        Pose::Palm => "palm",
    }
}

/// One hand as the hand view draws it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayHand {
    /// The 21 landmarks, `[x, y]` in picture fractions (`crate::handnet::BONES` joins them).
    pub points: Vec<[f32; 2]>,
    /// The landmarks' box with 12 % room each way: left, top, right, bottom.
    pub bounds: [f32; 4],
    pub right: bool,
    /// `stick` or `zoom`: which control this hand is.
    pub role: &'static str,
    /// `fist`, `point`, `two`, `horns`, `palm`, or none.
    pub pose: Option<&'static str>,
    pub score: f32,
    /// Index, middle, ring, pinky: tip reach over base reach.
    pub reach: [f32; 4],
    pub pinch: f32,
}

/// A pinch being held: where it began and where the fingers are.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayGrab {
    pub role: &'static str,
    pub anchor: [f32; 2],
    pub point: [f32; 2],
}

/// A face the finder sees: left, top, width, height in picture fractions.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayFace {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub score: f32,
}

/// `vision://hands`: everything the hand view shows. Coordinates are fractions of the
/// decoded picture before mirroring; the web mirrors them with the picture.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandOverlay {
    /// `cameraFeed`, `webcam`, or `off`.
    pub source: &'static str,
    /// What the models run on and how long they take, or why they are not running.
    pub status: String,
    pub hands: Vec<OverlayHand>,
    pub grabs: Vec<OverlayGrab>,
    /// How far through its hold the pose being held is, 0 to 1.
    pub hold: f32,
    pub faces: Vec<OverlayFace>,
}

impl HandOverlay {
    /// The hand view for a scene and the faces beside it.
    pub fn new(
        source: &'static str,
        status: &str,
        scene: Option<&HandScene>,
        faces: &[Face],
        stick_is_right: bool,
    ) -> Self {
        let role = |grab: &Grab| role_name(grab.role);
        let (hands, grabs, hold) = match scene {
            None => (Vec::new(), Vec::new(), 0.0),
            Some(scene) => (
                scene
                    .hands
                    .iter()
                    .map(|view| overlay_hand(view, stick_is_right))
                    .collect(),
                scene
                    .grabs
                    .iter()
                    .map(|grab| OverlayGrab {
                        role: role(grab),
                        anchor: point(grab.anchor),
                        point: point(grab.point),
                    })
                    .collect(),
                round(scene.hold.clamp(0.0, 1.0)),
            ),
        };
        Self {
            source,
            status: status.to_string(),
            hands,
            grabs,
            hold,
            faces: faces
                .iter()
                .map(|face| OverlayFace {
                    x: round(face.x),
                    y: round(face.y),
                    width: round(face.width),
                    height: round(face.height),
                    score: round(face.score),
                })
                .collect(),
        }
    }
}

fn overlay_hand(view: &HandView, stick_is_right: bool) -> OverlayHand {
    let hand = &view.hand;
    let (l, t, r, b) = hand.bounds();
    let (pad_x, pad_y) = ((r - l) * 0.12, (b - t) * 0.12);
    OverlayHand {
        points: hand.points.iter().copied().map(point).collect(),
        bounds: [
            round(l - pad_x),
            round(t - pad_y),
            round(r + pad_x),
            round(b + pad_y),
        ],
        right: hand.right,
        role: role_name(if hand.right == stick_is_right {
            Role::Stick
        } else {
            Role::Zoom
        }),
        pose: view.pose.map(pose_name),
        score: round(hand.score),
        reach: finger_reach(hand).map(|reach| (reach * 10.0).round() / 10.0),
        pinch: (pinch_ratio(hand) * 100.0).round() / 100.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handnet::POINTS;

    const ASPECT: f32 = 16.0 / 9.0;

    /// A hand at (`cx`, `cy`) with the fingers `out` straight up and the rest folded
    /// into the palm, the thumb `pinched` onto the index tip or held off to the side.
    fn hand(cx: f32, cy: f32, out: [bool; 4], pinched: bool, right: bool) -> Hand {
        let s = 0.05;
        let mut points = [(cx, cy); POINTS];
        // Wrist below, the four finger bases across the top of the palm.
        points[0] = (cx, cy + 2.0 * s);
        let bases = [(5, -0.6), (9, -0.2), (13, 0.2), (17, 0.6)];
        for (finger, (base, dx)) in bases.iter().enumerate() {
            let bx = cx + dx * s / ASPECT;
            points[*base] = (bx, cy);
            let reach = if out[finger] { 2.0 } else { 0.2 };
            points[base + 1] = (bx, cy - reach * s * 0.4);
            points[base + 2] = (bx, cy - reach * s * 0.7);
            points[base + 3] = (bx, cy - reach * s);
        }
        points[1] = (cx - s / ASPECT, cy + s);
        points[2] = (cx - 1.5 * s / ASPECT, cy + 0.5 * s);
        points[3] = (cx - 2.0 * s / ASPECT, cy);
        points[4] = if pinched {
            points[8]
        } else {
            (cx - 3.0 * s / ASPECT, cy - s)
        };
        Hand {
            points,
            aspect: ASPECT,
            score: 0.97,
            right,
        }
    }

    fn seen(hands: Vec<Hand>, faces: Option<Vec<Face>>) -> Vec<Update> {
        vec![Update::Seen {
            hands,
            faces,
            ms: 9.0,
        }]
    }

    fn tuning() -> Tuning {
        Tuning {
            map: GestureMap::default(),
            stick_is_right: true,
            hand_control: true,
            face_requested: false,
            auto_face: false,
            tracking: false,
        }
    }

    const PALM: [bool; 4] = [true; 4];
    const FIST: [bool; 4] = [false; 4];
    const TWO: [bool; 4] = [true, true, false, false];

    #[test]
    fn the_test_hands_read_as_their_poses() {
        assert_eq!(
            pose_of(&hand(0.5, 0.5, PALM, false, true)),
            Some(Pose::Palm)
        );
        assert_eq!(
            pose_of(&hand(0.5, 0.5, FIST, false, true)),
            Some(Pose::Fist)
        );
        assert_eq!(pose_of(&hand(0.5, 0.5, TWO, false, true)), Some(Pose::Two));
        assert!(pinch_ratio(&hand(0.5, 0.5, FIST, true, true)) < crate::hand::PINCH_ON);
    }

    #[test]
    fn a_held_fist_fires_once_after_the_hold_and_reports_progress_on_the_way() {
        let mut reader = FeedReader::new();
        let mut fired = Vec::new();
        let mut halfway = None;
        let mut now = 0.0;
        // Held on, it starts over and fires again a hold later, as the old viewfinder did.
        while now < 1.5 {
            let looked = reader.read(
                seen(vec![hand(0.5, 0.5, FIST, false, true)], None),
                None,
                now,
                &tuning(),
            );
            if now > 0.4 && now < 0.5 {
                halfway = looked.progress;
            }
            fired.extend(looked.gestures);
            now += OFFER_INTERVAL;
        }
        assert_eq!(fired, [Gesture::Fist]);
        let (gesture, fraction) = halfway.expect("progress while held");
        assert_eq!(gesture, Gesture::Fist);
        assert!((0.4..0.6).contains(&fraction), "{fraction}");
    }

    #[test]
    fn the_record_pose_takes_two_and_a_half_seconds() {
        let mut reader = FeedReader::new();
        let mut fired_at = None;
        let mut now = 0.0;
        while now < 4.0 && fired_at.is_none() {
            let looked = reader.read(
                seen(vec![hand(0.5, 0.5, TWO, false, true)], None),
                None,
                now,
                &tuning(),
            );
            if looked.gestures.contains(&Gesture::Two) {
                fired_at = Some(now);
            }
            now += OFFER_INTERVAL;
        }
        let at = fired_at.expect("fires");
        assert!((RECORD_HOLD..RECORD_HOLD + 0.1).contains(&at), "{at}");
        assert_eq!(
            hold_seconds(&GestureMap::default(), Gesture::Two),
            RECORD_HOLD
        );
        assert_eq!(hold_seconds(&GestureMap::default(), Gesture::Fist), HOLD);
    }

    #[test]
    fn a_pinch_drags_the_stick_and_letting_go_ends_it() {
        let mut reader = FeedReader::new();
        let t = tuning();
        // Two pinched readings take hold at the pinch point.
        for (i, now) in [0.0, 0.05].into_iter().enumerate() {
            let looked = reader.read(
                seen(vec![hand(0.5, 0.5, FIST, true, true)], None),
                None,
                now,
                &t,
            );
            assert!(looked.gestures.is_empty(), "reading {i}");
        }
        assert!(reader.busy());
        // Dragged right and up by a full reach: full stick right and up.
        let looked = reader.read(
            seen(vec![hand(0.62, 0.32, FIST, true, true)], None),
            None,
            0.1,
            &t,
        );
        let Some(Control::Stick { x, y }) = looked.controls.first().copied() else {
            panic!("{:?}", looked.controls);
        };
        // Past full reach both ways: full throw, along the drag.
        assert!(
            x > 0.5 && y > 0.5 && (x.hypot(y) - 1.0).abs() < 1e-3,
            "{x} {y}"
        );
        assert!((looked.dt - 0.05).abs() < 1e-9);
        let scene = reader.scene().expect("scene");
        assert_eq!(scene.grabs.len(), 1);
        // Opening the fingers lets go.
        let looked = reader.read(
            seen(vec![hand(0.62, 0.32, FIST, false, true)], None),
            None,
            0.15,
            &t,
        );
        assert_eq!(looked.controls, [Control::StickEnd]);
        assert!(!reader.busy());
    }

    #[test]
    fn the_left_hand_zooms_when_the_right_is_the_stick_and_swaps_with_the_setting() {
        let mut reader = FeedReader::new();
        let mut t = tuning();
        for now in [0.0, 0.05] {
            reader.read(
                seen(vec![hand(0.3, 0.5, FIST, true, false)], None),
                None,
                now,
                &t,
            );
        }
        // Up is zoom in.
        let looked = reader.read(
            seen(vec![hand(0.3, 0.3, FIST, true, false)], None),
            None,
            0.1,
            &t,
        );
        assert!(matches!(looked.controls[..], [Control::Zoom { rate }] if rate > 0.9));
        reader.release();
        t.stick_is_right = false;
        for now in [1.0, 1.05] {
            reader.read(
                seen(vec![hand(0.3, 0.5, FIST, true, false)], None),
                None,
                now,
                &t,
            );
        }
        let looked = reader.read(
            seen(vec![hand(0.3, 0.3, FIST, true, false)], None),
            None,
            1.1,
            &t,
        );
        assert!(
            matches!(looked.controls[..], [Control::Stick { .. }]),
            "{:?}",
            looked.controls
        );
    }

    #[test]
    fn hand_control_off_lets_go_and_reads_no_pinches() {
        let mut reader = FeedReader::new();
        let mut t = tuning();
        for now in [0.0, 0.05] {
            reader.read(
                seen(vec![hand(0.5, 0.5, FIST, true, true)], None),
                None,
                now,
                &t,
            );
        }
        assert!(reader.busy());
        t.hand_control = false;
        let looked = reader.read(Vec::new(), None, 0.1, &t);
        assert_eq!(looked.controls, [Control::StickEnd]);
        let looked = reader.read(
            seen(vec![hand(0.6, 0.4, FIST, true, true)], None),
            None,
            0.15,
            &t,
        );
        assert!(looked.controls.is_empty());
    }

    #[test]
    fn sweeps_are_not_read_while_the_gimbal_turns() {
        let pose = |yaw: f64| {
            Some(Waypoint {
                yaw,
                pitch: 0.0,
                native_pitch: 0.0,
            })
        };
        let run = |turning: bool| {
            let mut reader = FeedReader::new();
            let mut out = Vec::new();
            let mut now = 0.0;
            let mut x: f32 = 0.2;
            let mut yaw = 0.0;
            // Settle in view, then sweep across quickly.
            while now < 1.2 {
                if now > 0.7 {
                    x += 0.08;
                }
                if turning {
                    yaw += 1.0;
                }
                let looked = reader.read(
                    seen(
                        vec![hand(
                            x.min(0.9),
                            0.5,
                            [true, true, true, false],
                            false,
                            true,
                        )],
                        None,
                    ),
                    pose(yaw),
                    now,
                    &tuning(),
                );
                out.extend(looked.gestures);
                now += OFFER_INTERVAL;
            }
            out
        };
        // The picture faces the operator: a sweep to the frame's right is their left.
        assert_eq!(run(false), [Gesture::SwipeLeft]);
        assert!(run(true).is_empty());
    }

    fn face() -> Face {
        Face {
            x: 0.45,
            y: 0.2,
            width: 0.1,
            height: 0.15,
            score: 0.9,
        }
    }

    #[test]
    fn a_face_gesture_tracks_the_face_found_or_says_none_was() {
        let mut reader = FeedReader::new();
        let mut t = tuning();
        t.face_requested = true;
        let looked = reader.read(Vec::new(), None, 0.0, &t);
        assert!(looked.face.is_none());
        assert!(reader.wants_faces());
        t.face_requested = false;
        let looked = reader.read(seen(Vec::new(), Some(vec![face()])), None, 0.3, &t);
        let (x, y, w, h) = looked.face.expect("tracked");
        assert!((w - 0.2).abs() < 1e-6 && (h - 0.36).abs() < 1e-6);
        assert!(
            (x - 0.4).abs() < 1e-6 && (y - (0.275 - 0.144)).abs() < 1e-6,
            "{x} {y}"
        );
        assert!(!reader.wants_faces());
        assert_eq!(reader.faces(0.5).len(), 1);
        assert!(reader.faces(2.0).is_empty());

        let mut reader = FeedReader::new();
        t.face_requested = true;
        reader.read(Vec::new(), None, 0.0, &t);
        t.face_requested = false;
        assert!(
            !reader
                .read(seen(Vec::new(), Some(Vec::new())), None, 1.0, &t)
                .no_face
        );
        assert!(reader.read(Vec::new(), None, FACE_WAIT + 0.1, &t).no_face);
        assert!(!reader.wants_faces());
    }

    #[test]
    fn auto_face_track_waits_for_a_steady_face_then_rests() {
        let mut reader = FeedReader::new();
        let mut t = tuning();
        t.auto_face = true;
        reader.read(Vec::new(), None, 0.0, &t);
        assert!(reader.wants_faces());
        let mut started = Vec::new();
        let mut now = 0.0;
        while now < 40.0 {
            let looked = reader.read(seen(Vec::new(), Some(vec![face()])), None, now, &t);
            if looked.face.is_some() {
                started.push(now);
            }
            now += FACE_ASK_INTERVAL;
        }
        assert_eq!(started.len(), 2, "{started:?}");
        assert!((FACE_SETTLE..FACE_SETTLE + 0.3).contains(&started[0]));
        assert!(started[1] - started[0] >= FACE_REST_AFTER_AUTO);
        // Already tracking: never by itself, and no faces asked for.
        let mut reader = FeedReader::new();
        t.tracking = true;
        reader.read(Vec::new(), None, 0.0, &t);
        assert!(!reader.wants_faces());
    }

    #[test]
    fn the_overlay_carries_landmarks_roles_poses_grabs_and_faces() {
        let mut reader = FeedReader::new();
        let t = tuning();
        reader.read(
            seen(
                vec![
                    hand(0.7, 0.5, PALM, false, true),
                    hand(0.3, 0.5, FIST, true, false),
                ],
                Some(vec![face()]),
            ),
            None,
            0.0,
            &t,
        );
        reader.read(
            seen(
                vec![
                    hand(0.7, 0.5, PALM, false, true),
                    hand(0.3, 0.5, FIST, true, false),
                ],
                None,
            ),
            None,
            0.05,
            &t,
        );
        let overlay = HandOverlay::new(
            "cameraFeed",
            reader.status(),
            reader.scene(),
            reader.faces(0.05),
            true,
        );
        assert_eq!(overlay.hands.len(), 2);
        assert_eq!(overlay.hands[0].points.len(), POINTS);
        assert_eq!(overlay.hands[0].role, "stick");
        assert_eq!(overlay.hands[0].pose, Some("palm"));
        assert_eq!(overlay.hands[1].role, "zoom");
        assert_eq!(overlay.hands[1].pose, None);
        let [l, t, r, b] = overlay.hands[0].bounds;
        assert!(l < 0.7 && r > 0.7 && t < 0.5 && b > 0.5);
        assert_eq!(overlay.grabs.len(), 1);
        assert_eq!(overlay.grabs[0].role, "zoom");
        assert_eq!(overlay.faces.len(), 1);
        let json = serde_json::to_value(&overlay).expect("json");
        assert_eq!(json["source"], "cameraFeed");
        assert!(json["hands"][0]["points"][0].is_array());
        assert!(json["faces"][0]["width"].is_number());
        // Nothing seen yet: a status line and nothing else.
        let empty = HandOverlay::new("webcam", "webcam", None, &[], true);
        assert!(empty.hands.is_empty() && empty.faces.is_empty());
    }
}
