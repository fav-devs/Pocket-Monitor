/**
 * Gimbal stick: `0x04/0x01` axis encoding, response curves, `0x04/0x05` attitude decode and the
 * face / 180° rotation bookkeeping (`GimbalStickMapping`).
 *
 * Source of truth: OpenCine `OpenCineCameraVocabulary/CameraControl.swift` (`GimbalStick`,
 * `GimbalStickMapping`) + `OpenCineDJI/CameraControl+DJIWire.swift` (attitude layouts, encode).
 * Not ported: on-screen TouchMapping / TapSequence and the chrome-luma helpers (UI side).
 *
 * NATIVE: the stick stream itself (25 Hz while held, one centre on lift) must be emitted from the
 * native UDP queue; JS only supplies the latest axes.
 */
import { type ByteInput, i16le } from '../bytes';
import { roundHalfAway } from '../math';
import type { GimbalFace } from '../commands/vocabulary';
import type { GimbalNativePitchWire } from './reach';

export type ResponseCurve = 'linear' | 'standard' | 'fine';
export interface StickMapping {
  invertPan: boolean;
  invertTilt: boolean;
  deadzone: number;
  curve: ResponseCurve;
}

export const GimbalStick = {
  center: 1024,
  travel: 550,
  min: 474,
  max: 1574,
  deadzone: 0.08,
  analogExpo: 2,
  sensitivityMin: 1,
  sensitivityMax: 5,
  defaultSensitivity: 4,
  streamInterval: 0.04,
  videoGrace: 3,
  rotated180TenthDeg: 900,
  settle180TenthDeg: 1650,
  settleFrontTenthDeg: 150,
  poseSeedFrontVotes: 3,
  tapSlop: 0.18,
  doubleTapWindow: 0.35,
  attitudeLength: 50,

  curveExpo(c: ResponseCurve): number {
    return c === 'linear' ? 1 : c === 'fine' ? 3 : 2;
  },
  clampedSensitivity(v: number): number {
    return Math.min(Math.max(v, 1), 5);
  },
  clampedDeadzone(v: number): number {
    if (!Number.isFinite(v)) return 0.08;
    return Math.min(Math.max(v, 0), 0.25);
  },
  mapping(partial: Partial<StickMapping> = {}): StickMapping {
    return {
      invertPan: partial.invertPan ?? false,
      invertTilt: partial.invertTilt ?? false,
      deadzone: GimbalStick.clampedDeadzone(partial.deadzone ?? 0.08),
      curve: partial.curve ?? 'standard',
    };
  },
  sensitivityGain(v: number): number {
    return GimbalStick.clampedSensitivity(v) / 4;
  },
  linearThrow(normalized: number, zone = 0.08): number {
    const n = Math.min(Math.max(normalized, -1), 1);
    const mag = Math.abs(n);
    const rest = GimbalStick.clampedDeadzone(zone);
    if (mag < rest) return 0;
    const span = 1 - rest;
    if (span <= 0) return 0;
    const t = (mag - rest) / span;
    return n < 0 ? -t : t;
  },
  analogCurve(normalized: number, zone = 0.08, expo = 2): number {
    const t = GimbalStick.linearThrow(normalized, zone);
    if (t === 0) return 0;
    const power = Number.isFinite(expo) && expo > 0 ? expo : 2;
    const curved = Math.pow(Math.abs(t), power);
    return t < 0 ? -curved : curved;
  },
  axis(normalized: number, sensitivity = 4, mapping: StickMapping = DEFAULT_MAPPING): number {
    const curved = GimbalStick.analogCurve(normalized, mapping.deadzone, GimbalStick.curveExpo(mapping.curve));
    if (curved === 0) return 1024;
    const scaled = Math.min(Math.max(curved * GimbalStick.sensitivityGain(sensitivity), -1), 1);
    return Math.min(Math.max(roundHalfAway(1024 + scaled * 550), 474), 1574);
  },
  axisLinear(normalized: number): number {
    const n = Math.min(Math.max(normalized, -1), 1);
    if (Math.abs(n) < 0.02) return 1024;
    return Math.min(Math.max(roundHalfAway(1024 + n * 550), 474), 1574);
  },
  radialThrow(a: number, b: number, sensitivity = 4, mapping: StickMapping = DEFAULT_MAPPING): [number, number] {
    const aa = Number.isFinite(a) ? a : 0;
    const bb = Number.isFinite(b) ? b : 0;
    const length = Math.hypot(aa, bb);
    if (!(length > 0)) return [0, 0];
    const curved = GimbalStick.analogCurve(Math.min(length, 1), mapping.deadzone, GimbalStick.curveExpo(mapping.curve));
    const scaled = Math.min(curved * GimbalStick.sensitivityGain(sensitivity), 1);
    return [(aa / length) * scaled, (bb / length) * scaled];
  },
  wireAxis(value: number): number {
    if (value === 0) return 1024;
    return Math.min(Math.max(roundHalfAway(1024 + Math.min(Math.max(value, -1), 1) * 550), 474), 1574);
  },
  /**
   * `x` −1…1 left…right → pan (axis1). `y` −1…1 down…up → tilt (axis0).
   * `linear` skips expo (head-tracking look-at).
   */
  encode(
    x: number,
    y: number,
    opts: { invertPan?: boolean; sensitivity?: number; linear?: boolean; mapping?: StickMapping } = {},
  ): { axis0: number; axis1: number } {
    const invertPan = opts.invertPan ?? false;
    const mapping = opts.mapping ?? DEFAULT_MAPPING;
    if (opts.linear) {
      const pan = invertPan ? -x : x;
      return { axis0: GimbalStick.axisLinear(y), axis1: GimbalStick.axisLinear(pan) };
    }
    const pan = invertPan !== mapping.invertPan ? -x : x;
    const tilt = mapping.invertTilt ? -y : y;
    const [ct, cp] = GimbalStick.radialThrow(tilt, pan, opts.sensitivity ?? 4, mapping);
    return { axis0: GimbalStick.wireAxis(ct), axis1: GimbalStick.wireAxis(cp) };
  },
  invertPanFor(face: GimbalFace | null | undefined): boolean {
    return face === 'selfie';
  },
  shouldEmit(held: boolean, restPending: boolean, now: number, lastEmitted: number): boolean {
    if (restPending) return true;
    if (!held) return false;
    if (lastEmitted === 0) return true;
    return now - lastEmitted >= 0.04;
  },
  shouldEmitOnSocket(rest: boolean, liveAccepting: boolean, hasConnection: boolean): boolean {
    if (!hasConnection) return false;
    if (rest) return true;
    return liveAccepting;
  },
  isTap(normalizedMagnitude: number): boolean {
    return normalizedMagnitude < 0.18;
  },
  shouldHoldWatchdog(secondsSinceThrow: number | null, lastVideoPacketAge: number | null = null, stickHeld = false, stallThreshold = 2): boolean {
    if (stickHeld) return true;
    if (secondsSinceThrow == null) return false;
    if (secondsSinceThrow < 0 || secondsSinceThrow >= 3) return false;
    if (lastVideoPacketAge != null && lastVideoPacketAge >= stallThreshold + 3) return false;
    return true;
  },
  rotationSettled(yawTenthDeg: number, want180: boolean): boolean {
    const a = Math.abs(yawTenthDeg);
    return want180 ? a >= 1650 : a <= 150;
  },
  fe09GoesTo180(yawTenthDeg: number | null): boolean {
    return yawTenthDeg == null ? true : Math.abs(yawTenthDeg) <= 900;
  },

  // ---- attitude (`0x04/0x05`) ----
  i16LE(p: ByteInput, offset: number): number | null {
    return p.length >= offset + 2 ? i16le(p, offset) : null;
  },
  /** 50 = full layout (Pocket 3 old fw, Pocket 4); 49 = Pocket 3 compact. Anything else fails closed. */
  attitudeLayout(p: ByteInput): 'full' | 'pocket3Compact' | null {
    return p.length === 50 ? 'full' : p.length === 49 ? 'pocket3Compact' : null;
  },
  nativePitchWire(layout: 'full' | 'pocket3Compact'): GimbalNativePitchWire {
    return layout === 'full' ? 'wrapped' : 'continuous';
  },
  isAttitude: (p: ByteInput) => p.length === 50 || p.length === 49,
  yawTenthDeg(p: ByteInput): number | null {
    return GimbalStick.isAttitude(p) ? i16le(p, 4) : null;
  },
  rotated180(p: ByteInput): boolean | null {
    const y = GimbalStick.yawTenthDeg(p);
    return y == null ? null : Math.abs(y) > 900;
  },
  nativePitchTenthDeg(p: ByteInput): number | null {
    return GimbalStick.isAttitude(p) ? i16le(p, 0) : null;
  },
  /** Tilt 0.1° from i16-LE `@20`, negated so look-up is positive (wrapping Int16 negate). */
  pitchTenthDeg(p: ByteInput): number | null {
    if (!GimbalStick.isAttitude(p)) return null;
    const raw = i16le(p, 20);
    return raw === -32768 ? -32768 : -raw;
  },
  attitudeAngleDump(p: ByteInput): string {
    const parts = [`n=${p.length}`];
    for (let o = 0; o + 2 <= p.length; o += 2) {
      const v = i16le(p, o);
      if (Math.abs(v) <= 3600) parts.push(`@${o}=${v}`);
    }
    const dv = new DataView(new ArrayBuffer(4));
    for (let o = 0; o + 4 <= p.length; o += 4) {
      for (let i = 0; i < 4; i++) dv.setUint8(i, p[o + i]);
      const f = dv.getFloat32(0, true);
      if (Number.isFinite(f) && Math.abs(f) >= 0.5 && Math.abs(f) <= 200) parts.push(`f@${o}=${f.toFixed(1)}`);
    }
    return parts.join(' ');
  },
};

const DEFAULT_MAPPING: StickMapping = { invertPan: false, invertTilt: false, deadzone: 0.08, curve: 'standard' };
export const DEFAULT_STICK_MAPPING = DEFAULT_MAPPING;

/** Face + 180° rotation bookkeeping fed by body face reports and attitude. */
export class GimbalStickMapping {
  face: GimbalFace | null = null;
  wireFace: GimbalFace | null = null;
  rotated180 = false;
  holdFace = false;
  seenFront = false;
  rotateParity = false;
  commanded180 = false;
  selfieFlip = false;
  pendingWant180: boolean[] = [];
  yawTenthDeg: number | null = null;
  pitchTenthDeg: number | null = null;
  poseSeeded = false;
  poseSeedFrontCount = 0;

  constructor(init: Partial<GimbalStickMapping> = {}) {
    Object.assign(this, init);
  }

  get poseViewFlip(): boolean {
    return this.commanded180 && !this.selfieFlip;
  }
  get invertPan(): boolean {
    return this.commanded180;
  }

  noteAppMotion(): void {
    if (this.poseSeeded || this.pendingWant180.length > 0 || this.yawTenthDeg == null) return;
    this.poseSeeded = true;
    this.poseSeedFrontCount = 0;
  }

  noteRotate180(fromBody = false): void {
    if (!fromBody) this.holdFace = true;
    this.pendingWant180.push(GimbalStick.fe09GoesTo180(this.yawTenthDeg));
  }

  noteBodyFace(next: GimbalFace | null): boolean {
    const previous = this.wireFace;
    const wasHold = this.holdFace;
    this.applyFace(next);
    if (wasHold || previous == null || next == null || next === previous) return false;
    this.commanded180 = next === 'selfie';
    this.poseSeeded = true;
    this.poseSeedFrontCount = 0;
    return true;
  }

  applyFace(next: GimbalFace | null): boolean {
    if (next == null) return false;
    if (next === 'front') this.seenFront = true;
    if (next === 'selfie' && !this.seenFront) return false;
    if (this.holdFace) {
      if (this.wireFace == null) {
        this.wireFace = next;
        return false;
      }
      if (next === this.wireFace) return false;
      this.wireFace = next;
      this.rotateParity = !this.rotateParity;
      this.holdFace = false;
      return false;
    }
    this.wireFace = next;
    const decoded: GimbalFace = (next === 'selfie') !== this.rotateParity ? 'selfie' : 'front';
    const changed = this.face !== decoded;
    this.face = decoded;
    return changed;
  }

  applyAttitude(payload: ByteInput): void {
    const yaw = GimbalStick.yawTenthDeg(payload);
    if (yaw == null) return;
    const rotated = Math.abs(yaw) > GimbalStick.rotated180TenthDeg;
    if (this.pendingWant180.length > 0) {
      const want180 = this.pendingWant180[0];
      if (GimbalStick.rotationSettled(yaw, want180)) {
        this.commanded180 = want180;
        this.pendingWant180.shift();
        this.poseSeeded = true;
        this.poseSeedFrontCount = 0;
      }
    } else if (!this.poseSeeded) {
      if (rotated) {
        this.commanded180 = true;
        this.poseSeeded = true;
        this.poseSeedFrontCount = 0;
      } else if (GimbalStick.rotationSettled(yaw, false)) {
        this.poseSeedFrontCount += 1;
        if (this.poseSeedFrontCount >= GimbalStick.poseSeedFrontVotes) {
          this.commanded180 = false;
          this.poseSeeded = true;
        }
      } else {
        this.poseSeedFrontCount = 0;
      }
    }
    this.rotated180 = rotated;
    this.yawTenthDeg = yaw;
    const pitch = GimbalStick.pitchTenthDeg(payload);
    if (pitch != null) this.pitchTenthDeg = pitch;
  }
}
