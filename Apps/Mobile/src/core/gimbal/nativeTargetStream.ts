/**
 * A bounded, latest-target mailbox for native gimbal control (`0x04/0x14`) on the UDP queue.
 * Ownership tokens stop a late target/stop from affecting another controller.
 * Source of truth: OpenCine `OpenCineDJI/GimbalNativeTargetStream.swift`.
 * NATIVE: runs on the UDP queue next to the ACK pump; this is the reference implementation.
 */
import type { DumlFrame } from '../duml/frame';
import { GimbalStick } from './stick';

const samePayload = (a: Uint8Array | null, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

export class GimbalNativeTargetStream {
  private _token: number | null = null;
  private pending: DumlFrame | null = null;
  private lastPayload: Uint8Array | null = null;
  private submittedAt = 0;
  private emittedAt: number | null = null;

  get token(): number | null {
    return this._token;
  }

  begin(token: number): void {
    this.cancel();
    this._token = token;
  }

  submit(frame: DumlFrame, token: number, now: number): boolean {
    if (this._token !== token || !Number.isFinite(now) || frame.cmdSet !== 4 || frame.cmdId !== 0x14 || frame.payload.length !== 8) return false;
    this.submittedAt = now;
    if (samePayload(this.lastPayload, frame.payload)) return true;
    this.lastPayload = frame.payload;
    this.pending = frame;
    return true;
  }

  /** At most one target; never replays a backlog after a scheduling gap. */
  next(now: number, connectionReady = true): DumlFrame | null {
    if (this._token === null || !Number.isFinite(now) || !this.pending) return null;
    if (now < this.submittedAt || now - this.submittedAt > 0.2) {
      this.pending = null;
      this.lastPayload = null;
      return null;
    }
    if (!connectionReady) return null;
    if (this.emittedAt !== null && now - this.emittedAt < GimbalStick.streamInterval) return null;
    const f = this.pending;
    this.pending = null;
    this.emittedAt = now;
    return f;
  }

  /** A supplied stale token cannot cancel the current owner. */
  cancel(token?: number): boolean {
    if (token !== undefined && this._token !== token) return false;
    const was = this._token !== null;
    this._token = null;
    this.pending = null;
    this.lastPayload = null;
    this.emittedAt = null;
    return was;
  }
}

/** Refresh tilt/speed from attitude receipts at most once per second. */
export class GimbalParamPoll {
  private lastRequestAt: number | null = null;
  shouldRequest(now: number): boolean {
    if (this.lastRequestAt !== null && now - this.lastRequestAt < 1) return false;
    this.lastRequestAt = now;
    return true;
  }
}
