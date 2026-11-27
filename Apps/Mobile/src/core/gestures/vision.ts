/**
 * Gestures read from a picture of the operator: a port of `pm_controller::vision::FeedReader`
 * (`Apps/Desktop/crates/pm-controller/src/vision.rs`). Whoever runs the models (on phones, the
 * native `PocketHands` module: Apple Vision on iOS, MediaPipe Tasks on Android) offers it what
 * they saw, and {@link FeedReader.read} turns that into what the live controls carry out: held
 * poses, sweeps and the open-close pulse as gestures, both hands' pinch-and-drag as controls, how
 * far a held pose has got, and a face to track.
 *
 * The gimbal moving shifts the whole scene, so sweeps are ignored while it moves and for a moment
 * after; held poses and pinches do not depend on that.
 *
 * {@link handOverlay} is what the hand view draws over the picture, in the shape of the desktop's
 * `vision://hands` (`HandOverlay`), so the same web overlay draws both.
 */
import type { GestureKey, GestureMap } from './gesture';
import {
  Controls,
  HOLD,
  Holder,
  PINCH_OFF,
  Pulse,
  Sweep,
  fingerReach,
  handBounds,
  pinchRatio,
  poseGesture,
  poseOf,
  type Control,
  type Grab,
  type Hand,
  type HandScene,
  type Pose,
  type Role,
} from './hand';

/** A picture is offered to the models about this often on the desktop; phones offer 15 a second. */
export const OFFER_INTERVAL = 1 / 20;
/** The models read the picture scaled to this many pixels across, in proportion. */
export const FRAME_WIDTH = 480;
/** Faces are asked for at a few a second, not every frame. */
export const FACE_ASK_INTERVAL = 0.25;
/** Recording takes longer to hold than the rest, so it is never an accident. */
export const RECORD_HOLD = 2.5;
/** A face a gesture asked for is looked for this long before "NO FACE FOUND". */
export const FACE_WAIT = 3.0;
/** A face in view this long starts tracking by itself (auto face track). */
export const FACE_SETTLE = 1.5;
/** After a face a gesture asked for, none is started by itself for this long. */
export const FACE_REST_AFTER_ASKED = 20.0;
/** After one started by itself, none again for this long: stopping it by hand must not start it again at once. */
export const FACE_REST_AFTER_AUTO = 30.0;
/** The gimbal turning more than this (degrees) between readings is the scene moving. */
const POSE_MOVED = 0.3;
/** Sweeps are ignored this long after the gimbal moved. */
const MOVING_HOLD = 1.0;
/** Faces in the hand view are dropped once this old. */
const FACES_SHOWN_FOR = 0.6;

/** A face the finder sees: left, top, width, height in picture fractions. */
export interface Face {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

/** A box: left, top, width, height as fractions of the picture. */
export type FaceBox = [number, number, number, number];

/** What the models reported (`handnet::Update`). */
export type VisionUpdate =
  /** The models are loaded; `provider` is what they run on ("GPU", "CPU", "Vision"). */
  | { kind: 'ready'; provider: string }
  | { kind: 'failed'; error: string }
  /** One picture read: its hands, the faces when they were looked for, and how long it took. */
  | { kind: 'seen'; hands: Hand[]; faces: Face[] | null; ms: number };

/** The gimbal's live attitude in degrees, so sweeps made by the gimbal moving are not read. */
export interface Attitude {
  yaw: number;
  pitch: number;
}

/** How long `gesture` has to be held, with this map: recording takes {@link RECORD_HOLD}. */
export function holdSeconds(map: GestureMap, gesture: GestureKey): number {
  return map[gesture] === 'record' ? RECORD_HOLD : HOLD;
}

/**
 * The box to give the camera for a face: the head with some shoulders, inside the picture.
 * Left, top, width, height as fractions of the picture.
 */
export function faceBox(face: Face): FaceBox {
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  const w = face.width * 2;
  const h = face.height * 2.4;
  const x = clamp(cx - w / 2, 0, 1 - Math.min(w, 1));
  const y = clamp(cy - h * 0.4, 0, 1 - Math.min(h, 1));
  return [x, y, Math.min(w, 1), Math.min(h, 1)];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** What the reader needs to know from the live controls each time. */
export interface Tuning {
  /** What each gesture does, for how long each has to be held. */
  map: GestureMap;
  stickIsRight: boolean;
  /** Pinch-and-drag hand control is on. */
  handControl: boolean;
  /** A gesture just asked for the face to be tracked. */
  faceRequested: boolean;
  autoFace: boolean;
  /** The camera already has something to follow. */
  tracking: boolean;
}

/** What one look came to. */
export interface Looked {
  gestures: GestureKey[];
  controls: Control[];
  /** Seconds since the controls were last read, for the zoom rate. */
  dt: number;
  /** A held pose part-way to firing. */
  progress: { gesture: GestureKey; fraction: number } | null;
  /** A face to track, as left, top, width, height of the picture. */
  face: FaceBox | null;
  /** A face was asked for and none was found. */
  noFace: boolean;
}

/** The hands and faces in a picture, as the live controls read them (`FeedReader`). */
export class FeedReader {
  private holder = new Holder();
  private sweep: Sweep;
  private pulse = new Pulse();
  private controls = new Controls(true);
  private lastRead = -Infinity;
  private lastPose: Attitude | null = null;
  private movingUntil = 0;
  /** What the hands were doing at the last reading. */
  private sceneValue: HandScene | null = null;
  /** The faces at the last face reading, and when. */
  private facesSeen: { faces: Face[]; at: number } = { faces: [], at: -Infinity };
  /** What the models run on and how long they take, for the hand view. */
  private statusText = 'loading the hand model';
  private provider = '';
  /** A face is wanted until this time (a gesture asked for it). */
  private faceWantedUntil: number | null = null;
  /** When a face was first seen, for tracking one by itself. */
  private faceSeenSince: number | null = null;
  /** No face is started by itself before this time. */
  private faceRestUntil = 0;
  private wantsFacesValue = false;

  /**
   * `mirror`: the picture faces the operator (the camera's picture of someone in front of the
   * lens, or a phone's front camera, unmirrored), so a sweep to the frame's right is their left.
   */
  constructor(mirror = true) {
    this.sweep = new Sweep(mirror);
  }

  /** What the hand view says about the models: loading, "GPU 12 ms", or why not. */
  status(): string {
    return this.statusText;
  }

  /** What the hands were doing at the last reading. */
  scene(): HandScene | null {
    return this.sceneValue;
  }

  /** The faces the hand view shows at `now`. */
  faces(now: number): Face[] {
    return now - this.facesSeen.at <= FACES_SHOWN_FOR ? this.facesSeen.faces : [];
  }

  /** Whether the next offered picture should be searched for faces too. */
  wantsFaces(): boolean {
    return this.wantsFacesValue;
  }

  /** Whether a pinch holds a control. */
  busy(): boolean {
    return this.controls.busy();
  }

  /** Lets go of every pinch, as when hand control or gestures are switched off. */
  release(): Control[] {
    return this.controls.release();
  }

  /** One look at what the models reported since the last call, at `now` (seconds). */
  read(updates: readonly VisionUpdate[], pose: Attitude | null, now: number, tuning: Tuning): Looked {
    const looked: Looked = { gestures: [], controls: [], dt: 0, progress: null, face: null, noFace: false };
    if (pose) {
      if (this.lastPose && (Math.abs(pose.yaw - this.lastPose.yaw) > POSE_MOVED || Math.abs(pose.pitch - this.lastPose.pitch) > POSE_MOVED)) {
        this.movingUntil = now + MOVING_HOLD;
      }
      this.lastPose = { yaw: pose.yaw, pitch: pose.pitch };
    }
    this.controls.stickIsRight = tuning.stickIsRight;
    if (tuning.faceRequested) this.faceWantedUntil = now + FACE_WAIT;
    for (const update of updates) {
      if (update.kind === 'ready') {
        this.provider = update.provider;
        this.statusText = update.provider;
      } else if (update.kind === 'failed') {
        this.statusText = `model failed: ${update.error}`;
      } else {
        if (this.provider) this.statusText = `${this.provider} ${update.ms.toFixed(0)} ms`;
        this.reading(update.hands, now, tuning, looked);
        if (update.faces) this.foundFaces(update.faces, now, tuning, looked);
      }
    }
    if (!tuning.handControl && this.controls.busy()) {
      // Switched off mid-pinch: let go even with no new reading.
      looked.controls.push(...this.controls.release());
    }
    if (this.faceWantedUntil != null && now > this.faceWantedUntil) {
      this.faceWantedUntil = null;
      looked.noFace = true;
    }
    if (looked.gestures.length) {
      // Putting the hand down afterwards must not read as a sweep.
      this.sweep.holdOff(now);
      this.holder.reset();
    }
    this.wantsFacesValue = this.faceWantedUntil != null || (tuning.autoFace && !tuning.tracking && now >= this.faceRestUntil);
    return looked;
  }

  /** The hands in one result: pinch controls, then poses and sweeps from a hand that is not holding a control. */
  private reading(hands: readonly Hand[], now: number, tuning: Tuning, looked: Looked): void {
    let grabs: Grab[] = [];
    if (tuning.handControl) {
      const reading = this.controls.feed(hands, now);
      looked.controls.push(...reading.controls);
      grabs = reading.grabs;
    } else if (this.controls.busy()) {
      looked.controls.push(...this.controls.release());
    }
    looked.dt = Number.isFinite(this.lastRead) ? clamp(now - this.lastRead, 0, 0.1) : 0;
    this.lastRead = now;
    // Poses and sweeps come from a hand that is not pinching: the stick hand's if both are free.
    const busy = this.controls.busy();
    let posing: Hand | null = null;
    for (const hand of hands) {
      if (busy || pinchRatio(hand) <= PINCH_OFF) continue;
      if (!posing || (posing.right !== tuning.stickIsRight && hand.right === tuning.stickIsRight)) posing = hand;
    }
    const swipe = this.sweep.feed(posing, now);
    if (swipe && now >= this.movingUntil) looked.gestures.push(swipe);
    const seen: Pose | null = posing ? poseOf(posing) : null;
    if (this.pulse.feed(seen, now)) {
      looked.gestures.push('face_track');
      this.holder.reset();
    } else {
      const hold = seen ? holdSeconds(tuning.map, poseGesture(seen)) : HOLD;
      const fired = this.holder.feed(seen, now, hold);
      if (fired) looked.gestures.push(poseGesture(fired));
    }
    const held = this.holder.progress(now);
    looked.progress = held && held.fraction < 1 ? { gesture: poseGesture(held.pose), fraction: held.fraction } : null;
    this.sceneValue = {
      hands: hands.map((hand) => ({ hand, pose: poseOf(hand) })),
      grabs,
      hold: held ? held.fraction : 0,
    };
  }

  /** The faces in one result: the one a gesture asked for, or one seen for a moment. */
  private foundFaces(faces: readonly Face[], now: number, tuning: Tuning, looked: Looked): void {
    this.facesSeen = { faces: [...faces], at: now };
    const face = faces[0];
    if (!face) {
      this.faceSeenSince = null;
      return;
    }
    if (this.faceWantedUntil != null) {
      this.faceWantedUntil = null;
      looked.face = faceBox(face);
      looked.noFace = false;
      this.faceRestUntil = now + FACE_REST_AFTER_ASKED;
      return;
    }
    if (!tuning.autoFace || tuning.tracking) {
      this.faceSeenSince = null;
      return;
    }
    if (this.faceSeenSince == null) this.faceSeenSince = now;
    if (now - this.faceSeenSince >= FACE_SETTLE && now >= this.faceRestUntil) {
      looked.face = faceBox(face);
      this.faceSeenSince = null;
      this.faceRestUntil = now + FACE_REST_AFTER_AUTO;
    }
  }
}

// ---- The hand view --------------------------------------------------------------------------

/** Where the hands are read from, as the hand view names it. */
export type OverlaySource = 'cameraFeed' | 'webcam' | 'frontCamera' | 'off';

/** One hand as the hand view draws it (`OverlayHand`). */
export interface OverlayHand {
  /** The 21 landmarks, `[x, y]` in picture fractions. */
  points: [number, number][];
  /** The landmarks' box with 12 % room each way: left, top, right, bottom. */
  bounds: [number, number, number, number];
  right: boolean;
  role: Role;
  pose: Pose | null;
  score: number;
  /** Index, middle, ring, pinky: tip reach over base reach. */
  reach: [number, number, number, number];
  pinch: number;
}

/** Everything the hand view shows (`HandOverlay`, the desktop's `vision://hands`). */
export interface HandOverlay {
  source: OverlaySource;
  /** What the models run on and how long they take, or why they are not running. */
  status: string;
  hands: OverlayHand[];
  grabs: { role: Role; anchor: [number, number]; point: [number, number] }[];
  /** How far through its hold the pose being held is, 0 to 1. */
  hold: number;
  faces: Face[];
}

/** A point or a box corner, rounded so an unchanged scene compares the same. */
const round = (value: number) => Math.round(value * 1000) / 1000;
const point = ([x, y]: readonly [number, number]): [number, number] => [round(x), round(y)];

function overlayHand(view: { hand: Hand; pose: Pose | null }, stickIsRight: boolean): OverlayHand {
  const { hand } = view;
  const [l, t, r, b] = handBounds(hand);
  const padX = (r - l) * 0.12;
  const padY = (b - t) * 0.12;
  return {
    points: hand.points.map(point),
    bounds: [round(l - padX), round(t - padY), round(r + padX), round(b + padY)],
    right: hand.right,
    role: hand.right === stickIsRight ? 'stick' : 'zoom',
    pose: view.pose,
    score: round(hand.score),
    reach: fingerReach(hand).map((reach) => Math.round(reach * 10) / 10) as [number, number, number, number],
    pinch: Math.round(pinchRatio(hand) * 100) / 100,
  };
}

/** The hand view for a scene and the faces beside it (`HandOverlay::new`). */
export function handOverlay(source: OverlaySource, status: string, scene: HandScene | null, faces: readonly Face[], stickIsRight: boolean): HandOverlay {
  return {
    source,
    status,
    hands: scene ? scene.hands.map((view) => overlayHand(view, stickIsRight)) : [],
    grabs: scene ? scene.grabs.map((grab) => ({ role: grab.role, anchor: point(grab.anchor), point: point(grab.point) })) : [],
    hold: scene ? round(clamp(scene.hold, 0, 1)) : 0,
    faces: faces.map((face) => ({
      x: round(face.x),
      y: round(face.y),
      width: round(face.width),
      height: round(face.height),
      score: round(face.score),
    })),
  };
}
