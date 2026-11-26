/**
 * JS ⇄ native contract for pocket-native. The Swift and Kotlin modules implement exactly these
 * shapes. Web never loads native code: each module wrapper returns `null` there and callers
 * fall back to the demo path.
 */

// ───────────────────────────── Bluetooth ─────────────────────────────

export type BluetoothPowerState = 'unknown' | 'resetting' | 'unsupported' | 'unauthorized' | 'off' | 'on';

export interface BluetoothAdvert {
  /** Platform peripheral id (iOS UUID, Android MAC). */
  id: string;
  name: string | null;
  rssi: number;
  /** Raw manufacturer-specific data (company id included), for `src/core` BleAdvert decode. */
  manufacturerData: Uint8Array | null;
  serviceUuids: string[];
}

export interface BluetoothNotify {
  id: string;
  /** Characteristic UUID the bytes arrived on. */
  characteristic: string;
  bytes: Uint8Array;
}

export interface BluetoothConnectionEvent {
  id: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'failed';
  error?: string;
}

export interface PocketBluetoothNativeModule {
  getPowerState(): BluetoothPowerState;
  requestPermissions(): Promise<boolean>;
  startScan(serviceUuids: string[] | null): void;
  stopScan(): void;
  /**
   * Connects, discovers services, and enables notify on `notifyCharacteristics`.
   * `armPairing` (default true): once every CCCD settled, native writes the DJI app-pairing arm
   * `[01 00]` with response to `notifyCharacteristics[0]` (fff4) and resolves after it lands.
   */
  connect(
    id: string,
    options: { service: string; writeCharacteristic: string; notifyCharacteristics: string[]; armPairing?: boolean },
  ): Promise<void>;
  disconnect(id: string): Promise<void>;
  write(id: string, bytes: Uint8Array, withResponse: boolean): Promise<void>;
  /** Event names: 'onPowerState', 'onAdvert', 'onConnection', 'onNotify'. */
  addListener(event: 'onPowerState', cb: (e: { state: BluetoothPowerState }) => void): { remove(): void };
  addListener(event: 'onAdvert', cb: (e: BluetoothAdvert) => void): { remove(): void };
  addListener(event: 'onConnection', cb: (e: BluetoothConnectionEvent) => void): { remove(): void };
  addListener(event: 'onNotify', cb: (e: BluetoothNotify) => void): { remove(): void };
}

// ───────────────────────────── Wi-Fi ─────────────────────────────

export interface WifiJoinResult {
  joined: boolean;
  /** 'already-associated' means the phone was on that network already. */
  outcome: 'joined' | 'already-associated' | 'user-denied' | 'not-found' | 'wrong-password' | 'timeout' | 'failed';
  message?: string;
}

export interface PocketWifiNativeModule {
  /** iOS: NEHotspotConfiguration. Android: WifiNetworkSpecifier + process binding. */
  join(ssid: string, password: string, options: { joinOnce: boolean; timeoutMs: number }): Promise<WifiJoinResult>;
  /** Forget/release the network request (Android unbinds the process). */
  leave(ssid: string): Promise<void>;
  /** Current SSID if readable (needs location permission on both platforms). */
  currentSsid(): Promise<string | null>;
  /** Local IPv4 on the camera network, if associated. */
  localAddress(): Promise<string | null>;
}

// ───────────────────────────── Datalink (UDP) ─────────────────────────────

export interface DatalinkOpenOptions {
  /** Camera address, usually 192.168.2.1 on SoftAP. */
  host: string;
  /** DUML datalink port, 9004. */
  port: number;
  /** Local bind port (0 = any). */
  localPort: number;
  /** ACK pump rate; protocol requires 40 Hz independent of UI. */
  ackHz: number;
  /**
   * Optional TCP "poke" opened before UDP and kept for the session (Mimo keeps 7001 open; the
   * camera pushes 0x21/0x06 there). `bytes` is the SetPairingPIN DUML frame built by src/core.
   * Best effort: a failed poke does not fail `open`.
   */
  tcpPoke?: { port: number; bytes: Uint8Array } | null;
}

export interface DatalinkStats {
  sessionId: string;
  rxPackets: number;
  txPackets: number;
  rxBytesPerSec: number;
  videoPacketsPerSec: number;
  /** Measured ACK pump rate. */
  ackHz: number;
  /** ms since last datagram from the camera. */
  lastRxAgeMs: number;
}

export interface DatalinkFrame {
  sessionId: string;
  /** One complete DUML frame (0x55 … CRC16) from the camera's command/notification channel. */
  bytes: Uint8Array;
}

export interface DatalinkStateEvent {
  sessionId: string;
  state: 'opening' | 'handshaking' | 'open' | 'stalled' | 'closed' | 'failed';
  error?: string;
}

export interface PocketDatalinkNativeModule {
  open(sessionId: string, options: DatalinkOpenOptions): Promise<void>;
  close(sessionId: string): Promise<void>;
  /** Send one DUML frame on the command channel (native wraps it in transport framing). */
  sendDuml(sessionId: string, bytes: Uint8Array): void;
  /** Send a raw transport datagram (handshake bytes built by src/core). */
  sendRaw(sessionId: string, bytes: Uint8Array): void;
  /** Route video payloads of this session into the native decoder (PocketVideo). */
  attachVideo(sessionId: string, codec: 'hevc' | 'avc'): void;
  detachVideo(sessionId: string): void;
  /** Event names: 'onDuml', 'onState', 'onStats'. */
  addListener(event: 'onDuml', cb: (e: DatalinkFrame) => void): { remove(): void };
  addListener(event: 'onState', cb: (e: DatalinkStateEvent) => void): { remove(): void };
  addListener(event: 'onStats', cb: (e: DatalinkStats) => void): { remove(): void };
}

// ───────────────────────────── Video ─────────────────────────────

export type Rgb = [number, number, number];

export type FalseColorMode = 'cinestop' | 'video' | 'ire' | 'limits';

/**
 * Per-pixel effects the picture renderer applies (GPU shader on every platform:
 * Metal on iOS, GLES on Android, WebGL on web). Overlays that are not per-pixel
 * (grids, guides, tracking box, meters) are drawn by React on top, not here.
 */
export interface PictureEffects {
  /** Display transform for log footage before anything else. */
  sourceColor: 'rec709' | 'hlg' | 'dlog-m' | 'dlog' | 'dlog2';
  /** Registered LUT id (see `loadLut`) applied as the monitoring look. */
  lutId: string | null;
  lutIntensity: number;
  falseColor: FalseColorMode | null;
  /**
   * Zebra on the camera signal (not the graded picture). `upper`: highlight threshold in monitor
   * IRE (WAVE axis, 0–100, above 100 = headroom over the live ceiling) on max(R,G,B); values far
   * above the axis (e.g. 1000) = highlight off. `lower`: midtone centre in monitor IRE, ±5 IRE on
   * luma; null = off. `midtone` (optional, additive): the same midtone band already resolved to
   * encoded luma codes 0…1, with its own paint (renderers without it use `paint`).
   */
  zebra: {
    upper: number;
    lower: number | null;
    paint: Rgb;
    stripes: boolean;
    midtone?: { lower: number; upper: number; paint: Rgb } | null;
  } | null;
  peaking: { color: Rgb; ratioThreshold: number; noiseGate: number } | null;
  /** Desqueeze factor (1 = off) and axis. */
  desqueeze: { factor: number; direction: 'horizontal' | 'vertical' };
  mirror: boolean;
  monochrome: boolean;
  /**
   * Optional (additive). The curve the camera signal is in, for false colour / zebra / the
   * peaking gate. `sourceColor` is only the display transform; absent = same as `sourceColor`.
   */
  signal?: 'rec709' | 'hlg' | 'dlog-m' | 'dlog' | 'dlog2';
  /** Optional (additive). Live clip ceiling of `signal` on the 0…255 tap axis (D-Log2 247). Default 255. */
  clipByte?: number;
  /** Optional (additive). Input exposure in stops of `signal`, applied before the LUT. Default 0. */
  lutExposureStops?: number;
  /** Optional (additive). Top-to-bottom flip (MIRROR Vertical). Default false. */
  mirrorVertical?: boolean;
}

export const defaultPictureEffects: PictureEffects = {
  sourceColor: 'rec709',
  lutId: null,
  lutIntensity: 1,
  falseColor: null,
  zebra: null,
  peaking: null,
  desqueeze: { factor: 1, direction: 'horizontal' },
  mirror: false,
  monochrome: false,
};

export type DemoScene = 'studio' | 'bars' | 'skin' | 'night';

export interface VideoViewProps {
  /** Native session whose decoded frames to show; null shows `demoScene` or black. */
  sessionId: string | null;
  /** Procedural test scene when there is no session (simulator, previews). */
  demoScene?: DemoScene | null;
  effects: PictureEffects;
  resizeMode: 'fit' | 'fill';
  /** Fires ~1 Hz. */
  onFrameStats?: (e: { nativeEvent: VideoFrameStats }) => void;
}

export interface VideoFrameStats {
  width: number;
  height: number;
  presentedFps: number;
  decodedFps: number;
  droppedFrames: number;
  lastFrameAgeMs: number;
}

export type ScopeKind = 'waveform' | 'parade' | 'histogram' | 'vectorscope';

export interface ScopeViewProps {
  sessionId: string | null;
  demoScene?: DemoScene | null;
  kind: ScopeKind;
  /** Scope-specific options: waveform {mode:'luma'|'rgb'}, histogram {mode:'luma'|'rgb'}, vectorscope {zoom:1|2}. */
  options: Record<string, string | number | boolean>;
  /** Trace brightness 0..1. */
  brightness: number;
  /** Apply the monitoring effects (LUT) before measuring. */
  measureAfterLut: boolean;
  effects: PictureEffects;
}

export interface PocketVideoNativeModule {
  /** Parse and register a .cube LUT; returns its size (e.g. 33). */
  loadLut(id: string, cubeText: string): Promise<number>;
  unloadLut(id: string): void;
  /** Grab the current frame (after effects if `withEffects`) as a JPEG file URI. */
  snapshot(sessionId: string, withEffects: boolean): Promise<string>;
  /** Latest small RGBA sample for JS-side meters (EV, traffic lights, ND). */
  sampleFrame(sessionId: string, width: number, height: number): Promise<{ width: number; height: number; rgba: Uint8Array } | null>;
}

// ───────────────────────────── Gamepad ─────────────────────────────

export interface GamepadState {
  connected: boolean;
  name?: string;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  l2: number;
  r2: number;
  buttons: {
    a: boolean;
    b: boolean;
    x: boolean;
    y: boolean;
    l1: boolean;
    r1: boolean;
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    menu: boolean;
  };
}

export interface PocketGamepadNativeModule {
  start(): void;
  stop(): void;
  addListener(event: 'onGamepad', cb: (e: GamepadState) => void): { remove(): void };
}

// ───────────────────────────── Head motion (iOS AirPods) ─────────────────────────────

export interface HeadMotionSample {
  /** Quaternion (x, y, z, w). */
  quaternion: [number, number, number, number];
  /** Sample timestamp, seconds (device clock). */
  timestamp: number;
}

export interface PocketHeadMotionNativeModule {
  isAvailable(): boolean;
  start(): Promise<void>;
  stop(): void;
  addListener(event: 'onSample', cb: (e: HeadMotionSample) => void): { remove(): void };
  addListener(event: 'onConnection', cb: (e: { connected: boolean }) => void): { remove(): void };
}
