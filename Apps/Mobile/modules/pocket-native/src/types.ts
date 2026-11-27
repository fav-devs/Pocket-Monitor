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

// ───────────────────────────── Watcher relay ─────────────────────────────
// docs/watcher-relay.md. Native owns sockets, Bonjour / NSD, framing and video; JS reads and writes
// the small JSON messages (src/camera/watcher/protocol.ts) and runs the watcher's retry policy.

/** A sharing host found on this Wi-Fi (Bonjour `_pocket-mon._tcp` or legacy `_opc-mon._tcp`). */
export interface RelayHostAdvert {
  /** `<serviceType>/<instance name>`: pass to `join`. */
  id: string;
  name: string;
  /** TXT `c`. */
  camera: string;
  serviceType: string;
  /** TXT `w` is not `"0"`. */
  watchable: boolean;
}

export interface RelayHostsEvent {
  hosts: RelayHostAdvert[];
  browsing: boolean;
  error?: string | null;
}

export interface RelayHostStartOptions {
  /**
   * The camera's native video session (`VideoSource.sessionId`). The host keeps its decoder running
   * while sharing and re-encodes the decoded picture for watchers (or, without a hardware encoder,
   * forwards its access units).
   */
  cameraSessionId: string;
  /** Bonjour instance name; empty = this device's name. */
  hostName: string;
  cameraName: string;
  /** Empty = open feed. */
  passcode: string;
  allowsControl: boolean;
  /** Video sends in flight per watcher (Broadcast priority). */
  window: number;
}

export interface RelayHostStatusEvent {
  state: 'starting' | 'advertising' | 'stopped' | 'failed';
  error?: string | null;
  /** Authorized watchers. */
  watchers: number;
  /** A control request waiting for Grant / Deny. */
  pending: { name: string; watcherId: string } | null;
  /** Who holds control: "Host" or a watcher name. */
  holder: string;
  /**
   * A new watcher gets a picture promptly: always true while re-encoding; when forwarding, false
   * while no camera keyframe is cached (a new watcher waits for one).
   */
  joinable: boolean;
  /** Names of the authorized watchers, in join order. */
  watcherNames?: string[];
  /**
   * `reencode`: the phone's hardware HEVC encode, a keyframe at least every 2 s and on join.
   * `forward`: no hardware encoder, the camera's own access units (new watchers may wait for a
   * camera keyframe). Absent from older native builds.
   */
  video?: 'reencode' | 'forward';
}

/** A command from the watcher holding control (already admitted natively). JSON per `encodeCommand`. */
export interface RelayHostCommandEvent {
  json: string;
  watcherId: string;
}

export interface RelayJoinOptions {
  /** Relay video session id the picture is published under (`VideoSource { kind: 'relay' }`). */
  sessionId: string;
  /** `RelayHostAdvert.id`. Resolved again on each join (a restarted host can move ports). */
  hostId: string;
  /** Hello JSON (`encodeHello`), sent once the socket is ready. */
  hello: string;
}

export interface RelayWatcherStatusEvent {
  sessionId: string;
  /** `open`: the socket is up and the hello went out; acceptance is the host's hello message. */
  state: 'connecting' | 'open' | 'closed';
  error?: string | null;
}

export interface RelayWatcherMessageEvent {
  sessionId: string;
  kind: 'hello' | 'state' | 'token' | 'denied';
  json: string;
}

export interface RelayWatcherStatsEvent {
  sessionId: string;
  /** Pictures received in the last second. */
  framesPerSec: number;
  kbps: number;
  /** Total pictures received on this join. */
  frames: number;
  /** -1 before the first picture. */
  lastFrameAgeMs: number;
  /** Codec of the last picture. */
  codec: 'hevc' | 'avc' | null;
  /** The host is replaying frames behind live (a fresh join catching up). */
  catchingUp: boolean;
}

export interface PocketRelayNativeModule {
  /** This device's name for Bonjour and the hello. */
  deviceName(): string;
  startBrowse(): void;
  stopBrowse(): void;
  startHost(options: RelayHostStartOptions): Promise<void>;
  /** Closes every watcher with `reason` (a join refusal they can show), or silently when null. */
  stopHost(reason: string | null): void;
  /** Applies to new joins (passcode) and control requests at once. */
  updateHost(options: { passcode: string; allowsControl: boolean; window: number }): void;
  /** State JSON (`encodeState`); sampled by JS at ≤ 5 Hz, at most one send in flight per watcher. */
  publishHostState(json: string): void;
  grantControl(): void;
  denyControl(): void;
  reclaimControl(): void;
  join(options: RelayJoinOptions): Promise<void>;
  leave(sessionId: string): void;
  requestControl(sessionId: string): void;
  releaseControl(sessionId: string): void;
  sendCommand(sessionId: string, json: string): void;
  addListener(event: 'onHosts', cb: (e: RelayHostsEvent) => void): { remove(): void };
  addListener(event: 'onHostStatus', cb: (e: RelayHostStatusEvent) => void): { remove(): void };
  addListener(event: 'onHostCommand', cb: (e: RelayHostCommandEvent) => void): { remove(): void };
  addListener(event: 'onWatcherStatus', cb: (e: RelayWatcherStatusEvent) => void): { remove(): void };
  addListener(event: 'onWatcherMessage', cb: (e: RelayWatcherMessageEvent) => void): { remove(): void };
  addListener(event: 'onWatcherStats', cb: (e: RelayWatcherStatsEvent) => void): { remove(): void };
}

// ───────────────────────────── Background / server mode (Android) ─────────────────────────────
// Server mode: a connectedDevice foreground service keeps the camera link and the relay running
// with the screen off. Android only; iOS / web get `null` (src/camera/server checks the platform).

export interface ServerNotificationStatus {
  /** Camera name. */
  title: string;
  /** One line: link and watchers, e.g. "Live · 2 watchers". */
  text: string;
  /** Camera link live (offers Record / Stop). */
  live: boolean;
  recording: boolean;
  /** Seconds into the take; the notification runs its own chronometer from it. */
  recordingElapsedSec: number | null;
  /** Deep link for Open / a tap on the notification. */
  openUrl: string | null;
}

export interface ServerCapabilities {
  sdk: number;
  /** `WifiManager.isStaConcurrencyForLocalOnlyConnectionsSupported()` (API 31+). */
  staConcurrencyLocalOnly: boolean;
  notificationsAllowed: boolean;
  bluetoothAllowed: boolean;
  ignoringBatteryOptimizations: boolean;
  serving: boolean;
}

export interface ServerPrimaryWifi {
  ssid: string | null;
  address: string | null;
  prefixLength: number | null;
  internet: boolean;
}

export interface ServerDeviceStatus {
  batteryPercent: number | null;
  charging: boolean;
  plugged: boolean;
  /** `PowerManager.getCurrentThermalStatus()`. */
  thermal: 'none' | 'light' | 'moderate' | 'severe' | 'critical' | 'emergency';
}

export type ServerAction = 'record' | 'stop' | 'disconnect';

export interface PocketBackgroundNativeModule {
  capabilities(): ServerCapabilities;
  /** POST_NOTIFICATIONS (13+) and BLUETOOTH_CONNECT (12+). */
  requestPermissions(): Promise<{ notifications: boolean; bluetooth: boolean }>;
  /** Starts the foreground service. Call only while the app is in the foreground. */
  startServer(status: ServerNotificationStatus): Promise<void>;
  updateServer(status: ServerNotificationStatus): void;
  stopServer(): Promise<void>;
  isServing(): boolean;
  /** Camera SoftAP as a local-only second Wi-Fi connection (no process binding). */
  joinLocalOnly(ssid: string, password: string, options: { timeoutMs: number }): Promise<WifiJoinResult>;
  leaveLocalOnly(): Promise<void>;
  localOnlyAddress(): Promise<string | null>;
  primaryWifi(): Promise<ServerPrimaryWifi | null>;
  /** Hosts answering `port` on the phone's Wi-Fi / hotspot subnets. */
  findCameraHosts(options: { port: number; timeoutMs: number; max: number }): Promise<string[]>;
  deviceStatus(): ServerDeviceStatus;
  /** Event names: 'onTick' (~10 Hz while serving), 'onAction', 'onServerState'. */
  addListener(event: 'onTick', cb: (e: { at: number }) => void): { remove(): void };
  addListener(event: 'onAction', cb: (e: { action: ServerAction }) => void): { remove(): void };
  addListener(event: 'onServerState', cb: (e: { running: boolean; reason: string | null }) => void): { remove(): void };
}

// ───────────────────────────── Background (iOS) ─────────────────────────────
// The same JS module `PocketBackground` on iOS (modules/pocket-native/ios/Background): Live Activity
// + Dynamic Island, Picture in Picture monitoring, the iOS 18 record control and the background
// grace task. Shared with Android (`PocketBackgroundNativeModule` above): `isServing()` (iOS: PiP or
// the grace task keeps the process running), `onAction` (Live Activity buttons / record control:
// 'record' | 'stop' | 'disconnect') and `onServerState` (`running` = isServing, iOS `reason`
// 'pip' | 'grace'). Everything else below is iOS-only and named for it; Android members are absent
// on iOS. Use `PocketBackgroundIos` (native.ts), which is null off iOS.

export interface IosBackgroundCapabilities {
  /** ActivityKit allowed for the app (Settings → Pocket Monitor → Live Activities). */
  liveActivities: boolean;
  /** `AVPictureInPictureController.isPictureInPictureSupported()`. */
  pictureInPicture: boolean;
  /** iOS 18+: Control Center / Lock Screen / Action button record control. */
  controls: boolean;
}

/** Static Live Activity data. */
export interface LiveActivityAttributesInput {
  cameraName: string;
  cameraModel: string;
}

/** Live Activity content (ActivityKit `ContentState`). */
export interface LiveActivityState {
  phase: 'live' | 'recovering' | 'ended';
  recording: boolean;
  /** Epoch ms when the take started (drives the system timer); null when not recording. */
  recordingStartedAtMs: number | null;
  /** Card record time left, seconds; -1 unknown. */
  remainingSec: number;
  /** Camera battery percent; -1 unknown. */
  batteryPercent: number;
  charging: boolean;
  linkBand: 'poor' | 'watch' | 'stable';
  /** 0–4. */
  signalBars: number;
}

export interface PictureInPictureState {
  /** A controller exists for the live session. */
  prepared: boolean;
  /** iOS would start PiP now (`isPictureInPicturePossible`). */
  possible: boolean;
  active: boolean;
}

export interface PocketBackgroundIosMembers {
  iosCapabilities(): Promise<IosBackgroundCapabilities>;
  /** Resolves the activity id, or null when Live Activities are off. Re-uses a running one. */
  startLiveActivity(attributes: LiveActivityAttributesInput, state: LiveActivityState): Promise<string | null>;
  /** False when no activity is running (never started, ended, dismissed by the operator). Moves `staleDate` 90 s out. */
  updateLiveActivity(state: LiveActivityState): Promise<boolean>;
  endLiveActivity(state: LiveActivityState | null, immediate: boolean): Promise<void>;
  /** What the record control shows (app group); reloads the control when it changed. */
  setRecordControlState(live: boolean, recording: boolean, cameraName: string | null): void;
  /** Ready PiP for a native video session (`VideoSource.sessionId`); false without PiP support. */
  pipPrepare(sessionId: string): Promise<boolean>;
  pipRelease(): Promise<void>;
  /** False when PiP is not possible right now. */
  pipStart(): Promise<boolean>;
  pipStop(): Promise<void>;
  /** Start PiP automatically when the app leaves the foreground while prepared. */
  setPipAutoStart(enabled: boolean): Promise<void>;
  /** Armed while live: leaving the foreground without PiP starts a background task. */
  setGraceArmed(armed: boolean): Promise<void>;
  addListener(event: 'onPipState', cb: (e: PictureInPictureState) => void): { remove(): void };
}

/** The iOS view of `PocketBackground`: the shared members plus the iOS ones. */
export type PocketBackgroundIosModule = Pick<PocketBackgroundNativeModule, 'isServing' | 'addListener'> & PocketBackgroundIosMembers;

// ───────────────────────────── Hands (gestures) ─────────────────────────────
// docs: modules/pocket-native/README.md "PocketHands". Native runs the models (iOS Apple Vision,
// Android MediaPipe Tasks) on small pictures off the render path; every rule that turns
// landmarks into gestures is TypeScript (`src/core/gestures`, the desktop's `pm_controller`).

/** Where the hands are read from: the camera's live picture, or the phone's own front camera. */
export type HandsSource = 'cameraFeed' | 'frontCamera';

export interface HandsStartOptions {
  source: HandsSource;
  /** `cameraFeed`: the native video session (`VideoSource.sessionId`) whose decoded picture is read. */
  sessionId?: string | null;
  /** Pictures offered to the models per second (default 15, 1…20). One offered while busy is dropped. */
  rate?: number;
  /** Width the picture is scaled to, in proportion, before the models read it (default 480). */
  width?: number;
}

/** One hand. */
export interface HandsLandmarks {
  /**
   * 42 numbers, `x0, y0, x1, y1, …`: MediaPipe's 21 landmarks in order (0 wrist … 20 pinky tip)
   * as fractions of the picture read (origin top-left, never mirrored).
   */
  points: number[];
  /** 0…1. */
  score: number;
  /**
   * MediaPipe's handedness label is `Right` on that picture (the desktop model's own reading).
   * iOS maps Vision's chirality to the same convention.
   */
  right: boolean;
}

/** A face: left, top, width, height as fractions of the picture read. */
export interface HandsFace {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

/** `onHands`: one picture read (≤ 15 a second). */
export interface HandsSeenEvent {
  source: HandsSource;
  hands: HandsLandmarks[];
  /** The faces when this picture was searched for them (`setWantsFaces`, at most every 0.25 s); else null. */
  faces?: HandsFace[] | null;
  /** The picture's width over its height. */
  aspect: number;
  /** How long the models took on this picture, milliseconds. */
  ms: number;
}

/** `onStatus`. */
export interface HandsStatusEvent {
  state: 'starting' | 'ready' | 'stopped' | 'failed';
  /** What the models run on: `GPU` / `CPU` (Android MediaPipe), `Vision` (iOS). */
  provider?: string | null;
  error?: string | null;
}

/** `onAudio`: the microphone as 10 ms blocks (about ten a call), for the double clap. */
export interface HandsAudioEvent {
  sampleRate: number;
  /** Each block's peak, mono, −1…1 scale. */
  peaks: number[];
  /** Each block's RMS level. */
  levels: number[];
}

export interface PocketHandsNativeModule {
  isAvailable(): boolean;
  /** Starts reading hands (or switches source). Rejects when the camera is denied or missing. */
  start(options: HandsStartOptions): Promise<void>;
  /** Stops reading and releases the camera and the models. */
  stop(): void;
  /** Also look for faces, at most every 0.25 s. */
  setWantsFaces(on: boolean): void;
  /** Opens the microphone for `onAudio`. Rejects when it is denied. */
  startMicrophone(): Promise<void>;
  stopMicrophone(): void;
  addListener(event: 'onHands', cb: (e: HandsSeenEvent) => void): { remove(): void };
  addListener(event: 'onStatus', cb: (e: HandsStatusEvent) => void): { remove(): void };
  addListener(event: 'onAudio', cb: (e: HandsAudioEvent) => void): { remove(): void };
}
