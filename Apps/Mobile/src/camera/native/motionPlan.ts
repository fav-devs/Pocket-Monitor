/**
 * Motion Control (A→B→C) planning onto native timed targets (`0x04/0x14`). Pure.
 *
 * Contract (docs/programmed-moves.md): approach A along the reachable pan arc in ≤120° steps,
 * each ≥0.5 s (120°/s), then hold 2 s at A outside the take. Exact legs are one timed target
 * each, split into sub-moves when the pan delta is ≥180° (firmware would pick the route through
 * the missing sector) or the leg exceeds the 25.5 s native limit; durations are in tenths.
 * Smoothness > 0 with C streams 100 ms look-ahead targets every 50 ms off `GimbalProgramCurve`,
 * the final C 100 ms before the end.
 *
 * Playback (`GimbalMoveEngine`) is not ported to src/core, so this is a reduced engine: no
 * exact-B delay fit, no pause/resume. The session verifies arrival at A and at the end only.
 */
import { Commands } from '@/core/commands/commands';
import type { DumlFrame } from '@/core/duml/frame';
import { GimbalPath, type GimbalProgram, GimbalProgramCurve, type GimbalWaypoint, Programs } from '@/core/gimbal/program';
import { type GimbalNativePitchWire, nativePitchTarget } from '@/core/gimbal/reach';

export const APPROACH_STEP_MAX_DEG = 120;
export const APPROACH_RATE_DEG_S = 120;
export const APPROACH_MIN_S = 0.5;
export const HOLD_AT_A_S = 2;
export const NATIVE_MAX_DURATION_S = 25.5;
export const MAX_PAN_DELTA_DEG = 179.9;
export const SMOOTH_INTERVAL_S = 0.05;
export const SMOOTH_LOOKAHEAD_S = 0.1;
/** Arrival tolerance at A / at the end, combined pan+tilt degrees. Looser than upstream 0.15°. */
export const ARRIVAL_TOLERANCE_DEG = 1.5;

export interface TimedMove {
  /** Seconds after the plan starts. */
  at: number;
  yawDeg: number;
  /** Native pitch (attitude `@0` reference). */
  nativePitchDeg: number;
  durationS: number;
}

export interface MovePlan {
  approach: TimedMove[];
  /** Take start, seconds after the plan starts (approach + hold). */
  takeStart: number;
  /** Take moves, `at` relative to the plan start. Empty for a smoothed take (streamed). */
  take: TimedMove[];
  /** Total plan duration, seconds. */
  end: number;
  smooth: GimbalProgramCurve | null;
}

const tenthsUp = (s: number) => Math.ceil(s * 10 - 1e-9) / 10;

function poseDistance(a: GimbalWaypoint, b: GimbalWaypoint): number {
  return GimbalPath.angularDistance(a, b);
}

/** Approach from the live pose to A: ≤120° steps, each at least 0.5 s at 120°/s. */
export function approachMoves(from: GimbalWaypoint, to: GimbalWaypoint): TimedMove[] {
  const span = Math.abs(to.yawDeg - from.yawDeg);
  const steps = Math.max(1, Math.ceil(span / APPROACH_STEP_MAX_DEG));
  const out: TimedMove[] = [];
  let at = 0;
  let prev = from;
  for (let i = 1; i <= steps; i++) {
    const p = GimbalPath.lerp(from, to, i / steps);
    const duration = Math.min(NATIVE_MAX_DURATION_S, tenthsUp(Math.max(APPROACH_MIN_S, poseDistance(prev, p) / APPROACH_RATE_DEG_S)));
    out.push({ at, yawDeg: p.yawDeg, nativePitchDeg: p.nativePitchDeg ?? 0, durationS: duration });
    at += duration;
    prev = p;
  }
  return out;
}

/** Split `tenths` into `n` near-equal positive integer parts. */
export function splitTenths(tenths: number, n: number): number[] {
  const parts = Math.max(1, Math.min(n, tenths));
  const base = Math.floor(tenths / parts);
  const extra = tenths - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/** One exact leg, subdivided for ≥180° pan or > 25.5 s. */
export function exactLegMoves(from: GimbalWaypoint, to: GimbalWaypoint, durationS: number, startAt: number): TimedMove[] {
  const tenths = Math.max(1, Math.round(durationS * 10));
  const pan = Math.abs(to.yawDeg - from.yawDeg);
  const n = Math.max(1, Math.ceil(pan / MAX_PAN_DELTA_DEG), Math.ceil(tenths / (NATIVE_MAX_DURATION_S * 10)));
  const parts = splitTenths(tenths, n);
  const out: TimedMove[] = [];
  let done = 0;
  for (const part of parts) {
    const at = startAt + done / 10;
    done += part;
    const p = GimbalPath.lerp(from, to, done / tenths);
    out.push({ at, yawDeg: p.yawDeg, nativePitchDeg: p.nativePitchDeg ?? 0, durationS: part / 10 });
  }
  return out;
}

export type PlanError = 'incomplete' | 'noNativePitch' | 'noPose';

export function planProgram(program: GimbalProgram, pose: GimbalWaypoint | null): MovePlan | PlanError {
  if (!Programs.canRun(program) || !program.a || !program.b) return 'incomplete';
  if (!pose) return 'noPose';
  const points = [program.a, program.b, program.c].filter((w): w is GimbalWaypoint => !!w);
  if (pose.nativePitchDeg == null || points.some((w) => w.nativePitchDeg == null)) return 'noNativePitch';
  const approach = approachMoves(pose, program.a);
  const last = approach[approach.length - 1];
  const takeStart = (last ? last.at + last.durationS : 0) + HOLD_AT_A_S;
  const smooth = GimbalProgramCurve.make(program);
  if (smooth) return { approach, takeStart, take: [], end: takeStart + smooth.duration, smooth };
  const take = exactLegMoves(program.a, program.b, program.durationAB, takeStart);
  if (program.c) take.push(...exactLegMoves(program.b, program.c, program.durationBC, takeStart + program.durationAB));
  return { approach, takeStart, take, end: takeStart + Programs.duration(program), smooth: null };
}

/** The streamed look-ahead target `t` seconds into a smoothed take. */
export function smoothMoveAt(curve: GimbalProgramCurve, t: number): { yawDeg: number; nativePitchDeg: number; durationS: number } {
  const target = curve.position(Math.min(curve.duration, t + SMOOTH_LOOKAHEAD_S));
  return { yawDeg: target.yawDeg, nativePitchDeg: target.nativePitchDeg ?? 0, durationS: SMOOTH_LOOKAHEAD_S };
}

/**
 * Validated `0x04/0x14` frame for a move, or null when the core refuses it (out of reach,
 * duration off the tenth grid, or a ≥180° pan delta from the live pose).
 */
export function moveFrame(
  move: { yawDeg: number; nativePitchDeg: number; durationS: number },
  wire: GimbalNativePitchWire,
  live: { yawDeg: number; nativePitchDeg: number } | null,
): DumlFrame | null {
  if (live && Math.abs(move.yawDeg - live.yawDeg) >= 180) return null;
  const pitch = live ? nativePitchTarget(wire, move.nativePitchDeg, live.nativePitchDeg) : move.nativePitchDeg;
  if (pitch == null) return null;
  const duration = Math.round(move.durationS * 10) / 10;
  return Commands.gimbalTimedTarget(move.yawDeg, pitch, duration, 0, wire);
}

export function arrived(pose: GimbalWaypoint, target: GimbalWaypoint, tolerance = ARRIVAL_TOLERANCE_DEG): boolean {
  return poseDistance(pose, target) <= tolerance;
}
