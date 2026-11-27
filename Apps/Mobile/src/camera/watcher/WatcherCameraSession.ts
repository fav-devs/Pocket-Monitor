/**
 * A watcher's camera session (`CameraSession.kind === 'watcher'`): another phone's shared feed on
 * the same camera Wi-Fi. It never opens BLE or a camera datalink.
 *
 * - Picture: the native relay client publishes the host's access units into the video sink
 *   registry under `video.sessionId`, so `<LivePicture>` (PocketVideoView) decodes them like a
 *   camera feed. Assists run locally on that picture.
 * - State: the host's hello / state / control-token messages are folded into `CameraState`
 *   (`stateFromRelay`), with `connection.transport = 'watcher'`.
 * - Recovery: `WatcherRelayRecovery` (bounded 1/2/4 s retries, join and silence deadlines). A
 *   passcode refusal stops and asks; an explicit host stop fails with its reason.
 * - Control: once the host grants the token, record, tap focus, ISO, shutter, white balance,
 *   colour and zoom are forwarded; everything else is refused with a notice (upstream rule).
 */
import { initialCameraState } from '../defaults';
import type {
  CameraController,
  CameraMediaService,
  CameraSession,
  ConnectOptions,
  GimbalController,
  PictureFrameStats,
  SessionEvent,
  Unsubscribe,
  VideoSource,
} from '../session';
import type { CameraNotice, CameraState, DiscoveredCamera, MotionWaypoint, SavedCamera } from '../types';
import {
  connectionPhaseFor,
  controlRefusal,
  hostTitle,
  idleWatcherInfo,
  isoOptionsOf,
  needsDirectLink,
  planColor,
  planFocus,
  planIso,
  planRecord,
  planShutter,
  planWhiteBalance,
  planZoom,
  stateFromRelay,
  type CommandPlan,
  type WatcherInfo,
} from './mapping';
import {
  RelayCopy,
  RELAY_VERSION,
  controlAfterState,
  controlFromToken,
  decodeControlToken,
  decodeHello,
  decodeJoinDenied,
  decodeState,
  encodeCommand,
  encodeHello,
  type RelayState,
} from './protocol';
import { WatcherRelayRecovery } from './recovery';
import type { RelayWatcherMessageEvent, RelayWatcherStatsEvent, RelayWatcherStatusEvent, RelayWatcherTransport } from './transport';

export interface WatcherTarget {
  /** `RelayHostAdvert.id`. */
  hostId: string;
  name: string;
  camera?: string;
}

export interface WatcherSessionOptions {
  transport: RelayWatcherTransport;
  /** Stable per install so a dropped holder can reclaim the control lease within 20 s. */
  watcherId: string;
  /** Monotonic seconds. */
  now?: () => number;
  /** Deadline tick period, ms. */
  tickMs?: number;
}

let sessionCounter = 0;

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

export class WatcherCameraSession implements CameraSession {
  readonly kind = 'watcher' as const;
  readonly video: VideoSource;
  private state: CameraState;
  private info: WatcherInfo = idleWatcherInfo;
  private relayState: RelayState | null = null;
  private readonly listeners = new Set<(s: CameraState) => void>();
  private readonly infoListeners = new Set<(i: WatcherInfo) => void>();
  private readonly eventListeners = new Set<(e: SessionEvent) => void>();
  private readonly transport: RelayWatcherTransport;
  private readonly sessionId: string;
  private readonly watcherId: string;
  private readonly now: () => number;
  private readonly tickMs: number;
  private policy: WatcherRelayRecovery | null = null;
  private target: WatcherTarget | null = null;
  private passcode = '';
  private connectedSocket = false;
  private lastFrames = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: Unsubscribe[] = [];

  constructor(options: WatcherSessionOptions) {
    this.transport = options.transport;
    this.watcherId = options.watcherId;
    this.now = options.now ?? defaultNow;
    this.tickMs = options.tickMs ?? 250;
    this.sessionId = `relay-${++sessionCounter}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.video = { kind: 'relay', sessionId: this.sessionId };
    this.state = { ...initialCameraState(), connection: { ...initialCameraState().connection, transport: 'watcher' } };
  }

  /** The simulated hosts: the picture is the demo scene. */
  get simulated() {
    return this.transport.simulated;
  }

  getState() {
    return this.state;
  }

  subscribe(listener: (state: CameraState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(listener: (event: SessionEvent) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  getWatcherInfo(): WatcherInfo {
    return this.info;
  }

  subscribeWatcher(listener: (info: WatcherInfo) => void): Unsubscribe {
    this.infoListeners.add(listener);
    return () => this.infoListeners.delete(listener);
  }

  // ───────────────────────────── Join ─────────────────────────────

  /** Join a sharing host. A passcode refusal ends in `needs-passcode`; answer with `answerPasscode`. */
  watch(target: WatcherTarget, passcode = ''): void {
    this.stopTimer();
    this.transport.leave(this.sessionId);
    this.target = target;
    this.passcode = passcode.trim();
    this.relayState = null;
    this.lastFrames = 0;
    this.attach();
    this.policy = new WatcherRelayRecovery(this.now());
    this.setInfo({
      ...idleWatcherInfo,
      phase: 'connecting',
      hostName: target.name,
      cameraName: target.camera ?? '',
      title: hostTitle(target.name, target.camera),
    });
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.openSocket();
  }

  answerPasscode(passcode: string): void {
    if (!this.target) return;
    this.watch(this.target, passcode);
  }

  /** Leave cancels pending retries. */
  leave(): void {
    this.policy?.stop();
    this.stopTimer();
    this.transport.leave(this.sessionId);
    this.connectedSocket = false;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.setInfo({ ...idleWatcherInfo });
  }

  private attach() {
    if (this.unsubs.length) return;
    this.unsubs = [
      this.transport.onStatus((e) => e.sessionId === this.sessionId && this.handleStatus(e)),
      this.transport.onMessage((e) => e.sessionId === this.sessionId && this.handleMessage(e)),
      this.transport.onStats((e) => e.sessionId === this.sessionId && this.handleStats(e)),
    ];
  }

  private openSocket() {
    if (!this.target) return;
    this.connectedSocket = true;
    const hello = encodeHello({ version: RELAY_VERSION, hostName: this.transport.deviceName(), passcode: this.passcode || null, watcherID: this.watcherId });
    this.transport.join(this.sessionId, this.target.hostId, hello).catch((e: unknown) => {
      this.socketLost(e instanceof Error ? e.message : 'Could not reach the host.');
    });
  }

  private tick() {
    const policy = this.policy;
    if (!policy) return;
    const now = this.now();
    const action = policy.tick(now);
    if (action === 'reconnect') {
      this.openSocket();
      return;
    }
    if (action === 'exhausted') {
      this.fail(RelayCopy.exhausted);
      return;
    }
    // A deadline passed inside tick: the policy scheduled a retry. Drop the silent socket.
    if (policy.retryAt != null && this.connectedSocket) {
      this.transport.leave(this.sessionId);
      this.connectedSocket = false;
      this.enterReconnecting();
    }
  }

  private socketLost(reason: string) {
    const policy = this.policy;
    if (!policy || policy.isStopped) return;
    this.transport.leave(this.sessionId);
    this.connectedSocket = false;
    const action = policy.disconnected(this.now());
    if (action === 'exhausted') {
      this.fail(`${RelayCopy.exhausted}${reason ? ` ${reason}` : ''}`);
      return;
    }
    this.enterReconnecting();
  }

  private enterReconnecting() {
    this.setInfo({ ...this.info, phase: 'reconnecting', attempt: Math.max(1, this.policy?.retryCount ?? 1), control: this.info.control === 'not-offered' ? 'not-offered' : 'available', holder: '' });
  }

  private fail(message: string) {
    this.policy?.stop();
    this.stopTimer();
    this.transport.leave(this.sessionId);
    this.connectedSocket = false;
    this.setInfo({ ...this.info, phase: 'failed', error: message, control: 'not-offered', holder: '' });
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ───────────────────────────── Transport events ─────────────────────────────

  private handleStatus(e: RelayWatcherStatusEvent) {
    if (e.state !== 'closed') return;
    if (this.info.phase === 'needs-passcode' || this.info.phase === 'failed' || this.info.phase === 'idle') return;
    this.socketLost(e.error ?? '');
  }

  private handleMessage(e: RelayWatcherMessageEvent) {
    const policy = this.policy;
    if (!policy || policy.isStopped) return;
    const now = this.now();
    switch (e.kind) {
      case 'hello': {
        const hello = decodeHello(e.json);
        if (!hello) return this.socketLost('The host sent a message this build cannot read.');
        if (hello.version !== RELAY_VERSION) return this.fail(RelayCopy.versionMismatch);
        policy.connected(now);
        const cameraName = hello.cameraName ?? this.info.cameraName;
        this.setInfo({ ...this.info, phase: 'live', error: null, attempt: 0, hostName: hello.hostName, cameraName, title: hostTitle(hello.hostName, cameraName) });
        return;
      }
      case 'state': {
        const state = decodeState(e.json);
        if (!state) return;
        policy.received(now);
        this.relayState = state;
        this.setState(stateFromRelay(this.state, state, { hostName: this.info.hostName, cameraName: this.info.cameraName }));
        const cameraName = state.cameraName || this.info.cameraName;
        this.setInfo({
          ...this.info,
          cameraName,
          title: hostTitle(this.info.hostName, cameraName),
          control: controlAfterState(this.info.control, state.allowsControlRequests),
          options: {
            iso: isoOptionsOf(state),
            shutter: state.controlOptions?.shutterDenominators ?? [],
            zoom: (state.controlOptions?.zoomHundredths ?? []).map((h) => h / 100),
          },
        });
        return;
      }
      case 'token': {
        const token = decodeControlToken(e.json);
        if (!token) return;
        policy.received(now);
        const next = controlFromToken(token, this.info.control === 'requested', this.info.hostName);
        const allows = this.relayState?.allowsControlRequests ?? true;
        const control = next.control === 'available' && !allows ? 'not-offered' : next.control;
        if (control === 'held' && this.info.control !== 'held') this.notice('You have control', 'success');
        if (this.info.control === 'held' && control !== 'held') this.notice('Control returned to the host');
        this.setInfo({ ...this.info, control, holder: next.holder });
        return;
      }
      case 'denied': {
        const denied = decodeJoinDenied(e.json);
        if (!denied) return this.socketLost('');
        if (denied.passcodeRequired) {
          policy.stop();
          this.stopTimer();
          this.transport.leave(this.sessionId);
          this.connectedSocket = false;
          this.setInfo({ ...this.info, phase: 'needs-passcode', error: this.passcode ? denied.reason : null, control: 'not-offered', holder: '' });
        } else {
          this.fail(denied.reason || RelayCopy.hostStopped);
        }
        return;
      }
    }
  }

  private handleStats(e: RelayWatcherStatsEvent) {
    const policy = this.policy;
    if (!policy || policy.isStopped) return;
    if (e.frames > this.lastFrames) policy.received(this.now(), true);
    this.lastFrames = e.frames;
    this.setInfo({ ...this.info, receivedFps: Math.round(e.framesPerSec) });
    const c = this.state.connection;
    this.setState({
      ...this.state,
      connection: {
        ...c,
        videoKbps: Math.round(e.kbps),
        videoFps: c.videoFps > 0 ? c.videoFps : e.framesPerSec,
        lastFrameAgeMs: e.lastFrameAgeMs >= 0 ? e.lastFrameAgeMs : c.lastFrameAgeMs,
        streamCodec: e.codec ?? c.streamCodec,
      },
    });
  }

  notePictureStats(stats: PictureFrameStats): void {
    const c = this.state.connection;
    this.setState({
      ...this.state,
      connection: {
        ...c,
        videoFps: stats.presentedFps,
        lastFrameAgeMs: stats.lastFrameAgeMs,
        streamWidth: stats.width && stats.width > 1 ? stats.width : c.streamWidth,
        streamHeight: stats.height && stats.height > 1 ? stats.height : c.streamHeight,
      },
    });
  }

  // ───────────────────────────── State ─────────────────────────────

  private setInfo(next: WatcherInfo) {
    this.info = next;
    const c = this.state.connection;
    const phase = connectionPhaseFor(next.phase);
    const detail =
      next.phase === 'connecting'
        ? `Joining ${next.hostName}`
        : next.phase === 'reconnecting'
          ? `Reconnecting ${next.attempt} of ${WatcherRelayRecovery.maximumRetries}`
          : next.phase === 'needs-passcode'
            ? 'Passcode needed'
            : undefined;
    const error = next.phase === 'failed' ? (next.error ?? undefined) : undefined;
    if (c.phase !== phase || c.detail !== detail || c.error !== error) {
      this.setState({ ...this.state, connection: { ...c, phase, detail, error, transport: 'watcher', linkBand: next.phase === 'live' ? 'stable' : 'watch', signalBars: next.phase === 'live' ? 4 : 0 } });
    }
    this.infoListeners.forEach((l) => l(next));
  }

  private setState(next: CameraState) {
    this.state = next;
    this.listeners.forEach((l) => l(next));
  }

  private emit(event: SessionEvent) {
    this.eventListeners.forEach((l) => l(event));
  }

  private notice(message: string, tone: CameraNotice['tone'] = 'info') {
    this.emit({ type: 'notice', notice: { id: `watcher-${Date.now()}-${Math.random()}`, message, tone } });
  }

  // ───────────────────────────── Control lease ─────────────────────────────

  get canControl(): boolean {
    return this.info.phase === 'live' && this.info.control === 'held';
  }

  requestControl(): void {
    if (this.info.phase !== 'live' || this.info.control !== 'available') return;
    this.transport.requestControl(this.sessionId);
    this.setInfo({ ...this.info, control: 'requested' });
  }

  releaseControl(): void {
    if (!this.canControl) return;
    this.transport.releaseControl(this.sessionId);
  }

  /** Commands need the live token at send time; otherwise ask for it (once) or say why not. */
  private run(plan: CommandPlan): Promise<void> {
    if ('quiet' in plan) return Promise.resolve();
    if ('refuse' in plan) {
      this.notice(plan.refuse, 'warning');
      return Promise.resolve();
    }
    if (!this.canControl) {
      const control = this.info.control;
      if (this.info.phase === 'live' && control === 'available') this.requestControl();
      const copy = this.info.phase === 'live' ? controlRefusal(control, this.info.holder) : 'Not connected to the host';
      if (copy) this.notice(copy, control === 'available' ? 'info' : 'warning');
      return Promise.resolve();
    }
    this.transport.sendCommand(this.sessionId, encodeCommand(plan.send));
    return Promise.resolve();
  }

  private refuse(feature: string): Promise<void> {
    this.notice(needsDirectLink(feature), 'warning');
    return Promise.resolve();
  }

  readonly control: CameraController = {
    startRecording: () => this.run(planRecord(true, this.state.recording.recording)),
    stopRecording: () => this.run(planRecord(false, this.state.recording.recording)),
    capturePhoto: () => this.refuse('Photo'),
    setShootingMode: () => this.refuse('Shooting mode'),
    setExposureMode: () => this.refuse('Exposure mode'),
    setIso: (iso) => this.run(planIso(iso, this.relayState)),
    setIsoLimit: () => this.refuse('ISO limit'),
    setShutter: (denom) => this.run(planShutter(denom, this.relayState)),
    setEv: () => this.refuse('EV'),
    setAperture: () => this.refuse('Aperture'),
    setWhiteBalance: (change) => this.run(planWhiteBalance(change, this.state.whiteBalance)),
    setFormat: (change) => {
      const others = Object.entries(change).filter(([k, v]) => k !== 'colorMode' && v !== undefined);
      if (others.length || !change.colorMode) return this.refuse('Format');
      return this.run(planColor(change.colorMode));
    },
    setFocusMode: () => this.refuse('Focus mode'),
    focusAt: (point) => this.run(planFocus(point)),
    setManualFocus: () => this.refuse('Manual focus'),
    setZoom: (factor) => this.run(planZoom(factor)),
    zoomBy: () => {
      // Continuous zoom has no wire message; the zoom chip's stops still work.
    },
    startTracking: () => this.refuse('Tracking'),
    stopTracking: () => Promise.resolve(),
    setAudio: () => this.refuse('Audio'),
  };

  readonly gimbal: GimbalController = {
    drive: () => {
      // Called continuously while a stick is held; the relay does not carry the gimbal.
    },
    recenter: () => this.refuse('Gimbal'),
    flip: () => this.refuse('Gimbal'),
    setMode: () => this.refuse('Gimbal'),
    setSpeed: () => this.refuse('Gimbal'),
    setLockedAllAxes: () => {
      void this.refuse('Gimbal');
    },
    captureWaypoint: (): Promise<MotionWaypoint> => {
      this.notice(needsDirectLink('Motion Control'), 'warning');
      return Promise.reject(new Error(needsDirectLink('Motion Control')));
    },
    clearWaypoint: () => {},
    configureProgram: () => {},
    runProgram: () => this.refuse('Motion Control'),
    stopProgram: () => {},
    level: () => this.refuse('Gimbal'),
  };

  readonly media: CameraMediaService = {
    list: () => Promise.resolve([]),
    setFavorite: () => this.refuse('Library'),
    delete: () => this.refuse('Library'),
    download: () => Promise.reject(new Error(needsDirectLink('Library'))),
    resumeLive: () => Promise.resolve(),
  };

  // ───────────────────────────── CameraSession plumbing ─────────────────────────────

  /** Watchers do not scan for cameras; the watcher screen browses hosts. */
  startScan(onFound: (cameras: DiscoveredCamera[]) => void): Unsubscribe {
    onFound([]);
    return () => {};
  }

  /** A discovered host passed as a camera: its id is the host id. */
  connect(target: DiscoveredCamera | SavedCamera, _options?: ConnectOptions): Promise<void> {
    this.watch({ hostId: target.id, name: target.name });
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.leave();
    return Promise.resolve();
  }

  retry(): Promise<void> {
    if (this.target) this.watch(this.target, this.passcode);
    return Promise.resolve();
  }
}
