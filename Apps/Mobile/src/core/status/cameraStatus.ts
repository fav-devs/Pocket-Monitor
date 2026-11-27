/**
 * Decoded camera status (HUD truth) and the DJI status decoder: `0x02/0x80` status push,
 * `0x02/0xDC` storage, `0x0D/0x02` battery, gimbal `0x04/*`, `0x02/0x8E` param GET replies,
 * `0x02/0xA0` audio DSP, `0x00/0x00` version and `0x00/0x99` subscription pushes.
 *
 * Source of truth: OpenCine `OpenCineCameraVocabulary/CameraStatus.swift` and
 * `OpenCineDJI/CameraStatus+DJIWire.swift` (`CameraStatusDecoder`, `SubscribePush`).
 * Status is a plain mutable record; `applyFrame` mutates it in place like the Swift `inout`.
 */
import { type ByteInput, concat, putU32le, u16le, u32le, utf8Decode, utf8Encode } from '../bytes';
import { CamFov } from '../commands/camFov';
import { CameraParam } from '../commands/commands';
import { Aperture, AudioDspBlob, CameraParams, ExpoParam, GimbalWire, GlamourEffect, LensState, parseFocusTrackReply, WhiteBalanceWire } from '../commands/control';
import {
  APERTURE_CAPABILITY_KEY,
  APERTURE_STATE_KEY,
  type ApertureStrategy,
  type AudioChannel,
  type CameraAudioAdjustment,
  audioAdjustment,
  type ColorMode,
  ColorModes,
  type DirectionalAudio,
  type ExpoMode,
  ExpoMode as EM,
  type FocusMode,
  type FocusTrackMode,
  type GimbalFace,
  type GimbalModeFamily,
  type GimbalParamState,
  type IsoIndex,
  type IsoLimit,
  isIsoLimit,
  type SelfieFlip,
  type ShootingMode,
  ShootingModes,
  type VideoFormat,
  VideoFormats,
  VideoFrameRates,
  type VocalBoost,
  type WhiteBalance,
  WhiteBalanceMode,
  type WindNoiseReduction,
} from '../commands/vocabulary';
import type { DumlFrame } from '../duml/frame';
import { type AudioMeterLevels, CamAudioStatus } from './audio';
import { type CameraModel, supportsAperture } from './cameraModel';
import { CamCapColorMode, CamCapIso, CamCapShutter, CamCapVideoFormat } from './camCap';

export interface CameraTimecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

export interface CameraStatus {
  batteryPercent: number;
  batteryMilliVolts: number;
  /** signed; negative = discharging */
  batteryMilliAmps: number;
  docked: boolean;
  charging: boolean;
  chargingObservation: boolean | null;
  chargingObservationDeclared: boolean;
  storageTotalMb: number;
  storageFreeMb: number;
  sdTotalMb: number;
  sdFreeMb: number;
  /** -1 unknown, 0 confirmed absent */
  internalTotalMb: number;
  internalFreeMb: number;
  inPlayback: boolean;
  firmware: string | null;
  isRecording: boolean;
  recordingReported: boolean;
  /** Raw `0x02/0x80 @57` byte, -1 unknown. */
  shootingMode: number;
  recordElapsedSec: number;
  recordRemainingSec: number;
  timecode: CameraTimecode | null;
  expoMode: ExpoMode | null;
  iso: number;
  isoIndex: IsoIndex | null;
  /** thirds */
  evComp: number | null;
  meteredEv: number | null;
  isoLimit: IsoLimit | null;
  shutterDenom: number;
  availableShutterDenoms: number[];
  availableIsoIndices: IsoIndex[];
  fps: number;
  videoResolution: number | null;
  videoFormat: VideoFormat | null;
  availableVideoFormats: VideoFormat[];
  colorMode: ColorMode | null;
  availableColorModes: ColorMode[];
  whiteBalance: WhiteBalance | null;
  whiteBalanceKelvin: number;
  autoWhiteBalanceKelvin: number;
  whiteBalanceTint: number | null;
  focusMode: FocusMode | null;
  focusX: number;
  focusY: number;
  hasCameraFocusPoint: boolean;
  focusTrack: FocusTrackMode | null;
  zoomFactorRaw: number;
  zoomLens: number | null;
  zoomFactorOverride: number | null;
  audioChannel: AudioChannel | null;
  glamourBlob: Uint8Array | null;
  glamourEnabled: boolean | null;
  vocalBoost: VocalBoost | null;
  selfieFlip: SelfieFlip | null;
  audioDspBlob: Uint8Array | null;
  audioAdjustment: CameraAudioAdjustment | null;
  windNR: WindNoiseReduction | null;
  directionalAudio: DirectionalAudio | null;
  audioMeters: AudioMeterLevels | null;
  audioStatusRaw: Uint8Array | null;
  gimbalFace: GimbalFace | null;
  gimbalModeFamily: GimbalModeFamily | null;
  gimbalParams: GimbalParamState | null;
  irisHundredths: number | null;
  apertureStrategy: ApertureStrategy | null;
  availableApertureStrategies: ApertureStrategy[];
}

export function emptyCameraStatus(): CameraStatus {
  return {
    batteryPercent: -1,
    batteryMilliVolts: 0,
    batteryMilliAmps: 0,
    docked: false,
    charging: false,
    chargingObservation: null,
    chargingObservationDeclared: false,
    storageTotalMb: 0,
    storageFreeMb: 0,
    sdTotalMb: 0,
    sdFreeMb: 0,
    internalTotalMb: -1,
    internalFreeMb: -1,
    inPlayback: false,
    firmware: null,
    isRecording: false,
    recordingReported: false,
    shootingMode: -1,
    recordElapsedSec: 0,
    recordRemainingSec: 0,
    timecode: null,
    expoMode: null,
    iso: -1,
    isoIndex: null,
    evComp: null,
    meteredEv: null,
    isoLimit: null,
    shutterDenom: -1,
    availableShutterDenoms: [],
    availableIsoIndices: [],
    fps: 0,
    videoResolution: null,
    videoFormat: null,
    availableVideoFormats: [],
    colorMode: null,
    availableColorModes: [],
    whiteBalance: null,
    whiteBalanceKelvin: -1,
    autoWhiteBalanceKelvin: -1,
    whiteBalanceTint: null,
    focusMode: null,
    focusX: 0.5,
    focusY: 0.5,
    hasCameraFocusPoint: false,
    focusTrack: null,
    zoomFactorRaw: 0,
    zoomLens: null,
    zoomFactorOverride: null,
    audioChannel: null,
    glamourBlob: null,
    glamourEnabled: null,
    vocalBoost: null,
    selfieFlip: null,
    audioDspBlob: null,
    audioAdjustment: null,
    windNR: null,
    directionalAudio: null,
    audioMeters: null,
    audioStatusRaw: null,
    gimbalFace: null,
    gimbalModeFamily: null,
    gimbalParams: null,
    irisHundredths: null,
    apertureStrategy: null,
    availableApertureStrategies: [],
  };
}

export const StatusQueries = {
  zoomFactor(s: CameraStatus): number | null {
    return s.zoomFactorOverride ?? CamFov.hybridFactor(s.zoomFactorRaw, s.zoomLens);
  },
  chargingReading(s: CameraStatus): boolean | null {
    return s.chargingObservationDeclared ? s.chargingObservation : s.charging ? true : null;
  },
  shootingMode(s: CameraStatus): ShootingMode | null {
    return s.shootingMode >= 0 && s.shootingMode <= 255 ? ShootingModes.fromWire(s.shootingMode) : null;
  },
  isPhoto(s: CameraStatus): boolean {
    const m = StatusQueries.shootingMode(s);
    return m != null && ShootingModes.isPhoto(m);
  },
  timecodeLabel(s: CameraStatus): string | null {
    const t = s.timecode;
    if (!t) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(t.hours)}:${p(t.minutes)}:${p(t.seconds)}:${p(t.frames)}`;
  },
};

/** Changing shooting mode clears mode-dependent capability tables. */
export function applyShootingMode(s: CameraStatus, mode: number): void {
  if (s.shootingMode >= 0 && s.shootingMode !== mode) {
    s.availableVideoFormats = [];
    s.availableShutterDenoms = [];
    s.availableIsoIndices = [];
    s.availableColorModes = [];
  }
  s.shootingMode = mode;
}

export const SubscribePush = {
  parse(p: ByteInput): { name: string; value: Uint8Array } | null {
    if (p.length < 24 || p[0] !== 0x02 || p[1] !== 0x06) return null;
    const nameLen = p[13] | (p[14] << 8);
    if (nameLen <= 0 || nameLen >= 80 || 15 + nameLen + 8 > p.length) return null;
    const name = utf8Decode(p, 15, 15 + nameLen);
    if (!name || name.includes('�')) return null;
    const valueLenAt = 15 + nameLen + 6;
    if (valueLenAt + 2 > p.length) return null;
    const valueLen = p[valueLenAt] | (p[valueLenAt + 1] << 8);
    const valueAt = valueLenAt + 2;
    if (valueAt + valueLen > p.length) return null;
    return { name, value: Uint8Array.from(Array.prototype.slice.call(p, valueAt, valueAt + valueLen) as number[]) };
  },
  pack(name: string, value: ByteInput, idx = 0): Uint8Array {
    const nb = utf8Encode(name);
    const inner = 2 + nb.length + 6 + 2 + value.length;
    return concat(
      [0x02, 0x06, 0x00, 0x00],
      putU32le(idx),
      [0, 0, 0],
      [inner & 0xff, (inner >> 8) & 0xff],
      [nb.length & 0xff, (nb.length >> 8) & 0xff],
      nb,
      [0, 0, 0, 0, 0, 0],
      [value.length & 0xff, (value.length >> 8) & 0xff],
      value,
    );
  },
};

const sane = (v: number) => v >= 0 && v <= 50_000_000;

/** GetVersion reply is NUL-separated ASCII; take the last version-shaped token. */
function firmwareToken(p: ByteInput): string | null {
  const parts: number[][] = [[]];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0) parts.push([]);
    else parts[parts.length - 1].push(p[i]);
  }
  const tokens = parts.filter((x) => x.length > 0).reverse();
  for (const t of tokens) {
    const s = utf8Decode(t);
    const n = [...s].length;
    if (n >= 4 && n <= 24 && /[0-9]/.test(s)) return s;
  }
  return null;
}

function applyAudioByte2(raw: number, s: CameraStatus): void {
  s.audioAdjustment = audioAdjustment(raw);
  const wind = AudioDspBlob.wind(raw);
  if (wind != null) s.windNR = wind;
  const dir = AudioDspBlob.directional(raw);
  if (dir != null) s.directionalAudio = dir;
}

export const CameraStatusDecoder = {
  /** Apply one inbound DUML frame. Returns true when the frame carried status. */
  apply(frame: DumlFrame, s: CameraStatus, model?: CameraModel | null): boolean {
    const p = frame.payload;
    const key = (frame.cmdSet << 8) | frame.cmdId;
    switch (key) {
      case 0x0280: {
        if (p.length < 13) return false;
        const flags = u32le(p, 0);
        s.inPlayback = (flags & 0x40000000) !== 0;
        s.isRecording = (flags & 0x80) !== 0;
        s.recordingReported = true;
        const total = u32le(p, 5);
        const free = u32le(p, 9);
        if (total >= 1 && total <= 50_000_000) s.storageTotalMb = total;
        if (sane(free)) s.storageFreeMb = free;
        if (p.length >= 21) {
          const remain = u32le(p, 17);
          if (remain >= 0 && remain <= 86_400) s.recordRemainingSec = remain;
        }
        if (p.length >= 31) s.recordElapsedSec = u16le(p, 29);
        if (p.length >= 58) applyShootingMode(s, p[57]);
        return true;
      }
      case 0x02dc: {
        if (p.length < 22) return false;
        const sdTotal = u32le(p, 6);
        const sdFree = u32le(p, 10);
        const blanked = sdTotal === 0 && s.sdTotalMb > 0;
        if (sane(sdTotal) && !blanked) s.sdTotalMb = sdTotal;
        if (sane(sdFree) && !blanked) s.sdFreeMb = sdFree;
        if (p.length >= 32) {
          const it = u32le(p, 24);
          const ifree = u32le(p, 28);
          if (sane(it)) s.internalTotalMb = it;
          if (sane(ifree)) s.internalFreeMb = ifree;
        } else {
          s.internalTotalMb = 0;
          s.internalFreeMb = 0;
        }
        return true;
      }
      case 0x0d02: {
        if (p.length < 21) return false;
        if (p.length >= 34) {
          const mv = p[1] | (p[2] << 8);
          s.batteryMilliAmps = u32le(p, 5) | 0;
          s.docked = p[27] !== 0;
          s.charging = p[32] === 1;
          s.chargingObservationDeclared = true;
          s.chargingObservation = p[32] <= 1 ? p[32] === 1 : null;
          if (mv >= 2000 && mv <= 5000) s.batteryMilliVolts = mv;
        }
        if (p[20] <= 100) s.batteryPercent = p[20];
        return true;
      }
      case 0x0405:
        if (p.length === 50) s.gimbalModeFamily = GimbalWire.modeFamily(p);
        return true;
      case 0x0427: {
        const face = GimbalWire.face(p);
        if (face) s.gimbalFace = face;
        return p.length > 2;
      }
      case 0x0450: {
        const params = GimbalWire.parseParams(p);
        if (!params) return false;
        s.gimbalParams = params;
        return true;
      }
      case 0x028e: {
        const blob = GlamourEffect.blob(p);
        if (blob) {
          s.glamourBlob = blob;
          s.glamourEnabled = GlamourEffect.isEnabled(blob);
          return true;
        }
        const track = parseFocusTrackReply(p);
        if (track != null) {
          s.focusTrack = track;
          return true;
        }
        const parsed = CameraParams.parseGetReply(p);
        if (!parsed) return false;
        switch (parsed.pid) {
          case CameraParam.audioChannel:
            s.audioChannel = parsed.value >= 1 && parsed.value <= 3 ? (parsed.value as AudioChannel) : null;
            break;
          case CameraParam.vocalBoost:
            s.vocalBoost = parsed.value <= 1 ? (parsed.value as VocalBoost) : null;
            break;
          case CameraParam.isoLimit:
            s.isoLimit = isIsoLimit(parsed.value) ? parsed.value : null;
            break;
          case CameraParam.selfieFlip:
            s.selfieFlip = parsed.value <= 1 ? (parsed.value as SelfieFlip) : null;
            break;
        }
        return true;
      }
      case 0x02a0: {
        const blob = AudioDspBlob.blob(p);
        if (!blob) return false;
        s.audioDspBlob = blob;
        if (blob.length > 2) applyAudioByte2(blob[2], s);
        return true;
      }
      case 0x0000: {
        if (p.length < 6) return false;
        const fw = firmwareToken(p);
        if (!fw) return false;
        s.firmware = fw;
        return true;
      }
      case 0x0099:
        return CameraStatusDecoder.applySubscribePush(p, s, model);
      default:
        return false;
    }
  },

  applySubscribePush(payload: ByteInput, s: CameraStatus, model?: CameraModel | null): boolean {
    const item = SubscribePush.parse(payload);
    if (!item) return false;
    const v = item.value;
    switch (item.name) {
      case 'timecode_info':
        if (v.length < 8) return false;
        s.timecode = { hours: v[3], minutes: v[4], seconds: v[5], frames: v[6] };
        return true;
      case CamCapShutter.subscribeKey: {
        const d = CamCapShutter.parseDenoms(v);
        if (d.length) s.availableShutterDenoms = d;
        return d.length > 0;
      }
      case CamCapIso.subscribeKey: {
        const i = CamCapIso.parseIndices(v);
        if (i.length) s.availableIsoIndices = i;
        return i.length > 0;
      }
      case CamCapColorMode.subscribeKey: {
        const m = CamCapColorMode.parse(v, model);
        if (m.length) s.availableColorModes = m;
        return m.length > 0;
      }
      case CamCapVideoFormat.subscribeKey: {
        const f = CamCapVideoFormat.parse(v);
        if (f.length) s.availableVideoFormats = f;
        return f.length > 0;
      }
      case 'cam_expo_param': {
        if (v.length < 8) return false;
        const mode = ExpoParam.expoMode(v);
        if (mode != null) s.expoMode = mode;
        if (mode === EM.auto) s.shutterDenom = ExpoParam.shutterDenom(v) ?? -1;
        else {
          const d = ExpoParam.shutterDenom(v);
          if (d != null) s.shutterDenom = d;
        }
        const idx = ExpoParam.isoIndex(v);
        if (idx != null) s.isoIndex = idx;
        const iso = ExpoParam.isoValue(v);
        if (iso != null) s.iso = iso;
        s.evComp = ExpoParam.evComp(v);
        s.meteredEv = ExpoParam.meteredEv(v);
        if (model && supportsAperture(model)) s.irisHundredths = Aperture.irisHundredths(v);
        return true;
      }
      case APERTURE_STATE_KEY: {
        const st = Aperture.parseState(v);
        if (st == null) return false;
        s.apertureStrategy = st;
        return true;
      }
      case APERTURE_CAPABILITY_KEY: {
        const c = Aperture.parseCapability(v);
        if (c.length) s.availableApertureStrategies = c;
        return c.length > 0;
      }
      case 'cam_video_param_v2': {
        if (v.length < 2) return false;
        const fps = VideoFrameRates.fps(v[1]);
        if (fps > 0) s.fps = fps;
        s.videoResolution = v[0];
        s.videoFormat = VideoFormats.parseVideoParamV2(v);
        return true;
      }
      case 'cam_image_effect': {
        if (v.length <= 2) return false;
        const color = ColorModes.parseImageEffect(v, model);
        if (color != null) s.colorMode = color;
        const wb = WhiteBalanceWire.parseImageEffect(v);
        if (wb) {
          s.whiteBalance = wb;
          if (wb.mode === WhiteBalanceMode.custom && wb.kelvin >= 2000 && wb.kelvin <= 10000) s.whiteBalanceKelvin = wb.kelvin;
          s.whiteBalanceTint = wb.tint;
          s.autoWhiteBalanceKelvin = wb.mode === WhiteBalanceMode.auto ? (WhiteBalanceWire.autoKelvin(v) ?? -1) : -1;
        }
        return true;
      }
      case 'cam_lens_state': {
        if (v.length === 0) return false;
        const focus = LensState.focusMode(v);
        if (focus != null) s.focusMode = focus;
        const lens = CamFov.lensAt14(v);
        if (lens != null) s.zoomLens = lens;
        const pt = LensState.focusPoint(v);
        if (pt) {
          s.focusX = pt.x;
          s.focusY = pt.y;
          s.hasCameraFocusPoint = true;
        }
        return true;
      }
      case 'cam_fov': {
        if (v.length < 4) return false;
        const raw = CamFov.rawAt0(v);
        if (raw != null) s.zoomFactorRaw = raw;
        return true;
      }
      case 'cam_record_time': {
        if (v.length < 4) return false;
        const sec = u32le(v, 0);
        if (sec <= 86_400) s.recordElapsedSec = sec;
        return true;
      }
      case CamAudioStatus.subscribeKey: {
        s.audioStatusRaw = v;
        const levels = CamAudioStatus.parse(v);
        if (levels) s.audioMeters = levels;
        return true;
      }
      default:
        return false;
    }
  },
};
