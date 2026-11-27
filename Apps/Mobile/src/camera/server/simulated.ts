/**
 * A simulated server for the web preview (and reviews): the Android service, its heartbeat and
 * a relay host whose watchers come and go. Runs the real `ServerController` against the demo
 * camera, so the Server screen shows the Android UI end to end without a phone.
 */
import type { PocketBackgroundNativeModule, ServerAction, ServerCapabilities, ServerDeviceStatus, ServerNotificationStatus, ServerPrimaryWifi } from '@modules/pocket-native/src/types';
import type { RelayHostOptions, RelayHostPort, RelayHostStatus } from './relayHostPort';

type Listener = (e: never) => void;

export function createSimulatedBackground(): PocketBackgroundNativeModule & { notification: ServerNotificationStatus | null } {
  const listeners = new Map<string, Set<Listener>>();
  let serving = false;
  let tick: ReturnType<typeof setInterval> | null = null;
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((l) => (l as (e: unknown) => void)(payload));
  const api = {
    notification: null as ServerNotificationStatus | null,
    capabilities: (): ServerCapabilities => ({
      sdk: 36,
      staConcurrencyLocalOnly: true,
      notificationsAllowed: true,
      bluetoothAllowed: true,
      ignoringBatteryOptimizations: false,
      serving,
    }),
    requestPermissions: async () => ({ notifications: true, bluetooth: true }),
    startServer: async (status: ServerNotificationStatus) => {
      api.notification = status;
      if (serving) return;
      serving = true;
      tick = setInterval(() => emit('onTick', { at: Date.now() }), 100);
      emit('onServerState', { running: true, reason: null });
    },
    updateServer: (status: ServerNotificationStatus) => {
      api.notification = status;
    },
    stopServer: async () => {
      if (!serving) return;
      serving = false;
      if (tick) clearInterval(tick);
      tick = null;
      api.notification = null;
      emit('onServerState', { running: false, reason: null });
    },
    isServing: () => serving,
    joinLocalOnly: async () => ({ joined: true, outcome: 'joined' as const }),
    leaveLocalOnly: async () => {},
    localOnlyAddress: async () => '192.168.2.20',
    primaryWifi: async (): Promise<ServerPrimaryWifi> => ({ ssid: 'Studio', address: '192.168.1.24', prefixLength: 24, internet: true }),
    findCameraHosts: async () => ['192.168.1.40'],
    deviceStatus: (): ServerDeviceStatus => ({ batteryPercent: 82, charging: true, plugged: true, thermal: 'none' }),
    addListener: ((event: string, cb: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(cb);
      listeners.set(event, set);
      return { remove: () => set.delete(cb) };
    }) as PocketBackgroundNativeModule['addListener'],
    /** Preview only: press a notification action. */
    press: (action: ServerAction) => emit('onAction', { action }),
  };
  return api;
}

const PREVIEW_WATCHERS = ['iPad', 'Desk', 'Director'];

/** A relay host whose watchers join one by one (preview). */
export function createSimulatedRelay(): RelayHostPort {
  const idle: RelayHostStatus = { state: 'off', watchers: 0, names: [], holder: null, joinable: false, sessionId: null };
  let status = idle;
  const listeners = new Set<(s: RelayHostStatus) => void>();
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  const set = (next: RelayHostStatus) => {
    status = next;
    listeners.forEach((l) => l(status));
  };
  return {
    available: true,
    status: () => status,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async start(sessionId: string, _options: RelayHostOptions) {
      if (status.sessionId === sessionId) return;
      timers.forEach(clearTimeout);
      set({ ...idle, state: 'advertising', sessionId, joinable: true, holder: 'Host' });
      timers = [1500, 4000].map((ms, i) =>
        setTimeout(() => {
          const names = PREVIEW_WATCHERS.slice(0, i + 1);
          set({ ...status, watchers: names.length, names });
        }, ms),
      );
    },
    stop() {
      timers.forEach(clearTimeout);
      timers = [];
      set(idle);
    },
  };
}
