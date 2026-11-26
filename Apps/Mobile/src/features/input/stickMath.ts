/**
 * Port of OpenCine `GimbalStick` (OpenCineCameraVocabulary/CameraControl.swift): deadzone,
 * expo response, tap/double-tap/triple-tap sequencing and on-screen touch mapping.
 * The on-screen stick and the gamepad share this so they throw the same.
 */

/** Rest snap. Inside this, both axes stay at rest. */
export const STICK_DEADZONE = 0.08;
/** Stay inside this (fraction of travel) and the press is a tap. */
export const TAP_SLOP = 0.18;
/** Second tap inside this recenters (levels); a third tap in the same window flips. */
export const DOUBLE_TAP_WINDOW_MS = 350;
/** Full command throw as a multiple of the visible outer radius. */
export const TOUCH_COMMAND_RADIUS_FACTOR = 1.35;
/** Knob as a share of the stick (`LiveChromeMetrics.gimbalKnobSize / gimbalStickSize`). */
export const KNOB_FRACTION = 0.42;
/** Drive cadence: ~30 Hz. */
export const DRIVE_INTERVAL_MS = 33;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Operator expo preference (0…1) → exponent. 0.5 is upstream `analogExpo` 2 ("Standard"). */
export function expoExponent(pref: number): number {
  const p = Number.isFinite(pref) ? clamp(pref, 0, 1) : 0.5;
  return 1 + p * 2;
}

/** Deadzone, then linear remainder onto −1…1. */
export function linearThrow(n: number, zone = STICK_DEADZONE): number {
  const v = clamp(Number.isFinite(n) ? n : 0, -1, 1);
  const m = Math.abs(v);
  if (m < zone) return 0;
  const span = 1 - zone;
  if (span <= 0) return 0;
  const t = (m - zone) / span;
  return v < 0 ? -t : t;
}

/** Deadzone, then expo ease-in. Full throw stays 1, rest stays 0. */
export function analogCurve(n: number, exponent = 2, zone = STICK_DEADZONE): number {
  const t = linearThrow(n, zone);
  if (t === 0) return 0;
  const curved = Math.pow(Math.abs(t), exponent > 0 ? exponent : 2);
  return t < 0 ? -curved : curved;
}

export interface StickMapping {
  exponent: number;
  invertPan: boolean;
  invertTilt: boolean;
  directionLock: boolean;
}

/**
 * One stick sample (x right +, y up +, both −1…1) → drive vector. Picture-relative pan
 * invert (selfie face) and the operator's tilt invert apply after the curve.
 * Direction Lock keeps only the dominant axis.
 */
export function applyStickMapping(x: number, y: number, m: StickMapping): { x: number; y: number } {
  let cx = analogCurve(x, m.exponent);
  let cy = analogCurve(y, m.exponent);
  if (m.directionLock) {
    if (Math.abs(x) >= Math.abs(y)) cy = 0;
    else cx = 0;
  }
  if (m.invertPan) cx = -cx;
  if (m.invertTilt) cy = -cy;
  return { x: cx || 0, y: cy || 0 };
}

function radialClamp(x: number, y: number, radius: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (radius <= 0 || mag <= radius) return [x, y];
  const s = radius / mag;
  return [x * s, y * s];
}

export interface TouchMapping {
  visualX: number;
  visualY: number;
  commandX: number;
  commandY: number;
  isTap: boolean;
  engaged: boolean;
}

/** `GimbalStick.mapTouch`: the knob travels inside the ring, the command uses 1.35× radius. */
export function mapTouch(dx: number, dy: number, stickSize: number, knobSize: number, engaged: boolean): TouchMapping {
  const travel = Math.max((stickSize - knobSize) / 2, 0);
  const commandRadius = TOUCH_COMMAND_RADIUS_FACTOR * (stickSize / 2);
  const [vx, vy] = radialClamp(dx, dy, travel);
  const visualNorm = travel > 0 ? Math.hypot(vx, vy) / travel : 0;
  const isTap = visualNorm < TAP_SLOP;
  const nowEngaged = engaged || !isTap;
  const [cx, cy] = radialClamp(dx, dy, commandRadius);
  return {
    visualX: vx,
    visualY: vy,
    commandX: commandRadius > 0 ? cx / commandRadius : 0,
    commandY: commandRadius > 0 ? -cy / commandRadius : 0,
    isTap,
    engaged: nowEngaged,
  };
}

/** Counts stick taps so a double-tap can wait for a possible triple. */
export class TapSequence {
  count = 0;
  private lastAt: number | null = null;

  tap(now: number): 'first' | 'second' | 'third' {
    if (this.lastAt != null && now - this.lastAt >= 0 && now - this.lastAt < DOUBLE_TAP_WINDOW_MS) {
      this.count += 1;
      this.lastAt = now;
      if (this.count >= 3) {
        this.reset();
        return 'third';
      }
      return 'second';
    }
    this.count = 1;
    this.lastAt = now;
    return 'first';
  }

  commitDouble(): boolean {
    if (this.count !== 2) return false;
    this.reset();
    return true;
  }

  reset() {
    this.count = 0;
    this.lastAt = null;
  }
}
