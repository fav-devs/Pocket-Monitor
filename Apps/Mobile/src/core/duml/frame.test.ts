import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../bytes';
import {
  crc16,
  crc8,
  decodeFrame,
  encodeFrame,
  FLAG_REQUEST,
  framesEqual,
  isLiveCameraRead,
  makeFrame,
  packString,
  RX_CAMERA,
  RX_WIFI,
  SENDER_APP,
  unpackStatusString,
} from './frame';

// Ported from OpenCine Tests/OpenCineDJITests/DumlFrameTests.swift (+ fork roundTrip/decode tests).
describe('DumlFrame', () => {
  it('crc8 vectors (Osmosis)', () => {
    expect(crc8([0x55, 0x11, 0x04])).toBe(0x92);
    expect(crc8([0x55, 0x33, 0x04])).toBe(0xc2);
  });

  it('encodes enter-playback byte for byte', () => {
    const frame = encodeFrame(
      makeFrame({ sender: SENDER_APP, receiver: RX_CAMERA, seq: 0xa000, flags: FLAG_REQUEST, cmdSet: 0x02, cmdId: 0x0c, payload: [1, 1, 0, 1] }),
    );
    expect(Array.from(frame)).toEqual([
      0x55, 0x11, 0x04, 0x92, 0x02, 0x01, 0x00, 0xa0, 0x40, 0x02, 0x0c, 0x01, 0x01, 0x00, 0x01, 0xb6, 0x3b,
    ]);
  });

  it('encodes SetPairingPIN (51 bytes)', () => {
    const pin = [...packString('284ae5b8d76b3375a04a6417ad71bea3'), ...packString('osmo')];
    const frame = encodeFrame(
      makeFrame({ sender: SENDER_APP, receiver: RX_WIFI, seq: 0x8092, flags: FLAG_REQUEST, cmdSet: 0x07, cmdId: 0x45, payload: pin }),
    );
    expect(frame.length).toBe(51);
    expect(frame[3]).toBe(0xc2);
    expect(Array.from(frame.slice(-2))).toEqual([0xa0, 0xb4]);
    expect(Array.from(frame.slice(0, 11))).toEqual([0x55, 0x33, 0x04, 0xc2, 0x02, 0x07, 0x92, 0x80, 0x40, 0x07, 0x45]);
  });

  it('round-trips through decode', () => {
    const original = makeFrame({ sender: SENDER_APP, receiver: RX_CAMERA, seq: 0xa000, flags: FLAG_REQUEST, cmdSet: 2, cmdId: 0x0c, payload: [1, 1, 0, 1] });
    const b = encodeFrame(original);
    const d = decodeFrame(b);
    expect(d).not.toBeNull();
    expect(d!.consumed).toBe(b.length);
    expect(framesEqual(d!.frame, original)).toBe(true);
  });

  it('unpacks status strings', () => {
    const ssid = utf8Encode('XtraEdgePro-2DCA16');
    expect(unpackStatusString([0x00, ssid.length, ...ssid])).toBe('XtraEdgePro-2DCA16');
    expect(unpackStatusString([0xe0])).toBe('');
    expect(unpackStatusString([0x00, 0x00])).toBe('');
    expect(unpackStatusString([])).toBe('');
  });

  it('decode rejects bad crc', () => {
    const b = encodeFrame(makeFrame({ sender: 2, receiver: 1, seq: 0xa000, flags: 0x40, cmdSet: 2, cmdId: 0x0c, payload: [1] }));
    b[b.length - 1] ^= 0xff;
    expect(decodeFrame(b)).toBeNull();
  });

  it('classifies live camera reads', () => {
    expect(isLiveCameraRead(makeFrame({ sender: 2, receiver: 1, seq: 0, flags: 0x40, cmdSet: 2, cmdId: 0x8e, payload: [0] }))).toBe(true);
    expect(isLiveCameraRead(makeFrame({ sender: 2, receiver: 1, seq: 0, flags: 0x40, cmdSet: 2, cmdId: 0x8e, payload: [1] }))).toBe(false);
    expect(isLiveCameraRead(makeFrame({ sender: 2, receiver: 1, seq: 0, flags: 0x40, cmdSet: 2, cmdId: 0xa0 }))).toBe(true);
    expect(isLiveCameraRead(makeFrame({ sender: 2, receiver: 1, seq: 0, flags: 0x40, cmdSet: 2, cmdId: 0x18 }))).toBe(false);
  });

  it('crc ranges match full arrays', () => {
    const raw = [1, 2, 3, 4, 5, 6];
    expect(crc16(raw, 2)).toBe(crc16(raw.slice(2)));
  });
});
