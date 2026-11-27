/**
 * Datalink handshake admission: evidence belonging to one UDP endpoint epoch.
 * Source of truth: OpenCine `Sources/OpenCineDJI/DatalinkHandshakeAdmission.swift` and
 * `MulticamCommands.controlSequence(fromInitialWindow:)`.
 */
import type { ByteInput } from '../bytes';
import { isHandshake, PktType } from './datalink';

/** A short handshake reply is not the camera's initial command window (exactly 34-byte 0x01). */
export function controlSequenceFromInitialWindow(b: ByteInput): number | null {
  if (b.length !== 34 || b[6] !== PktType.telemetry) return null;
  return ((b[8] | (b[9] << 8)) + 8) & 0xffff;
}

export class DatalinkHandshakeAdmission {
  private epoch = 0;
  private _acknowledged = false;
  private window: number | null = null;

  get acknowledged(): boolean {
    return this._acknowledged;
  }

  reset(epoch: number): void {
    if (epoch < this.epoch) return;
    this.epoch = epoch;
    this._acknowledged = false;
    this.window = null;
  }

  receive(bytes: ByteInput, epoch: number): void {
    if (epoch !== this.epoch) return;
    if (isHandshake(bytes)) this._acknowledged = true;
    if (this.window === null) this.window = controlSequenceFromInitialWindow(bytes);
  }

  get initialCommandSequence(): number | null {
    return this._acknowledged ? this.window : null;
  }

  get hasInitialWindow(): boolean {
    return this.window !== null;
  }
}
