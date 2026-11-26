import { describe, expect, it } from 'vitest';
import { DumlNotificationAssembler } from './assembler';
import { encodeFrame, makeFrame } from './frame';

// Ported from OpenCine Tests/OpenCineDJITests/DumlNotificationAssemblerTests.swift
describe('DumlNotificationAssembler', () => {
  const frame = makeFrame({ sender: 7, receiver: 2, seq: 1, flags: 0x40, cmdSet: 7, cmdId: 0xac, payload: new Array(391).fill(0x33) });

  it('network report spans notifications', () => {
    const b = encodeFrame(frame);
    for (let cut = 1; cut < b.length; cut++) {
      const r = new DumlNotificationAssembler();
      expect(r.append(b.slice(0, cut))).toHaveLength(0);
      const frames = r.append(b.slice(cut));
      expect(frames).toHaveLength(1);
      expect(Array.from(frames[0].payload)).toEqual(Array.from(frame.payload));
    }
  });

  it('multiple frames and bad CRC resynchronize', () => {
    const r = new DumlNotificationAssembler();
    const good = Array.from(encodeFrame(frame));
    const bad = good.slice();
    bad[bad.length - 1] ^= 1;
    expect(r.append([0, 1, 2, ...bad, ...good, ...good])).toHaveLength(2);
  });
});
