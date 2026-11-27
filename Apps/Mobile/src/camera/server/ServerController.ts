/**
 * Server mode: this phone holds one camera link and relays it to every watcher on the network,
 * with the screen off and the app in the background (Android).
 *
 * Start (only from the Server screen, i.e. in the foreground):
 *   permissions → foreground service (`PocketBackground.startServer`) → the camera session
 *   (kept when the app's live session already uses this setup's network, else a server-owned
 *   session with the setup's Wi-Fi path) → relay host once the camera's video session exists.
 * While serving:
 *   - In the background the shared session clock runs off the service's ~10 Hz native heartbeat
 *     (RN's JS timers are paused there; `src/camera/native/clock.ts`). In the foreground it is the
 *     ordinary JS timers, so single-camera behaviour is unchanged.
 *   - The notification follows the camera (link, watchers, REC with a native chronometer) and its
 *     actions (Record / Stop, Disconnect) act on the session.
 *   - A failed camera link is retried on the session clock (15 s, doubling to 60 s): a box on a
 *     charger has nobody to press Retry.
 *   - The relay host is re-pointed whenever the camera's video session changes (reconnects).
 * Nothing here decodes video: the picture is only mounted by the screen while it is visible.
 *
 * Every dependency is injected (`ServerDeps`) so this runs under vitest and, on web, against the
 * simulated service (`./simulated.ts`).
 */
import type { PocketBackgroundNativeModule, ServerAction, ServerNotificationStatus } from '@modules/pocket-native/src/types';
import type { ClockTimer, SwitchableClock, TickSource } from '../native/clock';
import type { CameraSession } from '../session';
import type { CameraState, SavedCamera } from '../types';
import { notificationChanged, serverNotification } from './notification';
import type { RelayHostPort, RelayHostStatus } from './relayHostPort';
import { sessionFitsSetup, type ServerSetup } from './setups';

export type ServerStatus = 'idle' | 'starting' | 'serving' | 'stopping' | 'failed';

export interface ServerState {
  status: ServerStatus;
  setup: ServerSetup | null;
  cameraId: string | null;
  cameraName: string | null;
  /** Wall-clock ms when serving began. */
  startedAt: number | null;
  error: string | null;
  relay: RelayHostStatus;
  /** App is not in the foreground (session timers on the native heartbeat). */
  backgrounded: boolean;
}

export interface AppStatePort {
  current(): string;
  subscribe(listener: (state: string) => void): () => void;
}

export type ServerBackground = Pick<
  PocketBackgroundNativeModule,
  'requestPermissions' | 'startServer' | 'updateServer' | 'stopServer' | 'addListener'
>;

export interface ServerDeps {
  background: ServerBackground;
  /** The clock every camera session runs on (`sessionClock`). */
  clock: SwitchableClock;
  appState: AppStatePort;
  relay: RelayHostPort;
  /** The app's camera session now. */
  currentSession(): CameraSession | null;
  /** A server-owned session that reaches the camera through `setup`'s network. */
  createSession(setup: ServerSetup, camera: SavedCamera): CameraSession;
  /** Make `session` the app's session (the screens follow it). */
  installSession(session: CameraSession): void;
  /** After stopping: hand the app an ordinary session again if `session` is still installed. */
  releaseSession(session: CameraSession): void;
  readPassword(cameraId: string, ssid: string): Promise<string | undefined>;
  /** Deep link back to the Server screen (notification Open). */
  openUrl: string | null;
  /** Wall clock (ms). */
  wallNow?(): number;
  log?(line: string): void;
}

const RETRY_FIRST_MS = 15_000;
const RETRY_MAX_MS = 60_000;
const LIVE_PHASES = new Set(['live', 'live-start', 'recovering']);

const idleRelay = (relay: RelayHostPort): RelayHostStatus => relay.status();

export const ServerCopy = {
  startRefused: 'Android did not start the server. Open the app and try again.',
  stoppedBySystem: 'Android stopped the server.',
  cameraDisconnected: 'The camera was disconnected.',
} as const;

export class ServerController {
  private state: ServerState;
  private listeners = new Set<(s: ServerState) => void>();
  private wiring: Array<() => void> = [];
  private session: CameraSession | null = null;
  private ownsSession = false;
  private sessionUnsub: (() => void) | null = null;
  private lastNotification: ServerNotificationStatus | null = null;
  private retryTimer: ClockTimer | null = null;
  private retries = 0;
  private run = 0;
  private readonly ticks: TickSource;

  constructor(private readonly deps: ServerDeps) {
    this.state = this.idleState();
    this.ticks = {
      subscribe: (onTick) => {
        const sub = deps.background.addListener('onTick', () => onTick());
        return () => sub.remove();
      },
    };
  }

  getState(): ServerState {
    return this.state;
  }

  subscribe(listener: (s: ServerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get serving(): boolean {
    return this.state.status === 'serving' || this.state.status === 'starting';
  }

  /** The camera session being served (null when idle). */
  get servedSession(): CameraSession | null {
    return this.session;
  }

  async start(setup: ServerSetup, camera: SavedCamera): Promise<void> {
    if (this.serving || this.state.status === 'stopping') return;
    const run = ++this.run;
    this.set({ ...this.idleState(), status: 'starting', setup, cameraId: camera.id, cameraName: camera.name });
    this.log(`server: start setup=${setup} camera=${camera.model}`);
    await this.deps.background.requestPermissions().catch(() => null);
    if (run !== this.run) return;
    this.lastNotification = serverNotification({ cameraName: camera.name, phase: 'scanning', recording: false, elapsedSec: 0, watchers: 0, openUrl: this.deps.openUrl });
    try {
      await this.deps.background.startServer(this.lastNotification);
    } catch (e) {
      if (run !== this.run) return;
      this.log(`server: start refused (${e instanceof Error ? e.message : String(e)})`);
      this.set({ ...this.idleState(), status: 'failed', setup, cameraId: camera.id, cameraName: camera.name, error: ServerCopy.startRefused });
      return;
    }
    if (run !== this.run) return;
    this.wire();

    const current = this.deps.currentSession();
    const cs = current?.getState();
    const adopt =
      !!current && !!cs && current.kind !== 'watcher' && cs.identity?.id === camera.id && sessionFitsSetup(setup, cs.connection.transport, cs.connection.phase);
    const session = adopt ? current! : this.deps.createSession(setup, camera);
    if (!adopt) this.deps.installSession(session);
    this.session = session;
    this.ownsSession = !adopt;
    this.sessionUnsub = session.subscribe((s) => this.onCamera(s));
    this.set({ ...this.state, status: 'serving', startedAt: this.wallNow(), error: null });
    this.log(`server: ${adopt ? 'kept the live session' : 'connecting a server session'}`);
    if (!adopt) {
      const password = camera.path.ssid ? await this.deps.readPassword(camera.id, camera.path.ssid).catch(() => undefined) : undefined;
      if (run !== this.run) return;
      session.connect(camera, password ? { wifiPassword: password } : undefined).catch(() => {
        // Reported through connection.phase; `onCamera` schedules the retry.
      });
    }
    this.onCamera(session.getState());
  }

  /** Stop serving: relay, camera link, service. `reason` leaves the screen showing why. */
  async stop(reason?: string): Promise<void> {
    if (this.state.status === 'idle' || this.state.status === 'stopping') return;
    this.run += 1;
    this.log(`server: stop${reason ? ` (${reason})` : ''}`);
    this.set({ ...this.state, status: 'stopping' });
    this.unwire();
    this.deps.relay.stop();
    this.deps.clock.useTicks(null);
    this.clearRetry();
    const session = this.session;
    this.session = null;
    this.sessionUnsub?.();
    this.sessionUnsub = null;
    // A server-owned session goes (its Wi-Fi path is the server's); a live session the server
    // adopted stays connected for the screens.
    if (session && this.ownsSession) {
      await session.disconnect().catch(() => {});
      this.deps.releaseSession(session);
    }
    this.ownsSession = false;
    this.lastNotification = null;
    await this.deps.background.stopServer().catch(() => {});
    this.set(reason ? { ...this.idleState(), status: 'failed', error: reason } : this.idleState());
  }

  /** Clear a failure message. */
  dismissError(): void {
    if (this.state.status === 'failed') this.set(this.idleState());
  }

  // ─── wiring ───

  private wire(): void {
    const { background, appState, relay } = this.deps;
    const onAppState = (s: string) => {
      const backgrounded = s !== 'active';
      // Foreground: ordinary JS timers. Background: the service heartbeat (RN pauses JS timers).
      this.deps.clock.useTicks(backgrounded ? this.ticks : null);
      if (backgrounded !== this.state.backgrounded) this.set({ ...this.state, backgrounded });
    };
    onAppState(appState.current());
    this.wiring.push(appState.subscribe(onAppState));
    const action = background.addListener('onAction', (e) => void this.onAction(e.action));
    const serverState = background.addListener('onServerState', (e) => {
      if (!e.running && this.serving) void this.stop(e.reason || ServerCopy.stoppedBySystem);
    });
    this.wiring.push(() => action.remove(), () => serverState.remove());
    this.wiring.push(
      relay.subscribe((r) => {
        this.set({ ...this.state, relay: r });
        if (this.session) this.onCamera(this.session.getState());
      }),
    );
  }

  private unwire(): void {
    this.wiring.forEach((u) => u());
    this.wiring = [];
  }

  private async onAction(action: ServerAction): Promise<void> {
    const session = this.session;
    if (!session || !this.serving) return;
    this.log(`server: notification ${action}`);
    if (action === 'disconnect') {
      const adopted = !this.ownsSession;
      await this.stop();
      if (adopted) await session.disconnect().catch(() => {});
      return;
    }
    const control = session.control;
    await (action === 'record' ? control.startRecording() : control.stopRecording()).catch(() => {});
  }

  private onCamera(s: CameraState): void {
    const session = this.session;
    if (!session || this.state.status !== 'serving') return;
    const phase = s.connection.phase;

    if (phase === 'disconnected') {
      // Someone disconnected the camera (Settings, a session swap): nothing left to serve.
      void this.stop(ServerCopy.cameraDisconnected);
      return;
    }

    // Notification: only on a visible change (the REC time is a native chronometer).
    const next = serverNotification({
      cameraName: s.identity?.name ?? this.state.cameraName ?? '',
      phase,
      recording: s.recording.recording,
      elapsedSec: s.recording.elapsedSec,
      watchers: this.state.relay.watchers,
      openUrl: this.deps.openUrl,
    });
    if (notificationChanged(this.lastNotification, next)) {
      this.lastNotification = next;
      try {
        this.deps.background.updateServer(next);
      } catch {
        // Service gone; `onServerState` stops us.
      }
    }

    // Relay: follow the camera's video session (a reconnect makes a new one).
    const video = session.video;
    if (LIVE_PHASES.has(phase) && (video.kind === 'native' || video.kind === 'demo')) {
      const sessionId = video.kind === 'native' ? video.sessionId : 'demo';
      if (this.state.relay.sessionId !== sessionId) {
        void this.deps.relay.start(sessionId, { cameraName: s.identity?.name ?? '', session });
      }
    }

    // A box on a charger has nobody to press Retry.
    if (phase === 'live') {
      this.retries = 0;
      this.clearRetry();
    } else if (phase === 'failed') {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** this.retries);
    this.retries += 1;
    this.log(`server: camera link failed; retry in ${Math.round(delay / 1000)} s`);
    this.retryTimer = this.deps.clock.setTimeout(() => {
      this.retryTimer = null;
      const session = this.session;
      if (!session || this.state.status !== 'serving') return;
      if (session.getState().connection.phase !== 'failed') return;
      session.retry().catch(() => {});
    }, delay);
  }

  private clearRetry(): void {
    this.deps.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // ─── plumbing ───

  private idleState(): ServerState {
    return {
      status: 'idle',
      setup: null,
      cameraId: null,
      cameraName: null,
      startedAt: null,
      error: null,
      relay: idleRelay(this.deps.relay),
      backgrounded: false,
    };
  }

  private set(next: ServerState): void {
    this.state = next;
    this.listeners.forEach((l) => l(next));
  }

  private wallNow(): number {
    return this.deps.wallNow ? this.deps.wallNow() : Date.now();
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}
