/**
 * What a watcher session needs from the relay transport. The native one wraps `PocketRelay`
 * (modules/pocket-native); `demo.ts` simulates hosts for the web preview and tests.
 */
import type {
  RelayHostAdvert,
  RelayHostsEvent,
  RelayWatcherMessageEvent,
  RelayWatcherStatsEvent,
  RelayWatcherStatusEvent,
} from '@modules/pocket-native/src/types';
import type { Unsubscribe } from '../session';

export type { RelayHostAdvert, RelayHostsEvent, RelayWatcherMessageEvent, RelayWatcherStatsEvent, RelayWatcherStatusEvent };

export interface RelayWatcherTransport {
  /** True for the simulated hosts (web preview). The picture is the demo scene. */
  readonly simulated: boolean;
  deviceName(): string;
  /** Browse while subscribed. */
  browse(onHosts: (event: RelayHostsEvent) => void): Unsubscribe;
  join(sessionId: string, hostId: string, hello: string): Promise<void>;
  /** After this returns, no event of the left connection is delivered. */
  leave(sessionId: string): void;
  requestControl(sessionId: string): void;
  releaseControl(sessionId: string): void;
  sendCommand(sessionId: string, json: string): void;
  onStatus(cb: (e: RelayWatcherStatusEvent) => void): Unsubscribe;
  onMessage(cb: (e: RelayWatcherMessageEvent) => void): Unsubscribe;
  onStats(cb: (e: RelayWatcherStatsEvent) => void): Unsubscribe;
}
