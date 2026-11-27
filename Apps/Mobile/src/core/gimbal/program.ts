/**
 * Motion Control (A→B→C) programs: waypoints, durations, linear legs and the smoothness fillet
 * (a quadratic Bézier corner at B whose half-width is `min(AB, BC)·0.5·smoothness`).
 *
 * Source of truth: OpenCine `OpenCineMotion/GimbalProgram.swift` (GimbalWaypoint, GimbalProgram,
 * GimbalPath) and `GimbalProgramCurve.swift`. Upstream bounds are parameterised (`MotionBounds`);
 * the Pocket reach is the default. Playback (`GimbalMoveEngine`, 737 lines) is NOT ported: the
 * native module streams `0x04/0x14` timed targets through `GimbalNativeTargetStream`.
 */
import { GimbalReach } from './reach';

export interface MotionBounds {
  pan: [number, number];
  tilt: [number, number];
}
export const POCKET_BOUNDS: MotionBounds = {
  pan: [GimbalReach.panMinDeg, GimbalReach.panMaxDeg],
  tilt: [GimbalReach.tiltMinDeg, GimbalReach.tiltMaxDeg],
};
export const MotionBoundsOps = {
  gapMidDeg: (b: MotionBounds) => (b.pan[1] + b.pan[0] - 360) / 2,
  clampPan: (b: MotionBounds, d: number) => Math.min(Math.max(d, b.pan[0]), b.pan[1]),
  clampTilt: (b: MotionBounds, d: number) => Math.min(Math.max(d, b.tilt[0]), b.tilt[1]),
};

export interface GimbalWaypoint {
  yawDeg: number;
  pitchDeg: number;
  /** ≥ 1 */
  zoom: number;
  /** Native absolute pitch (`0x04/0x05 @0`), when known. */
  nativePitchDeg: number | null;
}

export function waypoint(yawDeg: number, pitchDeg: number, zoom = 1, nativePitchDeg: number | null = null): GimbalWaypoint {
  return { yawDeg, pitchDeg, zoom: Math.max(1, zoom), nativePitchDeg };
}

export const Waypoints = {
  /** Raw telemetry yaw past the unreachable gap unwraps onto the long side (+360). */
  unwrapYaw(rawDeg: number, bounds: MotionBounds = POCKET_BOUNDS): number {
    return rawDeg < MotionBoundsOps.gapMidDeg(bounds) ? rawDeg + 360 : rawDeg;
  },
  /** From `0x04/0x05` tenths (yaw @4, display pitch @20 negated). */
  fromTenths(yawTenth: number, pitchTenth: number, zoom: number, nativePitchTenth: number | null = null): GimbalWaypoint {
    return waypoint(Waypoints.unwrapYaw(yawTenth / 10), pitchTenth / 10, zoom, nativePitchTenth == null ? null : nativePitchTenth / 10);
  },
  clamped(w: GimbalWaypoint, bounds: MotionBounds = POCKET_BOUNDS): GimbalWaypoint {
    return waypoint(MotionBoundsOps.clampPan(bounds, w.yawDeg), MotionBoundsOps.clampTilt(bounds, w.pitchDeg), w.zoom, w.nativePitchDeg);
  },
  equal(a: GimbalWaypoint, b: GimbalWaypoint): boolean {
    return a.yawDeg === b.yawDeg && a.pitchDeg === b.pitchDeg && a.zoom === b.zoom && a.nativePitchDeg === b.nativePitchDeg;
  },
};

export const GimbalPath = {
  wrapAngle(deg: number): number {
    const r = (deg + 180) % 360;
    return (r < 0 ? r + 360 : r) - 180;
  },
  pitchDelta(from: GimbalWaypoint, to: GimbalWaypoint): number {
    if (from.nativePitchDeg != null && to.nativePitchDeg != null) return GimbalPath.wrapAngle(to.nativePitchDeg - from.nativePitchDeg);
    return to.pitchDeg - from.pitchDeg;
  },
  angularDistance(a: GimbalWaypoint, b: GimbalWaypoint): number {
    return Math.hypot(b.yawDeg - a.yawDeg, GimbalPath.pitchDelta(a, b));
  },
  lerp(a: GimbalWaypoint, b: GimbalWaypoint, u: number): GimbalWaypoint {
    const t = Math.min(Math.max(u, 0), 1);
    const native =
      a.nativePitchDeg != null && b.nativePitchDeg != null ? GimbalPath.wrapAngle(a.nativePitchDeg + GimbalPath.pitchDelta(a, b) * t) : null;
    return waypoint(a.yawDeg + (b.yawDeg - a.yawDeg) * t, a.pitchDeg + (b.pitchDeg - a.pitchDeg) * t, a.zoom + (b.zoom - a.zoom) * t, native);
  },
};

export type WaypointSlot = 'a' | 'b' | 'c';

export interface GimbalProgram {
  a: GimbalWaypoint | null;
  b: GimbalWaypoint | null;
  c: GimbalWaypoint | null;
  durationAB: number;
  durationBC: number;
  /** 0 = exact corners at B, 1 = widest fillet. */
  smoothness: number;
  loop: boolean;
}

export const PROGRAM_DURATION_STEP = 0.5;
export const PROGRAM_MIN_DURATION = 0.5;
export const PROGRAM_MAX_DURATION = 120;
export const PROGRAM_DEFAULT_DURATION = 5;
export const PROGRAM_DURATION_STOPS = [2, 5, 10];

const clampDuration = (v: number) => Math.min(Math.max(v, PROGRAM_MIN_DURATION), PROGRAM_MAX_DURATION);

export function gimbalProgram(p: Partial<GimbalProgram> = {}): GimbalProgram {
  return {
    a: p.a ?? null,
    b: p.b ?? null,
    c: p.c ?? null,
    durationAB: clampDuration(p.durationAB ?? PROGRAM_DEFAULT_DURATION),
    durationBC: clampDuration(p.durationBC ?? PROGRAM_DEFAULT_DURATION),
    smoothness: p.smoothness ?? 0,
    loop: p.loop ?? false,
  };
}

export const Programs = {
  canRun: (p: GimbalProgram) => p.a != null && p.b != null,
  duration: (p: GimbalProgram) => p.durationAB + (p.c == null ? 0 : p.durationBC),
  summary(p: GimbalProgram): string {
    if (p.a && p.b && p.c) return 'A·B·C';
    if (p.a && p.b) return 'A·B';
    if (p.a || p.b || p.c) return 'Partial';
    return 'Not set';
  },
  changesZoom(p: GimbalProgram): boolean {
    const z = [p.a, p.b, p.c].filter((w): w is GimbalWaypoint => !!w).map((w) => w.zoom);
    for (let i = 1; i < z.length; i++) if (Math.abs(z[i] - z[i - 1]) > 1e-6) return true;
    return false;
  },
  pose(p: GimbalProgram, time: number): GimbalWaypoint | null {
    if (!p.a || !p.b) return null;
    const curve = GimbalProgramCurve.make(p);
    if (curve) return curve.position(time);
    if (!p.c || time < p.durationAB) return GimbalPath.lerp(p.a, p.b, time / p.durationAB);
    return GimbalPath.lerp(p.b, p.c, (time - p.durationAB) / p.durationBC);
  },
  clampedDuration: clampDuration,
  snapDuration(v: number): number {
    const c = clampDuration(v);
    return Math.round(c / PROGRAM_DURATION_STEP) * PROGRAM_DURATION_STEP;
  },
  minTravelDuration: (from: GimbalWaypoint | null, to: GimbalWaypoint | null) => (from == null || to == null ? PROGRAM_DEFAULT_DURATION : PROGRAM_MIN_DURATION),
  steppedDuration: (v: number, delta: number, floor: number) => Programs.snapDuration(Math.max(floor, v + delta)),
  durationLabel(v: number): string {
    const s = Programs.snapDuration(v);
    if (Math.abs(s - Math.round(s)) < 0.05) return `${Math.round(s)}s`;
    return `${s.toFixed(1)}s`;
  },
  /** Set a slot and seed travel durations. Returns a new program. */
  setPoint(p: GimbalProgram, slot: WaypointSlot, point: GimbalWaypoint | null): GimbalProgram {
    const next = { ...p, [slot]: point };
    if (next.a && next.b) next.durationAB = Math.max(next.durationAB, Programs.minTravelDuration(next.a, next.b));
    if (next.b && next.c) next.durationBC = Math.max(next.durationBC, Programs.minTravelDuration(next.b, next.c));
    return next;
  },
};

interface Piece {
  from: GimbalWaypoint;
  control: GimbalWaypoint | null;
  to: GimbalWaypoint;
  duration: number;
}

/** A→B→C with a quadratic fillet through B. `make` returns null when smoothness ≤ 0 or C missing. */
export class GimbalProgramCurve {
  private constructor(
    readonly a: GimbalWaypoint,
    readonly b: GimbalWaypoint,
    readonly c: GimbalWaypoint,
    private _durationAB: number,
    private _durationBC: number,
    readonly halfCornerDuration: number,
    private pieces: Piece[],
  ) {}

  static make(p: GimbalProgram): GimbalProgramCurve | null {
    const { a, b, c } = p;
    if (!a || !b || !c || !Number.isFinite(p.smoothness) || !(p.smoothness > 0)) return null;
    if (!Number.isFinite(p.durationAB) || !Number.isFinite(p.durationBC) || !(p.durationAB > 0) || !(p.durationBC > 0)) return null;
    const half = Math.min(p.durationAB, p.durationBC) * 0.5 * Math.min(p.smoothness, 1);
    const P = GimbalPath.lerp(a, b, 1 - half / p.durationAB);
    const Q = GimbalPath.lerp(b, c, half / p.durationBC);
    return new GimbalProgramCurve(a, b, c, p.durationAB, p.durationBC, half, [
      { from: a, control: null, to: P, duration: p.durationAB - half },
      { from: P, control: b, to: Q, duration: 2 * half },
      { from: Q, control: null, to: c, duration: p.durationBC - half },
    ]);
  }

  get durationAB(): number {
    return this._durationAB;
  }
  get durationBC(): number {
    return this._durationBC;
  }
  get duration(): number {
    return this._durationAB + this._durationBC;
  }

  position(time: number): GimbalWaypoint {
    const first = this.pieces[0];
    if (!first) return this.c;
    if (time <= 0) return first.from;
    if (time >= this.duration) return this.c;
    let remaining = time;
    for (const piece of this.pieces) {
      if (remaining <= piece.duration) {
        const u = remaining / piece.duration;
        if (piece.control) {
          return GimbalPath.lerp(GimbalPath.lerp(piece.from, piece.control, u), GimbalPath.lerp(piece.control, piece.to, u), u);
        }
        return GimbalPath.lerp(piece.from, piece.to, u);
      }
      remaining -= piece.duration;
    }
    return this.c;
  }

  /** The rest of the curve after `time`, re-anchored at the live `pose`. */
  remaining(time: number, pose: GimbalWaypoint): GimbalProgramCurve {
    let consumed = Math.max(0, time);
    let rest: Piece[] = [];
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i];
      if (consumed >= piece.duration) {
        consumed -= piece.duration;
        continue;
      }
      const u = consumed / piece.duration;
      rest = [
        { from: pose, control: piece.control ? GimbalPath.lerp(piece.control, piece.to, u) : null, to: piece.to, duration: piece.duration - consumed },
        ...this.pieces.slice(i + 1),
      ];
      break;
    }
    if (!rest.length) rest = [{ from: pose, control: null, to: this.c, duration: 0.1 }];
    const total = rest.reduce((s, x) => s + x.duration, 0);
    if (total < 0.1) rest[0] = { ...rest[0], duration: rest[0].duration + 0.1 - total };
    const ab = Math.max(0, this._durationAB - Math.max(0, time));
    const bc = rest.reduce((s, x) => s + x.duration, 0) - ab;
    return new GimbalProgramCurve(this.a, this.b, this.c, ab, bc, this.halfCornerDuration, rest);
  }

  samples(count = 80): GimbalWaypoint[] {
    const n = Math.max(2, count);
    return Array.from({ length: n }, (_, i) => this.position((this.duration * i) / (n - 1)));
  }
}
