import { describe, expect, it } from 'vitest';
import { DatalinkHandshakeAdmission } from './handshakeAdmission';

// Ported from OpenCine Tests/OpenCineDJITests/DatalinkHandshakeAdmissionTests.swift
function packet(type: number, count: number, channel: number): number[] {
  const b = new Array(count).fill(0);
  b[6] = type;
  b[8] = channel & 0xff;
  b[9] = (channel >> 8) & 0xff;
  return b;
}

describe('DatalinkHandshakeAdmission', () => {
  it('short ack cannot register before initial window', () => {
    const a = new DatalinkHandshakeAdmission();
    a.reset(1);
    a.receive(packet(0, 15, 1), 1);
    expect(a.acknowledged).toBe(true);
    expect(a.initialCommandSequence).toBeNull();
    a.receive(packet(1, 34, 0x6000), 1);
    expect(a.initialCommandSequence).toBe(0x6008);
  });
  it('telemetry before ack still requires both and latches the initial window', () => {
    const a = new DatalinkHandshakeAdmission();
    a.reset(1);
    a.receive(packet(1, 34, 0x6000), 1);
    expect(a.initialCommandSequence).toBeNull();
    a.receive(packet(0, 15, 1), 1);
    a.receive(packet(1, 34, 0x6010), 1);
    expect(a.initialCommandSequence).toBe(0x6008);
  });
  it('long status and other packet types cannot substitute for window', () => {
    const a = new DatalinkHandshakeAdmission();
    a.reset(1);
    a.receive(packet(0, 15, 1), 1);
    for (const input of [packet(1, 91, 0x6000), packet(1, 33, 0x6000), packet(2, 34, 0x6000), packet(3, 34, 0x6000)]) {
      a.receive(input, 1);
      expect(a.initialCommandSequence).toBeNull();
    }
    a.receive(packet(1, 34, 0x6000), 1);
    expect(a.initialCommandSequence).toBe(0x6008);
  });
  it('zero and wraparound are valid window sequences', () => {
    for (const [channel, next] of [
      [0, 8],
      [0xfff8, 0],
    ]) {
      const a = new DatalinkHandshakeAdmission();
      a.reset(1);
      a.receive(packet(0, 15, 1), 1);
      a.receive(packet(1, 34, channel), 1);
      expect(a.initialCommandSequence).toBe(next);
    }
  });
  it('retired epoch cannot acknowledge or seed replacement', () => {
    const a = new DatalinkHandshakeAdmission();
    a.reset(1);
    a.receive(packet(0, 15, 1), 1);
    a.reset(2);
    a.receive(packet(1, 34, 0x6000), 1);
    a.receive(packet(0, 15, 1), 1);
    expect(a.acknowledged).toBe(false);
    expect(a.initialCommandSequence).toBeNull();
    a.receive(packet(1, 34, 0x9000), 2);
    a.reset(1);
    a.receive(packet(0, 15, 1), 2);
    expect(a.initialCommandSequence).toBe(0x9008);
  });
});
