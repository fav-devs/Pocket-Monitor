/**
 * Wires `WatcherCameraSession` to the native relay (`PocketRelay`) on phones, or to the simulated
 * hosts on web and in builds without the module. The only file in src/camera/watcher that imports
 * runtime modules, so the session stays testable with fakes.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { PocketRelay } from '@modules/pocket-native/src/native';
import type { PocketRelayNativeModule } from '@modules/pocket-native/src/types';
import { persistStorage } from '@/state/storage';
import type { Unsubscribe } from '../session';
import { DemoRelayTransport } from './demo';
import type { RelayHostsEvent, RelayWatcherTransport } from './transport';
import { WatcherCameraSession } from './WatcherCameraSession';

/** One id per install, so a watcher that drops and returns within 20 s keeps the control lease. */
const useWatcherIdentity = create<{ watcherId: string }>()(
  persist(() => ({ watcherId: `pm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}` }), {
    name: 'pm.watcherIdentity.v1',
    storage: persistStorage,
  }),
);

export function watcherId(): string {
  return useWatcherIdentity.getState().watcherId;
}

/** The native relay as a watcher transport. Browsing is reference-counted across screens. */
class NativeRelayTransport implements RelayWatcherTransport {
  readonly simulated = false;
  private browsers = 0;
  constructor(private readonly relay: PocketRelayNativeModule) {}

  deviceName() {
    try {
      return this.relay.deviceName() || 'Phone';
    } catch {
      return 'Phone';
    }
  }

  browse(onHosts: (event: RelayHostsEvent) => void): Unsubscribe {
    const sub = this.relay.addListener('onHosts', onHosts);
    if (this.browsers++ === 0) this.relay.startBrowse();
    return () => {
      sub.remove();
      if (--this.browsers === 0) this.relay.stopBrowse();
    };
  }

  join(sessionId: string, hostId: string, hello: string) {
    return this.relay.join({ sessionId, hostId, hello });
  }

  leave(sessionId: string) {
    this.relay.leave(sessionId);
  }

  requestControl(sessionId: string) {
    this.relay.requestControl(sessionId);
  }

  releaseControl(sessionId: string) {
    this.relay.releaseControl(sessionId);
  }

  sendCommand(sessionId: string, json: string) {
    this.relay.sendCommand(sessionId, json);
  }

  onStatus(cb: Parameters<RelayWatcherTransport['onStatus']>[0]): Unsubscribe {
    const sub = this.relay.addListener('onWatcherStatus', cb);
    return () => sub.remove();
  }

  onMessage(cb: Parameters<RelayWatcherTransport['onMessage']>[0]): Unsubscribe {
    const sub = this.relay.addListener('onWatcherMessage', cb);
    return () => sub.remove();
  }

  onStats(cb: Parameters<RelayWatcherTransport['onStats']>[0]): Unsubscribe {
    const sub = this.relay.addListener('onWatcherStats', cb);
    return () => sub.remove();
  }
}

let shared: RelayWatcherTransport | null = null;

/** The relay transport for this build: native on phones with the module, simulated otherwise. */
export function relayTransport(): RelayWatcherTransport {
  shared ??= PocketRelay ? new NativeRelayTransport(PocketRelay) : new DemoRelayTransport();
  return shared;
}

/** True when this build can join real hosts (not the simulated list). */
export const nativeRelayAvailable = PocketRelay != null;

export function createWatcherSession(): WatcherCameraSession {
  return new WatcherCameraSession({ transport: relayTransport(), watcherId: watcherId() });
}
