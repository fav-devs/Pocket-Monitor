/**
 * DJI Pocket gimbal reach and the native pitch wire convention.
 * Source of truth: OpenCine `OpenCineDJI/GimbalReach.swift` and `GimbalWaypoint+DJI.swift`
 * (`GimbalNativePitchWire`).
 */
import { wrapAngle } from '../math';

export const GimbalReach = {
  panMinDeg: -48,
  panMaxDeg: 225,
  tiltMinDeg: -44,
  tiltMaxDeg: 70,
  get gapMidDeg(): number {
    return (this.panMaxDeg + this.panMinDeg - 360) / 2;
  },
  clampPan(deg: number): number {
    return Math.min(Math.max(deg, -48), 225);
  },
  clampTilt(deg: number): number {
    return Math.min(Math.max(deg, -44), 70);
  },
  /** Unbounded SET-relative look → nearest reachable yaw/pitch. */
  project(lookRight: number, lookUp: number, yaw0: number, pitch0: number): { yaw: number; pitch: number } {
    return { yaw: Math.min(Math.max(yaw0 + lookRight, -48), 225), pitch: Math.min(Math.max(pitch0 + lookUp, -44), 70) };
  },
};

export type GimbalNativePitchWire = 'wrapped' | 'continuous';
export const NATIVE_PITCH_MAX_OFFSET_DEG = GimbalReach.tiltMaxDeg - GimbalReach.tiltMinDeg;

export function nativePitchRange(wire: GimbalNativePitchWire): [number, number] {
  return wire === 'wrapped' ? [-180, 180] : [-180 - NATIVE_PITCH_MAX_OFFSET_DEG, 180 + NATIVE_PITCH_MAX_OFFSET_DEG];
}

/** `target` expressed beside `reference`. `.wrapped` keeps it as is. */
export function nativePitchTarget(wire: GimbalNativePitchWire, target: number, reference: number): number | null {
  if (!Number.isFinite(target) || !Number.isFinite(reference)) return null;
  if (wire === 'wrapped') return target;
  if (reference < -180 || reference > 180) return null;
  const offset = wrapAngle(target - reference);
  if (Math.abs(offset) > NATIVE_PITCH_MAX_OFFSET_DEG) return null;
  return reference + offset;
}
