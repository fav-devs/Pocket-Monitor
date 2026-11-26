/**
 * The camera session inside the desktop app (Tauri 2, `Apps/Desktop/crates/pm-desktop`).
 *
 * The Rust backend owns the camera: the UDP datalink and its 40 Hz ACK pump, decode, the
 * Vulkan picture (under this transparent web view), the gimbal stream at 100 Hz. This
 * session only speaks IPC:
 *
 * - state: `camera://state` carries the whole mobile `CameraState`, ≤ 5 Hz with REC, phase,
 *   format, colour and zoom immediate. Slices that did not change keep their identity, so
 *   `useCamera(selector)` subscribers do not re-render for nothing.
 * - control / gimbal one-shots: `camera_command` with a `{ type, ...args }` call that Rust
 *   resolves against the body's own lists. A refusal comes back as operator copy and is
 *   shown as a notice.
 * - gimbal stick: `gimbal_drive` coalesced to one per frame plus a 100 ms heartbeat while
 *   held; `gimbal_release` on (0, 0), blur and dispose. Rust rests the stick by itself after
 *   250 ms of silence, on focus loss and on close.
 *
 * A web reload re-attaches to the running link (`camera_state`); it never reconnects.
 */
import { initialCameraState } from '../defaults';
import type {
  CameraController,
  CameraMediaService,
  CameraSession,
  ConnectOptions,
  GimbalController,
  SessionEvent,
  Unsubscribe,
  VideoSource,
} from '../session';
import type { CameraModelId, CameraNotice, CameraState, DiscoveredCamera, MotionWaypoint, SavedCamera } from '../types';
import { DesktopMediaService } from './media';
import { cancelDesktopConnect, desktopConnect, startDesktopScan, type ConnectReport } from './connect';
import { invoke, listen, type Unlisten } from './tauri';
import * as input from './input';

type Listener<T> = (value: T) => void;

/** `CameraModelId` → the body's model id the Rust status decoder wants. */
export const DESKTOP_MODEL_IDS: Partial<Record<CameraModelId, number>> = {
  'osmo-pocket-3': 0x20,
  'osmo-pocket-4': 0x21,
  'osmo-pocket-4-pro': 0x22,
  'osmo-nano': 0x19,
};

/** What `camera_connect` takes. */
export interface DesktopTarget {
  host?: string;
  model?: number;
}

/** A saved station camera connects to its last address; SoftAP to the camera's own. */
export function desktopTarget(target: DiscoveredCamera | SavedCamera): DesktopTarget {
  const model = DESKTOP_MODEL_IDS[target.model];
  const host = 'path' in target && target.path.kind === 'station' ? target.path.host : undefined;
  return { ...(host ? { host } : {}), ...(model != null ? { model } : {}) };
}

/** Keeps every top-level slice of `prev` that is unchanged in `next`. */
export function shareSlices(prev: CameraState, next: CameraState): CameraState {
  const out = { ...next } as Record<string, unknown>;
  const before = prev as unknown as Record<string, unknown>;
  let same = true;
  for (const key of Object.keys(out)) {
    if (JSON.stringify(before[key]) === JSON.stringify(out[key])) out[key] = before[key];
    else same = false;
  }
  return same ? prev : (out as unknown as CameraState);
}

/** The Rust `camera://event` payload. */
type RustEvent =
  | { type: 'notice'; message: string; tone: CameraNotice['tone'] }
  | { type: 'recording-started' }
  | { type: 'recording-stopped' };

/** How often a held stick repeats when the UI stops moving it. Rust rests after 250 ms. */
export const DRIVE_HEARTBEAT_MS = 100;
/** One drive per frame at most; Rust streams at its own cadence. */
const DRIVE_MIN_INTERVAL_MS = 16;
/** The same refusal is not repeated as a notice within this window. */
const REFUSAL_QUIET_MS = 3000;

export class DesktopCameraSession implements CameraSession {
  readonly kind = 'desktop' as const;
  readonly video: VideoSource = { kind: 'desktop' };
  private state: CameraState = initialCameraState();
  private listeners = new Set<Listener<CameraState>>();
  private eventListeners = new Set<Listener<SessionEvent>>();
  private unlisten: Unlisten[] = [];
  private drive = { x: 0, y: 0, sentAt: 0, pending: false };
  private driveTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private refusals = new Map<string, number>();
  private noticeSeq = 0;
  private zoomRate = 0;
  private onBlur = () => this.releaseStick();

  constructor() {
    this.unlisten.push(listen<CameraState>('camera://state', (next) => this.apply(next)));
    this.unlisten.push(listen<RustEvent>('camera://event', (event) => this.relay(event)));
    // Live controls (countdown, tracking, Motion Control, lock) live in Rust: ./input.ts.
    this.unlisten.push(...input.watchInput(() => this.apply(this.backend ?? this.state)));
    // Re-attach to whatever the backend is already doing (a reload never reconnects).
    invoke<CameraState>('camera_state')
      .then((next) => this.apply(next))
      .catch(() => {});
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('blur', this.onBlur);
  }

  /** Stops listening and rests the stick. The provider drops a replaced session. */
  dispose() {
    this.releaseStick();
    this.unlisten.forEach((stop) => stop());
    this.unlisten = [];
    if (this.media instanceof DesktopMediaService) this.media.dispose();
    if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('blur', this.onBlur);
  }

  getState() {
    return this.state;
  }

  subscribe(listener: Listener<CameraState>): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(listener: Listener<SessionEvent>): Unsubscribe {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Pairing and Wi-Fi phases laid over the backend's connection until its link takes over. */
  private overlay: Partial<CameraState['connection']> | null = null;
  private backend: CameraState | null = null;
  private lastConnect: { target: DiscoveredCamera | SavedCamera; options?: ConnectOptions } | null = null;
  private report: ConnectReport = (patch) => {
    this.overlay = patch ? { ...(this.overlay ?? {}), ...patch } : null;
    this.apply(this.backend ?? this.state);
  };

  private apply(incoming: CameraState) {
    if (!incoming || typeof incoming !== 'object' || !incoming.connection) return;
    if (incoming !== this.state) this.backend = incoming;
    const next = input.withInput(this.overlay ? { ...incoming, connection: { ...incoming.connection, ...this.overlay } } : incoming);
    const shared = shareSlices(this.state, next);
    if (shared === this.state) return;
    this.state = shared;
    this.listeners.forEach((l) => l(shared));
  }

  private emit(event: SessionEvent) {
    this.eventListeners.forEach((l) => l(event));
  }

  private notice(message: string, tone: CameraNotice['tone']) {
    this.noticeSeq += 1;
    this.emit({ type: 'notice', notice: { id: `desktop-${Date.now()}-${this.noticeSeq}`, message, tone } });
  }

  private relay(event: RustEvent) {
    if (event.type === 'notice') this.notice(event.message, event.tone);
    else this.emit({ type: event.type });
  }

  /** Sends one controller call; a refusal becomes a notice (once per few seconds). */
  private async call(type: string, args: Record<string, unknown> = {}): Promise<void> {
    try {
      // On a phone's shared feed the relay proxies what its wire carries (§1.E E3).
      const target = this.state.connection.transport === 'watcher' ? 'relay_command' : 'camera_command';
      await invoke(target, { command: { type, ...args } });
    } catch (error) {
      const message = typeof error === 'string' ? error : error instanceof Error ? error.message : 'The camera did not take that.';
      const now = Date.now();
      if (now - (this.refusals.get(message) ?? 0) > REFUSAL_QUIET_MS) {
        this.refusals.set(message, now);
        this.notice(message, 'warning');
      }
    }
  }

  // ───────────── Discovery and connection ─────────────

  startScan(onFound: (cameras: DiscoveredCamera[]) => void): Unsubscribe {
    // Bluetooth in the backend (`ble_scan_start`, `ble://adverts`); see ./connect.ts.
    return startDesktopScan(onFound);
  }

  async connect(target: DiscoveredCamera | SavedCamera, options?: ConnectOptions): Promise<void> {
    // Pairing, the Wi-Fi join or the LAN search first, then the link (./connect.ts).
    this.lastConnect = { target, options };
    await desktopConnect(target, options, this.report);
  }

  async disconnect(): Promise<void> {
    this.releaseStick();
    if (this.overlay) {
      void cancelDesktopConnect();
      this.report(null);
    }
    // Watching a phone's feed: leaving it is the disconnect (§1.E).
    if (this.state.connection.transport === 'watcher') await invoke('relay_leave').catch(() => {});
    await invoke('camera_disconnect');
  }

  async retry(): Promise<void> {
    // A failure before the link (pairing, Wi-Fi) is retried from the start.
    if (this.overlay?.phase === 'failed' && this.lastConnect) {
      await this.connect(this.lastConnect.target, this.lastConnect.options);
      return;
    }
    await invoke('camera_reconnect');
  }

  // ───────────── Gimbal stick ─────────────

  private sendDrive() {
    this.driveTimer = null;
    this.drive.pending = false;
    this.drive.sentAt = Date.now();
    invoke('gimbal_drive', { x: this.drive.x, y: this.drive.y, source: 'touch' }).catch(() => {});
  }

  private driveStick(x: number, y: number) {
    const rest = Math.abs(x) < 0.02 && Math.abs(y) < 0.02;
    if (rest) {
      this.releaseStick();
      return;
    }
    this.drive.x = x;
    this.drive.y = y;
    const since = Date.now() - this.drive.sentAt;
    if (since >= DRIVE_MIN_INTERVAL_MS) this.sendDrive();
    else if (!this.driveTimer) this.driveTimer = setTimeout(() => this.sendDrive(), DRIVE_MIN_INTERVAL_MS - since);
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.drive.sentAt >= DRIVE_HEARTBEAT_MS - 5) this.sendDrive();
      }, DRIVE_HEARTBEAT_MS);
    }
  }

  private releaseStick() {
    const wasDriving = !!this.heartbeat || this.drive.x !== 0 || this.drive.y !== 0;
    if (this.driveTimer) clearTimeout(this.driveTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.driveTimer = null;
    this.heartbeat = null;
    this.drive.x = 0;
    this.drive.y = 0;
    if (wasDriving) invoke('gimbal_release', { source: 'touch' }).catch(() => {});
  }

  readonly gimbal: GimbalController = {
    drive: (x, y) => this.driveStick(x, y),
    recenter: () => this.call('gimbalRecenter'),
    flip: () => this.call('gimbalFlip'),
    setMode: (mode) => this.call('gimbalSetMode', { mode }),
    setSpeed: (speed) => this.call('gimbalSetSpeed', { speed }),
    setLockedAllAxes: (locked) => input.lockAllAxes(locked),
    captureWaypoint: (slot): Promise<MotionWaypoint> =>
      input.movesSetPoint(slot).catch((error) => {
        this.notice(typeof error === 'string' ? error : 'NO GIMBAL ATTITUDE YET', 'warning');
        throw error;
      }),
    clearWaypoint: (slot) => input.movesClearPoint(slot),
    configureProgram: (options) => input.movesConfigure(options),
    runProgram: async () => input.movesStart(),
    stopProgram: () => input.movesStop(),
    level: () => this.call('gimbalLevel'),
  };

  // ───────────── Camera controls ─────────────

  readonly control: CameraController = {
    startRecording: async (options) => (options?.countdown ? input.recordCountdown() : this.call('startRecording', { countdown: false })),
    stopRecording: () => this.call('stopRecording'),
    capturePhoto: () => this.call('capturePhoto'),
    setShootingMode: (mode) => this.call('setShootingMode', { mode }),
    setExposureMode: (mode) => this.call('setExposureMode', { mode }),
    setIso: (iso) => this.call('setIso', { iso }),
    setIsoLimit: (iso) => this.call('setIsoLimit', { iso }),
    setShutter: (denom) => this.call('setShutter', { denom }),
    setEv: (ev) => this.call('setEv', { ev }),
    setAperture: (fNumber) => this.call('setAperture', { fNumber }),
    setWhiteBalance: (change) => this.call('setWhiteBalance', { ...change }),
    setFormat: (change) => this.call('setFormat', { ...change }),
    setFocusMode: (mode) => this.call('setFocusMode', { mode }),
    focusAt: async (point) => input.focusAt(point),
    setManualFocus: (position) => this.call('setManualFocus', { position }),
    setZoom: async (factor) => input.zoomWrite(factor),
    zoomBy: (rate) => {
      // Called repeatedly while a control is held: only a change goes over IPC.
      if (rate === this.zoomRate) return;
      this.zoomRate = rate;
      input.zoomRate(rate);
    },
    startTracking: (target) => ('width' in target ? input.trackBox(target) : this.call('startTracking', { ...target })),
    stopTracking: async () => input.trackClear(),
    setAudio: (change) => this.call('setAudio', { ...change }),
  };

  // ───────────── Media ─────────────

  /** The camera library and the native player's fetches (`media.ts`, §1.U). */
  readonly media: CameraMediaService = new DesktopMediaService();
}
