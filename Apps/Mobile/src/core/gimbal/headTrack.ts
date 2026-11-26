/**
 * Head-tracking math (quaternion look, reference fit/extrapolation) and the native target
 * mapper that turns a head look into `0x04/0x14` absolute targets around a calibrated origin.
 * Source of truth: OpenCine `OpenCineMotion/HeadTrack.swift`, `HeadTrackNative.swift`.
 * Sensor input (AirPods / device motion) is native; this is pure math.
 */
import { GimbalPath, type GimbalWaypoint, type MotionBounds, MotionBoundsOps, POCKET_BOUNDS, waypoint, Waypoints } from './program';

export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}
type Vec3 = { x: number; y: number; z: number };

export const Quats = {
  identity: { w: 1, x: 0, y: 0, z: 0 } as Quat,
  conjugate: (q: Quat): Quat => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z }),
  multiply: (a: Quat, r: Quat): Quat => ({
    w: a.w * r.w - a.x * r.x - a.y * r.y - a.z * r.z,
    x: a.w * r.x + a.x * r.w + a.y * r.z - a.z * r.y,
    y: a.w * r.y - a.x * r.z + a.y * r.w + a.z * r.x,
    z: a.w * r.z + a.x * r.y - a.y * r.x + a.z * r.w,
  }),
  rotate(q: Quat, v: Vec3): Vec3 {
    const r = Quats.multiply(Quats.multiply(q, { w: 0, ...v }), Quats.conjugate(q));
    return { x: r.x, y: r.y, z: r.z };
  },
  axisAngle(x: number, y: number, z: number, deg: number): Quat {
    const half = (deg * Math.PI) / 360;
    const s = Math.sin(half);
    const n = Math.sqrt(x * x + y * y + z * z);
    const inv = n > 0 ? s / n : 0;
    return { w: Math.cos(half), x: x * inv, y: y * inv, z: z * inv };
  },
};

export type CenterResult = 'centered' | 'waitingForGimbal' | 'waitingForStill';

export interface HeadSample {
  t: number;
  yaw: number;
  pitch: number;
}
export interface HeadReference {
  yaw: number;
  pitch: number;
  yawRate: number;
  pitchRate: number;
  yawAccel: number;
  pitchAccel: number;
}

export const HeadTrack = {
  calibrateStillRadPerSec: 0.08,
  gyroMagnitude: (lookRight: number, lookUp: number, yaw = 0) => Math.sqrt(lookRight * lookRight + lookUp * lookUp + yaw * yaw),
  wrapDeg(deg: number): number {
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  },
  unwrap: (wrapped: number, previous: number) => previous + HeadTrack.wrapDeg(wrapped - previous),
  radToDeg: (r: number) => (r * 180) / Math.PI,
  bodyLookRightDeg: (liveYaw: number, originYaw: number) => HeadTrack.wrapDeg(liveYaw - originYaw),
  bodyLookUpDeg: (livePitch: number, originPitch: number) => livePitch - originPitch,
  yawDialDeg: (lookRight: number) => HeadTrack.wrapDeg(lookRight),
  pitchDialDeg: (lookUp: number) => HeadTrack.wrapDeg(90 - lookUp),
  /** Look (right, up) of `current` relative to `origin`, forward = +Y, up = +Z. */
  look(current: Quat, origin: Quat): { right: number; up: number } {
    const v = Quats.rotate(Quats.multiply(Quats.conjugate(origin), current), { x: 0, y: 1, z: 0 });
    return { right: (Math.atan2(v.x, v.y) * 180) / Math.PI, up: (Math.atan2(v.z, Math.hypot(v.x, v.y)) * 180) / Math.PI };
  },
  /** Quadratic (≥4 samples) or linear least-squares fit over `fitWindow`, extrapolated to `time`. */
  reference(samples: HeadSample[], time: number, fitWindow: number): HeadReference | null {
    const newest = samples[samples.length - 1];
    if (!newest) return null;
    const recent = samples.filter((s) => newest.t - s.t <= fitWindow);
    const xs = recent.map((s) => s.t - newest.t);
    const fit = (ys: number[]): [number, number, number] => {
      const n = xs.length;
      const s = [0, 0, 0, 0, 0];
      const sy = [0, 0, 0];
      xs.forEach((x, i) => {
        let p = 1;
        for (let k = 0; k < 5; k++) {
          s[k] += p;
          if (k < 3) sy[k] += p * ys[i];
          p *= x;
        }
      });
      const det3 = (m: number[][]) =>
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      if (n >= 4) {
        const m = [
          [s[0], s[1], s[2]],
          [s[1], s[2], s[3]],
          [s[2], s[3], s[4]],
        ];
        const d = det3(m);
        if (Math.abs(d) > 1e-12) {
          const solve = (col: number) => det3(m.map((row, r) => row.map((v, c) => (c === col ? sy[r] : v)))) / d;
          return [solve(0), solve(1), 2 * solve(2)];
        }
      }
      const den = n * s[2] - s[1] * s[1];
      if (n < 2 || Math.abs(den) <= 1e-12) return [ys[ys.length - 1] ?? 0, 0, 0];
      const rate = (n * sy[1] - s[1] * sy[0]) / den;
      return [(sy[0] - rate * s[1]) / n, rate, 0];
    };
    if (time - newest.t > 0.2) return { yaw: newest.yaw, pitch: newest.pitch, yawRate: 0, pitchRate: 0, yawAccel: 0, pitchAccel: 0 };
    const [yv, yr, ya] = fit(recent.map((s) => s.yaw));
    const [pv, pr, pa] = fit(recent.map((s) => s.pitch));
    const h = Math.max(time - newest.t, 0);
    return { yaw: yv + yr * h + (ya * h * h) / 2, pitch: pv + pr * h + (pa * h * h) / 2, yawRate: yr, pitchRate: pr, yawAccel: ya, pitchAccel: pa };
  },
};

/** Calibrated head-look → native absolute target mapper. */
export class HeadTrackNative {
  static readonly commandDuration = 0.1;
  static readonly maxHeadSampleAge = 0.2;
  private _origin: GimbalWaypoint | null = null;
  private _lastTarget: GimbalWaypoint | null = null;
  private lookRight = 0;
  private lookUp = 0;

  constructor(readonly bounds: MotionBounds = POCKET_BOUNDS) {}

  get origin(): GimbalWaypoint | null {
    return this._origin;
  }
  get lastTarget(): GimbalWaypoint | null {
    return this._lastTarget;
  }
  get isCentered(): boolean {
    return this._origin !== null;
  }

  reset(): void {
    this._origin = null;
    this._lastTarget = null;
    this.lookRight = 0;
    this.lookUp = 0;
  }

  static headSampleIsFresh(measuredAt: number | null, now: number): boolean {
    if (measuredAt == null || !Number.isFinite(measuredAt) || !Number.isFinite(now)) return false;
    const age = now - measuredAt;
    return age >= 0 && age <= HeadTrackNative.maxHeadSampleAge;
  }

  center(pose: GimbalWaypoint | null, gyroLookRight = 0, gyroLookUp = 0, gyroYaw = 0): CenterResult {
    const np = pose?.nativePitchDeg;
    if (
      !pose ||
      np == null ||
      ![pose.yawDeg, pose.pitchDeg, pose.zoom, np].every(Number.isFinite) ||
      np < -180 ||
      np > 180 ||
      !Waypoints.equal(pose, Waypoints.clamped(pose, this.bounds))
    )
      return 'waitingForGimbal';
    if (
      ![gyroLookRight, gyroLookUp, gyroYaw].every(Number.isFinite) ||
      HeadTrack.gyroMagnitude(gyroLookRight, gyroLookUp, gyroYaw) >= HeadTrack.calibrateStillRadPerSec
    )
      return 'waitingForStill';
    this._origin = pose;
    this._lastTarget = pose;
    this.lookRight = 0;
    this.lookUp = 0;
    return 'centered';
  }

  /** Native pitch falls 1° per 1° of look-up and stays continuous around the origin (never wrapped). */
  target(lookRightDeg: number, lookUpDeg: number): GimbalWaypoint | null {
    const o = this._origin;
    if (!o || o.nativePitchDeg == null || !Number.isFinite(lookRightDeg) || !Number.isFinite(lookUpDeg)) return null;
    this.lookRight = HeadTrack.unwrap(lookRightDeg, this.lookRight);
    this.lookUp = HeadTrack.unwrap(lookUpDeg, this.lookUp);
    const yaw = MotionBoundsOps.clampPan(this.bounds, o.yawDeg + this.lookRight);
    const pitch = MotionBoundsOps.clampTilt(this.bounds, o.pitchDeg + this.lookUp);
    const point = waypoint(yaw, pitch, o.zoom, o.nativePitchDeg - (pitch - o.pitchDeg));
    this._lastTarget = point;
    return point;
  }
}

/** Generation gate so a late head sample from a previous run cannot drive the gimbal. */
export class HeadTrackNativeSampleGate {
  private generation = 0;
  private active = false;
  begin(): number {
    this.generation += 1;
    this.active = true;
    return this.generation;
  }
  invalidate(): void {
    this.generation += 1;
    this.active = false;
  }
  isCurrent(token: number): boolean {
    return this.active && token === this.generation;
  }
  accepts(token: number, measuredAt: number, now: number): boolean {
    return this.isCurrent(token) && HeadTrackNative.headSampleIsFresh(measuredAt, now);
  }
}

export { GimbalPath };
