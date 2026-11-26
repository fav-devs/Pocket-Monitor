/**
 * UI-facing camera model. This is the contract between the screens and whatever drives
 * the camera (the native session built on `src/core` + `modules/pocket-native`, the demo
 * session, or a watcher relay).
 *
 * Rules for editing this file:
 * - Additive changes only (new optional fields, new union members). Never rename/remove.
 * - Wire bytes never appear here. `src/core` decodes wire state and maps it into these values.
 */

export type CameraModelId =
  | 'osmo-pocket-3'
  | 'osmo-pocket-4'
  | 'osmo-pocket-4-pro'
  | 'osmo-nano'
  | 'osmo-action-6'
  | 'unknown';

export interface CameraIdentity {
  /** Stable id for saved cameras (BLE identifier or serial). */
  id: string;
  /** Operator-visible name, e.g. "Pocket 3". */
  name: string;
  model: CameraModelId;
  serial?: string;
  firmware?: string;
  /** Camera SoftAP SSID once known. */
  ssid?: string;
}

/** A camera found during Bluetooth scan. */
export interface DiscoveredCamera {
  id: string;
  name: string;
  model: CameraModelId;
  rssi: number;
  /** True when the advert says the camera is ready to pair (pairing mode). */
  pairable: boolean;
  /** True when the camera is already saved on this device. */
  saved: boolean;
}

/** How this device reaches the camera after first pairing. */
export type CameraNetworkPath =
  | { kind: 'softap'; ssid: string }
  | { kind: 'station'; ssid: string; host?: string }
  | { kind: 'hotspot'; ssid: string };

/** A camera remembered on this device. Credentials live in secure storage, not here. */
export interface SavedCamera {
  id: string;
  name: string;
  model: CameraModelId;
  path: CameraNetworkPath;
  lastConnectedAt?: number;
  favorite?: boolean;
}

/**
 * The connection spine: BLE → SoftAP (or station Wi-Fi) → UDP datalink → live view.
 * Order matters; the UI shows these as a checklist.
 */
export type ConnectionPhase =
  | 'idle'
  | 'scanning'
  | 'bluetooth'
  | 'authorizing'
  | 'wifi-handoff'
  | 'joining-wifi'
  | 'datalink'
  | 'live-start'
  | 'live'
  | 'recovering'
  | 'failed'
  | 'disconnected';

export type ConnectionTransport = 'none' | 'softap' | 'station' | 'hotspot' | 'watcher' | 'demo';

export type LinkHealthBand = 'poor' | 'watch' | 'stable';

export interface ConnectionState {
  phase: ConnectionPhase;
  /** Short operator copy for the current phase, e.g. "Joining camera Wi-Fi". */
  detail?: string;
  /** Operator copy for a failure, with a suggested fix where possible. */
  error?: string;
  transport: ConnectionTransport;
  linkBand: LinkHealthBand;
  /** 0–4 bars. */
  signalBars: number;
  /** Frames presented per second (measured). */
  videoFps: number;
  /** Received video bitrate, kbit/s. */
  videoKbps: number;
  /** Milliseconds since the last presented frame. */
  lastFrameAgeMs: number;
  /** Encoded stream geometry once known. */
  streamWidth?: number;
  streamHeight?: number;
  streamCodec?: 'hevc' | 'avc';
}

export type ShootingMode =
  | 'video'
  | 'photo'
  | 'slow-motion'
  | 'timelapse'
  | 'hyperlapse'
  | 'panorama'
  | 'night'
  | 'unknown';

export interface RecordingState {
  recording: boolean;
  /** Seconds into the current take. */
  elapsedSec: number;
  /** Remaining record time on the card, seconds. -1 unknown. */
  remainingSec: number;
  /** 3-2-1 countdown before record starts, or null. */
  countdown: number | null;
  /** Timecode HH:MM:SS:FF if the camera reports one. */
  timecode?: string;
  /** Still capture in flight. */
  capturingStill: boolean;
}

export type ExposureMode = 'auto' | 'manual';

export interface ExposureState {
  mode: ExposureMode;
  /** Current ISO, or null if unknown. */
  iso: number | null;
  isoAuto: boolean;
  isoOptions: number[];
  /** Max ISO in auto. */
  isoLimit?: number;
  isoLimitOptions?: number[];
  /** Shutter as 1/denom seconds. */
  shutterDenom: number | null;
  shutterAuto: boolean;
  shutterOptions: number[];
  /** Exposure compensation in stops. */
  ev: number;
  evOptions: number[];
  /** f-number, only on cameras with an iris (Action 6). */
  aperture?: number | null;
  apertureOptions?: number[];
  /** Metered exposure offset in stops for the EV meter, if known. */
  meteredEv?: number | null;
}

export type WhiteBalancePreset = 'auto' | 'daylight' | 'cloudy' | 'incandescent' | 'fluorescent' | 'custom';

export interface WhiteBalanceState {
  preset: WhiteBalancePreset;
  kelvin: number | null;
  tint: number | null;
  kelvinMin: number;
  kelvinMax: number;
  kelvinStep: number;
  tintMin: number;
  tintMax: number;
}

export type ColorMode = 'normal' | 'hlg' | 'dlog-m' | 'dlog' | 'dlog2' | '10bit';

export interface VideoFormatOption {
  /** e.g. '4K', '2.7K', '1080p', '3K'. */
  resolution: string;
  width: number;
  height: number;
  fps: number[];
  aspect: '16:9' | '9:16' | '1:1' | '4:3' | '3:2';
}

export interface FormatState {
  shootingMode: ShootingMode;
  shootingModeOptions: ShootingMode[];
  resolution: string;
  fps: number;
  aspect: VideoFormatOption['aspect'];
  options: VideoFormatOption[];
  colorMode: ColorMode;
  colorModeOptions: ColorMode[];
  codec: 'h264' | 'h265';
  bitrate?: 'low' | 'normal' | 'high';
}

export type FocusMode = 'afc' | 'afs' | 'mf';

export interface FocusState {
  mode: FocusMode;
  /** Normalized focus point (0..1) in picture space. */
  x: number;
  y: number;
  hasPoint: boolean;
  /** Manual focus distance 0 (near) … 1 (far), when mode is 'mf'. */
  manualPosition?: number;
  faceDetection?: boolean;
}

export interface ZoomState {
  factor: number;
  /** Tap stops for the zoom chip, e.g. [1, 2, 4]. */
  stops: number[];
  min: number;
  max: number;
  /** Above this factor the picture is a digital crop. */
  opticalMax: number;
}

export type GimbalMode = 'follow' | 'tilt-locked' | 'fpv' | 'spin' | 'locked';
export type GimbalSpeed = 'slow' | 'normal' | 'fast';
export type CameraFace = 'front' | 'selfie';

export interface GimbalState {
  available: boolean;
  mode: GimbalMode;
  modeOptions: GimbalMode[];
  speed: GimbalSpeed;
  face: CameraFace;
  /** Attitude in degrees. */
  yaw: number;
  pitch: number;
  roll: number;
  /** All-axes joystick hold latch (not the same as tilt-locked). */
  lockedAllAxes: boolean;
  recentering: boolean;
  /** Motion Control (A→B→C) program state. */
  program: MotionProgramState;
}

export interface MotionWaypoint {
  yaw: number;
  pitch: number;
  zoom?: number;
}

export interface MotionProgramState {
  status: 'idle' | 'preparing' | 'running' | 'done' | 'failed';
  a?: MotionWaypoint;
  b?: MotionWaypoint;
  c?: MotionWaypoint;
  /** Duration per leg, seconds. */
  legSeconds: [number, number];
  smoothness: number;
  /** 0..1 while running. */
  progress: number;
  error?: string;
}

export interface TrackingState {
  available: boolean;
  status: 'idle' | 'searching' | 'tracking' | 'lost';
  /** Normalized box in picture space. */
  box?: { x: number; y: number; width: number; height: number };
  label?: string;
}

export interface PowerStorageState {
  batteryPercent: number;
  charging: boolean;
  docked: boolean;
  storageFreeMb: number;
  storageTotalMb: number;
  sdPresent: boolean;
  thermal: 'normal' | 'warm' | 'hot';
}

export interface AudioMeterValue {
  /** dBFS, −∞..0 (use −120 for silence). */
  rmsDb: number;
  peakDb: number;
}

export interface AudioState {
  left: AudioMeterValue;
  right: AudioMeterValue;
  channel: 'stereo' | 'mono';
  source: 'internal' | 'mic' | 'external';
  windReduction: boolean;
  directional: 'off' | 'front' | 'rear' | 'surround';
  vocalBoost: boolean;
  gainDb?: number;
}

export interface LevelState {
  /** Camera roll in degrees (horizon tilt). */
  roll: number;
  /** Camera pitch in degrees. */
  pitch: number;
}

export interface CameraCapabilities {
  zoom: boolean;
  gimbal: boolean;
  tracking: boolean;
  selfieFlip: boolean;
  aperture: boolean;
  manualFocus: boolean;
  audioControls: boolean;
  media: boolean;
  timecode: boolean;
}

export interface CameraState {
  identity: CameraIdentity | null;
  connection: ConnectionState;
  recording: RecordingState;
  exposure: ExposureState;
  whiteBalance: WhiteBalanceState;
  format: FormatState;
  focus: FocusState;
  zoom: ZoomState;
  gimbal: GimbalState;
  tracking: TrackingState;
  power: PowerStorageState;
  audio: AudioState;
  level: LevelState;
  capabilities: CameraCapabilities;
}

/** Normalized point in picture space (0..1, origin top-left). */
export interface PicturePoint {
  x: number;
  y: number;
}

export interface PictureRect extends PicturePoint {
  width: number;
  height: number;
}

/** A toast the session wants the operator to see (e.g. "Gamepad connected"). */
export interface CameraNotice {
  id: string;
  message: string;
  tone: 'info' | 'warning' | 'error' | 'success';
}
