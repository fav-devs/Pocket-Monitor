/**
 * Reply / blob parsers for camera control (`0x02/*`) and gimbal param replies.
 * Source of truth: OpenCine `OpenCineDJI/CameraControl+DJIWire.swift`.
 */
import { type ByteInput, f32le, i16le, u16le } from '../bytes';
import type { DumlFrame } from '../duml/frame';
import { CameraParam, Commands } from './commands';
import {
  type ApertureStrategy,
  type DirectionalAudio,
  EvComp,
  ExpoMode,
  type FocusMode,
  type FocusTrackMode,
  type GimbalFace,
  type GimbalMode,
  type GimbalModeFamily,
  type GimbalParamState,
  type GimbalSpeed,
  GimbalSpeed as GS,
  GimbalTiltLock,
  type IsoIndex,
  IsoIndexes,
  type WhiteBalance,
  WhiteBalanceMode,
  WindNoiseReduction,
  type WindNoiseReduction as WNR,
  wbAuto,
  wbCustom,
} from './vocabulary';

/** Reply oracle (payload first byte). */
export type CameraReply = 'ok' | 'wrongState' | 'badParameter' | 'unsupported' | { other: number };
export const CameraReplies = {
  parse(payload: ByteInput): CameraReply {
    if (payload.length === 0) return { other: 0xff };
    const b = payload[0];
    if (b === 0x00) return 'ok';
    if (b === 0xd9) return 'wrongState';
    if (b === 0xdf || b === 0xe3 || b === 0xee) return 'badParameter';
    if (b === 0xe0) return 'unsupported';
    return { other: b };
  },
  isSuccess: (r: CameraReply) => r === 'ok',
  message(r: CameraReply): string {
    if (r === 'ok') return 'ok';
    if (r === 'wrongState') return 'camera rejected that in this mode';
    if (r === 'badParameter') return 'camera rejected that value';
    if (r === 'unsupported') return 'camera does not support that command';
    return `camera reply 0x${r.other.toString(16).toUpperCase().padStart(2, '0')}`;
  },
};

export const CameraParams = {
  /** GET reply `00 00 01 <pid u16-LE> 01 <value>`. A SET ACK is a lone `00`. */
  parseGetReply(p: ByteInput): { pid: number; value: number } | null {
    if (p.length < 7 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1 || p[5] !== 1) return null;
    return { pid: u16le(p, 3), value: p[6] };
  },
  isSelfieFlipGetReply(set: number, cmd: number, payload: ByteInput): boolean {
    return set === 0x02 && cmd === 0x8e && CameraParams.parseGetReply(payload)?.pid === CameraParam.selfieFlip;
  },
  /** GET reply `00 00 01 <pid u16-LE> <len> <blob>`. */
  parseBlobReply(p: ByteInput): { pid: number; value: Uint8Array } | null {
    if (p.length < 6 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1) return null;
    const len = p[5];
    if (len < 1 || p.length < 6 + len) return null;
    return { pid: u16le(p, 3), value: Uint8Array.from(Array.prototype.slice.call(p, 6, 6 + len) as number[]) };
  },
};

export const GlamourEffect = {
  blobLength: 62,
  enableOffset: 5,
  blob(fromGetReply: ByteInput): Uint8Array | null {
    const parsed = CameraParams.parseBlobReply(fromGetReply);
    if (!parsed || parsed.pid !== CameraParam.glamour || parsed.value.length !== 62) return null;
    return parsed.value;
  },
  isEnabled: (blob: ByteInput) => blob.length > 5 && blob[5] !== 0,
  disabled(blob: ByteInput): Uint8Array | null {
    if (blob.length !== 62) return null;
    const next = Uint8Array.from(blob);
    next[5] = 0;
    return next;
  },
};

/** `cam_expo_param` fields. */
export const ExpoParam = {
  expoMode(value: ByteInput): ExpoMode | null {
    if (value.length <= 7) return null;
    return value[7] === ExpoMode.auto || value[7] === ExpoMode.manual ? (value[7] as ExpoMode) : null;
  },
  /** Auto: applied shutter `@20–22`; manual: `@2–4`. */
  shutterDenom(value: ByteInput): number | null {
    if (ExpoParam.expoMode(value) === ExpoMode.auto) {
      if (value.length < 23 || (value[21] & 0x80) === 0 || value[22] !== 0) return null;
      const denom = u16le(value, 20) & 0x7fff;
      return denom >= 1 && denom <= 16000 ? denom : null;
    }
    if (value.length < 4) return null;
    const denom = u16le(value, 2) & 0x7fff;
    return denom >= 1 && denom <= 16000 ? denom : null;
  },
  isoIndex(value: ByteInput): IsoIndex | null {
    return value.length > 5 ? IsoIndexes.fromDjiWire(value[5]) : null;
  },
  /** `@6` configured EV thirds. */
  evComp(value: ByteInput): number | null {
    return value.length > 6 ? EvComp.fromRaw(value[6]) : null;
  },
  /** `@15` metered EV thirds. */
  meteredEv(value: ByteInput): number | null {
    return value.length > 15 ? EvComp.fromRaw(value[15]) : null;
  },
  /** `@16` u16-LE ISO number (50…102400). */
  isoValue(value: ByteInput): number | null {
    if (value.length < 18) return null;
    const iso = u16le(value, 16);
    return iso >= 50 && iso <= 102400 ? iso : null;
  },
};

export const Aperture = {
  /** `cam_aperture_ctrl_strategy` `01 00 00 <strategy>`. */
  parseState(value: ByteInput): ApertureStrategy | null {
    if (value.length < 4 || value[0] !== 1 || value[3] > 4) return null;
    return value[3] as ApertureStrategy;
  },
  /** `camcap_aperture_ctrl_strategy` `01 <len:u16-LE> <count> <ids…>`. */
  parseCapability(value: ByteInput): ApertureStrategy[] {
    if (value.length < 5 || value[0] !== 1) return [];
    const inner = value[1] | (value[2] << 8);
    if (inner < 2 || 3 + inner > value.length) return [];
    const count = value[3];
    if (count < 1 || 1 + count > inner) return [];
    const out: ApertureStrategy[] = [];
    for (let i = 4; i < 4 + count; i++) if (value[i] <= 4) out.push(value[i] as ApertureStrategy);
    return out;
  },
  /** Mechanical iris, `cam_expo_param` u16-LE `@13` hundredths (`290` = f/2.9). */
  irisHundredths(expo: ByteInput): number | null {
    if (expo.length < 15) return null;
    const raw = u16le(expo, 13);
    return raw >= 100 && raw <= 2200 ? raw : null;
  },
};

export const LensState = {
  focusMode(value: ByteInput): FocusMode | null {
    if (value.length === 0) return null;
    const b = value[0];
    if (b === 0x01 || b === 0xb1) return 0x01;
    if (b === 0x02 || b === 0xb2) return 0x02;
    return null;
  },
  focusPoint(value: ByteInput): { x: number; y: number } | null {
    if (value.length < 9) return null;
    const x = f32le(value, 1);
    const y = f32le(value, 5);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  },
};

export function parseFocusTrackReply(payload: ByteInput): FocusTrackMode | null {
  const parsed = CameraParams.parseBlobReply(payload);
  if (!parsed || parsed.pid !== CameraParam.focusTrack || parsed.value.length !== 2 || parsed.value[0] !== 1) return null;
  return parsed.value[1] <= 3 ? (parsed.value[1] as FocusTrackMode) : null;
}

export const WhiteBalanceWire = {
  /** `cam_image_effect` `@4` mode, `@5–6` K/100 (Custom only), `@7–8` tint. */
  parseImageEffect(value: ByteInput): WhiteBalance | null {
    if (value.length < 9) return null;
    const mode = value[4];
    if (mode !== WhiteBalanceMode.auto && mode !== WhiteBalanceMode.custom) return null;
    const tint = i16le(value, 7);
    if (mode === WhiteBalanceMode.auto) return wbAuto(tint);
    return wbCustom(u16le(value, 5) * 100, tint);
  },
  /** Auto's live measurement: `@5` alone as K/100; nil outside 2000…10000. */
  autoKelvin(value: ByteInput): number | null {
    if (value.length < 9 || value[4] !== WhiteBalanceMode.auto) return null;
    const k = value[5] * 100;
    return k >= 2000 && k <= 10000 ? k : null;
  },
};

/** GET `0x02/0xA0` → `00` + 26-byte blob. SET `0x02/0x9F` = that blob. */
export const AudioDspBlob = {
  size: 26,
  blob(fromGetReply: ByteInput): Uint8Array | null {
    if (fromGetReply.length < 27 || fromGetReply[0] !== 0) return null;
    return Uint8Array.from(Array.prototype.slice.call(fromGetReply, 1, 27) as number[]);
  },
  patch(blob: ByteInput, byte2: number): Uint8Array {
    const out = Uint8Array.from(blob);
    if (out.length > 2) out[2] = byte2;
    return out;
  },
  patchWind(blob: ByteInput, value: WNR): Uint8Array {
    if (value === WindNoiseReduction.off) return AudioDspBlob.patch(blob, WindNoiseReduction.off);
    const dir = AudioDspBlob.directional(blob.length > 2 ? blob[2] : 0);
    return AudioDspBlob.patch(blob, dir ?? WindNoiseReduction.on);
  },
  patchDirectional: (blob: ByteInput, value: DirectionalAudio) => AudioDspBlob.patch(blob, value),
  /** Wind off is only `18`. Every captured directional byte includes wind-on. */
  wind(raw: number): WNR | null {
    if (raw === 0x18) return WindNoiseReduction.off;
    if (raw === 0x1a || raw === 0xda || raw === 0x3a || raw === 0xba) return WindNoiseReduction.on;
    return null;
  },
  directional(raw: number): DirectionalAudio | null {
    return raw === 0xda || raw === 0x3a || raw === 0xba ? (raw as DirectionalAudio) : null;
  },
};

export const GimbalWire = {
  /** 50-byte attitude: family at `@6 >> 6`. */
  modeFamily(payload: ByteInput): GimbalModeFamily | null {
    if (payload.length !== 50) return null;
    const f = payload[6] >> 6;
    return f <= 2 ? (f as GimbalModeFamily) : null;
  },
  /** `0x04/0x50` GET reply `00 01 04 01 <tilt> 05 01 <speed>`. */
  parseParams(p: ByteInput): GimbalParamState | null {
    if (p.length < 8 || p[0] !== 0 || p[1] !== 1 || p[2] !== 4 || p[3] !== 1 || p[5] !== 5 || p[6] !== 1) return null;
    const tilt = p[4] === 0 ? GimbalTiltLock.unlocked : GimbalTiltLock.locked;
    const speed = p[7] <= 2 ? (p[7] as GimbalSpeed) : null;
    return { tiltLock: tilt, speed };
  },
  /** Gimbal face from a status payload bit `@2 & 0x40`. */
  face(payload: ByteInput): GimbalFace | null {
    if (payload.length <= 2) return null;
    return (payload[2] & 0x40) !== 0 ? 'selfie' : 'front';
  },
  modeFromGet(params: GimbalParamState, commanded: GimbalMode): GimbalMode {
    if (commanded === 'fpv' || commanded === 'directionLock') return commanded;
    return params.tiltLock === GimbalTiltLock.locked ? 'tiltLocked' : 'follow';
  },
  modeFromFamily(family: GimbalModeFamily, current: GimbalMode): GimbalMode {
    if (family === 0) return 'directionLock';
    if (family === 1) return 'fpv';
    return current === 'tiltLocked' ? 'tiltLocked' : 'follow';
  },
};

/**
 * Head tracking / Motion Control drive the gimbal on Fast with tilt unlocked; restore the
 * operator's speed and mode once idle for `idleDelay` seconds.
 */
export class GimbalPrepRestore {
  static readonly idleDelay = 1;
  speed: GimbalSpeed | null = null;
  mode: GimbalMode | null = null;
  private idleSince: number | null = null;

  get isHolding(): boolean {
    return this.speed !== null || this.mode !== null;
  }

  prep(current: GimbalSpeed, currentMode: GimbalMode): DumlFrame[] {
    if (this.speed === null) this.speed = current;
    if (this.mode === null) this.mode = currentMode;
    this.idleSince = null;
    return [Commands.setGimbalTiltLock(GimbalTiltLock.unlocked), Commands.setGimbalSpeed(GS.fast)];
  }

  restore(busy: boolean, now: number): { speed: GimbalSpeed | null; mode: GimbalMode | null; frames: DumlFrame[] } | null {
    if (!this.isHolding || busy || !Number.isFinite(now)) {
      this.idleSince = null;
      return null;
    }
    const since = this.idleSince ?? now;
    this.idleSince = since;
    return now - since >= GimbalPrepRestore.idleDelay ? this.restoreNow() : null;
  }

  restoreNow(): { speed: GimbalSpeed | null; mode: GimbalMode | null; frames: DumlFrame[] } | null {
    if (!this.isHolding) return null;
    const frames: DumlFrame[] = [];
    if (this.speed !== null && this.speed !== GS.fast) frames.push(Commands.setGimbalSpeed(this.speed));
    if (this.mode === 'tiltLocked') frames.push(Commands.setGimbalTiltLock(GimbalTiltLock.locked));
    const r = { speed: this.speed, mode: this.mode, frames };
    this.speed = null;
    this.mode = null;
    this.idleSince = null;
    return r;
  }
}
