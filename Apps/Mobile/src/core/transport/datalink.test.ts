import { describe, expect, it } from 'vitest';
import { encodeFrame, makeFrame } from '../duml/frame';
import { crc16 } from '../duml/frame';
import {
  AckWindowPolicy,
  ackPayload,
  ackWindowsEqual,
  ackWindowsFromTelemetry,
  advanceAckWindows,
  DatalinkSequencer,
  emptyAckWindows,
  handshakeDatagram,
  handshakePayload,
  isHandshake,
  PktType,
  routingHeader,
  scanFrames,
  transportHeader,
  transportSeq,
} from './datalink';

const arr = (u: Uint8Array) => Array.from(u);
const TEL = [
  0x22, 0x80, 0xb7, 0x11, 0xb8, 0xff, 0x01, 0x42, 0x60, 0xa9, 0xd8, 0xa9, 0, 0, 0, 0, 0x38, 0xcd, 0x38, 0xcd, 0, 0, 0, 0,
  0xa0, 0xdd, 0xa0, 0xdd, 0, 0, 0, 0, 0, 0,
];

// Ported from OpenCine Tests/OpenCineDJITests/DumlTransportTests.swift
describe('DumlTransport', () => {
  it('transport header worked example', () => {
    expect(arr(transportHeader(0x05, 29, 0x3a7c, 0xb890))).toEqual([0x25, 0x80, 0x7c, 0x3a, 0x90, 0xb8, 0x05, 0xce]);
  });
  it('routing header worked example', () => {
    expect(arr(routingHeader(0xb890, 0x06))).toEqual([0x88, 0xb8, 0x90, 0xb8, 0, 0, 0, 0, 0x06, 0x01, 0, 0]);
  });
  it('transport seq reads bytes 4 and 5', () => {
    const hdr = transportHeader(0x02, 100, 0x0992, 0xa8b0);
    expect(transportSeq(hdr)).toBe(0xa8b0);
    expect(hdr[6]).toBe(PktType.video);
  });
  it('xor is self-checking', () => {
    const hdr = transportHeader(0x00, 40, 0x1234, 0x5678);
    expect(hdr.length).toBe(8);
    expect(hdr.reduce((a, b) => a ^ b, 0)).toBe(0);
  });
  it('handshake payload stamps base seq', () => {
    const p = handshakePayload(0xb887);
    expect(p.length).toBe(40);
    expect([p[0], p[1]]).toEqual([0x87, 0xb8]);
    expect(arr(p.slice(2, 8))).toEqual([0x64, 0x00, 0x64, 0x00, 0xc0, 0x05]);
  });
  it('handshake datagram is pkt type 00', () => {
    expect(isHandshake(transportHeader(0, 40, 0x1234, 0))).toBe(true);
    expect(isHandshake(transportHeader(4, 26, 0x1234, 0))).toBe(false);
  });
  it('handshake datagram matches known good', () => {
    const pkt = handshakeDatagram(0x1234, 0, 0xb887);
    expect(pkt.length).toBe(48);
    expect(arr(pkt.slice(0, 8))).toEqual([0x30, 0x80, 0x34, 0x12, 0x00, 0x00, 0x00, 0x96]);
    expect(arr(pkt.slice(8, 14))).toEqual([0x87, 0xb8, 0x64, 0x00, 0x64, 0x00]);
    expect(isHandshake(pkt)).toBe(true);
  });
  it('ack payload layout', () => {
    const p = ackPayload(0x1234, 0x5678);
    expect(p.length).toBe(26);
    expect(arr(p.slice(0, 8))).toEqual([0x34, 0x12, 0x34, 0x12, 0, 0, 0, 0]);
    expect(arr(p.slice(8, 16))).toEqual([0x78, 0x56, 0x78, 0x56, 0, 0, 0, 0]);
    expect(arr(p.slice(16, 24))).toEqual([0x78, 0x56, 0x78, 0x56, 0, 0, 0, 0]);
    expect(arr(p.slice(-2))).toEqual([0, 0]);
  });
  it('ack payload echoes acked-data cursor', () => {
    const p = ackPayload(0xa9d8, 0xcd38, 0xdda0);
    expect(arr(p.slice(0, 8))).toEqual([0xd8, 0xa9, 0xd8, 0xa9, 0, 0, 0, 0]);
    expect(arr(p.slice(8, 16))).toEqual([0x38, 0xcd, 0x38, 0xcd, 0, 0, 0, 0]);
    expect(arr(p.slice(16, 24))).toEqual([0xa0, 0xdd, 0xa0, 0xdd, 0, 0, 0, 0]);
  });
  it('ack windows from telemetry', () => {
    const w = ackWindowsFromTelemetry(TEL)!;
    expect(w.video).toBe(0xa9d8);
    expect(w.ackedData).toBe(0xcd38);
    expect(w.extra).toBe(0xdda0);
    expect(ackWindowsFromTelemetry(TEL.slice(0, 8))).toBeNull();
  });
  it('ack windows advance from telemetry then acked data', () => {
    let w = advanceAckWindows(emptyAckWindows(), TEL);
    expect(w.ackedData).toBe(0xcd38);
    expect(w.extra).toBe(0xdda0);
    w = advanceAckWindows(w, transportHeader(0x03, 0, 1, 0xf740));
    expect(w.ackedData).toBe(0xf740);
    expect(w.extra).toBe(0xdda0);
    const after = advanceAckWindows(w, transportHeader(0x02, 8, 1, 0xa9d8));
    expect(ackWindowsEqual(after, w)).toBe(true);
    expect(AckWindowPolicy.shouldSeedVideoCursorFromTelemetry(false)).toBe(true);
    expect(AckWindowPolicy.shouldSeedVideoCursorFromTelemetry(true)).toBe(false);
    expect(AckWindowPolicy.windowCursor(0, true, 0x1000)).toBe(0);
    expect(AckWindowPolicy.windowCursor(0, false, 0x1000)).toBe(0x1000);
  });
  it('telemetry does not rewind acked-data seq zero', () => {
    let w = advanceAckWindows(emptyAckWindows(), transportHeader(0x03, 0, 1, 0));
    expect(w.ackedData).toBe(0);
    expect(w.hasAckedData).toBe(true);
    w = advanceAckWindows(w, TEL);
    expect(w.ackedData).toBe(0);
    expect(w.hasAckedData).toBe(true);
    expect(w.extra).toBe(0xdda0);
    expect(w.hasExtra).toBe(true);
  });
  it('advances forward from telemetry after acked data (incl. wrap)', () => {
    const telemetry = (r: number) => {
      const b = new Array(34).fill(0);
      b[6] = 1;
      b[18] = r & 0xff;
      b[19] = r >> 8;
      return b;
    };
    let w = advanceAckWindows(emptyAckWindows(), transportHeader(0x03, 0, 1, 0x1000));
    w = advanceAckWindows(w, telemetry(0x1020));
    expect(w.ackedData).toBe(0x1020);
    w = advanceAckWindows(w, telemetry(0x0ff8));
    expect(w.ackedData).toBe(0x1020);
    w = advanceAckWindows(emptyAckWindows({ ackedData: 0xfff8, hasAckedData: true }), telemetry(0x0008));
    expect(w.ackedData).toBe(0x0008);
    expect(AckWindowPolicy.isForward(0x0008, 0xfff8)).toBe(true);
  });
  it('scan finds wrapped frame', () => {
    const packet = [
      0x25, 0x80, 0x7c, 0x3a, 0x90, 0xb8, 0x05, 0xce, 0x88, 0xb8, 0x90, 0xb8, 0, 0, 0, 0, 0x06, 0x01, 0, 0, 0x55, 0x11,
      0x04, 0x92, 0x02, 0x01, 0x00, 0xa0, 0x40, 0x02, 0x0c, 0x01, 0x01, 0x00, 0x01, 0xb6, 0x3b,
    ];
    const frames = scanFrames(packet);
    expect(frames).toHaveLength(1);
    expect(frames[0].cmdSet).toBe(2);
    expect(frames[0].cmdId).toBe(0x0c);
    expect(arr(frames[0].payload)).toEqual([1, 1, 0, 1]);
  });
  it('scan finds every frame around junk and rejects bad crc', () => {
    const a = makeFrame({ sender: 2, receiver: 1, seq: 0x1234, flags: 0x40, cmdSet: 0x0d, cmdId: 0x02, payload: [0x55, 0x10, 0x04, 0x00] });
    const b = makeFrame({ sender: 0x28, receiver: 2, seq: 7, flags: 0x80, cmdSet: 0, cmdId: 0x99 });
    const corrupt = Array.from(encodeFrame(a));
    corrupt[corrupt.length - 1] ^= 0xff;
    const raw = [0x55, 0x00, ...encodeFrame(a), 0x55, ...corrupt, ...encodeFrame(b), 0x55];
    const frames = scanFrames(raw);
    expect(frames.map((f) => f.seq)).toEqual([0x1234, 7]);
    expect(arr(frames[0].payload)).toEqual(arr(a.payload));
    expect(frames[0].flags).toBe(0x40);
    expect(frames[1].sender).toBe(0x28);
    expect(frames[1].cmdId).toBe(0x99);
    expect(frames[1].payload.length).toBe(0);
    expect(crc16(raw, 2)).toBe(crc16(raw.slice(2)));
  });
});

describe('DatalinkSequencer', () => {
  it('stamps commands like the Swift driver (worked example)', () => {
    const s = new DatalinkSequencer(() => 0);
    s.sessionId = 0x3a7c;
    s.admit(0xb890);
    s.cmdCounter = 5;
    s.dumlSeq = 0xa000;
    const { seq, packet } = s.command(
      makeFrame({ sender: 2, receiver: 1, seq: 0, flags: 0x40, cmdSet: 2, cmdId: 0x0c, payload: [1, 1, 0, 1] }),
    );
    expect(seq).toBe(0xa000);
    expect(arr(packet)).toEqual([
      0x25, 0x80, 0x7c, 0x3a, 0x90, 0xb8, 0x05, 0xce, 0x88, 0xb8, 0x90, 0xb8, 0, 0, 0, 0, 0x06, 0x01, 0, 0, 0x55, 0x11,
      0x04, 0x92, 0x02, 0x01, 0x00, 0xa0, 0x40, 0x02, 0x0c, 0x01, 0x01, 0x00, 0x01, 0xb6, 0x3b,
    ]);
    expect(s.udpSeq).toBe(0xb898);
    expect(s.dumlSeq).toBe(0xa001);
  });
  it('base seq is 8-aligned and handshake advances udp seq', () => {
    const s = new DatalinkSequencer(() => 0.37);
    expect(s.baseSeq % 8).toBe(0);
    expect(s.sessionId).toBeGreaterThanOrEqual(0x1000);
    const hs = s.handshake();
    expect(hs.length).toBe(48);
    expect(s.udpSeq).toBe(8);
  });
  it('ack falls back to baseSeq until windows are seen', () => {
    const s = new DatalinkSequencer(() => 0);
    s.baseSeq = 0x5678;
    s.sessionId = 0x1234;
    const pkt = s.ack(0x1234, emptyAckWindows());
    expect(pkt.length).toBe(34);
    expect(arr(pkt.slice(8))).toEqual(arr(ackPayload(0x1234, 0x5678)));
    const pkt2 = s.ack(0x1234, emptyAckWindows({ ackedData: 0, hasAckedData: true }));
    expect(arr(pkt2.slice(16, 18))).toEqual([0, 0]);
  });
});
