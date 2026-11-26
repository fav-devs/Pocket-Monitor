/**
 * DUML wire framing for DJI Osmo cameras. Plaintext, no crypto.
 *
 * Source of truth: OpenCine `Sources/OpenCineDJI/DumlFrame.swift` (upstream, newer — adds
 * `isLiveCameraRead`), plus `decode` from this fork's `Sources/OpenPocketViewCore/DumlFrame.swift`
 * (upstream dropped it in favour of `DumlTransport.scanFrames`).
 *
 * Frame layout (total = 13 + payload.length):
 *   55 | len_lo | (ver<<2)|len_hi | crc8(bytes[0..2]) |
 *   sender | receiver | seq:u16le | flags | cmdSet | cmdId | payload | crc16:u16le
 */
import { type ByteInput, concat, hex as hexBytes, utf8Decode, utf8Encode } from '../bytes';

/** The app is always the sender: id 0, type 2 -> (0<<5)|2. */
export const SENDER_APP = 0x02;
/** Receivers, packed as (id<<5)|type. */
export const RX_CAMERA = 0x01;
export const RX_WIFI = 0x07;
/** id 7, type 0x10 — session/heartbeat (0x00/0x2b). */
export const RX_SESSION = 0xf0;
/** id 0, type 0x1C — wake (0x53/0x10). */
export const RX_1C = 0x1c;

export const FLAG_REQUEST = 0x40;
export const FLAG_RESPONSE = 0xc0;
export const FLAG_NOTIFY = 0x00;
/** Gimbal / cmdType-4 ACK (not the usual 0x02/* `0xC0`). */
export const FLAG_ACK80 = 0x80;

export interface DumlFrame {
  sender: number;
  receiver: number;
  /** u16 */
  seq: number;
  flags: number;
  cmdSet: number;
  cmdId: number;
  payload: Uint8Array;
}

export function makeFrame(f: Omit<DumlFrame, 'payload'> & { payload?: ByteInput }): DumlFrame {
  return { ...f, payload: Uint8Array.from(f.payload ?? []) };
}

/** Opcode waiter key: `cmdSet << 8 | cmdId`. */
export function opcodeKey(set: number, cmd: number): number {
  return ((set & 0xff) << 8) | (cmd & 0xff);
}

/** Camera/gimbal command ACK. `0xC0` is the 0x02/* reply; `0x80` is gimbal / cmdType 4. */
export function isCommandReply(flags: number): boolean {
  return flags === FLAG_RESPONSE || flags === FLAG_ACK80;
}

const LIVE_CAMERA_CONTROL = new Set([
  0x01, 0x02, 0x0c, 0x1e, 0x18, 0x22, 0x24, 0x28, 0x2a, 0x2c, 0x2e, 0x30, 0x32, 0x42, 0x68, 0x8e, 0x9f, 0xa0,
  0xa5, 0xa6, 0xb8, 0xbf, 0xe1,
]);

/** In-session `0x02/*` writes that wait for an ACK (includes zoom `0xB8`). */
export function isLiveCameraControl(set: number, cmd: number): boolean {
  return set === 0x02 && LIVE_CAMERA_CONTROL.has(cmd);
}

/**
 * A live `0x02/*` command that only asks the camera for state (must not arm the watchdog's
 * post-SET grace). `0x02/0x8E` carries GET and SET; payload[0] == 0 is GET.
 */
export function isLiveCameraRead(frame: DumlFrame): boolean {
  if (frame.cmdSet !== 0x02) return false;
  switch (frame.cmdId) {
    case 0xa0:
    case 0xa5:
      return true;
    case 0x8e:
      return frame.payload.length > 0 && frame.payload[0] === 0x00;
    default:
      return false;
  }
}

/** Pairing / Wi-Fi / live-control replies that can land before the waiter. */
export function shouldHoldReply(set: number, cmd: number): boolean {
  if (set === 0x07 && (cmd === 0x45 || cmd === 0x46 || cmd === 0x07 || cmd === 0x0e)) return true;
  if (set === 0x53 && cmd === 0x10) return true;
  return isLiveCameraControl(set, cmd);
}

export const hex = hexBytes;

/** Reflected CRC-8, init 0x77, poly 0x8C, over the 3 header bytes -> byte 3. */
export function crc8(data: ByteInput, start = 0, end = data.length): number {
  let c = 0x77;
  for (let i = start; i < end; i++) {
    c ^= data[i] & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8c : c >>> 1;
  }
  return c;
}

/** Reflected CRC-16, init 0x3692, poly 0x8408, over the whole frame minus the trailing CRC. */
export function crc16(data: ByteInput, start = 0, end = data.length): number {
  let c = 0x3692;
  for (let i = start; i < end; i++) {
    c ^= data[i] & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  }
  return c;
}

export function encodeFrame(f: DumlFrame | (Omit<DumlFrame, 'payload'> & { payload: ByteInput })): Uint8Array {
  const total = 13 + f.payload.length;
  const b = new Uint8Array(total);
  b[0] = 0x55;
  b[1] = total & 0xff;
  b[2] = (1 << 2) | ((total >> 8) & 0x03); // ver 1 + high length bits
  b[3] = crc8(b, 0, 3);
  b[4] = f.sender & 0xff;
  b[5] = f.receiver & 0xff;
  b[6] = f.seq & 0xff;
  b[7] = (f.seq >> 8) & 0xff;
  b[8] = f.flags & 0xff;
  b[9] = f.cmdSet & 0xff;
  b[10] = f.cmdId & 0xff;
  for (let i = 0; i < f.payload.length; i++) b[11 + i] = f.payload[i] & 0xff;
  const c = crc16(b, 0, total - 2);
  b[total - 2] = c & 0xff;
  b[total - 1] = (c >> 8) & 0xff;
  return b;
}

/**
 * Decode one frame at the start of `data`. Returns the frame and bytes consumed, or null if
 * `data` doesn't begin with a CRC-valid DUML frame. (Fork-only API.)
 */
export function decodeFrame(data: ByteInput): { frame: DumlFrame; consumed: number } | null {
  if (data.length < 13 || data[0] !== 0x55) return null;
  const total = data[1] | ((data[2] & 0x03) << 8);
  if (data[2] >> 2 !== 1 || total < 13 || data.length < total) return null;
  if (crc8(data, 0, 3) !== data[3]) return null;
  const got = data[total - 2] | (data[total - 1] << 8);
  if (crc16(data, 0, total - 2) !== got) return null;
  return { frame: frameAt(data, 0, total), consumed: total };
}

/** Build a frame from a validated span. */
export function frameAt(data: ByteInput, i: number, total: number): DumlFrame {
  const payload = new Uint8Array(total - 13);
  for (let k = 0; k < payload.length; k++) payload[k] = data[i + 11 + k];
  return {
    sender: data[i + 4],
    receiver: data[i + 5],
    seq: data[i + 6] | (data[i + 7] << 8),
    flags: data[i + 8],
    cmdSet: data[i + 9],
    cmdId: data[i + 10],
    payload,
  };
}

/** `[len:u8][utf8]` — how the WiFi subsystem packs strings (SSID, pass, PIN). */
export function packString(s: string): Uint8Array {
  const b = utf8Encode(s);
  return concat([b.length & 0xff], b);
}

/** A WiFi-subsystem reply is `[status:1][len:1][utf8…]`. Empty if truncated. */
export function unpackStatusString(p: ByteInput): string {
  if (p.length < 2) return '';
  const end = Math.min(2 + p[1], p.length);
  return utf8Decode(p, 2, end);
}

export function framesEqual(a: DumlFrame, b: DumlFrame): boolean {
  if (
    a.sender !== b.sender ||
    a.receiver !== b.receiver ||
    a.seq !== b.seq ||
    a.flags !== b.flags ||
    a.cmdSet !== b.cmdSet ||
    a.cmdId !== b.cmdId ||
    a.payload.length !== b.payload.length
  )
    return false;
  for (let i = 0; i < a.payload.length; i++) if (a.payload[i] !== b.payload[i]) return false;
  return true;
}
