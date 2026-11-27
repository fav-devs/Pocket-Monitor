/** `pm_controller::vision` tests, with the same vectors. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GESTURE_MAP, defaultGestureMap, type GestureKey } from './gesture';
import { HOLD, PINCH_ON, POINTS, pinchRatio, poseOf, type Hand } from './hand';
import {
  FACE_ASK_INTERVAL,
  FACE_REST_AFTER_AUTO,
  FACE_SETTLE,
  FACE_WAIT,
  FeedReader,
  OFFER_INTERVAL,
  RECORD_HOLD,
  handOverlay,
  holdSeconds,
  type Attitude,
  type Face,
  type Tuning,
  type VisionUpdate,
} from './vision';

const ASPECT = 16 / 9;
type Fingers = [boolean, boolean, boolean, boolean];

/**
 * A hand at (`cx`, `cy`) with the fingers `out` straight up and the rest folded into the palm,
 * the thumb `pinched` onto the index tip or held off to the side.
 */
function hand(cx: number, cy: number, out: Fingers, pinched: boolean, right: boolean): Hand {
  const s = 0.05;
  const points: [number, number][] = Array.from({ length: POINTS }, () => [cx, cy]);
  // Wrist below, the four finger bases across the top of the palm.
  points[0] = [cx, cy + 2 * s];
  const bases: [number, number][] = [
    [5, -0.6],
    [9, -0.2],
    [13, 0.2],
    [17, 0.6],
  ];
  bases.forEach(([base, dx], finger) => {
    const bx = cx + (dx * s) / ASPECT;
    points[base] = [bx, cy];
    const reach = out[finger] ? 2.0 : 0.2;
    points[base + 1] = [bx, cy - reach * s * 0.4];
    points[base + 2] = [bx, cy - reach * s * 0.7];
    points[base + 3] = [bx, cy - reach * s];
  });
  points[1] = [cx - s / ASPECT, cy + s];
  points[2] = [cx - (1.5 * s) / ASPECT, cy + 0.5 * s];
  points[3] = [cx - (2 * s) / ASPECT, cy];
  points[4] = pinched ? points[8] : [cx - (3 * s) / ASPECT, cy - s];
  return { points, aspect: ASPECT, score: 0.97, right };
}

const seen = (hands: Hand[], faces: Face[] | null = null): VisionUpdate[] => [{ kind: 'seen', hands, faces, ms: 9 }];

const tuning = (): Tuning => ({
  map: defaultGestureMap(),
  stickIsRight: true,
  handControl: true,
  faceRequested: false,
  autoFace: false,
  tracking: false,
});

const PALM: Fingers = [true, true, true, true];
const FIST: Fingers = [false, false, false, false];
const TWO: Fingers = [true, true, false, false];

describe('FeedReader', () => {
  it('the test hands read as their poses', () => {
    expect(poseOf(hand(0.5, 0.5, PALM, false, true))).toBe('palm');
    expect(poseOf(hand(0.5, 0.5, FIST, false, true))).toBe('fist');
    expect(poseOf(hand(0.5, 0.5, TWO, false, true))).toBe('two');
    expect(pinchRatio(hand(0.5, 0.5, FIST, true, true))).toBeLessThan(PINCH_ON);
  });

  it('a held fist fires once after the hold and reports progress on the way', () => {
    const reader = new FeedReader();
    const fired: GestureKey[] = [];
    let halfway: { gesture: GestureKey; fraction: number } | null = null;
    let now = 0;
    // Held on, it does not fire again (it fires once a hold, after letting go).
    while (now < 1.5) {
      const looked = reader.read(seen([hand(0.5, 0.5, FIST, false, true)]), null, now, tuning());
      if (now > 0.4 && now < 0.5) halfway = looked.progress;
      fired.push(...looked.gestures);
      now += OFFER_INTERVAL;
    }
    expect(fired).toEqual(['fist']);
    expect(halfway?.gesture).toBe('fist');
    expect(halfway!.fraction).toBeGreaterThanOrEqual(0.4);
    expect(halfway!.fraction).toBeLessThan(0.6);
  });

  it('the record pose takes two and a half seconds', () => {
    const reader = new FeedReader();
    let firedAt: number | null = null;
    let now = 0;
    while (now < 4 && firedAt == null) {
      const looked = reader.read(seen([hand(0.5, 0.5, TWO, false, true)]), null, now, tuning());
      if (looked.gestures.includes('two')) firedAt = now;
      now += OFFER_INTERVAL;
    }
    expect(firedAt).not.toBeNull();
    expect(firedAt!).toBeGreaterThanOrEqual(RECORD_HOLD);
    expect(firedAt!).toBeLessThan(RECORD_HOLD + 0.1);
    expect(holdSeconds(DEFAULT_GESTURE_MAP, 'two')).toBe(RECORD_HOLD);
    expect(holdSeconds(DEFAULT_GESTURE_MAP, 'fist')).toBe(HOLD);
  });

  it('a pinch drags the stick and letting go ends it', () => {
    const reader = new FeedReader();
    const t = tuning();
    // Two pinched readings take hold at the pinch point.
    [0, 0.05].forEach((now, i) => {
      const looked = reader.read(seen([hand(0.5, 0.5, FIST, true, true)]), null, now, t);
      expect(looked.gestures, `reading ${i}`).toEqual([]);
    });
    expect(reader.busy()).toBe(true);
    // Dragged right and up by a full reach: full stick right and up.
    const looked = reader.read(seen([hand(0.62, 0.32, FIST, true, true)]), null, 0.1, t);
    const control = looked.controls[0];
    if (control?.kind !== 'stick') throw new Error(JSON.stringify(looked.controls));
    // Past full reach both ways: full throw, along the drag.
    expect(control.x).toBeGreaterThan(0.5);
    expect(control.y).toBeGreaterThan(0.5);
    expect(Math.abs(Math.hypot(control.x, control.y) - 1)).toBeLessThan(1e-3);
    expect(Math.abs(looked.dt - 0.05)).toBeLessThan(1e-9);
    expect(reader.scene()?.grabs).toHaveLength(1);
    // Opening the fingers lets go.
    const open = reader.read(seen([hand(0.62, 0.32, FIST, false, true)]), null, 0.15, t);
    expect(open.controls).toEqual([{ kind: 'stickEnd' }]);
    expect(reader.busy()).toBe(false);
  });

  it('the left hand zooms when the right is the stick and swaps with the setting', () => {
    const reader = new FeedReader();
    const t = tuning();
    for (const now of [0, 0.05]) reader.read(seen([hand(0.3, 0.5, FIST, true, false)]), null, now, t);
    // Up is zoom in.
    const looked = reader.read(seen([hand(0.3, 0.3, FIST, true, false)]), null, 0.1, t);
    expect(looked.controls).toHaveLength(1);
    const zoom = looked.controls[0];
    expect(zoom.kind === 'zoom' && zoom.rate > 0.9).toBe(true);
    reader.release();
    t.stickIsRight = false;
    for (const now of [1, 1.05]) reader.read(seen([hand(0.3, 0.5, FIST, true, false)]), null, now, t);
    const swapped = reader.read(seen([hand(0.3, 0.3, FIST, true, false)]), null, 1.1, t);
    expect(swapped.controls.map((c) => c.kind)).toEqual(['stick']);
  });

  it('hand control off lets go and reads no pinches', () => {
    const reader = new FeedReader();
    const t = tuning();
    for (const now of [0, 0.05]) reader.read(seen([hand(0.5, 0.5, FIST, true, true)]), null, now, t);
    expect(reader.busy()).toBe(true);
    t.handControl = false;
    expect(reader.read([], null, 0.1, t).controls).toEqual([{ kind: 'stickEnd' }]);
    expect(reader.read(seen([hand(0.6, 0.4, FIST, true, true)]), null, 0.15, t).controls).toEqual([]);
  });

  it('sweeps are not read while the gimbal turns', () => {
    const run = (turning: boolean) => {
      const reader = new FeedReader();
      const out: GestureKey[] = [];
      let now = 0;
      let x = 0.2;
      let yaw = 0;
      // Settle in view, then sweep across quickly.
      while (now < 1.2) {
        if (now > 0.7) x += 0.08;
        if (turning) yaw += 1;
        const pose: Attitude = { yaw, pitch: 0 };
        const looked = reader.read(seen([hand(Math.min(x, 0.9), 0.5, [true, true, true, false], false, true)]), pose, now, tuning());
        out.push(...looked.gestures);
        now += OFFER_INTERVAL;
      }
      return out;
    };
    // The picture faces the operator: a sweep to the frame's right is their left.
    expect(run(false)).toEqual(['swipe_left']);
    expect(run(true)).toEqual([]);
  });

  const face = (): Face => ({ x: 0.45, y: 0.2, width: 0.1, height: 0.15, score: 0.9 });

  it('a face gesture tracks the face found or says none was', () => {
    let reader = new FeedReader();
    const t = tuning();
    t.faceRequested = true;
    expect(reader.read([], null, 0, t).face).toBeNull();
    expect(reader.wantsFaces()).toBe(true);
    t.faceRequested = false;
    const looked = reader.read(seen([], [face()]), null, 0.3, t);
    expect(looked.face).not.toBeNull();
    const [x, y, w, h] = looked.face!;
    expect(Math.abs(w - 0.2)).toBeLessThan(1e-6);
    expect(Math.abs(h - 0.36)).toBeLessThan(1e-6);
    expect(Math.abs(x - 0.4)).toBeLessThan(1e-6);
    expect(Math.abs(y - (0.275 - 0.144))).toBeLessThan(1e-6);
    expect(reader.wantsFaces()).toBe(false);
    expect(reader.faces(0.5)).toHaveLength(1);
    expect(reader.faces(2.0)).toHaveLength(0);

    reader = new FeedReader();
    t.faceRequested = true;
    reader.read([], null, 0, t);
    t.faceRequested = false;
    expect(reader.read(seen([], []), null, 1, t).noFace).toBe(false);
    expect(reader.read([], null, FACE_WAIT + 0.1, t).noFace).toBe(true);
    expect(reader.wantsFaces()).toBe(false);
  });

  it('auto face track waits for a steady face then rests', () => {
    let reader = new FeedReader();
    const t = tuning();
    t.autoFace = true;
    reader.read([], null, 0, t);
    expect(reader.wantsFaces()).toBe(true);
    const started: number[] = [];
    let now = 0;
    while (now < 40) {
      if (reader.read(seen([], [face()]), null, now, t).face) started.push(now);
      now += FACE_ASK_INTERVAL;
    }
    expect(started).toHaveLength(2);
    expect(started[0]).toBeGreaterThanOrEqual(FACE_SETTLE);
    expect(started[0]).toBeLessThan(FACE_SETTLE + 0.3);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(FACE_REST_AFTER_AUTO);
    // Already tracking: never by itself, and no faces asked for.
    reader = new FeedReader();
    t.tracking = true;
    reader.read([], null, 0, t);
    expect(reader.wantsFaces()).toBe(false);
  });

  it('the overlay carries landmarks roles poses grabs and faces', () => {
    const reader = new FeedReader();
    const t = tuning();
    const both = () => [hand(0.7, 0.5, PALM, false, true), hand(0.3, 0.5, FIST, true, false)];
    reader.read(seen(both(), [face()]), null, 0, t);
    reader.read(seen(both()), null, 0.05, t);
    const overlay = handOverlay('cameraFeed', reader.status(), reader.scene(), reader.faces(0.05), true);
    expect(overlay.hands).toHaveLength(2);
    expect(overlay.hands[0].points).toHaveLength(POINTS);
    expect(overlay.hands[0].role).toBe('stick');
    expect(overlay.hands[0].pose).toBe('palm');
    expect(overlay.hands[1].role).toBe('zoom');
    expect(overlay.hands[1].pose).toBeNull();
    const [l, top, r, b] = overlay.hands[0].bounds;
    expect(l < 0.7 && r > 0.7 && top < 0.5 && b > 0.5).toBe(true);
    expect(overlay.grabs).toHaveLength(1);
    expect(overlay.grabs[0].role).toBe('zoom');
    expect(overlay.faces).toHaveLength(1);
    const json = JSON.parse(JSON.stringify(overlay));
    expect(json.source).toBe('cameraFeed');
    expect(Array.isArray(json.hands[0].points[0])).toBe(true);
    expect(typeof json.faces[0].width).toBe('number');
    // Nothing seen yet: a status line and nothing else.
    const empty = handOverlay('webcam', 'webcam', null, [], true);
    expect(empty.hands).toEqual([]);
    expect(empty.faces).toEqual([]);
  });

  it('says what the models run on and how long they take', () => {
    const reader = new FeedReader();
    expect(reader.status()).toBe('loading the hand model');
    reader.read([{ kind: 'ready', provider: 'GPU' }], null, 0, tuning());
    expect(reader.status()).toBe('GPU');
    reader.read([{ kind: 'seen', hands: [], faces: null, ms: 12.4 }], null, 0.1, tuning());
    expect(reader.status()).toBe('GPU 12 ms');
    reader.read([{ kind: 'failed', error: 'no GPU' }], null, 0.2, tuning());
    expect(reader.status()).toBe('model failed: no GPU');
  });
});
