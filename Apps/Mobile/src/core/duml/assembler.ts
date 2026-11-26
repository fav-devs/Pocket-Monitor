/**
 * One ordered BLE characteristic stream; notification boundaries are not DUML boundaries.
 * Source of truth: OpenCine `Sources/OpenCineDJI/DumlNotificationAssembler.swift` (same as fork).
 */
import type { ByteInput } from '../bytes';
import { crc16, crc8, type DumlFrame, frameAt } from './frame';

const LIMIT = 4096;

export class DumlNotificationAssembler {
  private pending: number[] = [];

  reset(): void {
    this.pending = [];
  }

  append(input: ByteInput): DumlFrame[] {
    if (input.length > LIMIT) {
      this.pending = [];
      return [];
    }
    if (this.pending.length + input.length > LIMIT) this.pending = [];
    for (let i = 0; i < input.length; i++) this.pending.push(input[i] & 0xff);
    const output: DumlFrame[] = [];
    const p = this.pending;
    let start = 0;
    while (p.length - start >= 4) {
      if (p[start] !== 0x55 || p[start + 2] >> 2 !== 1 || crc8(p, start, start + 3) !== p[start + 3]) {
        start += 1;
        continue;
      }
      const length = p[start + 1] | ((p[start + 2] & 3) << 8);
      if (length < 13) {
        start += 1;
        continue;
      }
      if (p.length - start < length) break;
      const checksum = p[start + length - 2] | (p[start + length - 1] << 8);
      if (crc16(p, start, start + length - 2) === checksum) {
        output.push(frameAt(p, start, length));
        start += length;
      } else {
        start += 1;
      }
    }
    if (start > 0) this.pending = p.slice(start);
    return output;
  }
}
