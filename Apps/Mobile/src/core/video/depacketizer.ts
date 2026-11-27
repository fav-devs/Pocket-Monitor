/**
 * Reassembles Osmo live video (pktType 0x02) into Annex-B access units.
 *
 * A DJI marker `00 00 01 ff` carries a 16-byte header with the LE encoded byte count. Sized frames
 * validate the transport sequence (+8 per packet) and emit on their final packet; a large Nano
 * picture spans several transport groups. Older/unsized input uses the frame-number group fallback.
 *
 * Source of truth: OpenCine `OpenCineDJI/HevcDepacketizer.swift` (identical to fork).
 *
 * NATIVE (hot path): this exact algorithm must run in Swift/Kotlin on the UDP receive queue; the
 * TS version is the tested reference and is used for tests / web relay tooling only.
 */
import type { ByteInput } from '../bytes';
import { stripDjiMarker } from './nal';

const MAX_ENCODED_BYTES = 4 * 1024 * 1024;

const isMarker = (p: ByteInput, at: number) => p.length >= at + 4 && p[at] === 0 && p[at + 1] === 0 && p[at + 2] === 1 && p[at + 3] === 0xff;

function declaredSize(p: ByteInput, at: number): number | null {
  if (p.length - at < 16 || !isMarker(p, at)) return null;
  const count = (p[at + 4] | (p[at + 5] << 8) | (p[at + 6] << 16)) + p[at + 7] * 0x1000000;
  if (count <= 0 || count > MAX_ENCODED_BYTES) return null;
  return count + 16;
}

export class HevcDepacketizer {
  private sizedMode = false;
  private expectedSize: number | null = null;
  private sizedBuffer: number[] = [];
  private lastSizedSequence: number | null = null;
  private currentFrame: number | null = null;
  private buffer: number[] = [];
  private lastPosition: number | null = null;
  private corrupt = false;
  /** Frames dropped because a fragment was missing or reordered. */
  droppedIncomplete = 0;

  /** Returns a finished, complete access unit when its final packet arrives (or a legacy group ends). */
  feed(payload: ByteInput): Uint8Array | null {
    if (payload.length <= 20 || payload[6] !== 0x02) return null;
    const marker = isMarker(payload, 20);
    const declared = declaredSize(payload, 20);
    const bodyLen = payload.length - 20;
    const nonzeroDeclaration = marker && bodyLen >= 16 && (payload[24] | payload[25] | payload[26] | payload[27]) !== 0;
    if (this.sizedMode || nonzeroDeclaration) {
      if (!this.sizedMode) {
        this.sizedMode = true;
        this.buffer = [];
      }
      return this.feedSized(payload, marker, declared);
    }
    const frameNo = payload[16];
    const position = payload[18] * 2 + (payload[17] >> 7);
    let completed: Uint8Array | null = null;
    if (this.currentFrame !== null && this.currentFrame !== frameNo) {
      if (this.buffer.length) {
        if (this.corrupt) this.droppedIncomplete += 1;
        else completed = stripDjiMarker(this.buffer);
      }
      this.buffer = [];
      this.corrupt = false;
      this.lastPosition = null;
    }
    this.currentFrame = frameNo;
    if (this.lastPosition !== null) {
      const last = this.lastPosition;
      if (position === last) return completed; // UDP dup
      if (position < last) {
        if (this.buffer.length) {
          if (this.corrupt) this.droppedIncomplete += 1;
          else completed = stripDjiMarker(this.buffer);
        }
        this.buffer = [];
        this.corrupt = false;
      } else if (position !== last + 1) this.corrupt = true;
    }
    this.lastPosition = position;
    if (bodyLen <= MAX_ENCODED_BYTES + 16 - this.buffer.length) {
      for (let i = 20; i < payload.length; i++) this.buffer.push(payload[i]);
    } else this.corrupt = true;
    return completed;
  }

  private feedSized(packet: ByteInput, marker: boolean, declared: number | null): Uint8Array | null {
    const sequence = packet[4] | (packet[5] << 8);
    if (sequence === this.lastSizedSequence) return null;
    if (marker) {
      if (this.expectedSize !== null) this.droppedIncomplete += 1;
      this.sizedBuffer = [];
      this.expectedSize = declared;
      this.lastSizedSequence = null;
    }
    const expected = this.expectedSize;
    if (expected === null) return null;
    if (this.lastSizedSequence !== null && sequence !== ((this.lastSizedSequence + 8) & 0xffff)) {
      this.droppedIncomplete += 1;
      this.expectedSize = null;
      this.sizedBuffer = [];
      this.lastSizedSequence = sequence;
      return null;
    }
    this.lastSizedSequence = sequence;
    const bodyLen = packet.length - 20;
    if (bodyLen > expected - this.sizedBuffer.length) {
      this.droppedIncomplete += 1;
      this.expectedSize = null;
      this.sizedBuffer = [];
      return null;
    }
    for (let i = 20; i < packet.length; i++) this.sizedBuffer.push(packet[i]);
    if (this.sizedBuffer.length !== expected) return null;
    const au = Uint8Array.from(this.sizedBuffer.slice(16));
    this.sizedBuffer = [];
    this.expectedSize = null;
    return au;
  }

  reset(): void {
    this.sizedMode = false;
    this.expectedSize = null;
    this.sizedBuffer = [];
    this.lastSizedSequence = null;
    this.currentFrame = null;
    this.buffer = [];
    this.lastPosition = null;
    this.corrupt = false;
    this.droppedIncomplete = 0;
  }
}
