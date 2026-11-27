import { describe, expect, it } from 'vitest';
import { gimbalModeFrames, Commands } from '../commands/commands';
import { GimbalWire } from '../commands/control';
import { GamepadGimbalSticks, GamepadOperatorMap } from './gamepad';
import { HeadTrack, HeadTrackNative, HeadTrackNativeSampleGate, Quats } from './headTrack';
import { GimbalNativeTargetStream, GimbalParamPoll } from './nativeTargetStream';
import { gimbalProgram, GimbalPath, GimbalProgramCurve, Programs, waypoint, Waypoints } from './program';

const arr = (u: ArrayLike<number>) => Array.from(u);

// Ported from fork Tests/OpenPocketViewCoreTests/GimbalProgramTests.swift + GimbalProgramCurveTests.swift
describe('GimbalProgram', () => {
  const a = waypoint(0, 0, 1);
  const b = waypoint(30, 10, 3);
  it('run needs A and B; summary', () => {
    let p = gimbalProgram();
    expect(Programs.canRun(p)).toBe(false);
    expect(Programs.summary(p)).toBe('Not set');
    p = { ...p, a };
    expect(Programs.summary(p)).toBe('Partial');
    p = { ...p, b };
    expect(Programs.canRun(p)).toBe(true);
    expect(Programs.summary(p)).toBe('A·B');
    expect(Programs.changesZoom(p)).toBe(true);
  });
  it('direction lock mode frames', () => {
    const f = gimbalModeFrames('directionLock');
    expect(f.length).toBe(1);
    expect([f[0].cmdSet, f[0].cmdId, f[0].receiver, f[0].flags]).toEqual([4, 0x4c, 4, 0x40]);
    expect(arr(f[0].payload)).toEqual([0, 8]);
    expect(arr(gimbalModeFrames('follow')[1].payload)).toEqual([0, 4, 1, 0]);
    expect(gimbalModeFrames('fpv').length).toBe(1);
  });
  it('tilt reply does not mislabel direction lock or FPV', () => {
    const params = { tiltLock: 1 as const, speed: 2 as const };
    expect(GimbalWire.modeFromGet(params, 'fpv')).toBe('fpv');
    expect(GimbalWire.modeFromGet(params, 'directionLock')).toBe('directionLock');
    expect(GimbalWire.modeFromGet(params, 'follow')).toBe('tiltLocked');
    expect(GimbalWire.modeFromGet({ tiltLock: 0, speed: 0 }, 'tiltLocked')).toBe('follow');
  });
  it('mode family from attitude', () => {
    const p = new Array(50).fill(0);
    p[6] = 0x24;
    expect(GimbalWire.modeFamily(p)).toBe(0);
    p[6] = 0x84;
    expect(GimbalWire.modeFamily(p)).toBe(2);
    expect(GimbalWire.modeFromFamily(2, 'tiltLocked')).toBe('tiltLocked');
    p[6] = 0x44;
    expect(GimbalWire.modeFamily(p)).toBe(1);
    p[6] = 0xc4;
    expect(GimbalWire.modeFamily(p)).toBeNull();
    expect(GimbalWire.modeFamily(p.slice(0, 49))).toBeNull();
  });
  it('param poll at most 1 Hz', () => {
    const poll = new GimbalParamPoll();
    expect(poll.shouldRequest(0)).toBe(true);
    for (let t = 1; t <= 9; t++) expect(poll.shouldRequest(t / 10)).toBe(false);
    expect(poll.shouldRequest(1)).toBe(true);
  });
  it('lerp, min travel, unwrap', () => {
    const mid = GimbalPath.lerp(a, b, 0.5);
    expect(Math.abs(mid.yawDeg - 15)).toBeLessThan(1e-9);
    expect(Math.abs(mid.pitchDeg - 5)).toBeLessThan(1e-9);
    expect(Programs.minTravelDuration(a, b)).toBe(0.5);
    expect(Math.abs(Waypoints.unwrapYaw(-150) - 210)).toBeLessThan(1e-9);
    expect(Waypoints.unwrapYaw(50)).toBe(50);
    expect(Waypoints.fromTenths(-1500, 0, 1).yawDeg).toBe(210);
    expect(Programs.durationLabel(2.26)).toBe('2.5s');
    expect(Programs.durationLabel(5)).toBe('5s');
  });
  it('native pitch lerps across the ±180 wrap', () => {
    const p = GimbalPath.lerp(waypoint(0, 0, 1, 175), waypoint(0, -10, 1, -175), 0.5);
    expect(p.nativePitchDeg).toBe(-180);
  });
});

describe('GimbalProgramCurve', () => {
  const a = waypoint(0, 0, 1, 175);
  const b = waypoint(30, 0, 1, 175);
  const c = waypoint(30, 20, 1, 155);
  const program = (s: number) => gimbalProgram({ a, b, c, durationAB: 3, durationBC: 2, smoothness: s });
  it('zero is exact; increasing smoothness rounds farther from B', () => {
    expect(GimbalProgramCurve.make(program(0))).toBeNull();
    const tight = GimbalProgramCurve.make(program(0.2))!;
    const wide = GimbalProgramCurve.make(program(1))!;
    expect(wide.position(0)).toEqual(a);
    expect(wide.position(5)).toEqual(c);
    expect(GimbalPath.angularDistance(wide.position(3), b)).toBeGreaterThan(GimbalPath.angularDistance(tight.position(3), b));
    expect(wide.position(3).yawDeg).toBe(27.5);
    expect(wide.position(3).pitchDeg).toBe(2.5);
    expect(wide.samples().every((w) => Waypoints.equal(w, Waypoints.clamped(w)))).toBe(true);
  });
  it('angular velocity continuous at both Bézier joins', () => {
    const curve = GimbalProgramCurve.make(program(1))!;
    const e = 0.0001;
    for (const t of [2, 4]) {
      const l = curve.position(t - e);
      const m = curve.position(t);
      const r = curve.position(t + e);
      expect(Math.abs((m.yawDeg - l.yawDeg) / e - (r.yawDeg - m.yawDeg) / e)).toBeLessThan(0.001);
      expect(Math.abs((m.pitchDeg - l.pitchDeg) / e - (r.pitchDeg - m.pitchDeg) / e)).toBeLessThan(0.001);
    }
  });
  it('program pose follows the curve; remaining re-anchors', () => {
    expect(Programs.pose(program(1), 3)!.yawDeg).toBe(27.5);
    expect(Programs.pose(program(0), 3)).toEqual(b);
    const curve = GimbalProgramCurve.make(program(1))!;
    const rest = curve.remaining(1, waypoint(5, 0, 1, 175));
    expect(rest.position(0)).toEqual(waypoint(5, 0, 1, 175));
    expect(Math.abs(rest.duration - 4)).toBeLessThan(1e-9);
    expect(rest.position(rest.duration)).toEqual(c);
  });
});

// Ported from OpenCine Tests/OpenCineDJITests/GimbalNativeTargetStreamTests.swift
describe('GimbalNativeTargetStream', () => {
  const target = (yaw: number) => Commands.gimbalTimedTarget(yaw, 170, 0.1)!;
  const same = (x: ReturnType<typeof target> | null, y: ReturnType<typeof target>) => !!x && arr(x.payload).join() === arr(y.payload).join();
  it('coalesces rapid targets and honours wire budget', () => {
    const s = new GimbalNativeTargetStream();
    s.begin(1);
    s.submit(target(1), 1, 0);
    expect(same(s.next(0), target(1))).toBe(true);
    s.submit(target(2), 1, 0.01);
    s.submit(target(3), 1, 0.02);
    expect(s.next(0.03)).toBeNull();
    expect(same(s.next(0.04), target(3))).toBe(true);
    expect(s.next(0.08)).toBeNull();
  });
  it('stationary target not repeated; delayed queue does not burst', () => {
    const s = new GimbalNativeTargetStream();
    s.begin(1);
    s.submit(target(1), 1, 0);
    s.next(0);
    s.submit(target(1), 1, 0.1);
    expect(s.next(0.1)).toBeNull();
    s.submit(target(2), 1, 0.2);
    expect(s.next(0.5)).toBeNull();
    s.submit(target(2), 1, 0.51);
    expect(same(s.next(0.51), target(2))).toBe(true);
  });
  it('unavailable socket cannot accumulate stale targets', () => {
    const s = new GimbalNativeTargetStream();
    s.begin(1);
    s.submit(target(1), 1, 0);
    expect(s.next(0.1, false)).toBeNull();
    expect(s.next(0.3, false)).toBeNull();
    expect(s.next(0.31)).toBeNull();
    s.submit(target(2), 1, 0.32);
    expect(same(s.next(0.33), target(2))).toBe(true);
  });
  it('old owner cannot stop or overwrite new owner', () => {
    const s = new GimbalNativeTargetStream();
    s.begin(1);
    s.submit(target(1), 1, 0);
    s.begin(2);
    s.submit(target(2), 2, 0.01);
    expect(s.submit(target(3), 1, 0.02)).toBe(false);
    expect(s.cancel(1)).toBe(false);
    expect(same(s.next(0.04), target(2))).toBe(true);
    s.submit(target(4), 2, 0.05);
    expect(s.cancel(2)).toBe(true);
    expect(s.next(0.1)).toBeNull();
  });
});

describe('HeadTrack', () => {
  it('quaternion look', () => {
    const q = Quats.axisAngle(0, 0, 1, -30); // rotate about up: right turn
    const look = HeadTrack.look(q, Quats.identity);
    expect(Math.abs(look.right - 30)).toBeLessThan(1e-9);
    expect(Math.abs(look.up)).toBeLessThan(1e-9);
    const up = HeadTrack.look(Quats.axisAngle(1, 0, 0, 20), Quats.identity);
    expect(Math.abs(up.up - 20)).toBeLessThan(1e-9);
    expect(HeadTrack.wrapDeg(190)).toBe(-170);
    expect(HeadTrack.unwrap(-170, 175)).toBe(190);
    expect(HeadTrack.pitchDialDeg(0)).toBe(90);
  });
  it('reference fit extrapolates a constant rate and holds a stale head', () => {
    const samples = [0, 0.02, 0.04, 0.06, 0.08].map((t) => ({ t, yaw: 10 * t, pitch: 2 }));
    const r = HeadTrack.reference(samples, 0.1, 0.2)!;
    expect(Math.abs(r.yaw - 1)).toBeLessThan(1e-9);
    expect(Math.abs(r.yawRate - 10)).toBeLessThan(1e-9);
    expect(Math.abs(r.pitch - 2)).toBeLessThan(1e-9);
    expect(HeadTrack.reference(samples, 1, 0.2)!.yaw).toBeCloseTo(0.8, 12);
    expect(HeadTrack.reference([], 0, 0.2)).toBeNull();
  });
  it('native mapper centers, keeps native pitch continuous, clamps reach', () => {
    const h = new HeadTrackNative();
    expect(h.center(null)).toBe('waitingForGimbal');
    expect(h.center(waypoint(0, 0, 1))).toBe('waitingForGimbal');
    expect(h.center(waypoint(0, 0, 1, 174), 0.1)).toBe('waitingForStill');
    expect(h.center(waypoint(0, 0, 1, 174))).toBe('centered');
    const down = h.target(0, -9)!;
    expect(down.pitchDeg).toBe(-9);
    expect(down.nativePitchDeg).toBe(183);
    h.target(170, 0);
    const far = h.target(200, 100)!; // continuous past 180° from 170°
    expect(far.yawDeg).toBe(200);
    expect(far.pitchDeg).toBe(70);
    const fresh = new HeadTrackNative();
    fresh.center(waypoint(0, 0, 1, 174));
    expect(fresh.target(300, 0)!.yawDeg).toBe(-48); // 300° unwraps to −60°, clamped to the reach
    expect(HeadTrackNative.headSampleIsFresh(1, 1.2)).toBe(true);
    expect(HeadTrackNative.headSampleIsFresh(1, 1.21)).toBe(false);
    const gate = new HeadTrackNativeSampleGate();
    const tok = gate.begin();
    expect(gate.accepts(tok, 1, 1.1)).toBe(true);
    gate.invalidate();
    expect(gate.accepts(tok, 1, 1.1)).toBe(false);
  });
});

describe('Gamepad operator', () => {
  it('maps buttons', () => {
    expect(GamepadOperatorMap.face('a')).toBe('record');
    expect(GamepadOperatorMap.face('y')).toBe('track');
    expect(GamepadOperatorMap.shoulder('left')).toBe('zoomChipOut');
    expect(GamepadOperatorMap.dpad('right')).toBe('shutterClose');
    expect(GamepadGimbalSticks.parse('RIGHT')).toBe('right');
    expect(GamepadGimbalSticks.parse(null)).toBe('left');
    expect(GamepadGimbalSticks.axes('right', 1, 2, 3, 4)).toEqual({ x: 3, y: 4 });
    expect(GamepadGimbalSticks.restHeldMotion('left', 'right', true)).toBe(true);
  });
});
