/**
 * DUML-over-UDP datalink framing: the 8-byte transport header, the 12-byte command routing
 * header, the fixed handshake / ACK payloads, ACK window bookkeeping and frame scanning.
 *
 * Source of truth: OpenCine `Sources/OpenCineDJI/DumlTransport.swift` (upstream is newer than
 * this fork: telemetry may advance the reliable/download cursor *forward only*, including
 * wraparound — the fork refused all telemetry updates once a 0x03 had been seen).
 * Sequencing (`DatalinkSequencer`) mirrors the stateful half in
 * `OpenCineDJIApple/DjiAppleDatalink.swift` (`resetHandshakeSession`, `sendDumlOnQueue`, `sendAck`).
 *
 * Per packet the wire is `[8B transport hdr][12B routing hdr][DUML frame]`.
 *
 * ─── HOT PATH: what modules/opc-native MUST implement natively (Swift + Kotlin) ───────────────
 * JS must never sit on the per-packet path. This file is the tested reference those ports copy:
 *  1. UDP socket to 192.168.2.1:9004 bound to an *ephemeral* local port (see docs/live-session.md).
 *  2. Handshake: `handshakeDatagram` with a fresh random 8-aligned `baseSeq` and random session id,
 *     admission via `DatalinkHandshakeAdmission` (ACK 0x00 + 34-byte 0x01 initial window).
 *  3. ACK pump: pktType 0x04 at **40 Hz** on the UDP queue, payload =
 *     `ackPayload(videoCursor, windowCursor(ackedData), windowCursor(extra))`, seq 0, updated by
 *     `AckWindows.advancing(datagram)` for every inbound datagram and by the latest 0x02 seq.
 *  4. Every UDP write (ACK, command, gimbal stick 0x04/0x01 at 25 Hz) serializes on ONE queue with
 *     `DatalinkSequencer` semantics (dumlSeq+1, cmdCounter+1, udpSeq+8 per command packet).
 *  5. pktType 0x02 video ingest → `HevcDepacketizer` (src/core/video) → decoder.
 * JS (src/core) keeps: command building, reply parsing, status decode and session policy.
 */
import { type ByteInput, concat, u16le } from '../bytes';
import { crc16, crc8, type DumlFrame, encodeFrame, frameAt } from '../duml/frame';

export const PktType = {
  /** session open */
  handshake: 0x00,
  /** peer status push */
  telemetry: 0x01,
  /** HEVC/AVC live-view fragments (best-effort) */
  video: 0x02,
  ackedData: 0x03,
  /** window acknowledgement */
  ack: 0x04,
  /** carries a routing header + DUML frame */
  command: 0x05,
} as const;
export type PktTypeValue = (typeof PktType)[keyof typeof PktType];

/** Transport sequence (bytes 4–5). */
export function transportSeq(datagram: ByteInput): number | null {
  if (datagram.length < 6) return null;
  return u16le(datagram, 4);
}

/** Session-open reply. Byte 6 is pktType; do not require our session/seq. */
export function isHandshake(datagram: ByteInput): boolean {
  return datagram.length >= 8 && datagram[6] === PktType.handshake;
}

/** `[u16le 0x8000|total][u16le session][u16le seq][u8 pktType][u8 xor]`, total = 8 + payloadLen. */
export function transportHeader(pktType: number, payloadLen: number, sessionId: number, seq: number): Uint8Array {
  const total = 8 + payloadLen;
  const w0 = 0x8000 | (total & 0x3fff);
  const b = new Uint8Array(8);
  b[0] = w0 & 0xff;
  b[1] = (w0 >> 8) & 0xff;
  b[2] = sessionId & 0xff;
  b[3] = (sessionId >> 8) & 0xff;
  b[4] = seq & 0xff;
  b[5] = (seq >> 8) & 0xff;
  b[6] = pktType & 0xff;
  b[7] = b[0] ^ b[1] ^ b[2] ^ b[3] ^ b[4] ^ b[5] ^ b[6];
  return b;
}

/**
 * 12-byte routing header (pkt `0x05`): `[u16le ack=seq-8][u16le seq][00 00 00 00][u8 counter][01][drone?60:00][00]`.
 * Both seq fields are in OUR OWN command-seq space. Getting this wrong silently drops writes.
 */
export function routingHeader(seq: number, cmdCounter: number, drone = false): Uint8Array {
  const ack = (seq - 8) & 0xffff;
  return Uint8Array.from([
    ack & 0xff,
    (ack >> 8) & 0xff,
    seq & 0xff,
    (seq >> 8) & 0xff,
    0,
    0,
    0,
    0,
    cmdCounter & 0xff,
    0x01,
    drone ? 0x60 : 0x00,
    0x00,
  ]);
}

const HANDSHAKE_TEMPLATE = [
  0x00, 0x00, 0x64, 0x00, 0x64, 0x00, 0xc0, 0x05, 0x14, 0x00, 0x00, 0x64, 0x00, 0x00, 0x01, 0x90, 0x01, 0xc0, 0x05,
  0x14, 0x00, 0x00, 0x64, 0x00, 0x14, 0x00, 0x64, 0x00, 0xc0, 0x05, 0x14, 0x00, 0x00, 0x64, 0x00, 0x01, 0x01, 0x04,
  0x01, 0x02,
];

/** 40-byte handshake payload; first two bytes are `baseSeq` LE (fresh random 8-aligned per connect). */
export function handshakePayload(baseSeq: number): Uint8Array {
  const p = Uint8Array.from(HANDSHAKE_TEMPLATE);
  p[0] = baseSeq & 0xff;
  p[1] = (baseSeq >> 8) & 0xff;
  return p;
}

/** Full 48-byte session-open datagram. */
export function handshakeDatagram(sessionId: number, seq: number, baseSeq: number): Uint8Array {
  const payload = handshakePayload(baseSeq);
  return concat(transportHeader(PktType.handshake, payload.length, sessionId, seq), payload);
}

/**
 * Three window cursors in a pktType-0x04 ACK (and in 34-byte pktType-0x01 telemetry).
 * Group 0 video (`0x02`), group 1 reliable command/download data, group 2 extra.
 */
export interface AckWindows {
  video: number;
  ackedData: number;
  extra: number;
  /** Group 1 seeded (telemetry) or advanced (`0x03`). Seq `0` is valid. */
  hasAckedData: boolean;
  /** Group 2 seeded from 34-byte `0x01`. */
  hasExtra: boolean;
}

export function emptyAckWindows(partial: Partial<AckWindows> = {}): AckWindows {
  return { video: 0, ackedData: 0, extra: 0, hasAckedData: false, hasExtra: false, ...partial };
}

export const AckWindowPolicy = {
  shouldSeedCursorFromTelemetry(hasSeq: boolean): boolean {
    return !hasSeq;
  },
  shouldSeedVideoCursorFromTelemetry(hasVideoSeq: boolean): boolean {
    return !hasVideoSeq;
  },
  /** `0` is a valid 8-aligned seq. Do not treat it as "missing" once seen. */
  windowCursor(stored: number, seen: boolean, fallback: number): number {
    return seen ? stored : fallback;
  },
  /** Forward half of the u16 ring only. */
  isForward(candidate: number, current: number): boolean {
    const delta = (candidate - current) & 0xffff;
    return delta !== 0 && delta < 0x8000;
  },
};

function advanced(stored: number, seen: boolean, candidate: number): [number, boolean] {
  if (!seen || candidate === stored || AckWindowPolicy.isForward(candidate, stored)) return [candidate, true];
  return [stored, seen];
}

/** Pure: next windows after one inbound datagram. Video (0x02) is tracked separately. */
export function advanceAckWindows(w: AckWindows, datagram: ByteInput): AckWindows {
  const next = { ...w };
  if (datagram.length < 8) return next;
  switch (datagram[6]) {
    case PktType.telemetry: {
      const t = ackWindowsFromTelemetry(datagram);
      if (t) {
        [next.ackedData, next.hasAckedData] = advanced(next.ackedData, next.hasAckedData, t.ackedData);
        next.extra = t.extra;
        next.hasExtra = true;
      }
      break;
    }
    case PktType.ackedData: {
      const seq = transportSeq(datagram);
      if (seq !== null) [next.ackedData, next.hasAckedData] = advanced(next.ackedData, next.hasAckedData, seq);
      break;
    }
    default:
      break;
  }
  return next;
}

export function ackWindowsEqual(a: AckWindows, b: AckWindows): boolean {
  return (
    a.video === b.video &&
    a.ackedData === b.ackedData &&
    a.extra === b.extra &&
    a.hasAckedData === b.hasAckedData &&
    a.hasExtra === b.hasExtra
  );
}

/** 34-byte pktType-0x01 telemetry: cursors at bytes 10/18/26. */
export function ackWindowsFromTelemetry(datagram: ByteInput): AckWindows | null {
  if (datagram.length < 34 || datagram[6] !== PktType.telemetry) return null;
  return emptyAckWindows({ video: u16le(datagram, 10), ackedData: u16le(datagram, 18), extra: u16le(datagram, 26) });
}

function grp(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, v & 0xff, (v >> 8) & 0xff, 0, 0, 0, 0];
}

/**
 * The 26-byte pktType-0x04 ACK payload. Two-arg form (`baseSeq`) repeats the handshake base in
 * groups 1 and 2 (seed before any `0x03` / telemetry).
 */
export function ackPayload(peerCursor: number, ackedDataCursor: number, extraCursor: number = ackedDataCursor): Uint8Array {
  return Uint8Array.from([...grp(peerCursor), ...grp(ackedDataCursor), ...grp(extraCursor), 0, 0]);
}

/**
 * Every CRC-valid DUML frame in `raw`, scanning byte-at-a-time so it finds frames inside the
 * transport/routing wrapper and tolerates multiple frames per datagram.
 */
export function scanFrames(raw: ByteInput): DumlFrame[] {
  const out: DumlFrame[] = [];
  const n = raw.length;
  let i = 0;
  while (i + 13 <= n) {
    if (raw[i] !== 0x55) {
      i += 1;
      continue;
    }
    const total = raw[i + 1] | ((raw[i + 2] & 0x03) << 8);
    if (raw[i + 2] >> 2 !== 1 || total < 13 || i + total > n) {
      i += 1;
      continue;
    }
    const end = i + total;
    if (crc8(raw, i, i + 3) !== raw[i + 3]) {
      i += 1;
      continue;
    }
    const got = raw[end - 2] | (raw[end - 1] << 8);
    if (crc16(raw, i, end - 2) !== got) {
      i += 1;
      continue;
    }
    out.push(frameAt(raw, i, total));
    i += 1;
  }
  return out;
}

/**
 * Stateful sequence counters for one datalink session (JS reference for the native queue).
 * - session id: random 0x1000…0xFFFE per handshake
 * - baseSeq: random 0x1000…0xF000, 8-aligned
 * - udpSeq: starts 0, +8 after the handshake, then reseeded from the admitted initial window
 * - dumlSeq: starts 0xA000, +1 per command
 * - cmdCounter: u8, +1 per command
 */
export class DatalinkSequencer {
  sessionId = 0;
  baseSeq = 0;
  udpSeq = 0;
  dumlSeq = 0xa000;
  cmdCounter = 0;

  constructor(private readonly random: () => number = Math.random) {
    this.reset();
  }

  reset(): void {
    this.sessionId = 0x1000 + Math.floor(this.random() * (0xfffe - 0x1000 + 1));
    this.baseSeq = (0x1000 + Math.floor(this.random() * (0xf000 - 0x1000 + 1))) & 0xfff8;
    this.udpSeq = 0;
    this.dumlSeq = 0xa000;
    this.cmdCounter = 0;
  }

  /** The handshake open; advances udpSeq by 8 like the Swift driver. */
  handshake(): Uint8Array {
    const pkt = handshakeDatagram(this.sessionId, this.udpSeq, this.baseSeq);
    this.udpSeq = (this.udpSeq + 8) & 0xffff;
    return pkt;
  }

  /** Reseed the command window once `DatalinkHandshakeAdmission.initialCommandSequence` is known. */
  admit(initialCommandSequence: number): void {
    this.udpSeq = initialCommandSequence & 0xffff;
  }

  /** Stamp a command frame (overwrites `frame.seq`) and wrap it in transport + routing headers. */
  command(frame: DumlFrame, drone = false): { seq: number; packet: Uint8Array } {
    this.cmdCounter = (this.cmdCounter + 1) & 0xff;
    const seq = this.dumlSeq;
    this.dumlSeq = (this.dumlSeq + 1) & 0xffff;
    const duml = encodeFrame({ ...frame, seq });
    const routing = routingHeader(this.udpSeq, this.cmdCounter, drone);
    const header = transportHeader(PktType.command, routing.length + duml.length, this.sessionId, this.udpSeq);
    this.udpSeq = (this.udpSeq + 8) & 0xffff;
    return { seq, packet: concat(header, routing, duml) };
  }

  /** pktType-0x04 window ACK, transport seq 0. */
  ack(videoCursor: number, windows: AckWindows): Uint8Array {
    const payload = ackPayload(
      videoCursor,
      AckWindowPolicy.windowCursor(windows.ackedData, windows.hasAckedData, this.baseSeq),
      AckWindowPolicy.windowCursor(windows.extra, windows.hasExtra, this.baseSeq),
    );
    return concat(transportHeader(PktType.ack, payload.length, this.sessionId, 0), payload);
  }
}
