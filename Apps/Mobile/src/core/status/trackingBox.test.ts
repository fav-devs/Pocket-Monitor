import { describe, expect, it } from 'vitest';
import { putF32le } from '../bytes';
import { Commands } from '../commands/commands';
import { parseTrackingPoll, TrackingBoxes } from './trackingBox';

// Ported from OpenCine Tests/OpenCineDJITests/TrackingBoxTests.swift
describe('TrackingBox wire', () => {
  it('set tracking box matches Mimo layout', () => {
    const f = Commands.setTrackingBox(0x2726, 0.418, 0.525, 0.484, 0.461);
    expect([f.cmdSet, f.cmdId, f.receiver, f.flags]).toEqual([2, 0xa6, 1, 0x40]);
    expect(f.payload.length).toBe(21);
    expect(Array.from(f.payload.slice(0, 5))).toEqual([1, 0, 0, 0x26, 0x27]);
    expect(Array.from(f.payload.slice(5, 9))).toEqual(putF32le(0.418));
    expect(Array.from(f.payload.slice(17, 21))).toEqual(putF32le(0.461));
  });
  it('clear is 21 zeros; poll is 00', () => {
    expect(Array.from(Commands.clearTrackingBox().payload)).toEqual(new Array(21).fill(0));
    expect(Array.from(Commands.pollTracking().payload)).toEqual([0]);
  });
  it('poll parses locked and idle', () => {
    expect(parseTrackingPoll([0, 1, 0, 0])).toEqual({ kind: 'locked', box: null });
    expect(parseTrackingPoll([0, 0, 0, 0])).toEqual({ kind: 'idle' });
    expect(parseTrackingPoll([0])).toBeNull();
    expect(parseTrackingPoll([])).toBeNull();
  });
  it('live push parses Mimo subject box', () => {
    const b = TrackingBoxes.parseLivePush([
      0, 0, 0, 0, 0, 0xa0, 0x41, 0x85, 0x10, 0x05, 0x3f, 0xc5, 0x4c, 0xc5, 0x3e, 0xc0, 0x88, 0x3f, 0x3e, 0xca, 0x30, 0xca, 0x3e,
    ])!;
    expect(Math.abs(b.width - 0.187)).toBeLessThan(0.001);
    expect(Math.abs(b.height - 0.395)).toBeLessThan(0.001);
    const c = TrackingBoxes.center(b);
    expect(Math.abs(c.x - 0.52)).toBeLessThan(0.001);
    expect(Math.abs(c.y - 0.385)).toBeLessThan(0.001);
  });
  it('live push accepts alternate header tag', () => {
    const b = TrackingBoxes.parseLivePush([
      0, 0, 0, 0, 0, 0x80, 0x3f, 0xce, 0x45, 0xce, 0x3e, 0xd6, 0x9a, 0xd5, 0x3e, 0xde, 0x04, 0x5d, 0x3e, 0xd0, 0xb0, 0xd0, 0x3d,
    ])!;
    expect(Math.abs(TrackingBoxes.center(b).x - 0.403)).toBeLessThan(0.001);
    expect(Math.abs(b.height - 0.102)).toBeLessThan(0.001);
  });
  it('live push rejects short or bad prefix', () => {
    expect(TrackingBoxes.parseLivePush([0, 1, 0, 0])).toBeNull();
    const bad = new Array(23).fill(0);
    bad[0] = 1;
    expect(TrackingBoxes.parseLivePush(bad)).toBeNull();
  });
  it('poll reads subject box when reply carries floats', () => {
    const p = [0, 1, 0, 0, ...putF32le(0.4), ...putF32le(0.3), ...putF32le(0.18), ...putF32le(0.22)];
    const r = parseTrackingPoll(p);
    expect(r?.kind).toBe('locked');
    if (r?.kind === 'locked') expect(Math.abs(TrackingBoxes.center(r.box!).x - 0.4)).toBeLessThan(1e-6);
  });
});
