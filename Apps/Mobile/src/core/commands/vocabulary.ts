/**
 * Camera-control vocabulary: the wire-valued enums the DJI command builders and status decoder
 * share. Values are raw wire bytes, so they round-trip byte-exact.
 *
 * Source of truth: OpenCine `OpenCineCameraVocabulary/CameraControl.swift` plus the DJI wire
 * extensions in `OpenCineDJI/CameraControl+DJIWire.swift`. Ported subset: what Commands, the
 * status decoder and `src/core/mapping.ts` need. UI-only helpers (drum labels, ladders) are not ported.
 */
import { type CameraModel, isAction6, isPocket3, isPocket4Pro } from '../status/cameraModel';

export const ExpoMode = { auto: 0x01, manual: 0x04 } as const;
export type ExpoMode = (typeof ExpoMode)[keyof typeof ExpoMode];

export const ShootingMode = {
  slowMo: 0x00,
  video: 0x01,
  timeLapse: 0x02,
  /** Pocket 4 / 4 Pro Photo SET. Pocket 3 / Nano Photo is `PHOTO_RAW_POCKET3_AND_NANO`. */
  photo: 0x17,
  hyperLapse: 0x0a,
  livePhoto: 0x4d,
  /** Pocket 3 Low-Light **video**. */
  superNight: 0x28,
} as const;
export type ShootingMode = (typeof ShootingMode)[keyof typeof ShootingMode];
export const PHOTO_RAW_POCKET3_AND_NANO = 0x05;
const SHOOTING_MODES = new Set<number>(Object.values(ShootingMode));

/** Every `0x02/0xE1` value a supported body accepts. Nothing else may reach the wire. */
export const SHOOTING_MODE_TABLED_RAW = new Set([0x00, 0x01, 0x02, 0x05, 0x0a, 0x17, 0x28, 0x4d]);

export const ShootingModes = {
  isPhoto: (m: ShootingMode) => m === ShootingMode.photo || m === ShootingMode.livePhoto,
  usesShutterTriggerOnPocket3: (m: ShootingMode) => m === ShootingMode.timeLapse,
  fromWire(raw: number): ShootingMode | null {
    if (raw === PHOTO_RAW_POCKET3_AND_NANO) return ShootingMode.photo;
    return SHOOTING_MODES.has(raw) ? (raw as ShootingMode) : null;
  },
  photoWireByte(model: CameraModel | null | undefined): number {
    if (!model) return ShootingMode.photo;
    if (model.family === 'nano' || isPocket3(model) || isAction6(model)) return PHOTO_RAW_POCKET3_AND_NANO;
    return ShootingMode.photo;
  },
  wireByte(m: ShootingMode, model: CameraModel | null | undefined): number {
    return m === ShootingMode.photo ? ShootingModes.photoWireByte(model) : m;
  },
  label(m: ShootingMode): string {
    switch (m) {
      case ShootingMode.slowMo:
        return 'SlowMo';
      case ShootingMode.video:
        return 'Video';
      case ShootingMode.timeLapse:
        return 'TimeLapse';
      case ShootingMode.photo:
        return 'Photo';
      case ShootingMode.livePhoto:
        return 'Live Photo';
      case ShootingMode.hyperLapse:
        return 'HyperLapse';
      default:
        return 'SuperNight';
    }
  },
};

/** `0x02/0x8E` pid `0x000F` — Auto ISO ceiling. Ceiling = `100 << (raw − 1)`. */
export const IsoLimit = {
  max200: 0x02,
  max400: 0x03,
  max800: 0x04,
  max1600: 0x05,
  max3200: 0x06,
  max6400: 0x07,
  max12800: 0x08,
  max25600: 0x09,
} as const;
export type IsoLimit = (typeof IsoLimit)[keyof typeof IsoLimit];
export const isoLimitCeiling = (l: IsoLimit) => 100 << (l - 1);
export const isoLimitLabel = (l: IsoLimit, base = 100) => `${base}–${isoLimitCeiling(l)}`;
export const isIsoLimit = (v: number): v is IsoLimit => v >= 0x02 && v <= 0x09;

export const FovSetting = { wide: 0x01, naturalWide: 0x05 } as const;
export type FovSetting = (typeof FovSetting)[keyof typeof FovSetting];

/** Third-stop EV. raw = 0x10 + thirds, thirds −9…+9. */
export const EV_MIN_THIRDS = -9;
export const EV_MAX_THIRDS = 9;
export const MINUS_SIGN = '−';
export const EvComp = {
  fromRaw(raw: number): number | null {
    const t = raw - 0x10;
    return t >= EV_MIN_THIRDS && t <= EV_MAX_THIRDS ? t : null;
  },
  raw(thirds: number): number {
    return Math.min(Math.max(0x10 + Math.max(EV_MIN_THIRDS, Math.min(EV_MAX_THIRDS, thirds)), 0), 255);
  },
  fromStops(stops: number): number {
    return Math.max(EV_MIN_THIRDS, Math.min(EV_MAX_THIRDS, Math.round(stops * 3)));
  },
  stops(thirds: number): number {
    return Math.round((thirds / 3) * 10) / 10;
  },
  label(thirds: number): string {
    if (thirds === 0) return '0.0';
    const v = Math.abs(thirds) / 3;
    return `${thirds < 0 ? MINUS_SIGN : '+'}${v.toFixed(1)}`;
  },
  fromLabel(label: string): number | null {
    if (label === '0.0') return 0;
    const negative = label.startsWith(MINUS_SIGN) || label.startsWith('-');
    const positive = label.startsWith('+');
    if (!negative && !positive) return null;
    const parts = label.slice(1).split('.');
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
    const frac = { '0': 0, '3': 1, '7': 2 }[parts[1]];
    if (frac === undefined) return null;
    const t = parseInt(parts[0], 10) * 3 + frac;
    if (t < 0 || t > EV_MAX_THIRDS) return null;
    return negative ? -t : t;
  },
};

/** `0x02/0x2A` 1-byte index. Not the ISO number. */
export const IsoIndex = {
  auto: 0x00,
  iso100: 0x03,
  iso200: 0x04,
  iso400: 0x05,
  iso800: 0x06,
  iso1600: 0x07,
  iso3200: 0x08,
  iso6400: 0x09,
  iso12800: 0x0a,
  iso25600: 0x0b,
  /** Not a DJI byte; never decodes from the wire. */
  iso160: 0xe0,
} as const;
export type IsoIndex = (typeof IsoIndex)[keyof typeof IsoIndex];
const ISO_VALUE: Record<number, number | null> = {
  0x00: null,
  0x03: 100,
  0x04: 200,
  0x05: 400,
  0x06: 800,
  0x07: 1600,
  0x08: 3200,
  0x09: 6400,
  0x0a: 12800,
  0x0b: 25600,
  0xe0: 160,
};
export const IsoIndexes = {
  value: (i: IsoIndex): number | null => ISO_VALUE[i] ?? null,
  /** DJI byte to index. 160 has no DJI byte. */
  fromDjiWire(b: number): IsoIndex | null {
    if (b === IsoIndex.iso160) return null;
    return b in ISO_VALUE ? (b as IsoIndex) : null;
  },
  fromIso(iso: number): IsoIndex | null {
    for (const [k, v] of Object.entries(ISO_VALUE)) if (v === iso && Number(k) !== 0xe0) return Number(k) as IsoIndex;
    return null;
  },
  nearest(value: number, available: IsoIndex[]): IsoIndex | null {
    let best: IsoIndex | null = null;
    let bestD = Infinity;
    for (const i of available) {
      if (i === IsoIndex.auto) continue;
      const d = Math.abs((ISO_VALUE[i] ?? 0) - value);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  },
};

/** `0x02/0x42` color. rawValue is the Pocket 4 / 4 Pro SET byte. */
export const ColorMode = {
  normal: 0x3f,
  hdr: 0x3c,
  dLog: 0x17,
  dLog2: 0x41,
  normal10: 0x3d,
  dLogM: 0x00,
  iLog: 0xe2,
  dolbyVision: 0xe5,
} as const;
export type ColorMode = (typeof ColorMode)[keyof typeof ColorMode];
const COLOR_MODES = new Set<number>(Object.values(ColorMode));

export const ColorModes = {
  label(m: ColorMode): string {
    switch (m) {
      case ColorMode.normal:
        return 'Normal';
      case ColorMode.hdr:
        return 'HDR';
      case ColorMode.dLog:
        return 'D-Log';
      case ColorMode.dLog2:
        return 'D-Log2';
      case ColorMode.normal10:
        return 'Normal 10-bit';
      case ColorMode.dLogM:
        return 'D-Log M 10-bit';
      case ColorMode.iLog:
        return 'I-Log';
      default:
        return 'Dolby Vision';
    }
  },
  offersIsoAuto: (m: ColorMode) => m !== ColorMode.dLog2,
  isoIndices(m: ColorMode): IsoIndex[] {
    const I = IsoIndex;
    switch (m) {
      case ColorMode.dLog2:
        return [I.iso100, I.iso200, I.iso400, I.iso800, I.iso1600, I.iso3200];
      case ColorMode.dLog:
        return [I.auto, I.iso400, I.iso800, I.iso1600, I.iso3200, I.iso6400];
      case ColorMode.iLog:
      case ColorMode.dolbyVision:
        return [I.auto, I.iso100, I.iso160, I.iso200, I.iso400, I.iso800, I.iso1600, I.iso3200, I.iso6400];
      default:
        return [I.auto, I.iso100, I.iso200, I.iso400, I.iso800, I.iso1600, I.iso3200, I.iso6400, I.iso12800, I.iso25600];
    }
  },
  isoAutoLimits(m: ColorMode): IsoLimit[] {
    const L = IsoLimit;
    if (m === ColorMode.dLog2) return [];
    if (m === ColorMode.dLog) return [L.max800, L.max1600, L.max3200, L.max6400];
    return [L.max200, L.max400, L.max800, L.max1600, L.max3200, L.max6400, L.max12800, L.max25600];
  },
  isoAutoBase(m: ColorMode, model?: CameraModel | null): number | null {
    if (m === ColorMode.dLog2) return null;
    if (m === ColorMode.dLog) return 400;
    return model?.captureProfile?.isoAutoRangeFloor ?? null;
  },
  /** Pocket 3 / Nano / Action 6 SET byte. Other bodies use the raw value. */
  wireByte(m: ColorMode, model?: CameraModel | null): number {
    if (!model) return m;
    if (model.family === 'nano' || isAction6(model)) {
      if (m === ColorMode.normal) return 0x00;
      if (m === ColorMode.normal10) return 0x3f;
      if (m === ColorMode.dLogM) return 0x3d;
      return m;
    }
    if (!isPocket3(model)) return m;
    if (m === ColorMode.normal) return 0x00;
    if (m === ColorMode.dLogM) return 0x3d;
    return m;
  },
  /** DJI byte to color mode. I-Log and Dolby Vision have no DJI byte. */
  fromDjiWire(b: number): ColorMode | null {
    if (!COLOR_MODES.has(b) || b === ColorMode.iLog || b === ColorMode.dolbyVision) return null;
    return b as ColorMode;
  },
  fromWire(b: number, model?: CameraModel | null): ColorMode | null {
    if (model && (model.family === 'nano' || isAction6(model))) {
      if (b === 0x00) return ColorMode.normal;
      if (b === 0x3f) return ColorMode.normal10;
      if (b === 0x3d) return ColorMode.dLogM;
    }
    if (model && isPocket3(model)) {
      if (b === 0x00) return ColorMode.normal;
      if (b === 0x3d) return ColorMode.dLogM;
    }
    return ColorModes.fromDjiWire(b);
  },
  /** `cam_image_effect` `@2`. */
  parseImageEffect(value: ArrayLike<number>, model?: CameraModel | null): ColorMode | null {
    if (value.length <= 2) return null;
    return ColorModes.fromWire(value[2], model);
  },
};

/** Action 6 aperture strategy (`0x8E` pid `0x0044`). */
export const ApertureStrategy = { f2: 0x00, f26: 0x01, f28: 0x02, starburst: 0x03, auto: 0x04 } as const;
export type ApertureStrategy = (typeof ApertureStrategy)[keyof typeof ApertureStrategy];
export const APERTURE_CAPABILITY_KEY = 'camcap_aperture_ctrl_strategy';
export const APERTURE_STATE_KEY = 'cam_aperture_ctrl_strategy';
export const apertureFNumber = (s: ApertureStrategy): number | null =>
  ({ 0: 2.0, 1: 2.6, 2: 2.8, 3: 4.0 } as Record<number, number>)[s] ?? null;

export const FocusMode = { single: 0x01, continuous: 0x02 } as const;
export type FocusMode = (typeof FocusMode)[keyof typeof FocusMode];

export const FocusTrackMode = { default: 0x00, productShowcase: 0x01, subjectLock: 0x02, registeredPriority: 0x03 } as const;
export type FocusTrackMode = (typeof FocusTrackMode)[keyof typeof FocusTrackMode];

export const WhiteBalanceMode = { auto: 0x00, custom: 0x06 } as const;
export type WhiteBalanceMode = (typeof WhiteBalanceMode)[keyof typeof WhiteBalanceMode];

/** 5-byte WB: `[mode][K/100 u16-LE][tint i16-LE]`. Tint clamps to −100…+100. */
export interface WhiteBalance {
  mode: WhiteBalanceMode;
  kelvin: number;
  tint: number;
}
export function whiteBalance(mode: WhiteBalanceMode, kelvin: number, tint: number): WhiteBalance {
  return { mode, kelvin, tint: Math.min(Math.max(tint, -100), 100) };
}
export const wbAuto = (tint = 0) => whiteBalance(WhiteBalanceMode.auto, 0, tint);
export const wbCustom = (kelvin: number, tint: number) => whiteBalance(WhiteBalanceMode.custom, kelvin, tint);

export const AudioChannel = { stereo: 0x02, mono: 0x01, spatial: 0x03 } as const;
export type AudioChannel = (typeof AudioChannel)[keyof typeof AudioChannel];
export const VocalBoost = { off: 0x00, on: 0x01 } as const;
export type VocalBoost = (typeof VocalBoost)[keyof typeof VocalBoost];
export const SelfieFlip = { off: 0x00, on: 0x01 } as const;
export type SelfieFlip = (typeof SelfieFlip)[keyof typeof SelfieFlip];
export const WindNoiseReduction = { off: 0x18, on: 0x1a } as const;
export type WindNoiseReduction = (typeof WindNoiseReduction)[keyof typeof WindNoiseReduction];
export const DirectionalAudio = { all: 0xda, front: 0x3a, frontAndBack: 0xba } as const;
export type DirectionalAudio = (typeof DirectionalAudio)[keyof typeof DirectionalAudio];

export type CameraAudioAdjustment =
  | { kind: 'wind'; value: WindNoiseReduction }
  | { kind: 'directional'; value: DirectionalAudio }
  | { kind: 'unknown'; value: number };
export function audioAdjustment(raw: number): CameraAudioAdjustment {
  if (raw === 0x18 || raw === 0x1a) return { kind: 'wind', value: raw };
  if (raw === 0xda || raw === 0x3a || raw === 0xba) return { kind: 'directional', value: raw };
  return { kind: 'unknown', value: raw };
}

export type VideoAspect = '16:9' | '4:3' | '1:1' | '9:16';

/** `0x02/0x18` `@0` resolution byte. */
export const VideoResolution = {
  p1080: 0x0a,
  p1080_4x3: 0x0c,
  p4K: 0x10,
  p2_7K: 0x2d,
  p1080_9x16: 0x42,
  p2_7K_9x16: 0x43,
  p2_7K_4x3: 0x5f,
  p4K_4x3: 0x67,
  p1080_1x1: 0x69,
  p2160_1x1: 0x6a,
  p3K_1x1: 0x6b,
  p3K_9x16: 0x6c,
  p4K_1x1: 0x7d,
} as const;

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');

export const VideoResolutions = {
  aspect(raw: number): VideoAspect | null {
    if ([0x0a, 0x10, 0x2d, 0xd0, 0xd1, 0xd4].includes(raw)) return '16:9';
    if ([0x0c, 0x5f, 0x67].includes(raw)) return '4:3';
    if ([0x69, 0x6a, 0x6b, 0x7d].includes(raw)) return '1:1';
    if ([0x42, 0x43, 0x6c, 0xd3].includes(raw)) return '9:16';
    return null;
  },
  sizeTitle(raw: number): string {
    if ([0x0a, 0x0c, 0x42, 0x69].includes(raw)) return '1080';
    if ([0x2d, 0x43, 0x5f].includes(raw)) return '2.7K';
    if ([0x10, 0x67, 0x7d, 0xd3, 0xd6].includes(raw)) return '4K';
    if (raw === 0x6a) return '2160';
    if ([0x6b, 0x6c, 0xd4].includes(raw)) return '3K';
    if ([0xd0, 0xd5].includes(raw)) return '8K';
    if (raw === 0xd1) return '6K';
    return hex2(raw);
  },
  /** Nominal recorded pixel size for the UI format list (not on the wire). */
  dimensions(raw: number): { width: number; height: number } | null {
    const title = VideoResolutions.sizeTitle(raw);
    const aspect = VideoResolutions.aspect(raw);
    const long: Record<string, number> = { '1080': 1920, '2.7K': 2688, '4K': 3840, '2160': 2160, '3K': 3072 };
    const L = long[title];
    if (!L || !aspect) return null;
    switch (aspect) {
      case '16:9':
        return { width: L, height: Math.round((L * 9) / 16) };
      case '9:16':
        return { width: Math.round((L * 9) / 16), height: L };
      case '4:3':
        return { width: L, height: Math.round((L * 3) / 4) };
      case '1:1': {
        const side = title === '1080' ? 1080 : title === '3K' ? 3072 : 2160;
        return { width: side, height: side };
      }
    }
  },
  /** Pocket 3 digital-zoom ceiling for this FORMAT. */
  pocket3ZoomMax(raw: number): number | null {
    if ([0x0a, 0x0c, 0x42, 0x69].includes(raw)) return 4;
    if ([0x2d, 0x43, 0x5f, 0x6a].includes(raw)) return 3;
    if ([0x10, 0x67, 0x7d, 0x6b, 0x6c].includes(raw)) return 2;
    return null;
  },
};

/** `0x02/0x18` `@1` frame-rate index. */
export const VideoFrameRate = {
  fps24: 0x01,
  fps25: 0x02,
  fps30: 0x03,
  fps48: 0x04,
  fps50: 0x05,
  fps60: 0x06,
  fps120: 0x07,
  fps240: 0x08,
  fps100: 0x0a,
  fps96: 0x0b,
  fps200: 0x13,
  fps15: 0x1d,
} as const;
const FPS_BY_INDEX: Record<number, number> = { 1: 24, 2: 25, 3: 30, 4: 48, 5: 50, 6: 60, 7: 120, 8: 240, 10: 100, 11: 96, 19: 200, 29: 15 };
export const VideoFrameRates = {
  fps(index: number): number {
    return FPS_BY_INDEX[index] ?? 0;
  },
  fromFps(fps: number): number | null {
    for (const [k, v] of Object.entries(FPS_BY_INDEX)) if (v === fps) return Number(k);
    return null;
  },
  labeledVideo: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06] as number[],
};

export interface VideoFormat {
  resolution: number;
  frameRate: number;
}
export const videoFormatEqual = (a: VideoFormat | null | undefined, b: VideoFormat | null | undefined) =>
  !!a && !!b && a.resolution === b.resolution && a.frameRate === b.frameRate;

export const VideoFormats = {
  /** SlowMo 100/120/200 → `00 04 00`; 240 → `00 08 00`; else `00 00 00`. */
  trailer(frameRate: number, shootingMode: ShootingMode | null | undefined): number[] {
    if (shootingMode !== ShootingMode.slowMo) return [0, 0, 0];
    if (frameRate === VideoFrameRate.fps240) return [0, 0x08, 0];
    if (frameRate === VideoFrameRate.fps100 || frameRate === VideoFrameRate.fps120 || frameRate === VideoFrameRate.fps200) {
      return [0, 0x04, 0];
    }
    return [0, 0, 0];
  },
  setPayload(f: VideoFormat, shootingMode?: ShootingMode | null): number[] {
    return [f.resolution, f.frameRate, ...VideoFormats.trailer(f.frameRate, shootingMode)];
  },
  /** Captured SlowMo trailer context for Pocket 3 and Pocket 4 Pro only. */
  formatSetMode(model: CameraModel | null | undefined, statusMode: ShootingMode | null | undefined): ShootingMode | null {
    return model && (isPocket3(model) || isPocket4Pro(model)) ? (statusMode ?? null) : null;
  },
  parseVideoParamV2(value: ArrayLike<number>): VideoFormat | null {
    if (value.length < 2) return null;
    return { resolution: value[0], frameRate: value[1] };
  },
  /** Pocket 3 first picture: the other labeled size at the same fps, preferring advertised pairs. */
  firstPictureEncoderKick(original: VideoFormat, available: VideoFormat[] = []): VideoFormat {
    const naive = {
      resolution: original.resolution === VideoResolution.p4K ? VideoResolution.p1080 : VideoResolution.p4K,
      frameRate: original.frameRate,
    };
    if (available.length === 0) return naive;
    if (available.some((f) => videoFormatEqual(f, naive))) return naive;
    const sameFps = available.find((f) => f.frameRate === original.frameRate && f.resolution !== original.resolution);
    if (sameFps) return sameFps;
    const otherRes = available.find((f) => f.resolution !== original.resolution);
    if (otherRes) return otherRes;
    const other = available.find((f) => !videoFormatEqual(f, original));
    return other ?? naive;
  },
  firstPictureOriginal(format: VideoFormat | null, resolution: number | null, fps: number): VideoFormat {
    if (format) return format;
    return { resolution: resolution ?? VideoResolution.p4K, frameRate: VideoFrameRates.fromFps(fps) ?? VideoFrameRate.fps30 };
  },
};

/** `0x04/0x50` param `05`. */
export const GimbalSpeed = { fast: 0x00, defaultSpeed: 0x01, slow: 0x02 } as const;
export type GimbalSpeed = (typeof GimbalSpeed)[keyof typeof GimbalSpeed];
export type GimbalMode = 'follow' | 'tiltLocked' | 'fpv' | 'directionLock';
export const GimbalModeFamily = { directionLock: 0, fpv: 1, follow: 2 } as const;
export type GimbalModeFamily = (typeof GimbalModeFamily)[keyof typeof GimbalModeFamily];
export const GimbalTiltLock = { unlocked: 0x00, locked: 0x01 } as const;
export type GimbalTiltLock = (typeof GimbalTiltLock)[keyof typeof GimbalTiltLock];
export type GimbalFace = 'front' | 'selfie';
export interface GimbalParamState {
  tiltLock: GimbalTiltLock;
  speed: GimbalSpeed | null;
}
