/**
 * Pure mapping from decoded camera status / declared capabilities (src/core) onto the UI
 * contract `CameraState` (src/camera/types.ts), plus the inverse UI → wire value helpers the
 * native session uses to build commands. No React, no RN.
 *
 * Wire bytes never leave src/core: screens only ever see the values produced here.
 */
import type {
  AudioState,
  CameraCapabilities,
  CameraFace,
  CameraModelId,
  CameraState,
  ColorMode as UIColorMode,
  ExposureState,
  FocusMode as UIFocusMode,
  FormatState,
  GimbalMode as UIGimbalMode,
  GimbalSpeed as UIGimbalSpeed,
  PowerStorageState,
  RecordingState,
  ShootingMode as UIShootingMode,
  TrackingState,
  VideoFormatOption,
  WhiteBalanceState,
  ZoomState,
} from '../camera/types';
import { CamFov } from './commands/camFov';
import {
  ColorMode,
  ColorModes,
  DirectionalAudio,
  EV_MAX_THIRDS,
  EV_MIN_THIRDS,
  ExpoMode,
  FocusMode,
  type GimbalMode,
  GimbalSpeed,
  IsoIndex,
  IsoIndexes,
  isoLimitCeiling,
  ShootingMode,
  ShootingModes,
  type VideoFormat,
  VideoFrameRates,
  VideoResolutions,
  WhiteBalanceMode,
  WindNoiseReduction,
  apertureFNumber,
} from './commands/vocabulary';
import { activeZoomStops, type CameraModel, hasGimbal, isAction6, isPocket3, isPocket4Pro, supportsAperture, supportsZoom } from './status/cameraModel';
import { CamCapColorMode, CamCapShutter, CamCapVideoFormat } from './status/camCap';
import { type CameraStatus, StatusQueries } from './status/cameraStatus';
import type { TrackingPoll } from './status/trackingBox';

// ---------------------------------------------------------------------------------------------
// Model

export function modelIdOf(model: CameraModel): CameraModelId {
  const n = model.name.toLowerCase().replace(/ /g, '');
  if (isPocket3(model)) return 'osmo-pocket-3';
  if (isPocket4Pro(model)) return 'osmo-pocket-4-pro';
  if (n.includes('pocket4')) return 'osmo-pocket-4';
  if (model.family === 'nano') return 'osmo-nano';
  if (isAction6(model)) return 'osmo-action-6';
  return 'unknown';
}

export function capabilitiesOf(model: CameraModel): CameraCapabilities {
  const p = model.captureProfile;
  const gimbal = hasGimbal(model);
  return {
    zoom: supportsZoom(model),
    gimbal,
    tracking: gimbal,
    selfieFlip: gimbal,
    aperture: supportsAperture(model),
    manualFocus: p?.supportsFocusMode === true,
    audioControls: !model.isDrone,
    media: !model.isDrone,
    timecode: model.family === 'pocket',
  };
}

// ---------------------------------------------------------------------------------------------
// Value maps (wire ↔ UI)

const SHOOTING_TO_UI: Record<number, UIShootingMode> = {
  [ShootingMode.video]: 'video',
  [ShootingMode.photo]: 'photo',
  [ShootingMode.livePhoto]: 'photo',
  [ShootingMode.slowMo]: 'slow-motion',
  [ShootingMode.timeLapse]: 'timelapse',
  [ShootingMode.hyperLapse]: 'hyperlapse',
  [ShootingMode.superNight]: 'night',
};
export function uiShootingMode(mode: ShootingMode | null): UIShootingMode {
  return mode == null ? 'unknown' : (SHOOTING_TO_UI[mode] ?? 'unknown');
}
/** UI mode → tabled wire mode (`null` for panorama / unknown: never sent). */
export function wireShootingMode(mode: UIShootingMode): ShootingMode | null {
  switch (mode) {
    case 'video':
      return ShootingMode.video;
    case 'photo':
      return ShootingMode.photo;
    case 'slow-motion':
      return ShootingMode.slowMo;
    case 'timelapse':
      return ShootingMode.timeLapse;
    case 'hyperlapse':
      return ShootingMode.hyperLapse;
    case 'night':
      return ShootingMode.superNight;
    default:
      return null;
  }
}

const COLOR_TO_UI: Partial<Record<number, UIColorMode>> = {
  [ColorMode.normal]: 'normal',
  [ColorMode.hdr]: 'hlg',
  [ColorMode.dLog]: 'dlog',
  [ColorMode.dLog2]: 'dlog2',
  [ColorMode.dLogM]: 'dlog-m',
  [ColorMode.normal10]: '10bit',
};
export function uiColorMode(mode: ColorMode | null): UIColorMode | null {
  return mode == null ? null : (COLOR_TO_UI[mode] ?? null);
}
export function wireColorMode(mode: UIColorMode): ColorMode {
  switch (mode) {
    case 'hlg':
      return ColorMode.hdr;
    case 'dlog':
      return ColorMode.dLog;
    case 'dlog2':
      return ColorMode.dLog2;
    case 'dlog-m':
      return ColorMode.dLogM;
    case '10bit':
      return ColorMode.normal10;
    default:
      return ColorMode.normal;
  }
}

export const uiFocusMode = (m: FocusMode | null, fallback: UIFocusMode = 'afc'): UIFocusMode =>
  m === FocusMode.single ? 'afs' : m === FocusMode.continuous ? 'afc' : fallback;
/** `mf` has no DJI wire mode on Osmo bodies; it maps to Single. */
export const wireFocusMode = (m: UIFocusMode): FocusMode => (m === 'afc' ? FocusMode.continuous : FocusMode.single);

export function uiGimbalMode(m: GimbalMode): UIGimbalMode {
  return m === 'tiltLocked' ? 'tilt-locked' : m === 'fpv' ? 'fpv' : m === 'directionLock' ? 'locked' : 'follow';
}
/** `spin` has no captured wire command; it maps to null. */
export function wireGimbalMode(m: UIGimbalMode): GimbalMode | null {
  switch (m) {
    case 'follow':
      return 'follow';
    case 'tilt-locked':
      return 'tiltLocked';
    case 'fpv':
      return 'fpv';
    case 'locked':
      return 'directionLock';
    default:
      return null;
  }
}
export const uiGimbalSpeed = (s: GimbalSpeed | null): UIGimbalSpeed =>
  s === GimbalSpeed.fast ? 'fast' : s === GimbalSpeed.slow ? 'slow' : 'normal';
export const wireGimbalSpeed = (s: UIGimbalSpeed): GimbalSpeed =>
  s === 'fast' ? GimbalSpeed.fast : s === 'slow' ? GimbalSpeed.slow : GimbalSpeed.defaultSpeed;

/** EV stops (UI) ↔ thirds (wire). */
export const evToThirds = (ev: number) => Math.max(EV_MIN_THIRDS, Math.min(EV_MAX_THIRDS, Math.round(ev * 3)));
export const thirdsToEv = (t: number) => Math.round((t / 3) * 10) / 10;
export const EV_OPTIONS = Array.from({ length: EV_MAX_THIRDS - EV_MIN_THIRDS + 1 }, (_, i) => thirdsToEv(EV_MIN_THIRDS + i));

/** ISO number → manual index (nearest offered), or Auto. */
export function wireIsoIndex(iso: number | 'auto', available: IsoIndex[] = []): IsoIndex | null {
  if (iso === 'auto') return IsoIndex.auto;
  const exact = IsoIndexes.fromIso(iso);
  if (exact != null && (available.length === 0 || available.includes(exact))) return exact;
  return IsoIndexes.nearest(iso, available.length ? available : (Object.values(IsoIndex) as IsoIndex[]).filter((i) => i !== IsoIndex.iso160));
}

export function uiDirectional(d: DirectionalAudio | null): AudioState['directional'] {
  if (d === DirectionalAudio.front) return 'front';
  if (d === DirectionalAudio.frontAndBack) return 'rear';
  if (d === DirectionalAudio.all) return 'surround';
  return 'off';
}
/** `rear` is the camera's "Front+back" pattern; `off` and `surround` are "All". */
export function wireDirectional(d: AudioState['directional']): DirectionalAudio {
  return d === 'front' ? DirectionalAudio.front : d === 'rear' ? DirectionalAudio.frontAndBack : DirectionalAudio.all;
}

export function resolutionLabel(raw: number): string {
  const size = VideoResolutions.sizeTitle(raw);
  const title = size === '1080' ? '1080p' : size === '2160' ? '2160p' : size;
  const aspect = VideoResolutions.aspect(raw);
  return aspect && aspect !== '16:9' ? `${title} ${aspect}` : title;
}

/** Group reported (or documented fallback) res/fps pairs into the UI format list. */
export function formatOptions(formats: VideoFormat[]): VideoFormatOption[] {
  const byRes = new Map<number, VideoFormatOption>();
  for (const f of formats) {
    const fps = VideoFrameRates.fps(f.frameRate);
    if (fps <= 0) continue;
    let o = byRes.get(f.resolution);
    if (!o) {
      const dim = VideoResolutions.dimensions(f.resolution);
      const aspect = VideoResolutions.aspect(f.resolution);
      if (!dim || !aspect) continue;
      o = { resolution: resolutionLabel(f.resolution), width: dim.width, height: dim.height, fps: [], aspect };
      byRes.set(f.resolution, o);
    }
    if (!o.fps.includes(fps)) o.fps.push(fps);
  }
  for (const o of byRes.values()) o.fps.sort((a, b) => a - b);
  return [...byRes.values()];
}

// ---------------------------------------------------------------------------------------------
// State sections

export function mapRecording(s: CameraStatus, prev: RecordingState): RecordingState {
  return {
    ...prev,
    recording: s.recordingReported ? s.isRecording : prev.recording,
    elapsedSec: s.isRecording ? s.recordElapsedSec : 0,
    remainingSec: s.recordingReported ? s.recordRemainingSec : -1,
    timecode: StatusQueries.timecodeLabel(s) ?? prev.timecode,
  };
}

export function mapExposure(s: CameraStatus, model: CameraModel | null, prev: ExposureState): ExposureState {
  const auto = s.expoMode === ExpoMode.auto;
  const color = s.colorMode ?? ColorMode.normal;
  const indices = s.availableIsoIndices.length ? s.availableIsoIndices : ColorModes.isoIndices(color);
  const isoOptions = indices.map((i) => IsoIndexes.value(i)).filter((v): v is number => v != null).sort((a, b) => a - b);
  const limits = ColorModes.isoAutoLimits(color).map(isoLimitCeiling);
  const iris = s.irisHundredths != null ? s.irisHundredths / 100 : s.apertureStrategy != null ? apertureFNumber(s.apertureStrategy) : null;
  const apertureOptions = s.availableApertureStrategies.map(apertureFNumber).filter((v): v is number => v != null);
  const out: ExposureState = {
    ...prev,
    mode: s.expoMode == null ? prev.mode : auto ? 'auto' : 'manual',
    iso: s.iso > 0 ? s.iso : null,
    isoAuto: s.isoIndex == null ? auto : s.isoIndex === IsoIndex.auto,
    isoOptions: isoOptions.length ? isoOptions : prev.isoOptions,
    isoLimit: s.isoLimit != null ? isoLimitCeiling(s.isoLimit) : prev.isoLimit,
    isoLimitOptions: limits.length ? limits : prev.isoLimitOptions,
    shutterDenom: s.shutterDenom > 0 ? s.shutterDenom : null,
    shutterAuto: auto,
    shutterOptions: CamCapShutter.wheelDenoms(s.availableShutterDenoms, s.shutterDenom),
    ev: s.evComp != null ? thirdsToEv(s.evComp) : prev.ev,
    evOptions: EV_OPTIONS,
    meteredEv: s.meteredEv != null ? thirdsToEv(s.meteredEv) : null,
  };
  if (model && supportsAperture(model)) {
    out.aperture = iris;
    out.apertureOptions = apertureOptions.length ? apertureOptions : prev.apertureOptions;
  }
  return out;
}

export function mapWhiteBalance(s: CameraStatus, prev: WhiteBalanceState): WhiteBalanceState {
  const wb = s.whiteBalance;
  if (!wb) return prev;
  const custom = wb.mode === WhiteBalanceMode.custom;
  return {
    ...prev,
    preset: custom ? 'custom' : 'auto',
    kelvin: custom ? (s.whiteBalanceKelvin > 0 ? s.whiteBalanceKelvin : null) : s.autoWhiteBalanceKelvin > 0 ? s.autoWhiteBalanceKelvin : null,
    tint: s.whiteBalanceTint,
    kelvinMin: 2000,
    kelvinMax: 10000,
    kelvinStep: 100,
    tintMin: -100,
    tintMax: 100,
  };
}

export function mapFormat(s: CameraStatus, model: CameraModel | null, prev: FormatState): FormatState {
  const mode = StatusQueries.shootingMode(s);
  const formats = CamCapVideoFormat.pickerFormats(s.availableVideoFormats, model, s.shootingMode);
  const options = formatOptions(formats);
  const res = s.videoResolution;
  const order = (model?.captureProfile?.colorModes ?? []) as ColorMode[];
  const wheel = CamCapColorMode.wheel(s.availableColorModes, order)
    .map(uiColorMode)
    .filter((m): m is UIColorMode => m != null);
  const color = uiColorMode(s.colorMode);
  const aspect = res != null ? VideoResolutions.aspect(res) : null;
  return {
    ...prev,
    shootingMode: mode != null ? uiShootingMode(mode) : prev.shootingMode,
    resolution: res != null ? resolutionLabel(res) : prev.resolution,
    fps: s.fps > 0 ? s.fps : prev.fps,
    aspect: aspect ?? prev.aspect,
    options: options.length ? options : prev.options,
    colorMode: color ?? prev.colorMode,
    colorModeOptions: wheel.length ? wheel : prev.colorModeOptions,
  };
}

export function mapZoom(s: CameraStatus, model: CameraModel | null, prev: ZoomState): ZoomState {
  const stops = model ? activeZoomStops(model, s.videoResolution, s.shootingMode) : prev.stops;
  const max = stops[stops.length - 1] ?? 1;
  const live = StatusQueries.zoomFactor(s);
  return {
    ...prev,
    factor: live != null ? CamFov.displayTenths(live, Math.max(max, 1)) : prev.factor,
    stops,
    min: 1,
    max,
    opticalMax: model && isPocket4Pro(model) ? 3 : 1,
  };
}

export function mapPower(s: CameraStatus, prev: PowerStorageState): PowerStorageState {
  const sd = s.sdTotalMb > 0;
  return {
    ...prev,
    batteryPercent: s.batteryPercent,
    charging: StatusQueries.chargingReading(s) ?? false,
    docked: s.docked,
    storageFreeMb: sd ? s.sdFreeMb : s.storageFreeMb,
    storageTotalMb: sd ? s.sdTotalMb : s.storageTotalMb,
    sdPresent: sd || s.storageTotalMb > 0,
  };
}

export function mapAudio(s: CameraStatus, prev: AudioState): AudioState {
  const m = s.audioMeters;
  const db = (v: number) => (v <= -60 ? -120 : v);
  return {
    ...prev,
    left: m ? { rmsDb: db(m.left.levelDB), peakDb: db(m.left.peakDB) } : prev.left,
    right: m ? { rmsDb: db(m.right.levelDB), peakDb: db(m.right.peakDB) } : prev.right,
    channel: s.audioChannel === 0x01 ? 'mono' : s.audioChannel == null ? prev.channel : 'stereo',
    windReduction: s.windNR == null ? prev.windReduction : s.windNR === WindNoiseReduction.on,
    directional: s.directionalAudio == null ? prev.directional : uiDirectional(s.directionalAudio),
    vocalBoost: s.vocalBoost == null ? prev.vocalBoost : s.vocalBoost === 1,
  };
}

export function mapTracking(poll: TrackingPoll | null, prev: TrackingState): TrackingState {
  if (!poll) return prev;
  if (poll.kind === 'idle') return { ...prev, status: 'idle', box: undefined };
  return { ...prev, status: 'tracking', box: poll.box ?? prev.box };
}

export interface GimbalLive {
  mode?: GimbalMode;
  /** Attitude tenths from `GimbalStickMapping`. */
  yawTenthDeg?: number | null;
  pitchTenthDeg?: number | null;
  face?: CameraFace | null;
}

// ---------------------------------------------------------------------------------------------
// Whole state

export interface MapInput {
  status: CameraStatus;
  model: CameraModel | null;
  tracking?: TrackingPoll | null;
  gimbal?: GimbalLive;
}

/** Overlay decoded status onto the previous UI state (connection/identity are owned by the session). */
export function mapCameraState(prev: CameraState, input: MapInput): CameraState {
  const { status: s, model } = input;
  const g = input.gimbal ?? {};
  const params = s.gimbalParams;
  const face: CameraFace = g.face ?? (s.gimbalFace === 'selfie' ? 'selfie' : s.gimbalFace === 'front' ? 'front' : prev.gimbal.face);
  return {
    ...prev,
    identity: prev.identity && model ? { ...prev.identity, model: modelIdOf(model), firmware: s.firmware ?? prev.identity.firmware } : prev.identity,
    recording: mapRecording(s, prev.recording),
    exposure: mapExposure(s, model, prev.exposure),
    whiteBalance: mapWhiteBalance(s, prev.whiteBalance),
    format: mapFormat(s, model, prev.format),
    focus: {
      ...prev.focus,
      mode: uiFocusMode(s.focusMode, prev.focus.mode),
      x: s.hasCameraFocusPoint ? s.focusX : prev.focus.x,
      y: s.hasCameraFocusPoint ? s.focusY : prev.focus.y,
      hasPoint: s.hasCameraFocusPoint || prev.focus.hasPoint,
    },
    zoom: mapZoom(s, model, prev.zoom),
    gimbal: {
      ...prev.gimbal,
      available: model ? hasGimbal(model) : prev.gimbal.available,
      mode: g.mode ? uiGimbalMode(g.mode) : prev.gimbal.mode,
      speed: params?.speed != null ? uiGimbalSpeed(params.speed) : prev.gimbal.speed,
      face,
      yaw: g.yawTenthDeg != null ? g.yawTenthDeg / 10 : prev.gimbal.yaw,
      pitch: g.pitchTenthDeg != null ? g.pitchTenthDeg / 10 : prev.gimbal.pitch,
    },
    tracking: { ...mapTracking(input.tracking ?? null, prev.tracking), available: model ? hasGimbal(model) : prev.tracking.available },
    power: mapPower(s, prev.power),
    audio: mapAudio(s, prev.audio),
    capabilities: model ? capabilitiesOf(model) : prev.capabilities,
  };
}
