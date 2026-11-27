/** `pm_controller::hand` tests, with the same vectors. */
import { describe, expect, it } from 'vitest';
import type { GestureKey } from './gesture';
import {
  Controls,
  HOLD,
  HandSmoother,
  Holder,
  PINCH_OFF,
  PINCH_ON,
  POINTS,
  Pulse,
  Sweep,
  palmCentre,
  pinchRatio,
  poseOf,
  type Control,
  type Hand,
  type Pose,
} from './hand';

/**
 * A hand with the wrist at the bottom and each finger either out or curled, as a 4:3 picture
 * sees it. Fingers are listed index to pinky.
 */
function handWith(out: [boolean, boolean, boolean, boolean], tilt: number): Hand {
  const points: [number, number][] = Array.from({ length: POINTS }, () => [0, 0]);
  const s = Math.sin(tilt);
  const c = Math.cos(tilt);
  // A point `along` up the hand and `across` it, from the wrist, rotated by `tilt`.
  const place = (across: number, along: number): [number, number] => [0.5 + (across * c + along * s) * 0.75, 0.8 - (along * c - across * s)];
  points[0] = place(0, 0);
  points[9] = place(0, 0.18);
  // The thumb, out to the side and well clear of the index tip.
  points[4] = place(-0.16, 0.14);
  out.forEach((straight, finger) => {
    const across = -0.045 + 0.03 * finger;
    const base = 1 + 4 * (finger + 1);
    points[base] = place(across, 0.18);
    if (straight) {
      points[base + 1] = place(across, 0.27);
      points[base + 2] = place(across, 0.34);
      points[base + 3] = place(across, 0.4);
    } else {
      // Folded down over the palm: the tip comes back near the base.
      points[base + 1] = place(across, 0.24);
      points[base + 2] = place(across, 0.2);
      points[base + 3] = place(across, 0.14);
    }
  });
  return { points, aspect: 4 / 3, score: 0.99, right: true };
}

const ALL: [boolean, boolean, boolean, boolean] = [true, true, true, true];
const NONE: [boolean, boolean, boolean, boolean] = [false, false, false, false];

/** A hand pinching with its index tip meeting its thumb tip at (x, y) in the picture. */
function pinchingAt(x: number, y: number, right: boolean): Hand {
  const hand = handWith([false, true, true, true], 0);
  hand.right = right;
  hand.points[8] = [x, y];
  hand.points[4] = [x + 0.004, y + 0.004];
  return hand;
}

describe('hand poses', () => {
  it('fingers out make the poses', () => {
    expect(poseOf(handWith(NONE, 0))).toBe('fist');
    expect(poseOf(handWith([true, false, false, false], 0))).toBe('point');
    expect(poseOf(handWith([true, true, false, false], 0))).toBe('two');
    expect(poseOf(handWith([true, false, false, true], 0))).toBe('horns');
    expect(poseOf(handWith(ALL, 0))).toBe('palm');
    // The middle two alone is not a pose we name.
    expect(poseOf(handWith([false, true, true, false], 0))).toBeNull();
  });

  it('the reading does not care which way the hand points', () => {
    for (const tilt of [-1.2, -0.6, 0.6, 1.5, 3.0]) {
      expect(poseOf(handWith(ALL, tilt)), `${tilt}`).toBe('palm');
      expect(poseOf(handWith(NONE, tilt)), `${tilt}`).toBe('fist');
    }
  });

  it('a pinch is not a pose', () => {
    const hand = pinchingAt(0.5, 0.5, true);
    expect(pinchRatio(hand)).toBeLessThan(PINCH_ON);
    expect(poseOf(hand)).toBeNull();
    expect(pinchRatio(handWith(ALL, 0))).toBeGreaterThan(PINCH_OFF);
  });
});

describe('Holder', () => {
  it('a pose fires once after its hold and a longer hold waits longer', () => {
    const holder = new Holder();
    const fired: Pose[] = [];
    let now = 0;
    const push = (p: Pose | null) => p && fired.push(p);
    for (let i = 0; i < 60; i++) {
      push(holder.feed('fist', now, HOLD));
      now += 0.05;
    }
    expect(fired).toEqual(['fist']);
    // Lowering the hand re-arms it.
    for (let i = 0; i < 20; i++) {
      holder.feed(null, now, HOLD);
      now += 0.05;
    }
    for (let i = 0; i < 30; i++) {
      push(holder.feed('fist', now, HOLD));
      now += 0.05;
    }
    expect(fired).toEqual(['fist', 'fist']);
    // A pose that must be held 2.5 s is not there at 1.5 s, and is at 2.6 s.
    const record = new Holder();
    let at = 0;
    const got: Pose[] = [];
    while (at < 1.5) {
      const p = record.feed('two', at, 2.5);
      if (p) got.push(p);
      at += 0.05;
    }
    expect(got).toEqual([]);
    const partway = record.progress(at)?.fraction ?? -1;
    expect(partway).toBeGreaterThan(0.5);
    expect(partway).toBeLessThan(0.7);
    while (at < 2.7) {
      const p = record.feed('two', at, 2.5);
      if (p) got.push(p);
      at += 0.05;
    }
    expect(got).toEqual(['two']);
  });

  it('a flickering pose never fires', () => {
    const holder = new Holder();
    let now = 0;
    for (let i = 0; i < 80; i++) {
      const pose: Pose = i % 10 < 5 ? 'palm' : 'fist';
      expect(holder.feed(pose, now, HOLD)).toBeNull();
      now += 0.05;
    }
  });
});

describe('Pulse', () => {
  it('opening and closing three times is a pulse and holding is not', () => {
    const pulse = new Pulse();
    let fired = 0;
    let now = 0;
    // Open, closed, three times over, each for about a third of a second.
    for (let cycle = 0; cycle < 6; cycle++) {
      const pose: Pose = cycle % 2 === 0 ? 'palm' : 'fist';
      for (let i = 0; i < 7; i++) {
        if (pulse.feed(pose, now)) fired += 1;
        now += 0.05;
      }
    }
    expect(fired).toBe(1);
    const slow = new Pulse();
    now = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      const pose: Pose = cycle % 2 === 0 ? 'palm' : 'fist';
      for (let i = 0; i < 40; i++) {
        expect(slow.feed(pose, now)).toBe(false);
        now += 0.05;
      }
    }
    // And twice is not enough.
    const twice = new Pulse();
    now = 0;
    for (let cycle = 0; cycle < 4; cycle++) {
      const pose: Pose = cycle % 2 === 0 ? 'palm' : 'fist';
      for (let i = 0; i < 7; i++) {
        expect(twice.feed(pose, now)).toBe(false);
        now += 0.05;
      }
    }
  });
});

describe('Controls', () => {
  it('pinching and dragging one hand is the stick until the pinch is let go', () => {
    const controls = new Controls(true);
    let last: Control[] = [];
    // Pinch at the middle, hold still: grips after a couple of readings, no throw.
    for (let step = 0; step < 4; step++) last = controls.feed([pinchingAt(0.5, 0.5, true)], step * 0.05).controls;
    expect(last).toEqual([{ kind: 'stick', x: 0, y: 0 }]);
    expect(controls.busy()).toBe(true);
    // Drag up and to the right a good way: full throw up and right.
    const reading = controls.feed([pinchingAt(0.7, 0.3, true)], 0.3);
    expect(reading.controls).toHaveLength(1);
    const c = reading.controls[0];
    if (c.kind !== 'stick') throw new Error(JSON.stringify(c));
    expect(c.x).toBeGreaterThan(0.5);
    expect(c.y).toBeGreaterThan(0.5);
    expect(reading.grabs).toHaveLength(1);
    // Open the fingers: let go.
    const open = controls.feed([handWith(ALL, 0)], 0.35);
    expect(open.controls).toEqual([{ kind: 'stickEnd' }]);
    expect(controls.busy()).toBe(false);
  });

  it('the other hand zooms by dragging up and down and the hands do not mix', () => {
    const controls = new Controls(true);
    const zoomRates: number[] = [];
    const stickThrows: [number, number][] = [];
    for (let step = 0; step < 5; step++) {
      const t = step * 0.05;
      // The left hand pinches and drags down; the right hand just hangs there open.
      const zoom = pinchingAt(0.3, 0.5 + 0.1 * step, false);
      const stick = handWith(ALL, 0);
      for (const control of controls.feed([zoom, stick], t).controls) {
        if (control.kind === 'zoom') zoomRates.push(control.rate);
        if (control.kind === 'stick') stickThrows.push([control.x, control.y]);
      }
    }
    expect(stickThrows, 'an open right hand is not a grip').toEqual([]);
    expect(zoomRates[zoomRates.length - 1]).toBeLessThan(-0.5);
    // Swapping hands makes the right the zoom.
    const swapped = new Controls(false);
    let got: Control[] = [];
    for (let step = 0; step < 4; step++) got = swapped.feed([pinchingAt(0.5, 0.5, true)], step * 0.05).controls;
    expect(got).toEqual([{ kind: 'zoom', rate: 0 }]);
  });

  it('a pinch that drops out of view lets go after a moment', () => {
    const controls = new Controls(true);
    for (let step = 0; step < 3; step++) controls.feed([pinchingAt(0.5, 0.5, true)], step * 0.05);
    expect(controls.busy()).toBe(true);
    expect(controls.feed([], 0.2).controls, 'a flicker is forgiven').toEqual([]);
    expect(controls.feed([], 0.5).controls).toEqual([{ kind: 'stickEnd' }]);
  });
});

/** The hand's palm at (x, y) of the picture. */
function handAt(x: number, y: number): Hand {
  const hand = handWith(ALL, 0);
  const [cx, cy] = palmCentre(hand.points);
  hand.points = hand.points.map(([px, py]) => [px + x - cx, py + y - cy]);
  return hand;
}

function sweepAcross(mirror: boolean, from: [number, number], to: [number, number]): GestureKey[] {
  const sweep = new Sweep(mirror);
  const found: GestureKey[] = [];
  // The hand is in view and still first, as a hand being held up is.
  const still = handAt(from[0], from[1]);
  for (let step = 0; step < 14; step++) sweep.feed(still, -1 + step * 0.05);
  for (let step = 0; step <= 8; step++) {
    const t = step / 8;
    const hand = handAt(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
    const g = sweep.feed(hand, step * 0.05);
    if (g) found.push(g);
  }
  return found;
}

describe('Sweep', () => {
  it('a quick run of the palm is a sweep', () => {
    expect(sweepAcross(false, [0.2, 0.5], [0.7, 0.5])).toEqual(['swipe_right']);
    expect(sweepAcross(false, [0.7, 0.5], [0.2, 0.5])).toEqual(['swipe_left']);
    expect(sweepAcross(true, [0.2, 0.5], [0.7, 0.5]), 'a mirrored picture swaps the sides').toEqual(['swipe_left']);
    expect(sweepAcross(false, [0.5, 0.8], [0.5, 0.3])).toEqual(['swipe_up']);
  });

  it('a hand coming into view or going down is not a sweep', () => {
    const sweep = new Sweep(false);
    const found: GestureKey[] = [];
    // Raised from low in the picture to high, in half a second, straight into view.
    for (let step = 0; step <= 8; step++) {
      const g = sweep.feed(handAt(0.5, 0.9 - 0.5 * (step / 8)), step * 0.05);
      if (g) found.push(g);
    }
    expect(found).toEqual([]);
  });

  it('a gesture that just fired holds sweeps off', () => {
    const sweep = new Sweep(false);
    const still = handAt(0.2, 0.5);
    for (let step = 0; step < 14; step++) sweep.feed(still, step * 0.05);
    sweep.holdOff(0.7);
    const found: GestureKey[] = [];
    for (let step = 0; step <= 8; step++) {
      const g = sweep.feed(handAt(0.2 + 0.0625 * step, 0.5), 0.75 + step * 0.05);
      if (g) found.push(g);
    }
    expect(found).toEqual([]);
  });

  it('a hand that drifts or wobbles is not a sweep', () => {
    expect(sweepAcross(false, [0.4, 0.5], [0.5, 0.5])).toEqual([]);
    expect(sweepAcross(false, [0.2, 0.3], [0.5, 0.6]), 'diagonal').toEqual([]);
    const slow = new Sweep(false);
    const found: GestureKey[] = [];
    for (let step = 0; step < 40; step++) {
      const g = slow.feed(handAt(0.2 + 0.0125 * step, 0.5), step * 0.2);
      if (g) found.push(g);
    }
    expect(found, 'a slow drift is not a sweep').toEqual([]);
  });
});

describe('HandSmoother', () => {
  it('holds a still hand steady and lets a fast one through', () => {
    const smoother = new HandSmoother();
    const hand = handAt(0.5, 0.5);
    smoother.smooth([hand]);
    // A jitter of a few thousandths is mostly held back.
    const jittered = { ...hand, points: hand.points.map(([x, y]) => [x + 0.004, y] as [number, number]) };
    const [held] = smoother.smooth([jittered]);
    expect(held.points[0][0] - hand.points[0][0]).toBeLessThan(0.003);
    // A jump of a tenth of the picture is followed at once.
    const moved = handAt(0.6, 0.5);
    const [followed] = smoother.smooth([moved]);
    expect(followed.points[0][0]).toBeCloseTo(moved.points[0][0], 6);
    // A hand far from the last one is not blended with it.
    const far = handAt(0.1, 0.2);
    expect(smoother.smooth([far])[0].points).toEqual(far.points);
  });
});
