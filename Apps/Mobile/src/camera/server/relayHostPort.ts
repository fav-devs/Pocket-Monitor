/**
 * The relay host as server mode drives it (`RelayHostPort`), over the relay owner's native
 * `PocketRelay` host API. No native import here so it runs under vitest; the app's instance and
 * the `startRelayHost` / `stopRelayHost` seam live in `./relayHost.ts`.
 */
import type { PocketRelayNativeModule, RelayHostStatusEvent } from '@modules/pocket-native/src/types';
import { sessionClock, type ClockTimer, type SessionClock } from '../native/clock';
import type { CameraSession } from '../session';
import { encodeState } from '../watcher/protocol';
import { relayStateFromCamera } from '../watcher/mapping';

export interface RelayHostStatus {
  /** `unavailable`: no relay in this build (web, Expo Go, or the native module not linked yet). */
  state: 'off' | 'starting' | 'advertising' | 'stopped' | 'failed' | 'unavailable';
  watchers: number;
  /** Watcher names when the relay reports them (holder / pending at least). */
  names: string[];
  /** Who holds control: "Host" or a watcher name. */
  holder: string | null;
  /** False while no camera keyframe is cached yet. */
  joinable: boolean;
  error?: string | null;
  /** The camera video session being shared. */
  sessionId: string | null;
}

export interface RelayHostOptions {
  cameraName: string;
  /** The camera session whose state is shared with watchers. */
  session?: CameraSession;
}

/** The host as server mode sees it. `createRelayHost(PocketRelay)` is the app's; tests pass fakes. */
export interface RelayHostPort {
  readonly available: boolean;
  start(sessionId: string, options: RelayHostOptions): Promise<void>;
  stop(): void;
  status(): RelayHostStatus;
  subscribe(listener: (s: RelayHostStatus) => void): () => void;
}

const STATE_INTERVAL_MS = 500;

const idle = (available: boolean): RelayHostStatus => ({
  state: available ? 'off' : 'unavailable',
  watchers: 0,
  names: [],
  holder: null,
  joinable: false,
  sessionId: null,
});

export function namesOf(e: RelayHostStatusEvent): string[] {
  const extra = (e as RelayHostStatusEvent & { watcherNames?: unknown }).watcherNames;
  const names = Array.isArray(extra) ? extra.filter((n): n is string => typeof n === 'string' && n.length > 0) : [];
  if (e.holder && e.holder !== 'Host' && !names.includes(e.holder)) names.push(e.holder);
  if (e.pending?.name && !names.includes(e.pending.name)) names.push(e.pending.name);
  return names;
}

export function createRelayHost(relay: PocketRelayNativeModule | null, clock: SessionClock = sessionClock): RelayHostPort {
  let status = idle(relay != null);
  const listeners = new Set<(s: RelayHostStatus) => void>();
  let sub: { remove(): void } | null = null;
  let stateTimer: ClockTimer | null = null;
  let lastState = '';

  const set = (next: RelayHostStatus) => {
    status = next;
    listeners.forEach((l) => l(status));
  };

  const stopState = () => {
    clock.clearInterval(stateTimer);
    stateTimer = null;
    lastState = '';
  };

  return {
    available: relay != null,
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(sessionId, options) {
      if (!relay) return;
      if (status.sessionId === sessionId && (status.state === 'starting' || status.state === 'advertising')) return;
      if (status.sessionId) relay.stopHost(null);
      stopState();
      sub ??= relay.addListener('onHostStatus', (e) => {
        set({
          ...status,
          state: e.state,
          watchers: e.watchers,
          names: namesOf(e),
          holder: e.holder || null,
          joinable: e.joinable,
          error: e.error ?? null,
        });
      });
      set({ ...idle(true), state: 'starting', sessionId });
      try {
        await relay.startHost({
          cameraSessionId: sessionId,
          hostName: '',
          cameraName: options.cameraName,
          passcode: '',
          allowsControl: false,
          window: 2,
        });
      } catch (e) {
        set({ ...status, state: 'failed', error: e instanceof Error ? e.message : String(e) });
        return;
      }
      const session = options.session;
      if (session) {
        const publish = () => {
          const json = encodeState(relayStateFromCamera(session.getState(), false));
          if (json === lastState) return;
          lastState = json;
          try {
            relay.publishHostState(json);
          } catch {
            // Host stopped between ticks.
          }
        };
        publish();
        stateTimer = clock.setInterval(publish, STATE_INTERVAL_MS);
      }
    },
    stop() {
      stopState();
      if (relay && status.sessionId) relay.stopHost('The host stopped sharing.');
      sub?.remove();
      sub = null;
      set(idle(relay != null));
    },
  };
}

