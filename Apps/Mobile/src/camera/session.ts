import type {
  CameraFace,
  CameraNotice,
  CameraState,
  ColorMode,
  DiscoveredCamera,
  ExposureMode,
  FocusMode,
  GimbalMode,
  GimbalSpeed,
  MotionWaypoint,
  PicturePoint,
  PictureRect,
  SavedCamera,
  ShootingMode,
  WhiteBalancePreset,
} from './types';

export type Unsubscribe = () => void;

/**
 * Where the live picture comes from. `<LivePicture>` (src/features/picture) reads this to
 * pick a renderer: the native decoder view, the procedural demo renderer, or a relay feed.
 */
export type VideoSource =
  | { kind: 'none' }
  /** Native decoder fed by the native datalink. `sessionId` keys the native session. */
  | { kind: 'native'; sessionId: string }
  /** Procedural test scene (web preview, simulator, no camera). */
  | { kind: 'demo'; scene: 'studio' | 'bars' | 'skin' | 'night' }
  /** Watcher relay from another phone (native). */
  | { kind: 'relay'; sessionId: string }
  /**
   * Desktop (Tauri): the Rust backend presents the picture natively (Vulkan) under a
   * transparent web view. `<LivePicture>` renders a transparent hole and reports its rect.
   */
  | { kind: 'desktop' };

export interface FormatChange {
  resolution?: string;
  fps?: number;
  colorMode?: ColorMode;
  codec?: 'h264' | 'h265';
  bitrate?: 'low' | 'normal' | 'high';
}

export interface WhiteBalanceChange {
  preset?: WhiteBalancePreset;
  kelvin?: number;
  tint?: number;
}

export interface GimbalController {
  /**
   * Drive the gimbal with a velocity vector. x = pan (−1 left … 1 right),
   * y = tilt (−1 down … 1 up). Call repeatedly while the stick is held; send (0,0) on release.
   */
  drive(x: number, y: number): void;
  recenter(): Promise<void>;
  /** Rotate 180° / selfie flip. */
  flip(face?: CameraFace): Promise<void>;
  setMode(mode: GimbalMode): Promise<void>;
  setSpeed(speed: GimbalSpeed): Promise<void>;
  setLockedAllAxes(locked: boolean): void;
  /** Motion Control: capture the current pose as a waypoint. */
  captureWaypoint(slot: 'a' | 'b' | 'c'): Promise<MotionWaypoint>;
  clearWaypoint(slot: 'a' | 'b' | 'c'): void;
  configureProgram(options: { legSeconds?: [number, number]; smoothness?: number }): void;
  runProgram(): Promise<void>;
  stopProgram(): void;
  /** Double-tap level. */
  level(): Promise<void>;
}

export interface CameraController {
  startRecording(options?: { countdown?: boolean }): Promise<void>;
  stopRecording(): Promise<void>;
  capturePhoto(): Promise<void>;
  setShootingMode(mode: ShootingMode): Promise<void>;
  setExposureMode(mode: ExposureMode): Promise<void>;
  /** `'auto'` returns ISO to auto. */
  setIso(iso: number | 'auto'): Promise<void>;
  setIsoLimit(iso: number): Promise<void>;
  setShutter(denom: number | 'auto'): Promise<void>;
  setEv(ev: number): Promise<void>;
  setAperture(fNumber: number): Promise<void>;
  setWhiteBalance(change: WhiteBalanceChange): Promise<void>;
  setFormat(change: FormatChange): Promise<void>;
  setFocusMode(mode: FocusMode): Promise<void>;
  /** Tap-to-focus at a picture point. */
  focusAt(point: PicturePoint): Promise<void>;
  setManualFocus(position: number): Promise<void>;
  setZoom(factor: number): Promise<void>;
  /** Continuous zoom; rate −1 (out) … 1 (in), 0 stops. */
  zoomBy(rate: number): void;
  startTracking(target: PictureRect | PicturePoint): Promise<void>;
  stopTracking(): Promise<void>;
  setAudio(change: {
    channel?: 'stereo' | 'mono';
    windReduction?: boolean;
    directional?: 'off' | 'front' | 'rear' | 'surround';
    vocalBoost?: boolean;
  }): Promise<void>;
}

/** On-camera media (clips and stills). */
export interface CameraMediaItem {
  id: string;
  kind: 'video' | 'photo';
  fileName: string;
  createdAt: number;
  durationSec?: number;
  sizeBytes: number;
  width?: number;
  height?: number;
  fps?: number;
  colorMode?: ColorMode;
  favorite: boolean;
  /** Burst / panorama group. */
  groupId?: string;
  /** URL for a thumbnail image. May be a data: URL in demo. */
  thumbnailUrl?: string;
  /** Low-res preview stream URL for playback. */
  previewUrl?: string;
  /** Full-quality original URL. */
  originalUrl?: string;
}

export interface MediaTransferProgress {
  itemId: string;
  bytesDone: number;
  bytesTotal: number;
  /** Bytes per second. */
  rate: number;
}

export interface CameraMediaService {
  list(): Promise<CameraMediaItem[]>;
  setFavorite(id: string, favorite: boolean): Promise<void>;
  delete(ids: string[]): Promise<void>;
  /** Download an original to a local file URI. */
  download(id: string, onProgress?: (p: MediaTransferProgress) => void): Promise<string>;
  /** Live view is paused while browsing media on the camera; call when leaving. */
  resumeLive(): Promise<void>;
}

export type SessionEvent =
  | { type: 'notice'; notice: CameraNotice }
  | { type: 'photo-captured' }
  | { type: 'recording-started' }
  | { type: 'recording-stopped' };

export interface ConnectOptions {
  /** Wi-Fi password the camera handed over during BLE pairing, if this is the first pair. */
  wifiPassword?: string;
}

/**
 * Everything the UI can ask of a camera. Implementations:
 * - `DemoCameraSession` (src/camera/demo) — web preview and offline development.
 * - `NativeCameraSession` (src/camera/native) — real camera via src/core + modules/pocket-native.
 * - `DesktopCameraSession` (src/camera/desktop) — the Tauri desktop app, over Tauri IPC to the
 *   Rust backend (Apps/Desktop/crates/pm-desktop).
 */
export interface CameraSession {
  readonly kind: 'demo' | 'native' | 'watcher' | 'desktop';
  getState(): CameraState;
  subscribe(listener: (state: CameraState) => void): Unsubscribe;
  onEvent(listener: (event: SessionEvent) => void): Unsubscribe;
  readonly video: VideoSource;

  // Discovery and connection
  startScan(onFound: (cameras: DiscoveredCamera[]) => void): Unsubscribe;
  connect(target: DiscoveredCamera | SavedCamera, options?: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  retry(): Promise<void>;

  readonly control: CameraController;
  readonly gimbal: GimbalController;
  readonly media: CameraMediaService;

  /**
   * Optional (additive). The picture view reports presented-frame stats (~1 Hz, e.g. from
   * `PocketVideoView.onFrameStats`) so the session can show measured fps / frame age and feed
   * decoder ages to the watchdog. Sessions without a native decoder ignore it.
   */
  notePictureStats?(stats: PictureFrameStats): void;
}

/** Presented-frame stats from the picture view (subset of `VideoFrameStats`). */
export interface PictureFrameStats {
  presentedFps: number;
  lastFrameAgeMs: number;
  width?: number;
  height?: number;
}
