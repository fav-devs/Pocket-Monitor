/**
 * What the hands are doing, read from the 21 MediaPipe landmarks: a port of
 * `pm_controller::hand` (`Apps/Desktop/crates/pm-controller/src/hand.rs`) and the `Hand` helpers
 * and landmark smoothing of `pm_controller::handnet`. Which fingers are out (a pose), how long a
 * pose has been held, whether the palm has swept across the picture, and the two hands'
 * continuous controls: pinch and drag one hand for the gimbal stick, the other for zoom. The
 * reading works at any tilt of the hand, because it compares distances and not directions.
 *
 * Every number is the desktop's; the tests are its tests with the same vectors.
 */
import type { GestureKey } from './gesture';

/** Landmarks per hand, in MediaPipe's order (0 wrist, 4 thumb tip, 8 index tip, …, 20 pinky tip). */
export const POINTS = 21;

/** Which landmarks are joined, for drawing the skeleton (`handnet::BONES`). */
export const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export type Point = readonly [number, number];

/** One hand the model found (`handnet::Hand`). */
export interface Hand {
  /** The 21 landmarks, `[x, y]` in fractions of the picture read (origin top-left, not mirrored). */
  points: Point[];
  /** The picture's width over its height, for measuring distances between landmarks. */
  aspect: number;
  /** How sure the model is that this is a hand, 0 to 1. */
  score: number;
  /** Whether the model reads it as a right hand (MediaPipe's handedness label on that picture). */
  right: boolean;
}

/** The box around every landmark: left, top, right, bottom. */
export function handBounds(hand: Hand): [number, number, number, number] {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const [x, y] of hand.points) {
    l = Math.min(l, x);
    t = Math.min(t, y);
    r = Math.max(r, x);
    b = Math.max(b, y);
  }
  return [l, t, r, b];
}

const PALM = [0, 5, 9, 13, 17] as const;

/** The middle of the palm: the wrist and the four finger bases. */
export function palmCentre(points: readonly Point[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const i of PALM) {
    x += points[i][0];
    y += points[i][1];
  }
  return [x / PALM.length, y / PALM.length];
}

export type Pose = 'fist' | 'point' | 'two' | 'horns' | 'palm';

/** `Pose::gesture`: a pose is the gesture of the same name. */
export function poseGesture(pose: Pose): GestureKey {
  return pose;
}

/**
 * How long a pose is normally held before it counts, and how long it must be gone before it can
 * fire again.
 */
export const HOLD = 0.9;
const RELEASE = 0.5;

/** Distance between two landmarks, with the picture's shape taken out. */
function distance(hand: Hand, a: number, b: number): number {
  const [ax, ay] = hand.points[a];
  const [bx, by] = hand.points[b];
  return Math.hypot((ax - bx) * hand.aspect, ay - by);
}

/**
 * How far each finger's tip is from the wrist, as a multiple of how far its base is: index,
 * middle, ring, pinky. A straight finger reaches about 1.7 times as far as its base; one folded
 * into the palm 1.3 or less.
 */
export function fingerReach(hand: Hand): [number, number, number, number] {
  const reach = (base: number, tip: number) => distance(hand, tip, 0) / Math.max(distance(hand, base, 0), 1e-4);
  return [reach(5, 8), reach(9, 12), reach(13, 16), reach(17, 20)];
}

/** A finger counts as out past this reach. */
const OUT = 1.42;

/** Thumb tip to index tip, as a share of the palm's length: near zero when pinched. */
export function pinchRatio(hand: Hand): number {
  return distance(hand, 4, 8) / Math.max(distance(hand, 0, 9), 1e-4);
}

/** Pinched at or below this; let go at or above {@link PINCH_OFF}. */
export const PINCH_ON = 0.25;
export const PINCH_OFF = 0.42;

/** Where the pinch is: halfway between the thumb tip and the index tip. */
export function pinchPoint(hand: Hand): [number, number] {
  return [(hand.points[4][0] + hand.points[8][0]) / 2, (hand.points[4][1] + hand.points[8][1]) / 2];
}

/**
 * The pose this hand makes, or null for a shape we have no name for. The thumb is free: it does
 * not change the pose. A pinch is not a pose: it is the controls' grip.
 */
export function poseOf(hand: Hand): Pose | null {
  if (pinchRatio(hand) < PINCH_OFF) return null;
  const [index, middle, ring, pinky] = fingerReach(hand).map((reach) => reach > OUT);
  if (!index && !middle && !ring && !pinky) return 'fist';
  if (index && !middle && !ring && !pinky) return 'point';
  if (index && middle && !ring && !pinky) return 'two';
  if (index && !middle && !ring && pinky) return 'horns';
  if (index && middle && ring && pinky) return 'palm';
  return null;
}

/** Turns a stream of poses into held-pose events (`hand::Holder`). */
export class Holder {
  /** The pose, when it began, and how long it has to be held. */
  private current: { pose: Pose; since: number; hold: number } | null = null;
  private fired = false;
  private goneSince: number | null = null;

  /** The pose being held and how far through the hold it is, 0 to 1. */
  progress(now: number): { pose: Pose; fraction: number } | null {
    if (!this.current) return null;
    const { pose, since, hold } = this.current;
    const fraction = this.fired ? 1 : Math.min(1, Math.max(0, (now - since) / hold));
    return { pose, fraction };
  }

  /** `hold` is how long this pose has to be held, in seconds. */
  feed(seen: Pose | null, now: number, hold: number): Pose | null {
    const current = this.current;
    if (seen != null && current && seen === current.pose) {
      this.goneSince = null;
      if (!this.fired && now - current.since >= current.hold) {
        this.fired = true;
        return seen;
      }
    } else if (seen != null) {
      this.goneSince = null;
      this.current = { pose: seen, since: now, hold };
      this.fired = false;
    } else if (current) {
      if (this.goneSince == null) this.goneSince = now;
      if (now - this.goneSince >= RELEASE) {
        this.current = null;
        this.fired = false;
        this.goneSince = null;
      }
    }
    return null;
  }

  /** Forget what is being held, as when another gesture has just fired. */
  reset(): void {
    this.current = null;
    this.fired = false;
    this.goneSince = null;
  }
}

/** Each state must last at least this long to count, and at most the other. */
const PULSE_MIN = 0.06;
const PULSE_MAX = 0.9;
/** Three open-and-close cycles within this. */
const PULSE_WITHIN = 4.0;

/** Opening and closing the hand quickly, three times over: a pattern, not a pose (`hand::Pulse`). */
export class Pulse {
  /** Confirmed palm and fist states, with when each began. */
  private states: [Pose, number][] = [];
  /** A palm or fist just seen, and since when. */
  private candidate: [Pose, number] | null = null;
  private lastSeen = 0;

  /** True once, when the third cycle completes. */
  feed(seen: Pose | null, now: number): boolean {
    if (seen === 'palm' || seen === 'fist') {
      this.lastSeen = now;
      if (!this.candidate || this.candidate[0] !== seen) this.candidate = [seen, now];
      const [candidate, since] = this.candidate;
      const confirmed = now - since >= PULSE_MIN;
      const last = this.states[this.states.length - 1];
      const fresh = !last || last[0] !== candidate;
      if (confirmed && fresh) this.states.push([candidate, since]);
    } else if (seen != null) {
      // Some other pose is not part of the pattern.
      this.states = [];
      this.candidate = null;
    } else {
      this.candidate = null;
      if (now - this.lastSeen > 1.0) this.states = [];
    }
    this.states = this.states.filter(([, since]) => now - since <= PULSE_WITHIN);
    // Six states in a row: open, closed, open, closed, open, closed.
    if (this.states.length >= 6) {
      const tail = this.states.slice(this.states.length - 6);
      let quick = true;
      for (let i = 1; i < tail.length; i++) {
        const held = tail[i][1] - tail[i - 1][1];
        if (!(held >= PULSE_MIN && held <= PULSE_MAX)) quick = false;
      }
      if (quick) {
        this.states = [];
        this.candidate = null;
        return true;
      }
    }
    return false;
  }
}

// ---- Pinch and drag -------------------------------------------------------------------------

/** Which control a hand is: the gimbal stick, or zoom. */
export type Role = 'stick' | 'zoom';

/** What a pinching hand asks for. Stick from −1 to 1 each way, up positive; zoom −1 (out) … 1 (in). */
export type Control =
  | { kind: 'stick'; x: number; y: number }
  | { kind: 'stickEnd' }
  | { kind: 'zoom'; rate: number }
  | { kind: 'zoomEnd' };

/** A pinch being held, for drawing: where it began and where the fingers are now. */
export interface Grab {
  role: Role;
  anchor: [number, number];
  point: [number, number];
}

/** How far the pinch has to move, as a share of the picture's height, for full stick. */
const STICK_REACH = 0.18;
const ZOOM_REACH = 0.16;
const DEAD = 0.15;
/** A pinching hand that drops out of view this long is let go. */
const LOST = 0.3;

type Grip = { kind: 'idle' } | { kind: 'closing'; readings: number } | { kind: 'held'; anchor: [number, number]; seen: number };

const IDLE: Grip = { kind: 'idle' };

/** What one reading of the hands gave. */
export interface Reading {
  controls: Control[];
  grabs: Grab[];
}

/** Both hands' pinch controls (`hand::Controls`). */
export class Controls {
  private stick: Grip = IDLE;
  private zoom: Grip = IDLE;

  /**
   * Whether the right hand is the stick; the left is then the zoom. "Right" is the model's
   * handedness on the picture read, as on the desktop.
   */
  constructor(public stickIsRight: boolean) {}

  /** Whether either hand has hold of a control. */
  busy(): boolean {
    return this.stick.kind === 'held' || this.zoom.kind === 'held';
  }

  /** Lets go of everything, saying so for each control that was held. */
  release(): Control[] {
    const ended: Control[] = [];
    if (this.stick.kind === 'held') ended.push({ kind: 'stickEnd' });
    if (this.zoom.kind === 'held') ended.push({ kind: 'zoomEnd' });
    this.stick = IDLE;
    this.zoom = IDLE;
    return ended;
  }

  /** The hands in a frame at `now`. */
  feed(hands: readonly Hand[], now: number): Reading {
    const reading: Reading = { controls: [], grabs: [] };
    const stickHand = hands.find((hand) => hand.right === this.stickIsRight);
    const zoomHand = hands.find((hand) => hand.right !== this.stickIsRight);
    for (const [role, hand] of [
      ['stick', stickHand],
      ['zoom', zoomHand],
    ] as const) {
      const grip = role === 'stick' ? this.stick : this.zoom;
      const pinch = hand ? pinchRatio(hand) : null;
      let next: Grip;
      if (grip.kind === 'idle' && hand && pinch != null && pinch < PINCH_ON) {
        next = { kind: 'closing', readings: 1 };
      } else if (grip.kind === 'closing' && hand && pinch != null && pinch < PINCH_ON) {
        next = grip.readings + 1 >= 2 ? { kind: 'held', anchor: pinchPoint(hand), seen: now } : { kind: 'closing', readings: grip.readings + 1 };
      } else if (grip.kind === 'closing') {
        next = IDLE;
      } else if (grip.kind === 'held' && hand && pinch != null && pinch < PINCH_OFF) {
        next = { kind: 'held', anchor: grip.anchor, seen: now };
      } else if (grip.kind === 'held' && !hand && now - grip.seen <= LOST) {
        next = grip;
      } else if (grip.kind === 'held') {
        reading.controls.push(role === 'stick' ? { kind: 'stickEnd' } : { kind: 'zoomEnd' });
        next = IDLE;
      } else {
        next = IDLE;
      }
      if (role === 'stick') this.stick = next;
      else this.zoom = next;
      if (next.kind === 'held' && hand) {
        const point = pinchPoint(hand);
        reading.grabs.push({ role, anchor: next.anchor, point });
        const dx = (point[0] - next.anchor[0]) * hand.aspect;
        const dy = point[1] - next.anchor[1];
        if (role === 'stick') {
          const [x, y] = deadZone(dx / STICK_REACH, -dy / STICK_REACH);
          reading.controls.push({ kind: 'stick', x, y });
        } else {
          const [, rate] = deadZone(0, -dy / ZOOM_REACH);
          reading.controls.push({ kind: 'zoom', rate });
        }
      }
    }
    return reading;
  }
}

/** A stick throw with a dead zone in the middle and full throw at the edge. */
export function deadZone(x: number, y: number): [number, number] {
  const magnitude = Math.hypot(x, y);
  if (magnitude < DEAD) return [0, 0];
  const scaled = Math.min((magnitude - DEAD) / (1 - DEAD), 1);
  // `+ 0` turns a −0 (0 / m × s with a negative 0) into 0, as Rust's equality would treat it.
  return [(x / magnitude) * scaled + 0, (y / magnitude) * scaled + 0];
}

// ---- Sweeps ---------------------------------------------------------------------------------

/** How far the palm must travel, as a share of the picture, and how fast. */
const SWEEP_TRAVEL = 0.28;
const SWEEP_WITHIN = 0.55;
const SWEEP_DOMINANCE = 1.8;
const SWEEP_COOLDOWN = 1.5;
/**
 * A hand that has just come into view, or is being put down, is not sweeping: wait this long
 * after it appears before reading a sweep.
 */
const SWEEP_SETTLE = 0.6;

/** Reads a sweep of the palm across the picture: a quick, mostly straight run (`hand::Sweep`). */
export class Sweep {
  private trail: [number, number, number][] = [];
  private quietUntil = 0;
  /** When the hand came into view, while it has stayed in view. */
  private presentSince: number | null = null;
  private lastSeen = -Infinity;

  /** `mirror` flips left and right, for a picture that faces the operator. */
  constructor(private readonly mirror: boolean) {}

  /** Holds sweeps off for the cooldown, as when another gesture has just fired. */
  holdOff(now: number): void {
    this.trail = [];
    this.quietUntil = Math.max(this.quietUntil, now + SWEEP_COOLDOWN);
  }

  /** The hand found in a frame at `now` (seconds), or null when there is none. */
  feed(hand: Hand | null | undefined, now: number): GestureKey | null {
    while (this.trail.length && now - this.trail[0][0] > SWEEP_WITHIN) this.trail.shift();
    if (!hand) {
      if (now - this.lastSeen > 0.25) this.presentSince = null;
      return null;
    }
    this.lastSeen = now;
    if (this.presentSince == null) this.presentSince = now;
    if (now - this.presentSince < SWEEP_SETTLE) return null;
    let [x, y] = palmCentre(hand.points);
    if (this.mirror) x = 1 - x;
    this.trail.push([now, x, y]);
    if (now < this.quietUntil || this.trail.length < 4) return null;
    const first = this.trail[0];
    const last = this.trail[this.trail.length - 1];
    const dx = last[1] - first[1];
    const dy = last[2] - first[2];
    let gesture: GestureKey | null = null;
    if (Math.abs(dx) >= SWEEP_TRAVEL && Math.abs(dx) >= SWEEP_DOMINANCE * Math.abs(dy)) {
      gesture = dx > 0 ? 'swipe_right' : 'swipe_left';
    } else if (Math.abs(dy) >= SWEEP_TRAVEL && Math.abs(dy) >= SWEEP_DOMINANCE * Math.abs(dx)) {
      gesture = dy > 0 ? 'swipe_down' : 'swipe_up';
    }
    if (gesture) {
      this.trail = [];
      this.quietUntil = now + SWEEP_COOLDOWN;
    }
    return gesture;
  }
}

// ---- What the hand view draws ---------------------------------------------------------------

/** One hand as the hand view draws it. */
export interface HandView {
  hand: Hand;
  pose: Pose | null;
}

/** Everything the hand view shows for one reading. */
export interface HandScene {
  hands: HandView[];
  grabs: Grab[];
  /** How far through its hold the pose being held is, 0 to 1. */
  hold: number;
}

// ---- Landmark smoothing (`HandNet::smooth`) ---------------------------------------------------

/**
 * Landmarks jitter a pixel or two from frame to frame. Still parts are held steady, fast parts
 * follow at once: the blend leans on the newest frame as a point speeds up. Each hand is matched
 * with the nearest hand of the last frame (palm centres within 0.15 of the picture's height).
 */
export class HandSmoother {
  private steady: Point[][] = [];

  smooth(hands: Hand[]): Hand[] {
    const before = this.steady;
    const out = hands.map((hand) => {
      const [cx, cy] = palmCentre(hand.points);
      const aspect = hand.aspect;
      const away = (p: readonly Point[]) => {
        const [x, y] = palmCentre(p);
        return Math.hypot((x - cx) * aspect, y - cy);
      };
      let earlier: Point[] | null = null;
      for (const candidate of before) if (!earlier || away(candidate) < away(earlier)) earlier = candidate;
      if (!earlier || away(earlier) >= 0.15) return hand;
      const old = earlier;
      const points = hand.points.map((point, i): Point => {
        const o = old[i];
        if (!o) return point;
        const speed = Math.hypot((point[0] - o[0]) * aspect, point[1] - o[1]);
        const alpha = Math.min(0.25 + speed * 14, 1);
        return [o[0] + (point[0] - o[0]) * alpha, o[1] + (point[1] - o[1]) * alpha];
      });
      return { ...hand, points };
    });
    this.steady = out.map((hand) => hand.points);
    return out;
  }

  reset(): void {
    this.steady = [];
  }
}
