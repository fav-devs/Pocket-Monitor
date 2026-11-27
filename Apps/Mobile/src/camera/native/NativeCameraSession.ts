/**
 * The real-camera `CameraSession`: src/core decides, modules/pocket-native moves bytes.
 *
 * Spine (CONTEXT.md, docs/live-session.md), in the order of OpenCine `DjiAppleConnectionRun.run`
 * and the desktop shell (`Apps/Desktop/crates/opc-camera`):
 *   BLE scan/connect (+ arm) → `0x00/0x2B` wake + `0x07/0x45` SetPairingPIN → approval `0x07/0x46`
 *   → `0x53/0x10` AP wake → GetSSID/GetPassword → PocketWifi.join → PocketDatalink.open (TCP 7001
 *   poke) → handshake (sendRaw) until state `open` → registration + subscriptions → attachVideo →
 *   `0x02/0x68` prepare (Pocket) → `0x09/0xa8` ONCE → live.
 *
 * Ownership rules this file keeps:
 * - Enable-once: the connect path sends exactly one `0x09/0xa8` per datalink session
 *   (`enableLiveView('connect')`). Every later enable comes from the core `FeedWatchdog`
 *   (`runRepair`) or the documented return-from-gallery live start (`media.resumeLive`).
 * - The 40 Hz ACK pump is native; JS never acks. Frames sent before admission are dropped by
 *   native, so nothing is written on the datalink until it reports `open`.
 * - The gimbal stick stream is a JS interval at 25 Hz (see `startStickPump`).
 */
import type { BluetoothPowerState, DatalinkFrame, DatalinkStateEvent, DatalinkStats } from '@modules/pocket-native/src/types';
import { apWakeFrame, isPairApprovalRequest, PAIRING_DEFERRED_RETRIES, PAIRING_REPLY_OPCODES, PAIRING_REPLY_TIMEOUT_S, PAIRING_RETRY_PAUSE_S, pairApprovalResponse, pairingFrames, pairingOutcome, WIFI_STRING_ATTEMPT_TIMEOUT_S, WIFI_STRING_BUDGET_S, WIFI_STRING_RETRY_PAUSE_S, wifiCredentialFrames, wifiStringReply, AP_WAKE_TIMEOUT_S } from '@/core/ble/pairing';
import { CameraWifiResolution } from '@/core/ble/savedCamera';
import { runStationJoin, StationJoinError } from '@/core/ble/stationJoin';
import { captureCommand, Commands, FIRST_SUB_ID, gimbalModeFrames, subscriptionKeysFor } from '@/core/commands/commands';
import { AudioDspBlob, CameraReplies, GimbalPrepRestore } from '@/core/commands/control';
import { MulticamCommands, MulticamSupport } from '@/core/commands/livestream';
import {
  ApertureStrategy,
  apertureFNumber,
  ExpoMode,
  GimbalSpeed,
  IsoLimit,
  isoLimitCeiling,
  type IsoLimit as IsoLimitValue,
  type VideoFormat,
  VideoFormats,
  VideoFrameRates,
  wbAuto,
  wbCustom,
} from '@/core/commands/vocabulary';
import { CameraSoftAP, CameraSoftAPSwitch } from '@/core/connection/cameraSoftAP';
import { FeedWatchdog, type WatchdogAction } from '@/core/connection/feedWatchdog';
import { CameraPathRecovery } from '@/core/connection/pathRecovery';
import { type CameraConnectionPhase, ConnectTimeline, toUIConnectionPhase } from '@/core/connection/phase';
import { DumlNotificationAssembler } from '@/core/duml/assembler';
import { decodeFrame, type DumlFrame, encodeFrame, isLiveCameraControl, isLiveCameraRead } from '@/core/duml/frame';
import { gimbalProgram, type GimbalProgram, type GimbalWaypoint, Programs, Waypoints } from '@/core/gimbal/program';
import { GimbalStick } from '@/core/gimbal/stick';
import {
  evToThirds,
  resolutionLabel,
  wireColorMode,
  wireDirectional,
  wireFocusMode,
  wireGimbalMode,
  wireGimbalSpeed,
  wireIsoIndex,
  wireShootingMode,
} from '@/core/mapping';
import { type CameraModel, hasGimbal, liveViewEnableReceiver, pairingToken, sendsLiveViewPrepare, ssidConflictsWithBody, usesNanoLiveViewGate, BleConstants } from '@/core/status/cameraModel';
import { CamCapVideoFormat } from '@/core/status/camCap';
import { StatusQueries } from '@/core/status/cameraStatus';
import { MEDIA_INTERNAL_COUNTER, MEDIA_NEWEST_INTERNAL, MEDIA_NEWEST_SD, MEDIA_SD_COUNTER, MediaChunkAssembler, MediaManifest, type MediaFile } from '@/core/status/mediaManifest';
import { TrackingBoxes } from '@/core/status/trackingBox';
import { handshakeDatagram, DatalinkSequencer } from '@/core/transport/datalink';
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
import type { CameraNotice, CameraState, ConnectionState, DiscoveredCamera, MotionWaypoint, SavedCamera } from '../types';
import {
  type ConnectFailure,
  ConnectCancelled,
  ConnectError,
  type ConnectStage,
  connectFailureCopy,
  datalinkFailure,
  failureOf,
  joinRejectsCredentials,
  stageDetail,
  stagePhase,
  wifiJoinFailure,
} from './connectCopy';
import { type ClockTimer, type SessionClock, systemClock } from './clock';
import type { NativeSessionDeps } from './deps';
import { ExchangeClosed, ExchangeTimeout, FrameExchange, opcodeMatcher } from './exchange';
import { FeedTracker, type PictureStats } from './feedTracker';
import { mediaHandle, mediaItemId, mediaItemsOf } from './mediaMap';
import { codecHint, coreModelFor } from './models';
import { arrived, moveFrame, planProgram, SMOOTH_INTERVAL_S, smoothMoveAt, type TimedMove } from './motionPlan';
import { mergeSighting, type Sighting, sightingOf, sortedCameras } from './scanList';
import { LiveSetDriver, type SetResult } from './setDriver';
import { CameraStatusReducer } from './statusReducer';

type Listener<T> = (value: T) => void;
type Sub = { remove(): void };
type Timer = ClockTimer;

/** Gimbal stick stream cadence (`GimbalStick.streamInterval`, 25 Hz). */
const STICK_INTERVAL_MS = GimbalStick.streamInterval * 1000;
const HEARTBEAT_MS = 1000;
const WATCHDOG_MS = 1000;
const PATH_POLL_MS = 2000;
const PUBLISH_MS = 66;
const TRACK_POLL_MS = 500;
/** The camera ignores `0x09/0xa8` when it follows subscriptions in the same burst (desktop). */
const SUBSCRIBE_SETTLE_MS = 150;
const SLOW_PICTURE_MS = 8000;
const BLE_CONNECT_TIMEOUT_MS = 15000;
const SCAN_FOR_TARGET_MS = 8000;
const SIGHTING_FRESH_MS = 60000;
const WIFI_JOIN_ATTEMPT_MS = 45000;
const DATALINK_OPEN_TIMEOUT_MS = 20000;
const MEDIA_QUERY_BUDGET_MS = 12000;
const CAMERA_HOST = CameraSoftAP.host;
const TCP_POKE_PORT = 7001;
const ACK_HZ = 40;
const MOTION_LATE_MS = 60;
const MOTION_FEEDBACK_STALE_MS = 1000;
const PRESET_KELVIN: Record<string, number> = { daylight: 5600, cloudy: 6500, incandescent: 3200, fluorescent: 4000 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(clock: SessionClock, p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = clock.setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clock.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clock.clearTimeout(t);
        reject(e);
      },
    );
  });
}

let datalinkCounter = 0;

export class NativeCameraSession implements CameraSession {
  readonly kind = 'native' as const;
  video: VideoSource = { kind: 'none' };

  private readonly io: NativeSessionDeps['io'];
  private readonly now: () => number;
  /** Every session timer runs on this (`deps.clock`; global timers when absent). */
  private readonly clock: SessionClock;
  private readonly log: (line: string) => void;
  private readonly random: () => number;

  private state: CameraState = initialCameraState();
  private listeners = new Set<Listener<CameraState>>();
  private eventListeners = new Set<Listener<SessionEvent>>();
  private publishTimer: Timer | null = null;

  // ── attempt / lifecycle ──
  private attempt = 0;
  private lastTarget: DiscoveredCamera | SavedCamera | null = null;
  private lastOptions: ConnectOptions | undefined;
  private model: CameraModel = coreModelFor('unknown', '');
  private corePhase: CameraConnectionPhase = { kind: 'idle' };
  private stage: ConnectStage | null = null;
  private liveStartedAt: number | null = null;
  private timers = new Set<Timer>();
  private intervals = new Set<ClockTimer>();

  // ── BLE ──
  private sightings = new Map<string, Sighting>();
  private scanUsers = 0;
  private bleId: string | null = null;
  private bleConnected = false;
  private bleSubs: Sub[] = [];
  private bleAssembler = new DumlNotificationAssembler();
  private bleExchange: FrameExchange;
  private bleSeq = 0x9100;

  // ── Wi-Fi / datalink ──
  private ssid: string | null = null;
  private host = CAMERA_HOST;
  private softAP = true;
  private dlId: string | null = null;
  private dlState: DatalinkStateEvent['state'] | 'none' = 'none';
  private dlError: string | undefined;
  private dlSubs: Sub[] = [];
  private dlExchange: FrameExchange;
  private dlInbound = 0;
  private sequencer: DatalinkSequencer;
  private dumlSeq = 0xa000;
  private connectEnableSent = false;
  private stateWaiters = new Set<() => void>();
  private readonly sets: LiveSetDriver;
  private readonly reducer = new CameraStatusReducer(null);
  private readonly feed = new FeedTracker();
  private readonly watchdog = new FeedWatchdog();
  private readonly pathRecovery = new CameraPathRecovery();
  private repairing = false;
  private sessionRecoveries = 0;
  private lastLocalAddress: string | null = null;

  // ── controls ──
  private stickVector = { x: 0, y: 0 };
  private stickTimer: ClockTimer | null = null;
  private zoomRateSent = 0;
  private trackTimer: ClockTimer | null = null;
  private trackId = 1;
  private readonly prepRestore = new GimbalPrepRestore();
  private program: GimbalProgram = gimbalProgram({ durationAB: 4, durationBC: 4 });
  private motion: { token: number; timers: Timer[]; interval: ClockTimer | null; resolve: () => void } | null = null;
  private motionToken = 0;
  private wasRecording = false;
  /** First reported record state seeds `wasRecording` without an event (camera may already be rolling). */
  private recordingSeen = false;

  // ── media ──
  private browsing = false;
  private browseEnteredPlayback = false;
  private mediaChunks: MediaChunkAssembler | null = null;
  private mediaFiles = new Map<string, MediaFile>();
  private mediaActionCounter = 1;

  constructor(private readonly deps: NativeSessionDeps) {
    this.io = deps.io;
    this.clock = deps.clock ?? systemClock;
    this.now = deps.now ?? (deps.clock ? () => deps.clock!.now() : () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()));
    this.bleExchange = new FrameExchange(this.clock);
    this.dlExchange = new FrameExchange(this.clock);
    this.log = deps.log ?? (() => {});
    this.random = deps.random ?? Math.random;
    this.sequencer = new DatalinkSequencer(this.random);
    this.sets = new LiveSetDriver((f) => this.sendDatalink(f), this.now, this.clock);
  }

  // ───────────────────────────── state plumbing ─────────────────────────────

  getState(): CameraState {
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

  private set(mutator: (s: CameraState) => CameraState): void {
    this.state = mutator(this.state);
    this.listeners.forEach((l) => l(this.state));
  }

  private setConnection(patch: Partial<ConnectionState>): void {
    this.set((s) => ({ ...s, connection: { ...s.connection, ...patch } }));
  }

  private emit(event: SessionEvent): void {
    this.eventListeners.forEach((l) => l(event));
  }

  private notice(message: string, tone: CameraNotice['tone'] = 'info'): void {
    this.emit({ type: 'notice', notice: { id: `${Date.now()}-${Math.random()}`, message, tone } });
  }

  /** Status frames arrive at tens of Hz; fold them into one UI update per ~66 ms. */
  private schedulePublish(): void {
    if (this.publishTimer) return;
    this.publishTimer = this.clock.setTimeout(() => {
      this.publishTimer = null;
      this.publishStatus();
    }, PUBLISH_MS);
  }

  private publishStatus(): void {
    const now = this.now();
    this.set((s) => {
      const next = this.reducer.reduce(s);
      const chip = this.feed.linkChip(now, this.corePhase, this.isRecovering);
      return { ...next, connection: { ...next.connection, ...chip } };
    });
    const recording = this.state.recording.recording;
    if (!this.reducer.status.recordingReported) return;
    if (!this.recordingSeen) {
      this.recordingSeen = true;
      this.wasRecording = recording;
      return;
    }
    if (recording !== this.wasRecording) {
      this.wasRecording = recording;
      this.emit({ type: recording ? 'recording-started' : 'recording-stopped' });
    }
  }

  private get isRecovering(): boolean {
    return this.repairing || this.watchdog.isRecovering;
  }

  /** Live-path UI phase from the core phase, first video and the watchdog. */
  private refreshLivePhase(): void {
    if (this.corePhase.kind !== 'live') return;
    const now = this.now();
    // `live` once video has reached this session; a later stall shows as `recovering`.
    const phase = toUIConnectionPhase(this.corePhase, { pictureLive: this.feed.hadVideo, recovering: this.isRecovering });
    let detail: string | undefined;
    if (phase === 'recovering') detail = 'Reconnecting the picture';
    else if (phase === 'live-start') {
      const slow = this.liveStartedAt != null && now - this.liveStartedAt > SLOW_PICTURE_MS;
      detail = stageDetail(slow ? 'waiting-picture-slow' : 'waiting-picture');
    }
    const chip = this.feed.linkChip(now, this.corePhase, this.isRecovering);
    const c = this.state.connection;
    if (c.phase !== phase || c.detail !== detail || c.videoFps !== chip.videoFps || c.signalBars !== chip.signalBars || c.linkBand !== chip.linkBand || c.videoKbps !== chip.videoKbps || Math.abs(c.lastFrameAgeMs - chip.lastFrameAgeMs) > 50) {
      this.setConnection({ phase, detail, error: undefined, ...chip });
    }
  }

  // ───────────────────────────── timers ─────────────────────────────

  private after(ms: number, fn: () => void): Timer {
    const t = this.clock.setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private every(ms: number, fn: () => void): ClockTimer {
    const t = this.clock.setInterval(fn, ms);
    this.intervals.add(t);
    return t;
  }

  private clearTimers(): void {
    this.timers.forEach((t) => this.clock.clearTimeout(t));
    this.timers.clear();
    this.intervals.forEach((t) => this.clock.clearInterval(t));
    this.intervals.clear();
    if (this.publishTimer) this.clock.clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.stickTimer = null;
    this.trackTimer = null;
  }

  private check(token: number): void {
    if (token !== this.attempt) throw new ConnectCancelled();
  }

  private pause(ms: number, token: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.after(ms, () => (token === this.attempt ? resolve() : reject(new ConnectCancelled())));
    });
  }

  private enterStage(stage: ConnectStage, token: number, ctx: { ssid?: string | null } = {}): void {
    this.check(token);
    this.stage = stage;
    this.log(`connect: stage ${stage}`);
    this.setConnection({ phase: stagePhase(stage), detail: stageDetail(stage, ctx), error: undefined });
  }

  // ───────────────────────────── scan ─────────────────────────────

  startScan(onFound: (cameras: DiscoveredCamera[]) => void): Unsubscribe {
    const ble = this.io.bluetooth;
    let stopped = false;
    let emitTimer: Timer | null = null;
    const found = new Map<string, Sighting>();
    const emit = () => {
      emitTimer = null;
      if (!stopped) onFound(sortedCameras(found.values(), this.savedIds()));
    };
    const sub = ble.addListener('onAdvert', (advert) => {
      const s = sightingOf(advert, this.now());
      if (!s) return;
      mergeSighting(this.sightings, s);
      if (mergeSighting(found, s) && !emitTimer) emitTimer = this.clock.setTimeout(emit, 300);
    });
    this.scanUsers += 1;
    void (async () => {
      const allowed = await ble.requestPermissions().catch(() => false);
      if (stopped) return;
      if (!allowed) {
        this.notice('Allow Bluetooth for Pocket Monitor to find cameras.', 'warning');
        return;
      }
      ble.startScan(null);
    })();
    return () => {
      if (stopped) return;
      stopped = true;
      sub.remove();
      if (emitTimer) this.clock.clearTimeout(emitTimer);
      this.scanUsers -= 1;
      if (this.scanUsers <= 0) {
        this.scanUsers = 0;
        ble.stopScan();
      }
    };
  }

  private savedIds(): Set<string> {
    try {
      return new Set(this.deps.savedCameras().map((c) => c.id));
    } catch {
      return new Set();
    }
  }

  /** Scan until the target advertises (for its model id), up to `ms`. */
  private async scanForTarget(id: string, ms: number, token: number): Promise<Sighting | null> {
    const cached = this.sightings.get(id);
    if (cached && this.now() - cached.lastSeen < SIGHTING_FRESH_MS) return cached;
    const ble = this.io.bluetooth;
    return new Promise<Sighting | null>((resolve) => {
      let done = false;
      const finish = (s: Sighting | null) => {
        if (done) return;
        done = true;
        sub.remove();
        this.clock.clearTimeout(timer);
        this.scanUsers -= 1;
        if (this.scanUsers <= 0) {
          this.scanUsers = 0;
          ble.stopScan();
        }
        resolve(s);
      };
      const sub = ble.addListener('onAdvert', (advert) => {
        if (token !== this.attempt) return finish(null);
        if (advert.id !== id) return;
        const s = sightingOf(advert, this.now());
        if (!s) return;
        mergeSighting(this.sightings, s);
        finish(this.sightings.get(id) ?? s);
      });
      const timer = this.clock.setTimeout(() => finish(this.sightings.get(id) ?? null), ms);
      this.scanUsers += 1;
      ble.startScan(null);
    });
  }

  // ───────────────────────────── connect ─────────────────────────────

  async connect(target: DiscoveredCamera | SavedCamera, options?: ConnectOptions): Promise<void> {
    this.attempt += 1;
    const token = this.attempt;
    await this.teardown({ leaveWifi: false });
    this.check(token);
    this.lastTarget = target;
    this.lastOptions = options;
    const saved = 'path' in target ? target : (this.deps.savedCameras().find((c) => c.id === target.id) ?? null);
    const fresh = initialCameraState(target.model);
    const transport = saved?.path.kind ?? 'softap';
    this.set(() => ({
      ...fresh,
      identity: { id: target.id, name: target.name, model: target.model, ssid: saved?.path.ssid || undefined },
      connection: { ...fresh.connection, phase: 'scanning', detail: stageDetail('scanning'), transport },
    }));
    const timeline = new ConnectTimeline(this.now() / 1000);
    try {
      await this.runConnect(target, saved, options, token, timeline);
      this.log(timeline.line());
    } catch (e) {
      if (e instanceof ConnectCancelled || token !== this.attempt) return;
      const failure = failureOf(e);
      this.log(`connect: failed ${failure.kind} at ${this.stage ?? 'start'} (${errorText(e)})`);
      await this.teardown({ leaveWifi: false });
      if (token !== this.attempt) return;
      this.corePhase = { kind: 'failed', reason: failure.kind };
      this.setConnection({ phase: 'failed', detail: undefined, error: connectFailureCopy(failure), signalBars: 0, videoFps: 0, videoKbps: 0 });
    }
  }

  async retry(): Promise<void> {
    if (this.lastTarget) await this.connect(this.lastTarget, this.lastOptions);
  }

  async disconnect(): Promise<void> {
    this.attempt += 1;
    await this.teardown({ leaveWifi: true });
    this.corePhase = { kind: 'idle' };
    this.set((s) => ({
      ...s,
      connection: { ...s.connection, phase: 'disconnected', detail: undefined, error: undefined, signalBars: 0, videoFps: 0, videoKbps: 0, lastFrameAgeMs: 0 },
    }));
  }

  private async runConnect(target: DiscoveredCamera | SavedCamera, saved: SavedCamera | null, options: ConnectOptions | undefined, token: number, timeline: ConnectTimeline): Promise<void> {
    await this.ensureBluetooth(token);

    this.enterStage('scanning', token);
    const sighting = await this.scanForTarget(target.id, SCAN_FOR_TARGET_MS, token);
    this.check(token);
    if (!sighting) this.log('connect: target not advertising; trying a direct connect');
    this.model = coreModelFor(target.model, sighting?.name ?? target.name, sighting?.modelId ?? null);
    this.reducer.reset(this.model);
    this.log(`connect: body ${this.model.name}`);

    this.enterStage('bluetooth', token);
    await this.connectBle(target.id, token);
    timeline.mark('gatt', this.now() / 1000);

    await this.pair(target.id, token);
    timeline.mark('pair', this.now() / 1000);
    this.startHeartbeat();

    const path = saved?.path;
    if (path && (path.kind === 'station' || path.kind === 'hotspot')) {
      await this.runStation(target, path, options, token);
    } else {
      const creds = await this.softApCredentials(target, saved, options, sighting?.name ?? target.name, token);
      await this.joinCameraWifi(target.id, creds, token);
      timeline.mark('path', this.now() / 1000);
      this.softAP = true;
      this.host = CAMERA_HOST;
      await this.openDatalink(token, 'fresh');
    }
    timeline.mark('hs', this.now() / 1000);
    await this.startLive(token);
    timeline.mark('enable', this.now() / 1000);
  }

  private async ensureBluetooth(token: number): Promise<void> {
    const ble = this.io.bluetooth;
    let power = ble.getPowerState();
    if (power === 'unknown' || power === 'resetting') {
      power = await new Promise<BluetoothPowerState>((resolve) => {
        const sub = ble.addListener('onPowerState', (e) => {
          if (e.state !== 'unknown' && e.state !== 'resetting') {
            sub.remove();
            this.clock.clearTimeout(t);
            resolve(e.state);
          }
        });
        const t = this.clock.setTimeout(() => {
          sub.remove();
          resolve(ble.getPowerState());
        }, 2500);
      });
    }
    this.check(token);
    const allowed = await ble.requestPermissions().catch(() => false);
    this.check(token);
    if (!allowed) throw new ConnectError({ kind: 'bluetooth-permission' });
    power = ble.getPowerState();
    if (power === 'off' || power === 'unauthorized' || power === 'unsupported') throw new ConnectError({ kind: 'bluetooth-power', state: power });
  }

  // ───────────────────────────── BLE leg ─────────────────────────────

  private subscribeBle(id: string): void {
    this.unsubscribeBle();
    const ble = this.io.bluetooth;
    this.bleId = id;
    this.bleAssembler.reset();
    this.bleExchange.reopen();
    this.bleSubs.push(
      ble.addListener('onNotify', (e) => {
        if (e.id !== this.bleId) return;
        this.feed.lastBleNotifyAt = this.now();
        for (const frame of this.bleAssembler.append(e.bytes)) this.onBleFrame(frame);
      }),
      ble.addListener('onConnection', (e) => {
        if (e.id !== this.bleId) return;
        if (e.state === 'disconnected' || e.state === 'failed') {
          const was = this.bleConnected;
          this.bleConnected = false;
          this.bleExchange.close(`ble ${e.state}${e.error ? `: ${e.error}` : ''}`);
          this.bleExchange.reopen();
          if (was) this.log(`ble: link ${e.state}`);
          if (was && this.corePhase.kind === 'live') this.scheduleBleReconnect(this.attempt);
        } else if (e.state === 'connected') {
          this.bleConnected = true;
        }
      }),
    );
  }

  private unsubscribeBle(): void {
    this.bleSubs.forEach((s) => s.remove());
    this.bleSubs = [];
  }

  private onBleFrame(frame: DumlFrame): void {
    // The camera's first-time approval is a `0x07/0x46` request; it must be answered.
    const ack = isPairApprovalRequest(frame) ? pairApprovalResponse(frame) : null;
    if (ack) this.bleWrite(ack);
    this.bleExchange.deliver(frame);
    if (this.reducer.apply(frame, this.now())) this.schedulePublish();
  }

  private bleWrite(frame: DumlFrame): void {
    const id = this.bleId;
    if (!id) return;
    this.io.bluetooth.write(id, encodeFrame(frame), false).catch((e) => this.log(`ble: write failed (${errorText(e)})`));
  }

  private bleRequest(pairs: Array<[number, number]>, timeoutMs: number, label: string, frames: DumlFrame[]): Promise<DumlFrame> {
    return this.bleExchange.request(opcodeMatcher(pairs), timeoutMs, label, () => frames.forEach((f) => this.bleWrite(f)));
  }

  private async connectBle(id: string, token: number): Promise<void> {
    const ble = this.io.bluetooth;
    this.subscribeBle(id);
    for (let retry = 1; retry <= 3; retry++) {
      this.check(token);
      try {
        await withTimeout(this.clock, 
          ble.connect(id, {
            service: BleConstants.serviceFFF0,
            writeCharacteristic: BleConstants.charFFF5,
            notifyCharacteristics: [BleConstants.charFFF4],
            armPairing: true,
          }),
          BLE_CONNECT_TIMEOUT_MS,
          () => new Error('Bluetooth connect timed out'),
        );
        this.check(token);
        this.bleConnected = true;
        return;
      } catch (e) {
        this.check(token);
        this.log(`ble: connect attempt ${retry} failed (${errorText(e)})`);
        await ble.disconnect(id).catch(() => {});
        if (retry === 3) throw new ConnectError({ kind: 'ble-connect', message: errorText(e) });
        await this.pause(PAIRING_RETRY_PAUSE_S * 1000, token);
      }
    }
  }

  private async pair(id: string, token: number): Promise<void> {
    for (let attempt = 0; attempt <= PAIRING_DEFERRED_RETRIES; attempt++) {
      this.enterStage('pairing', token);
      let frame: DumlFrame;
      try {
        frame = await this.bleRequest(PAIRING_REPLY_OPCODES, PAIRING_REPLY_TIMEOUT_S * 1000, 'pairing', pairingFrames(this.model));
      } catch (e) {
        throw this.bleFailure(e, 'pairing', token);
      }
      this.check(token);
      const outcome = pairingOutcome(frame);
      if (outcome === 'awaitApproval') {
        this.enterStage('awaiting-approval', token);
        try {
          await this.bleRequest([[0x07, 0x46]], PAIRING_REPLY_TIMEOUT_S * 1000, 'approval', []);
        } catch (e) {
          throw this.bleFailure(e, 'approval', token);
        }
        this.check(token);
        return;
      }
      if (outcome !== 'deferred') return;
      this.log(`pair: camera deferred pairing (00 06), retry ${attempt + 1} of ${PAIRING_DEFERRED_RETRIES}`);
      if (attempt === PAIRING_DEFERRED_RETRIES) throw new ConnectError({ kind: 'pairing-deferred' });
      await this.io.bluetooth.disconnect(id).catch(() => {});
      this.bleConnected = false;
      await this.pause(PAIRING_RETRY_PAUSE_S * 1000, token);
      this.enterStage('bluetooth', token);
      await this.connectBle(id, token);
    }
  }

  private bleFailure(e: unknown, during: string, token: number): Error {
    this.check(token);
    if (e instanceof ExchangeTimeout) return new ConnectError(during === 'pairing' || during === 'approval' ? { kind: 'pairing-timeout' } : { kind: 'credentials-timeout', which: during === 'GetSSID' ? 'ssid' : 'password' });
    if (e instanceof ExchangeClosed) return new ConnectError({ kind: 'ble-dropped', during });
    return e instanceof Error ? e : new Error(String(e));
  }

  private scheduleBleReconnect(token: number, attempt = 1): void {
    if (attempt > 3) return;
    this.after(3000 * attempt, () => {
      if (token !== this.attempt || this.bleConnected || !this.bleId) return;
      const id = this.bleId;
      this.io.bluetooth
        .connect(id, { service: BleConstants.serviceFFF0, writeCharacteristic: BleConstants.charFFF5, notifyCharacteristics: [BleConstants.charFFF4], armPairing: false })
        .then(() => {
          if (token !== this.attempt) return;
          this.bleConnected = true;
          this.bleAssembler.reset();
          // Re-announce the app session; the camera keeps its pairing.
          this.bleWrite(Commands.sessionWake());
          this.log('ble: reconnected (keepalive restored)');
        })
        .catch(() => this.scheduleBleReconnect(token, attempt + 1));
    });
  }

  // ───────────────────────────── Wi-Fi handoff (SoftAP) ─────────────────────────────

  private async softApCredentials(
    target: DiscoveredCamera | SavedCamera,
    saved: SavedCamera | null,
    options: ConnectOptions | undefined,
    advertisedName: string,
    token: number,
  ): Promise<{ ssid: string; password: string; cached: boolean }> {
    this.enterStage('wifi-handoff', token);
    const savedSsid = saved?.path.kind === 'softap' && saved.path.ssid ? saved.path.ssid : null;
    const keychainPassword = savedSsid ? ((await this.deps.credentials.read(target.id, savedSsid).catch(() => undefined)) ?? null) : null;
    this.check(token);
    const known = CameraWifiResolution.resolve({
      cameraId: target.id,
      savedSSID: savedSsid,
      memory: options?.wifiPassword && savedSsid ? { cameraId: target.id, ssid: savedSsid, password: options.wifiPassword } : null,
      keychainSSID: keychainPassword ? savedSsid : null,
      keychainPassword,
      advertisedName,
    });
    if (!known.skipBle) {
      await this.pause(200, token);
      try {
        await this.bleRequest([[0x53, 0x10]], AP_WAKE_TIMEOUT_S * 1000, 'ap-wake', [apWakeFrame()]);
      } catch (e) {
        if (e instanceof ExchangeClosed) throw this.bleFailure(e, '0x53/0x10', token);
        this.log('creds: 0x53/0x10 no reply — continuing (Pocket 3 often answers e0/silent)');
      }
      await this.pause(600, token);
    }
    if (known.skipBle && known.ssid && known.password) {
      this.log(`creds: skipping BLE GetSSID/GetPassword (${known.source})`);
      return { ssid: known.ssid, password: known.password, cached: true };
    }
    const fallbackSsid = known.ssid ?? CameraWifiResolution.liveAdvertisedSSID(advertisedName);
    let ssid: string;
    if (known.ssid && !known.password) {
      ssid = known.ssid;
    } else {
      try {
        ssid = await this.wifiString('ssid', known.ssid, token);
      } catch (e) {
        if (!fallbackSsid || e instanceof ConnectCancelled || (e instanceof ConnectError && e.failure.kind === 'ble-dropped')) throw e;
        this.log('creds: GetSSID refused — using the advertised SSID');
        ssid = fallbackSsid;
      }
    }
    const password = await this.wifiString('password', known.password, token);
    if (ssidConflictsWithBody(ssid, null, advertisedName)) throw new ConnectError({ kind: 'ssid-conflict', ssid });
    return { ssid, password, cached: false };
  }

  /** GetSSID / GetPassword with the core reply decode: 4 s attempts, 12 s budget, 0.4 s pause. */
  private async wifiString(which: 'ssid' | 'password', cached: string | null, token: number): Promise<string> {
    const frames = wifiCredentialFrames();
    const frame = which === 'ssid' ? frames.ssid : frames.password;
    const label = which === 'ssid' ? 'GetSSID' : 'GetPassword';
    const deadline = this.now() + WIFI_STRING_BUDGET_S * 1000;
    while (this.now() < deadline) {
      this.check(token);
      try {
        const reply = await this.bleRequest([[frame.cmdSet, frame.cmdId]], WIFI_STRING_ATTEMPT_TIMEOUT_S * 1000, label, [frame]);
        const decoded = wifiStringReply(reply.payload);
        if (decoded.kind === 'value') return decoded.value;
        if (decoded.kind === 'refused') {
          if (cached) return cached;
          throw new ConnectError({ kind: 'credentials-refused', which });
        }
        this.log(`creds: ${label} empty reply (status=${decoded.status})`);
      } catch (e) {
        if (e instanceof ExchangeClosed) throw this.bleFailure(e, label, token);
        if (!(e instanceof ExchangeTimeout)) throw e;
        this.log(`creds: ${label} attempt timed out`);
      }
      await this.pause(WIFI_STRING_RETRY_PAUSE_S * 1000, token);
    }
    if (cached) return cached;
    throw new ConnectError({ kind: 'credentials-timeout', which });
  }

  private async joinCameraWifi(cameraId: string, creds: { ssid: string; password: string; cached: boolean }, token: number): Promise<void> {
    const { ssid, password } = creds;
    this.enterStage('joining-wifi', token, { ssid });
    const failure = await this.joinNetwork(ssid, password, token);
    if (failure) {
      if (creds.cached && failure.kind === 'wifi-join' && joinRejectsCredentials(failure.outcome)) {
        this.log('creds: join failed with cached credentials — dropping them');
        await this.deps.credentials.remove(cameraId, ssid).catch(() => {});
      }
      throw new ConnectError(failure);
    }
    this.ssid = ssid;
    await this.deps.credentials.save(cameraId, ssid, password).catch((e) => this.log(`creds: save failed (${errorText(e)})`));
    this.check(token);
    this.set((s) => ({ ...s, identity: s.identity ? { ...s.identity, ssid } : s.identity, connection: { ...s.connection, transport: 'softap' } }));
  }

  /** `PocketWifi.join` with the SoftAP switch retry budget (90 s, 10 s pause). */
  private async joinNetwork(ssid: string, password: string, token: number): Promise<ConnectFailure | null> {
    const deadline = this.now() + CameraSoftAPSwitch.joinDeadlineSeconds * 1000;
    for (;;) {
      this.check(token);
      const remaining = deadline - this.now();
      const result = await this.io.wifi
        .join(ssid, password, { joinOnce: false, timeoutMs: Math.max(5000, Math.min(WIFI_JOIN_ATTEMPT_MS, remaining)) })
        .catch((e) => ({ joined: false, outcome: 'failed' as const, message: errorText(e) }));
      this.check(token);
      const failure = wifiJoinFailure(result, ssid);
      if (!failure) {
        this.log(`wifi: ${result.outcome}`);
        return null;
      }
      this.log(`wifi: join ${result.outcome}${result.message ? ` (${result.message})` : ''}`);
      const secondsLeft = (deadline - this.now()) / 1000;
      const retryable = result.outcome === 'timeout' || result.outcome === 'not-found';
      if (!retryable || !CameraSoftAPSwitch.shouldRetryJoin(secondsLeft)) return failure;
      await this.pause(CameraSoftAPSwitch.joinRetryPauseSeconds * 1000, token);
    }
  }

  // ───────────────────────────── station / hotspot ─────────────────────────────

  private async runStation(
    target: DiscoveredCamera | SavedCamera,
    path: Extract<SavedCamera['path'], { kind: 'station' | 'hotspot' }>,
    options: ConnectOptions | undefined,
    token: number,
  ): Promise<void> {
    const hotspot = path.kind === 'hotspot';
    // Station host, or (additive) a hotspot host Multiview learned; single-camera hotspot paths have none.
    const savedHost = path.host;
    const password = options?.wifiPassword ?? (await this.deps.credentials.read(target.id, path.ssid).catch(() => undefined));
    this.check(token);
    if (!password) throw new ConnectError({ kind: 'saved-password-missing', ssid: path.ssid });
    if (!hotspot) {
      this.enterStage('joining-host-wifi', token, { ssid: path.ssid });
      const failure = await this.joinNetwork(path.ssid, password, token);
      if (failure) throw new ConnectError(failure);
    }
    const nextSeq = () => {
      this.bleSeq = (this.bleSeq + 1) & 0xffff;
      return this.bleSeq;
    };
    const exchange = async (frame: DumlFrame, timeoutS: number) => {
      try {
        return await this.bleRequest([[frame.cmdSet, frame.cmdId]], timeoutS * 1000, 'station', [frame]);
      } catch (e) {
        if (e instanceof ExchangeClosed) throw this.bleFailure(e, 'station', token);
        throw e;
      }
    };
    this.enterStage('station-join', token, { ssid: path.ssid });
    if (this.model.family === 'nano') {
      await exchange(Commands.session5310(nextSeq()), 12);
      await this.pause(1000, token);
    }
    const identity = (await exchange(Commands.getWifiSsid(nextSeq()), 12)).payload;
    const discovery = this.deps.station;
    const tryHost = async (host: string): Promise<boolean> => {
      this.host = host;
      this.softAP = false;
      try {
        await this.openDatalink(token, 'fresh');
        if (discovery?.verifyIdentity && !(await this.datalinkIdentityMatches(identity, token))) {
          this.log(`station: ${host} answered but is another camera`);
          await this.closeDatalink();
          return false;
        }
        discovery?.onHost?.(target.id, host);
        return true;
      } catch (e) {
        if (e instanceof ConnectCancelled) throw e;
        await this.closeDatalink();
        return false;
      }
    };
    const verify = async (): Promise<boolean> => {
      if (savedHost && (await tryHost(savedHost))) return true;
      // Without discovery (single-camera station path) only a saved host can be reached.
      if (!discovery) return false;
      const localAddress = await this.io.wifi.localAddress().catch(() => null);
      this.check(token);
      const all = (await discovery.candidates({ hotspot, localAddress, savedHost })).filter((h) => h !== savedHost);
      this.setConnection({ detail: 'Finding camera on Wi-Fi' });
      const hits = await this.probeHosts(all, token);
      this.log(`station: ${hits.length} of ${all.length} hosts answered`);
      for (const host of hits) if (await tryHost(host)) return true;
      return false;
    };
    let outcome: 'joined' | 'verified';
    try {
      outcome = await runStationJoin(
        {
          model: this.model,
          ssid: path.ssid,
          password,
          hotspot,
          experimental: !MulticamSupport.hasPreview(this.model),
          probeExistingStation: true,
        },
        {
          identity,
          exchange,
          send: (f) => this.bleWrite(f),
          next: nextSeq,
          status: (text) => this.token(token) && this.setConnection({ detail: text }),
          hotspotReady: () => true,
          verifyOnNetwork: verify,
          log: (line) => this.log(`station: ${line}`),
          sleep: (s) => this.pause(s * 1000, token),
        },
      );
    } catch (e) {
      if (e instanceof StationJoinError) throw new ConnectError({ kind: 'station', failure: e.failure });
      throw e;
    }
    this.check(token);
    this.set((s) => ({ ...s, connection: { ...s.connection, transport: hotspot ? 'hotspot' : 'station' } }));
    if (outcome === 'verified') return;
    // Without subnet discovery (`deps.station`), only a saved host can be reached.
    if ((!savedHost && !discovery) || !(await verify())) throw new ConnectError({ kind: 'station-no-host', ssid: path.ssid });
  }

  private token(token: number): boolean {
    return token === this.attempt;
  }

  /** Multiview: the camera's `07/07` identity over the open datalink equals the BLE one. */
  private async datalinkIdentityMatches(identity: Uint8Array, token: number): Promise<boolean> {
    const reply = await this.dlRequest(Commands.getWifiSsid(), 8000, 'identity');
    this.check(token);
    if (!reply) return false;
    const a = reply.payload;
    return a.length === identity.length && a.every((v, i) => v === identity[i]);
  }

  /**
   * Multiview discovery: which `hosts` answer a UDP handshake within the probe timeout,
   * `probeWidth` at a time, at most eight. Each probe is its own short-lived native session; the
   * camera's real session opens afterwards with a fresh identity.
   */
  private async probeHosts(hosts: string[], token: number): Promise<string[]> {
    const width = Math.max(1, this.deps.station?.probeWidth ?? 8);
    const timeoutMs = this.deps.station?.probeTimeoutMs ?? 1500;
    const found: string[] = [];
    for (let i = 0; i < hosts.length && found.length < 8; i += width) {
      this.check(token);
      const batch = hosts.slice(i, i + width);
      const answers = await Promise.all(batch.map((h) => this.probeHost(h, timeoutMs, token)));
      batch.forEach((h, k) => {
        if (answers[k]) found.push(h);
      });
    }
    this.check(token);
    return found.slice(0, 8);
  }

  private probeHost(host: string, timeoutMs: number, token: number): Promise<boolean> {
    const dl = this.io.datalink;
    datalinkCounter += 1;
    const sid = `pm-probe-${Math.floor(this.random() * 0xffffff).toString(36)}-${datalinkCounter}`;
    const probeSeq = new DatalinkSequencer(this.random);
    const handshake = handshakeDatagram(probeSeq.sessionId, 0, probeSeq.baseSeq);
    return new Promise<boolean>((resolve) => {
      let done = false;
      let resend: ClockTimer | null = null;
      const subs: Sub[] = [];
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        this.clock.clearTimeout(timer);
        if (resend) this.clock.clearInterval(resend);
        subs.forEach((s) => s.remove());
        void dl.close(sid).catch(() => {});
        resolve(ok && token === this.attempt);
      };
      const timer = this.clock.setTimeout(() => finish(false), timeoutMs);
      subs.push(
        dl.addListener('onState', (e) => {
          if (e.sessionId !== sid) return;
          if (e.state === 'open') finish(true);
          else if (e.state === 'failed') finish(false);
        }),
        dl.addListener('onStats', (e) => {
          if (e.sessionId === sid && e.rxPackets > 0) finish(true);
        }),
      );
      const tcpPoke = this.model.tcpPoke ? { port: TCP_POKE_PORT, bytes: encodeFrame(Commands.setPairingPin(pairingToken(this.model))) } : null;
      dl.open(sid, { host, port: this.model.datalinkPort, localPort: 0, ackHz: ACK_HZ, tcpPoke }).then(
        () => {
          if (done) return;
          const send = () => {
            if (done || token !== this.attempt) return finish(false);
            try {
              dl.sendRaw(sid, handshake);
            } catch {
              finish(false);
            }
          };
          send();
          resend = this.clock.setInterval(send, CameraSoftAP.handshakeSendIntervalMilliseconds);
        },
        () => finish(false),
      );
    });
  }

  /**
   * Multiview exit (additive): return a camera moved onto a shared network to its own access
   * point over BLE (`07/48 00`), before `disconnect()`. Uses the session's BLE link when it is up,
   * else connects and pairs again. `deferred`: the camera answered `00 06` (retry later).
   */
  async restoreAccessPoint(target?: DiscoveredCamera | SavedCamera): Promise<'restored' | 'deferred' | 'failed'> {
    const t = target ?? this.lastTarget;
    if (!t) return 'failed';
    try {
      if (!this.bleConnected || !this.bleId) {
        this.attempt += 1;
        const token = this.attempt;
        await this.teardown({ leaveWifi: false });
        await this.ensureBluetooth(token);
        const sighting = await this.scanForTarget(t.id, SCAN_FOR_TARGET_MS, token);
        this.model = coreModelFor(t.model, sighting?.name ?? t.name, sighting?.modelId ?? null);
        this.reducer.reset(this.model);
        await this.connectBle(t.id, token);
        await this.pair(t.id, token);
      }
      this.bleSeq = (this.bleSeq + 1) & 0xffff;
      const frame = MulticamCommands.stationMode(false, this.bleSeq);
      const reply = await this.bleRequest([[frame.cmdSet, frame.cmdId]], 12000, 'station-off', [frame]);
      const p = reply.payload;
      const ok = (p.length === 1 && p[0] === 0) || (p.length === 2 && p[0] === 0 && p[1] === 0);
      this.log(`station: access point restore ${ok ? 'ok' : 'refused'}`);
      return ok ? 'restored' : 'failed';
    } catch (e) {
      if (e instanceof ConnectError && e.failure.kind === 'pairing-deferred') return 'deferred';
      this.log(`station: access point restore failed (${errorText(e)})`);
      return 'failed';
    }
  }

  // ───────────────────────────── datalink ─────────────────────────────

  private subscribeDatalink(): void {
    if (this.dlSubs.length) return;
    const dl = this.io.datalink;
    this.dlSubs.push(
      dl.addListener('onDuml', (e) => this.onDuml(e)),
      dl.addListener('onState', (e) => this.onDatalinkState(e)),
      dl.addListener('onStats', (e) => this.onStats(e)),
    );
  }

  private unsubscribeDatalink(): void {
    this.dlSubs.forEach((s) => s.remove());
    this.dlSubs = [];
  }

  /**
   * Open the UDP datalink and wait for admission.
   * `fresh`: new handshake identity (session id / baseSeq). `rebind`: same identity, new socket
   * (`rebuildUDP keeps session id / seq`).
   */
  private async openDatalink(token: number, mode: 'fresh' | 'rebind'): Promise<void> {
    this.enterStage('datalink', token);
    this.subscribeDatalink();
    if (!this.dlId) {
      datalinkCounter += 1;
      this.dlId = `pm-${Math.floor(this.random() * 0xffffff).toString(36)}-${datalinkCounter}`;
    }
    const sid = this.dlId;
    if (mode === 'fresh') this.sequencer = new DatalinkSequencer(this.random);
    this.dumlSeq = 0xa000;
    this.sets.reset();
    this.dlExchange.reopen();
    this.connectEnableSent = false;
    this.feed.resetTransport(this.now());
    const options = {
      host: this.host,
      port: this.model.datalinkPort,
      localPort: 0,
      ackHz: ACK_HZ,
      tcpPoke: this.model.tcpPoke ? { port: TCP_POKE_PORT, bytes: encodeFrame(Commands.setPairingPin(pairingToken(this.model))) } : null,
    };
    const open = async () => {
      this.dlState = 'opening';
      this.dlError = undefined;
      this.dlInbound = 0;
      try {
        await withTimeout(this.clock, this.io.datalink.open(sid, options), DATALINK_OPEN_TIMEOUT_MS, () => new Error('datalink open timed out'));
      } catch (e) {
        this.check(token);
        throw new ConnectError(datalinkFailure(errorText(e)));
      }
      this.check(token);
    };
    await open();
    const handshake = handshakeDatagram(this.sequencer.sessionId, 0, this.sequencer.baseSeq);
    let rebinds = 0;
    for (let round = 1; ; round++) {
      for (let i = 0; i < CameraSoftAP.handshakeSendsPerBind; i++) {
        this.check(token);
        if (this.dlState === 'open') {
          this.feed.flowHealthy = true;
          return;
        }
        if (this.dlState === 'failed') throw new ConnectError(datalinkFailure(this.dlError));
        this.io.datalink.sendRaw(sid, handshake);
        await this.waitForDatalinkOpen(CameraSoftAP.handshakeSendIntervalMilliseconds, token);
      }
      if (this.dlState === 'open') {
        this.feed.flowHealthy = true;
        return;
      }
      const pathReady = await this.pathReady();
      this.check(token);
      const step = CameraSoftAP.handshakeTimeoutStep(pathReady, rebinds, this.dlInbound, CameraSoftAP.handshakeRebindLimit, round);
      this.log(`datalink: handshake miss round=${round} step=${step} inbound=${this.dlInbound}`);
      if (step === 'fail') throw new ConnectError({ kind: 'datalink-handshake' });
      if (step === 'rebindUDP') {
        rebinds += 1;
        await this.io.datalink.close(sid).catch(() => {});
        await this.pause(CameraSoftAP.handshakeRetryPauseMilliseconds, token);
        await open();
      }
    }
  }

  private waitForDatalinkOpen(ms: number, token: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        this.stateWaiters.delete(done);
        this.clock.clearTimeout(t);
        if (token !== this.attempt) reject(new ConnectCancelled());
        else resolve();
      };
      const t = this.clock.setTimeout(done, ms);
      this.stateWaiters.add(done);
    });
  }

  private async closeDatalink(): Promise<void> {
    const sid = this.dlId;
    this.sets.reset();
    this.dlExchange.close('datalink closed');
    this.dlExchange.reopen();
    this.feed.flowHealthy = false;
    if (!sid) return;
    this.dlState = 'closed';
    try {
      this.io.datalink.detachVideo(sid);
    } catch {
      // not attached
    }
    await this.io.datalink.close(sid).catch(() => {});
  }

  private async pathReady(): Promise<boolean> {
    if (!this.softAP) return true;
    const addr = await this.io.wifi.localAddress().catch(() => null);
    this.lastLocalAddress = addr;
    return addr != null && CameraSoftAP.isAssociatedIPv4(addr);
  }

  private onDatalinkState(e: DatalinkStateEvent): void {
    if (e.sessionId !== this.dlId) return;
    const previous = this.dlState;
    this.dlState = e.state;
    this.dlError = e.error;
    this.feed.flowHealthy = e.state === 'open';
    if (previous !== e.state) this.log(`datalink: ${e.state}${e.error ? ` (${e.error})` : ''}`);
    this.stateWaiters.forEach((w) => w());
    if (this.corePhase.kind !== 'live' || this.repairing) return;
    if (e.state === 'failed') {
      const failure = datalinkFailure(e.error);
      if (failure.kind === 'local-network-denied') {
        void this.failLive(failure);
        return;
      }
      void this.runRepair('reopenDatalink', 'datalink failed');
    } else if (e.state === 'closed' && previous !== 'closed') {
      void this.runRepair('reopenDatalink', 'datalink closed');
    }
  }

  private onStats(e: DatalinkStats): void {
    if (e.sessionId !== this.dlId) return;
    if (e.rxPackets > 0) this.dlInbound = Math.max(this.dlInbound, e.rxPackets);
    this.feed.noteStats(e, this.now());
    this.refreshLivePhase();
  }

  private onDuml(e: DatalinkFrame): void {
    if (e.sessionId !== this.dlId) return;
    const decoded = decodeFrame(e.bytes);
    if (!decoded) return;
    const frame = decoded.frame;
    const now = this.now();
    this.dlInbound += 1;
    this.feed.noteStatus(now);
    this.dlExchange.deliver(frame);
    this.sets.reply(frame);
    this.mediaChunks?.ingest(frame);
    if (this.reducer.apply(frame, now)) this.schedulePublish();
    if (this.reducer.takeFaceChanged()) this.notice(this.reducer.stick.face === 'selfie' ? 'Camera facing you' : 'Camera facing forward');
  }

  /** Stamp the DUML seq and write one frame on the open datalink. Null when not admitted. */
  private sendDatalink(frame: DumlFrame): number | null {
    const sid = this.dlId;
    if (!sid || this.dlState !== 'open') return null;
    const seq = this.dumlSeq;
    this.dumlSeq = (this.dumlSeq + 1) & 0xffff;
    try {
      this.io.datalink.sendDuml(sid, encodeFrame({ ...frame, seq }));
    } catch (e) {
      this.log(`datalink: send failed (${errorText(e)})`);
      return null;
    }
    return seq;
  }

  /** A non-mailbox request/reply on the datalink (gimbal, media). Null on timeout / offline. */
  private async dlRequest(frame: DumlFrame, timeoutMs: number, label: string): Promise<DumlFrame | null> {
    let seq: number | null = null;
    try {
      return await this.dlExchange.request(
        (f) => f.cmdSet === frame.cmdSet && f.cmdId === frame.cmdId && seq != null && f.seq === seq,
        timeoutMs,
        label,
        () => {
          seq = this.sendDatalink(frame);
          if (seq == null) throw new ExchangeClosed('offline');
        },
      );
    } catch (e) {
      this.log(`datalink: ${label} ${e instanceof ExchangeTimeout ? 'timed out' : errorText(e)}`);
      return null;
    }
  }

  /** Registration spine after admission (desktop `send_registration` + subscriptions + probes). */
  private sendRegistration(withGimbalInit: boolean): void {
    this.sendDatalink(Commands.appDeviceInfo(0));
    this.sendDatalink(Commands.appPresenceFrame(0));
    if (withGimbalInit) this.sendDatalink(Commands.gimbalInit(0));
    subscriptionKeysFor(this.model).forEach((key, i) => this.sendDatalink(Commands.subscribe(key, FIRST_SUB_ID + i, 0)));
    // No push for these; the phones read them on connect.
    for (const f of [Commands.getFocusTrack(), ...Commands.audioStateGets(), Commands.getIsoLimit()]) this.sendDatalink(f);
    if (hasGimbal(this.model)) {
      this.sendDatalink(Commands.gimbalParamsGet(0));
      this.sendDatalink(Commands.getSelfieFlip());
    }
  }

  /**
   * `0x09/0xa8` (+ Pocket `0x02/0x68 08` prepare, Nano `0x02/0x09` gate). `connect` is allowed
   * once per datalink session; `watchdog` and `media-resume` are the only repeat owners.
   */
  private enableLiveView(reason: 'connect' | 'watchdog' | 'media-resume', withPrepare: boolean): boolean {
    if (reason === 'connect') {
      if (this.connectEnableSent) {
        this.log('feed: connect enable already sent — not repeating (watchdog owns repeats)');
        return false;
      }
      this.connectEnableSent = true;
    }
    if (withPrepare && sendsLiveViewPrepare(this.model)) this.sendDatalink(Commands.liveViewPrepare());
    if (usesNanoLiveViewGate(this.model)) this.sendDatalink(Commands.nanoLiveViewGate(true));
    const seq = this.sendDatalink(Commands.liveViewEnable(0, liveViewEnableReceiver(this.model)));
    if (seq == null) return false;
    this.feed.noteEnable(this.now());
    this.log(`feed: 0x09/0xa8 reason=${reason} count=${this.feed.enableCount}`);
    return true;
  }

  private async startLive(token: number): Promise<void> {
    const sid = this.dlId;
    if (!sid) throw new ConnectError({ kind: 'datalink-open' });
    this.enterStage('registering', token);
    this.sendRegistration(true);
    this.io.datalink.attachVideo(sid, codecHint(this.model));
    await this.pause(SUBSCRIBE_SETTLE_MS, token);
    this.enterStage('live-start', token);
    this.enableLiveView('connect', true);
    this.corePhase = { kind: 'live' };
    this.liveStartedAt = this.now();
    this.video = { kind: 'native', sessionId: sid };
    this.sessionRecoveries = 0;
    this.watchdog.stage = 'idle';
    this.startLiveTimers(token);
    this.refreshLivePhase();
    this.publishStatus();
  }

  // ───────────────────────────── live timers, heartbeat, watchdog ─────────────────────────────

  private startHeartbeat(): void {
    const token = this.attempt;
    // Upstream `DjiAppleSessionHeartbeat`: BLE keepalive + app presence 1 Hz; camera video stops
    // after missing app registration even while telemetry stays fresh.
    this.every(HEARTBEAT_MS, () => {
      if (token !== this.attempt) return;
      if (this.bleConnected) this.bleWrite(Commands.sessionKeepalive());
      if (this.dlState !== 'open' || this.corePhase.kind !== 'live') return;
      this.sendDatalink(Commands.appPresenceFrame(0));
      if (hasGimbal(this.model) && !this.browsing) this.sendDatalink(Commands.getSelfieFlip());
      this.tickPathRecovery();
      this.refreshLivePhase();
    });
  }

  private startLiveTimers(token: number): void {
    this.every(WATCHDOG_MS, () => {
      if (token === this.attempt) this.tickWatchdog();
    });
    this.every(PATH_POLL_MS, () => {
      if (token !== this.attempt || !this.softAP) return;
      void this.pathReady().then((ready) => {
        if (token === this.attempt) this.feed.pathReady = ready;
      });
    });
  }

  private tickWatchdog(): void {
    if (this.corePhase.kind !== 'live') return;
    this.feed.repairBlocked = this.browsing || this.repairing;
    const now = this.now();
    const action = this.watchdog.tick(this.feed.snapshot(now, true));
    if (action !== 'none') {
      this.log(this.watchdog.stallLogLine(this.feed.snapshot(now, true)));
      void this.runRepair(action, 'watchdog');
    }
    this.refreshLivePhase();
  }

  private tickPathRecovery(): void {
    const now = this.now();
    const lost = this.pathRecovery.tick(now / 1000, this.feed.pathReady, this.feed.videoFlowing(now), this.corePhase.kind === 'live' && !this.browsing, this.repairing);
    if (lost) {
      this.log(`session: camera network absent after reassociation grace (addr=${this.lastLocalAddress ?? 'none'})`);
      void this.recoverSession('camera Wi-Fi lost');
    }
  }

  /** One feed repair at a time; the action comes only from `FeedWatchdog.tick` (or a dead datalink). */
  private async runRepair(action: WatchdogAction, why: string): Promise<void> {
    if (this.repairing || action === 'none') return;
    const token = this.attempt;
    const sid = this.dlId;
    if (!sid) return;
    this.repairing = true;
    this.restStick();
    this.cancelMotion('Motion Control stopped: the picture is reconnecting');
    this.refreshLivePhase();
    this.log(`feed: repair ${action} (${why})`);
    try {
      switch (action) {
        case 'resendLiveViewEnable':
          // Reassert the registration that owns the live lease, then the watchdog's enable.
          this.sendDatalink(Commands.appDeviceInfo(0));
          this.sendDatalink(Commands.appPresenceFrame(0));
          this.enableLiveView('watchdog', false);
          break;
        case 'rebuildVTSession':
          this.io.datalink.detachVideo(sid);
          this.io.datalink.attachVideo(sid, codecHint(this.model));
          break;
        case 'reopenDatalink':
        case 'fullSessionRejoin': {
          await this.io.datalink.close(sid).catch(() => {});
          await this.openDatalink(token, action === 'reopenDatalink' ? 'rebind' : 'fresh');
          this.sendRegistration(false);
          this.io.datalink.attachVideo(sid, codecHint(this.model));
          await this.pause(SUBSCRIBE_SETTLE_MS, token);
          // One enable rides with the new socket; it belongs to this watchdog rung.
          this.enableLiveView('watchdog', true);
          this.corePhase = { kind: 'live' };
          break;
        }
        default:
          break;
      }
    } catch (e) {
      if (e instanceof ConnectCancelled || token !== this.attempt) return;
      this.log(`feed: repair ${action} failed (${errorText(e)})`);
      this.repairing = false;
      if (action === 'fullSessionRejoin' || action === 'reopenDatalink') void this.recoverSession('datalink rejoin failed');
      return;
    } finally {
      if (token === this.attempt) this.repairing = false;
    }
    if (token === this.attempt) this.refreshLivePhase();
  }

  /** Bounded SessionRecovery: re-run the whole spine (BLE → Wi-Fi → datalink), up to twice. */
  private async recoverSession(why: string): Promise<void> {
    const target = this.lastTarget;
    if (!target) return;
    if (this.sessionRecoveries >= 2) {
      await this.failLive({ kind: 'datalink-handshake' });
      return;
    }
    this.sessionRecoveries += 1;
    const recoveries = this.sessionRecoveries;
    this.log(`session: recovery ${recoveries} (${why})`);
    this.notice('Reconnecting to the camera', 'warning');
    await this.connect(target, this.lastOptions);
    // `connect` resets the counter on success; keep the budget across failed attempts.
    if (this.corePhase.kind !== 'live') this.sessionRecoveries = recoveries;
  }

  private async failLive(failure: ConnectFailure): Promise<void> {
    this.attempt += 1;
    await this.teardown({ leaveWifi: false });
    this.corePhase = { kind: 'failed', reason: failure.kind };
    this.setConnection({ phase: 'failed', detail: undefined, error: connectFailureCopy(failure), signalBars: 0, videoFps: 0, videoKbps: 0 });
  }

  /** Tear down every listener, timer and native session. Bumping `attempt` is the caller's job. */
  private async teardown(opts: { leaveWifi: boolean }): Promise<void> {
    // Not live from here on: datalink close events must not look like a dead link to repair.
    this.corePhase = { kind: 'idle' };
    this.clearTimers();
    this.cancelMotion(null);
    this.stopTrackingPoll();
    this.stickVector = { x: 0, y: 0 };
    this.feed.stickHeld = false;
    this.zoomRateSent = 0;
    this.repairing = false;
    this.browsing = false;
    this.mediaChunks = null;
    this.recordingSeen = false;
    this.wasRecording = false;
    this.stateWaiters.forEach((w) => w());
    this.stateWaiters.clear();
    this.bleExchange.close('session closed');
    this.bleExchange.reopen();
    await this.closeDatalink();
    this.unsubscribeDatalink();
    this.dlId = null;
    this.dlState = 'none';
    this.video = { kind: 'none' };
    const ble = this.bleId;
    this.unsubscribeBle();
    this.bleId = null;
    this.bleConnected = false;
    if (ble) await this.io.bluetooth.disconnect(ble).catch(() => {});
    const ssid = this.ssid;
    this.ssid = null;
    if (opts.leaveWifi && ssid) await this.io.wifi.leave(ssid).catch(() => {});
    this.corePhase = { kind: 'idle' };
    this.stage = null;
    this.liveStartedAt = null;
    this.watchdog.stage = 'idle';
    this.pathRecovery.reset();
    this.feed.pathReady = true;
  }

  // ───────────────────────────── picture stats (additive seam) ─────────────────────────────

  /** The picture view reports presented frames (~1 Hz) so fps / frame age are measured. */
  notePictureStats(stats: PictureStats): void {
    this.feed.notePicture(stats, this.now());
    if (stats.width && stats.height && (this.state.connection.streamWidth !== stats.width || this.state.connection.streamHeight !== stats.height)) {
      this.setConnection({ streamWidth: stats.width, streamHeight: stats.height });
    }
  }

  // ───────────────────────────── control helpers ─────────────────────────────

  private get live(): boolean {
    return this.corePhase.kind === 'live' && this.dlState === 'open';
  }

  /** Send a camera SET: live controls through the mailbox, others as a tracked request. */
  private async cameraSet(frame: DumlFrame, label: string, opts: { urgent?: boolean; grace?: 'camera' | 'zoom' | 'focusTrack' | 'none' } = {}): Promise<boolean> {
    if (!this.live) {
      this.notice('Connect a camera first', 'warning');
      return false;
    }
    const now = this.now();
    const grace = opts.grace ?? (isLiveCameraRead(frame) ? 'none' : 'camera');
    if (grace === 'camera') this.feed.lastCameraSetAt = now;
    else if (grace === 'zoom') this.feed.lastZoomSetAt = now;
    else if (grace === 'focusTrack') this.feed.lastFocusTrackSetAt = now;
    let result: SetResult;
    if (isLiveCameraControl(frame.cmdSet, frame.cmdId)) {
      result = await this.sets.submit(frame, opts.urgent ?? true);
    } else {
      const reply = await this.dlRequest(frame, 1500, label);
      if (!reply) result = { kind: 'timeout' };
      else {
        const parsed = CameraReplies.parse(reply.payload);
        result = CameraReplies.isSuccess(parsed) ? { kind: 'ok' } : { kind: 'refused', reply: parsed, message: CameraReplies.message(parsed) };
      }
    }
    if (result.kind === 'refused') this.notice(`${label}: ${result.message}`, 'warning');
    else if (result.kind === 'timeout') this.notice(`${label}: the camera did not answer`, 'warning');
    else if (result.kind === 'offline') this.notice('The camera link is not ready', 'warning');
    return result.kind === 'ok' || result.kind === 'superseded';
  }

  /** Fire-and-forget gimbal write (`0x04/*` notify / ACK80 frames). */
  private gimbalSend(frame: DumlFrame): boolean {
    if (!this.live) return false;
    return this.sendDatalink(frame) != null;
  }

  private patch(mutator: (s: CameraState) => CameraState): void {
    this.set(mutator);
  }

  private videoFormatFor(resolution: string | undefined, fps: number | undefined): VideoFormat | null {
    const s = this.reducer.status;
    const formats = CamCapVideoFormat.pickerFormats(s.availableVideoFormats, this.model, s.shootingMode);
    const currentRes = s.videoResolution;
    const wantRes = resolution ?? this.state.format.resolution;
    const wantFps = fps ?? this.state.format.fps;
    const match = formats.find((f) => resolutionLabel(f.resolution) === wantRes && VideoFrameRates.fps(f.frameRate) === wantFps);
    if (match) return match;
    // No camcap table: keep the resolution byte we know and swap the frame rate.
    const rate = VideoFrameRates.fromFps(wantFps);
    if (!resolution && currentRes != null && rate != null) return { resolution: currentRes, frameRate: rate };
    return null;
  }

  // ───────────────────────────── CameraController ─────────────────────────────

  readonly control: CameraController = {
    startRecording: async (options) => {
      if (options?.countdown) {
        for (let n = 3; n > 0; n--) {
          this.patch((s) => ({ ...s, recording: { ...s.recording, countdown: n } }));
          await new Promise<void>((r) => this.clock.setTimeout(r, 1000));
        }
        this.patch((s) => ({ ...s, recording: { ...s.recording, countdown: null } }));
      }
      const mode = StatusQueries.shootingMode(this.reducer.status);
      await this.cameraSet(captureCommand(mode, this.model, false), 'Record');
    },
    stopRecording: async () => {
      const mode = StatusQueries.shootingMode(this.reducer.status);
      await this.cameraSet(captureCommand(mode, this.model, true), 'Stop');
    },
    capturePhoto: async () => {
      this.patch((s) => ({ ...s, recording: { ...s.recording, capturingStill: true } }));
      const ok = await this.cameraSet(Commands.shootPhoto(), 'Photo');
      this.patch((s) => ({ ...s, recording: { ...s.recording, capturingStill: false } }));
      if (ok) this.emit({ type: 'photo-captured' });
    },
    setShootingMode: async (mode) => {
      const wire = wireShootingMode(mode);
      if (wire == null) {
        this.notice('That mode is set on the camera', 'info');
        return;
      }
      await this.cameraSet(Commands.setShootingMode(wire, this.model), 'Mode');
    },
    setExposureMode: async (mode) => {
      await this.cameraSet(Commands.setExpoMode(mode === 'auto' ? ExpoMode.auto : ExpoMode.manual), 'Exposure');
    },
    setIso: async (iso) => {
      if (iso !== 'auto' && this.reducer.status.expoMode === ExpoMode.auto) await this.cameraSet(Commands.setExpoMode(ExpoMode.manual), 'Exposure');
      const index = wireIsoIndex(iso, this.reducer.status.availableIsoIndices);
      if (index == null) {
        this.notice('That ISO is not offered in this mode', 'warning');
        return;
      }
      await this.cameraSet(Commands.setIsoIndex(index), 'ISO', { urgent: false });
    },
    setIsoLimit: async (iso) => {
      const limits = Object.values(IsoLimit) as IsoLimitValue[];
      const best = limits.reduce((b, l) => (Math.abs(isoLimitCeiling(l) - iso) < Math.abs(isoLimitCeiling(b) - iso) ? l : b), limits[0]);
      await this.cameraSet(Commands.setIsoLimit(best), 'ISO limit');
      this.dlRequest(Commands.getIsoLimit(), 1000, 'iso limit get').catch(() => null);
    },
    setShutter: async (denom) => {
      if (denom === 'auto') {
        await this.cameraSet(Commands.setExpoMode(ExpoMode.auto), 'Exposure');
        return;
      }
      if (this.reducer.status.expoMode === ExpoMode.auto) await this.cameraSet(Commands.setExpoMode(ExpoMode.manual), 'Exposure');
      await this.cameraSet(Commands.setShutter(denom), 'Shutter', { urgent: false });
    },
    setEv: async (ev) => {
      await this.cameraSet(Commands.setEv(evToThirds(ev)), 'EV', { urgent: false });
    },
    setAperture: async (fNumber) => {
      const strategies = Object.values(ApertureStrategy) as ApertureStrategy[];
      const match = strategies.find((s) => apertureFNumber(s) === fNumber);
      if (match == null) {
        this.notice('That aperture is not available', 'warning');
        return;
      }
      await this.cameraSet(Commands.setApertureStrategy(match), 'Aperture');
    },
    setWhiteBalance: async (change) => {
      const current = this.state.whiteBalance;
      const tint = change.tint ?? current.tint ?? 0;
      if (change.preset === 'auto' && change.kelvin === undefined) {
        await this.cameraSet(Commands.setWhiteBalance(wbAuto(tint)), 'White balance');
        return;
      }
      const kelvin = change.kelvin ?? (change.preset ? PRESET_KELVIN[change.preset] : undefined) ?? current.kelvin ?? 5600;
      const wb = change.preset === undefined && change.kelvin === undefined && current.preset === 'auto' ? wbAuto(tint) : wbCustom(clamp(kelvin, 2000, 10000), tint);
      await this.cameraSet(Commands.setWhiteBalance(wb), 'White balance', { urgent: change.kelvin === undefined });
    },
    setFormat: async (change) => {
      if (change.codec !== undefined || change.bitrate !== undefined) this.notice('Codec and bitrate are set on the camera', 'info');
      if (change.resolution !== undefined || change.fps !== undefined) {
        const format = this.videoFormatFor(change.resolution, change.fps);
        if (!format) this.notice('That format is not offered in this mode', 'warning');
        else {
          const mode = VideoFormats.formatSetMode(this.model, StatusQueries.shootingMode(this.reducer.status));
          if (await this.cameraSet(Commands.setVideoFormat(format, mode), 'Format')) this.notice('Format changed');
        }
      }
      if (change.colorMode !== undefined) await this.cameraSet(Commands.setColorMode(wireColorMode(change.colorMode), this.model), 'Color');
    },
    setFocusMode: async (mode) => {
      if (mode === 'mf') this.notice('Manual focus is not available over the app link; using single AF', 'info');
      await this.cameraSet(Commands.setFocusMode(wireFocusMode(mode)), 'Focus', { grace: 'focusTrack' });
    },
    focusAt: async (point) => {
      const x = clamp(point.x, 0, 1);
      const y = clamp(point.y, 0, 1);
      // Tap-focus burst: AE meter spot → focus region → AE meter region.
      void this.cameraSet(Commands.tapFocusPrepare(), 'Focus', { grace: 'focusTrack' });
      void this.cameraSet(Commands.tapFocusPoint(x, y), 'Focus', { grace: 'focusTrack' });
      const ok = await this.cameraSet(Commands.tapFocusCommit(x, y), 'Focus', { grace: 'focusTrack' });
      if (ok) this.patch((s) => ({ ...s, focus: { ...s.focus, x, y, hasPoint: true } }));
    },
    setManualFocus: async () => {
      this.notice('Manual focus is not available over the app link', 'info');
    },
    setZoom: async (factor) => {
      const z = this.state.zoom;
      await this.cameraSet(Commands.setZoom(clamp(factor, z.min, z.max)), 'Zoom', { grace: 'zoom', urgent: false });
    },
    zoomBy: (rate) => {
      if (!this.live) return;
      const r = clamp(rate, -1, 1);
      const bucket = r === 0 ? 0 : Math.sign(r) * (72 + Math.round(Math.abs(r) * 6));
      if (bucket === this.zoomRateSent) return;
      this.zoomRateSent = bucket;
      this.feed.zoomHeld = r !== 0;
      this.feed.lastZoomSetAt = this.now();
      const frame = r === 0 ? Commands.setZoomStop() : Commands.setZoomRate(Math.abs(bucket), r > 0);
      void this.sets.submit(frame, true);
    },
    startTracking: async (target) => {
      const box = 'width' in target ? target : TrackingBoxes.fromCenter(target.x, target.y, 0.16, 0.24);
      if (TrackingBoxes.isTooSmall(box)) {
        this.notice('Draw a larger box to track', 'warning');
        return;
      }
      const c = TrackingBoxes.center(box);
      this.patch((s) => ({ ...s, tracking: { ...s.tracking, status: 'searching', box } }));
      this.reducer.tracking = null;
      const id = this.trackId;
      this.trackId = (this.trackId % 0xfffe) + 1;
      const ok = await this.cameraSet(Commands.setTrackingBox(id, c.x, c.y, box.width, box.height), 'Track');
      if (!ok) {
        this.patch((s) => ({ ...s, tracking: { ...s.tracking, status: 'idle', box: undefined } }));
        return;
      }
      this.startTrackingPoll();
    },
    stopTracking: async () => {
      this.stopTrackingPoll();
      this.reducer.tracking = { kind: 'idle' };
      this.patch((s) => ({ ...s, tracking: { ...s.tracking, status: 'idle', box: undefined, label: undefined } }));
      await this.cameraSet(Commands.clearTrackingBox(), 'Track clear');
    },
    setAudio: async (change) => {
      if (change.channel !== undefined) await this.cameraSet(Commands.setAudioChannel(change.channel === 'mono' ? 0x01 : 0x02), 'Audio');
      if (change.vocalBoost !== undefined) await this.cameraSet(Commands.setVocalBoost(change.vocalBoost ? 0x01 : 0x00), 'Vocal boost');
      if (change.windReduction !== undefined || change.directional !== undefined) {
        // The DSP SET is the whole 26-byte GET blob with byte 2 patched; read it first if missing.
        if (!this.reducer.status.audioDspBlob) await this.dlRequest(Commands.audioDspGet(), 1000, 'audio dsp get');
        const blob = this.reducer.status.audioDspBlob;
        if (!blob) {
          this.notice('The camera did not report its audio settings', 'warning');
          return;
        }
        let next = blob;
        if (change.directional !== undefined) next = AudioDspBlob.patchDirectional(next, wireDirectional(change.directional));
        if (change.windReduction !== undefined) next = AudioDspBlob.patchWind(next, change.windReduction ? 0x1a : 0x18);
        if (await this.cameraSet(Commands.audioDspSet(next), 'Audio')) this.reducer.status.audioDspBlob = next;
      }
      for (const f of Commands.audioStateGets()) this.sendDatalink(f);
    },
  };

  private startTrackingPoll(): void {
    this.stopTrackingPoll();
    const token = this.attempt;
    this.trackTimer = this.every(TRACK_POLL_MS, () => {
      if (token !== this.attempt || !this.live) return;
      if (this.state.tracking.status === 'idle') {
        this.stopTrackingPoll();
        return;
      }
      void this.sets.submit(Commands.pollTracking(), true);
    });
  }

  private stopTrackingPoll(): void {
    if (this.trackTimer) {
      this.clock.clearInterval(this.trackTimer);
      this.intervals.delete(this.trackTimer);
    }
    this.trackTimer = null;
  }

  // ───────────────────────────── GimbalController ─────────────────────────────

  /**
   * Stick stream: JS `setInterval` at 25 Hz. JS timers jitter (tens of ms under load, more when
   * the JS thread is busy), so the camera sees an uneven cadence; README asks for the stick to
   * ride the native UDP queue (no native API yet). The ACK pump is unaffected (native, 40 Hz).
   */
  private startStickPump(): void {
    if (this.stickTimer) return;
    const token = this.attempt;
    this.stickTimer = this.every(STICK_INTERVAL_MS, () => {
      if (token !== this.attempt) return;
      const { x, y } = this.stickVector;
      if (x === 0 && y === 0) {
        this.stopStickPump();
        return;
      }
      this.feed.lastGimbalThrowAt = this.now();
      this.gimbalSend(Commands.gimbalStick(GimbalStick.wireAxis(y), GimbalStick.wireAxis(x)));
    });
  }

  private stopStickPump(): void {
    if (this.stickTimer) {
      this.clock.clearInterval(this.stickTimer);
      this.intervals.delete(this.stickTimer);
    }
    this.stickTimer = null;
  }

  /** Lift: one centre frame, stop streaming. */
  private restStick(): void {
    const held = this.stickVector.x !== 0 || this.stickVector.y !== 0 || this.stickTimer != null;
    this.stickVector = { x: 0, y: 0 };
    this.feed.stickHeld = false;
    this.stopStickPump();
    if (held) this.gimbalSend(Commands.gimbalStick(GimbalStick.center, GimbalStick.center));
  }

  private currentWaypoint(): GimbalWaypoint | null {
    const a = this.reducer.attitude;
    if (!a || a.pitchTenthDeg == null) return null;
    return Waypoints.fromTenths(a.yawTenthDeg, a.pitchTenthDeg, this.state.zoom.factor, a.nativePitchTenthDeg);
  }

  private syncProgramState(patch: Partial<CameraState['gimbal']['program']> = {}): void {
    const ui = (w: GimbalWaypoint | null): MotionWaypoint | undefined => (w ? { yaw: w.yawDeg, pitch: w.pitchDeg, zoom: w.zoom } : undefined);
    const p = this.program;
    this.patch((s) => ({
      ...s,
      gimbal: {
        ...s.gimbal,
        program: { ...s.gimbal.program, a: ui(p.a), b: ui(p.b), c: ui(p.c), legSeconds: [p.durationAB, p.durationBC], smoothness: p.smoothness, ...patch },
      },
    }));
  }

  readonly gimbal: GimbalController = {
    drive: (x, y) => {
      if (!this.live || this.state.gimbal.lockedAllAxes) return;
      const vx = clamp(Number.isFinite(x) ? x : 0, -1, 1);
      const vy = clamp(Number.isFinite(y) ? y : 0, -1, 1);
      if (vx === 0 && vy === 0) {
        this.restStick();
        return;
      }
      if (this.motion) this.cancelMotion('Motion Control stopped: manual stick');
      this.stickVector = { x: vx, y: vy };
      this.feed.stickHeld = true;
      this.feed.lastGimbalThrowAt = this.now();
      this.reducer.stick.noteAppMotion();
      this.startStickPump();
    },
    recenter: async () => {
      if (!this.live) return;
      this.restStick();
      this.patch((s) => ({ ...s, gimbal: { ...s.gimbal, recentering: true } }));
      this.feed.lastGimbalThrowAt = this.now();
      await this.dlRequest(Commands.gimbalRecenter(), 1500, 'recenter');
      this.patch((s) => ({ ...s, gimbal: { ...s.gimbal, recentering: false } }));
    },
    flip: async (face) => {
      if (!this.live) return;
      if (face && face === this.state.gimbal.face) return;
      this.restStick();
      this.reducer.stick.noteRotate180();
      this.feed.lastGimbalThrowAt = this.now();
      await this.dlRequest(Commands.gimbalFlip(), 1500, 'flip');
    },
    setMode: async (mode) => {
      const wire = wireGimbalMode(mode);
      if (wire == null) {
        this.notice('That gimbal mode is set on the camera', 'info');
        return;
      }
      let ok = true;
      for (const f of gimbalModeFrames(wire)) ok = (await this.dlRequest(f, 1500, 'gimbal mode')) != null && ok;
      if (ok) {
        this.reducer.gimbalMode = wire;
        this.patch((s) => ({ ...s, gimbal: { ...s.gimbal, mode } }));
        this.notice(`Gimbal ${mode.replace('-', ' ')}`);
      } else this.notice('Gimbal mode: the camera did not answer', 'warning');
      this.sendDatalink(Commands.gimbalParamsGet(0));
    },
    setSpeed: async (speed) => {
      const reply = await this.dlRequest(Commands.setGimbalSpeed(wireGimbalSpeed(speed)), 1500, 'gimbal speed');
      if (reply) this.patch((s) => ({ ...s, gimbal: { ...s.gimbal, speed } }));
      this.sendDatalink(Commands.gimbalParamsGet(0));
    },
    setLockedAllAxes: (locked) => {
      // Latched joystick hold: no captured opcode (CONTEXT.md "Gimbal lock (all axes)").
      if (locked) this.restStick();
      this.patch((s) => ({ ...s, gimbal: { ...s.gimbal, lockedAllAxes: locked } }));
    },
    captureWaypoint: async (slot) => {
      const a = this.reducer.attitude;
      const wp = this.currentWaypoint();
      if (!wp || !a || this.now() - a.at > MOTION_FEEDBACK_STALE_MS) throw new Error('No fresh gimbal position yet. Let the gimbal settle, then set the point again.');
      this.program = Programs.setPoint(this.program, slot, wp);
      this.syncProgramState({ status: 'idle', error: undefined });
      return { yaw: wp.yawDeg, pitch: wp.pitchDeg, zoom: wp.zoom };
    },
    clearWaypoint: (slot) => {
      this.program = Programs.setPoint(this.program, slot, null);
      this.syncProgramState();
    },
    configureProgram: (options) => {
      const p = { ...this.program };
      if (options.legSeconds) {
        p.durationAB = Programs.snapDuration(options.legSeconds[0]);
        p.durationBC = Programs.snapDuration(options.legSeconds[1]);
      }
      if (options.smoothness !== undefined) p.smoothness = clamp(options.smoothness, 0, 1);
      this.program = p;
      this.syncProgramState();
    },
    runProgram: () => this.runProgram(),
    stopProgram: () => {
      this.cancelMotion(null);
      this.syncProgramState({ status: 'idle', progress: 0, error: undefined });
    },
    level: async () => {
      // Double-tap level: the body's recenter (FE 08) returns tilt and roll to level.
      await this.gimbal.recenter();
    },
  };

  // ───────────────────────────── Motion Control ─────────────────────────────

  private async runProgram(): Promise<void> {
    if (!this.live) {
      this.notice('Connect a camera first', 'warning');
      return;
    }
    if (this.motion) return;
    const plan = planProgram(this.program, this.currentWaypoint());
    const attitude = this.reducer.attitude;
    if (typeof plan === 'string' || !attitude) {
      const msg = plan === 'incomplete' ? 'Set A and B first' : 'Waiting for a fresh gimbal position';
      this.notice(msg, 'warning');
      this.syncProgramState({ status: 'idle', error: msg });
      return;
    }
    this.restStick();
    const speed = this.reducer.status.gimbalParams?.speed ?? GimbalSpeed.defaultSpeed;
    for (const f of this.prepRestore.prep(speed, this.reducer.gimbalMode)) await this.dlRequest(f, 1000, 'motion prep');
    this.motionToken += 1;
    const token = this.motionToken;
    const started = this.now();
    const wire = attitude.wire;
    const program = this.program;
    const finalPoint = program.c ?? program.b!;
    this.syncProgramState({ status: 'preparing', progress: 0, error: undefined });

    await new Promise<void>((resolve) => {
      const motion = { token, timers: [] as Timer[], interval: null as ClockTimer | null, resolve };
      this.motion = motion;
      const fail = (message: string) => {
        if (this.motion?.token !== token) return;
        this.cancelMotion(message);
      };
      const livePose = () => {
        const a = this.reducer.attitude;
        if (!a || a.nativePitchTenthDeg == null || this.now() - a.at > MOTION_FEEDBACK_STALE_MS) return null;
        return { yawDeg: Waypoints.unwrapYaw(a.yawTenthDeg / 10), nativePitchDeg: a.nativePitchTenthDeg / 10 };
      };
      const dispatch = (move: TimedMove | { yawDeg: number; nativePitchDeg: number; durationS: number }, scheduledAt: number | null) => {
        if (this.motion?.token !== token) return false;
        if (scheduledAt != null && this.now() - (started + scheduledAt * 1000) > MOTION_LATE_MS) {
          fail('Motion Control stopped: a move left late');
          return false;
        }
        const pose = livePose();
        if (!pose) {
          fail('Motion Control stopped: lost gimbal feedback');
          return false;
        }
        const frame = moveFrame(move, wire, pose);
        if (!frame) {
          fail('Motion Control stopped: a point is out of reach');
          return false;
        }
        this.feed.lastGimbalThrowAt = this.now();
        return this.gimbalSend(frame);
      };
      const at = (seconds: number, fn: () => void) => motion.timers.push(this.clock.setTimeout(fn, Math.max(0, started + seconds * 1000 - this.now())));

      for (const move of plan.approach) at(move.at, () => dispatch(move, move.at));
      at(plan.takeStart - 0.5, () => {
        const pose = this.currentWaypoint();
        if (!pose || !arrived(pose, program.a!)) fail('Motion Control stopped: the gimbal did not reach A');
      });
      at(plan.takeStart, () => {
        if (this.motion?.token !== token) return;
        this.syncProgramState({ status: 'running', progress: 0 });
        motion.interval = this.clock.setInterval(() => {
          if (this.motion?.token !== token) return;
          const t = (this.now() - started) / 1000 - plan.takeStart;
          this.patch((s) => ({ ...s, gimbal: { ...s.gimbal, program: { ...s.gimbal.program, progress: clamp(t / (plan.end - plan.takeStart), 0, 1) } } }));
        }, 200);
        if (plan.smooth) {
          const curve = plan.smooth;
          const stream = this.clock.setInterval(() => {
            if (this.motion?.token !== token) return this.clock.clearInterval(stream);
            const t = (this.now() - started) / 1000 - plan.takeStart;
            if (t >= curve.duration - SMOOTH_INTERVAL_S * 2) {
              this.clock.clearInterval(stream);
              dispatch({ yawDeg: finalPoint.yawDeg, nativePitchDeg: finalPoint.nativePitchDeg ?? 0, durationS: 0.1 }, null);
              return;
            }
            dispatch(smoothMoveAt(curve, t), null);
          }, SMOOTH_INTERVAL_S * 1000);
          motion.timers.push(stream as unknown as Timer);
        }
      });
      for (const move of plan.take) at(move.at, () => dispatch(move, move.at));
      at(plan.end + 0.4, () => {
        if (this.motion?.token !== token) return;
        const pose = this.currentWaypoint();
        const ok = pose != null && arrived(pose, finalPoint);
        this.finishMotion(ok ? null : 'Motion Control finished off the last point');
        this.syncProgramState({ status: 'done', progress: 1, error: ok ? undefined : 'The gimbal stopped short of the last point' });
      });
    });
  }

  private finishMotion(warning: string | null): void {
    const m = this.motion;
    if (!m) return;
    this.motion = null;
    m.timers.forEach((t) => {
      this.clock.clearTimeout(t);
      this.clock.clearInterval(t);
    });
    if (m.interval) this.clock.clearInterval(m.interval);
    const restore = this.prepRestore.restoreNow();
    restore?.frames.forEach((f) => this.gimbalSend(f));
    if (warning) this.notice(warning, 'warning');
    m.resolve();
  }

  /** Stop a running take: native relative-zero stop, restore speed/mode. */
  private cancelMotion(message: string | null): void {
    if (!this.motion) return;
    this.gimbalSend(Commands.gimbalTimedStop());
    this.finishMotion(message);
    if (message) this.syncProgramState({ status: 'failed', progress: 0, error: message });
  }

  // ───────────────────────────── CameraMediaService ─────────────────────────────

  private async enterPlayback(): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ok = await this.sets.submit(Commands.enterPlayback(), true);
      if (ok.kind === 'ok' || this.reducer.status.inPlayback) return true;
      await new Promise<void>((r) => this.clock.setTimeout(r, 120));
    }
    return this.reducer.status.inPlayback;
  }

  /** Collect `0x00/0x27` chunks until the store closes or goes idle (upstream `collect`). */
  private async collectMedia(a: MediaChunkAssembler, counter: number | null, floorS: number, idleS: number, deadline: number): Promise<void> {
    const start = this.now();
    let lastChange = start;
    let lastCount = counter != null ? a.chunkCountFor(counter) : a.chunkCount;
    for (;;) {
      const now = this.now();
      if (now >= deadline || !this.live) return;
      if (counter != null && now - start >= floorS * 1000 && a.didEnd(counter)) return;
      await new Promise<void>((r) => this.clock.setTimeout(r, 50));
      const count = counter != null ? a.chunkCountFor(counter) : a.chunkCount;
      if (count !== lastCount) {
        lastCount = count;
        lastChange = this.now();
      }
      const after = this.now();
      if (after - start >= floorS * 1000 && after - lastChange >= idleS * 1000) return;
    }
  }

  readonly media: CameraMediaService = {
    list: async () => {
      if (!this.live) throw new Error('Connect a camera to browse its media.');
      this.browsing = true;
      this.restStick();
      const entered = await this.enterPlayback();
      this.browseEnteredPlayback = this.browseEnteredPlayback || entered;
      const a = new MediaChunkAssembler();
      this.mediaChunks = a;
      const deadline = this.now() + MEDIA_QUERY_BUDGET_MS;
      try {
        // Newest page per store only: pagination helpers are not ported to src/core.
        this.sendDatalink(Commands.mediaList(MEDIA_SD_COUNTER, MEDIA_NEWEST_SD));
        await this.collectMedia(a, MEDIA_SD_COUNTER, 0.8, 1, deadline);
        this.sendDatalink(Commands.mediaListTrigger());
        await this.collectMedia(a, null, 0.4, 0.2, deadline);
        this.sendDatalink(Commands.mediaList(MEDIA_INTERNAL_COUNTER, MEDIA_NEWEST_INTERNAL));
        await this.collectMedia(a, MEDIA_INTERNAL_COUNTER, 0.8, 1, deadline);
      } finally {
        if (this.mediaChunks === a) this.mediaChunks = null;
      }
      if (a.chunkCount === 0 && !a.sawEnd) throw new Error('The camera did not send its media list. Try again.');
      const files = MediaManifest.decodeStores(a);
      this.mediaFiles = new Map(files.map((f) => [mediaItemId(f), f]));
      return mediaItemsOf(files);
    },
    setFavorite: async (id, favorite) => {
      const file = this.mediaFiles.get(id);
      if (!file) throw new Error('That clip is no longer on the camera list.');
      const frame = Commands.setMediaFavorite(mediaHandle(file), favorite, this.nextMediaCounter(), this.model);
      const reply = await this.sets.submit(frame, true);
      if (reply.kind !== 'ok') throw new Error('The camera did not star that clip.');
      this.mediaFiles.set(id, { ...file, isStarred: favorite });
    },
    delete: async (ids) => {
      const failed: string[] = [];
      for (const id of ids) {
        const file = this.mediaFiles.get(id);
        if (!file) continue;
        const reply = await this.dlRequest(Commands.deleteMedia(mediaHandle(file), this.nextMediaCounter()), 2000, 'delete media');
        const ok = reply != null && (CameraReplies.isSuccess(CameraReplies.parse(reply.payload)) || (reply.payload[0] === 0 && reply.payload[1] === 0));
        if (ok) this.mediaFiles.delete(id);
        else failed.push(id);
      }
      if (failed.length) throw new Error(`The camera did not delete ${failed.length === 1 ? 'one clip' : `${failed.length} clips`}.`);
    },
    download: async () => {
      throw new Error('Downloading from the camera is not available in this build yet: the camera media file paths are not ported.');
    },
    resumeLive: async () => {
      if (!this.browsing) return;
      const entered = this.browseEnteredPlayback || this.reducer.status.inPlayback;
      // MediaLiveResume: `0x02/0x0c` exit until the playback bit clears, then the captured
      // live start (`0x02/0x68 08` + `0x09/0xa8`). Without playback the feed never stopped.
      for (let attempt = 1; attempt <= 3 && this.reducer.status.inPlayback; attempt++) {
        await this.sets.submit(Commands.exitPlayback(), true);
        await new Promise<void>((r) => this.clock.setTimeout(r, 180));
      }
      this.browsing = false;
      this.browseEnteredPlayback = false;
      if (entered && this.live) this.enableLiveView('media-resume', true);
    },
  };

  private nextMediaCounter(): number {
    const v = this.mediaActionCounter;
    this.mediaActionCounter = (this.mediaActionCounter + 1) >>> 0 || 1;
    return v;
  }
}
