/**
 * SEAM — server mode ⇄ the watcher relay host (owned by the relay work: `PocketRelay` in
 * modules/pocket-native, `src/camera/watcher`, Settings feed sharing). Server mode does not build a
 * relay of its own; it calls these two functions and reads the status.
 *
 * What runs where while serving with the screen off:
 * - Native (`relay/RelayHost.kt`): listener socket, NSD `_pocket-mon._tcp`, per-watcher send
 *   windows, the GOP cache and forwarding of the camera's encoded access units straight from the
 *   datalink's video sink. No JS timer is involved, so it keeps running in the background.
 * - JS (here): the ≤ 5 Hz host state message (REC tally, format, ISO…). It runs on the session
 *   clock, which server mode moves onto the service's native heartbeat in the background.
 *
 * Left for the relay owner (see the final report): the host's passcode / control settings
 * (Settings feed sharing) are not read here yet — server mode shares an open, view-only feed
 * until that store exists; `RelayHostStatusEvent` has a watcher count but no names (this reads an
 * optional `watcherNames: string[]` if the native status adds one); and in the "phone on both
 * networks" setup the host should listen / advertise on `PocketServerNetworks.relayNetwork()`
 * (Kotlin) — accepted sockets already reply on the interface they arrived on, NSD advertises on
 * every interface.
 */
import { PocketRelay } from '@modules/pocket-native/src/native';
import { createRelayHost, type RelayHostOptions, type RelayHostPort } from './relayHostPort';

export type { RelayHostOptions, RelayHostPort, RelayHostStatus } from './relayHostPort';

/** The app's relay host. */
export const relayHost: RelayHostPort = createRelayHost(PocketRelay);

/** Share `sessionId` (the camera's native video session) with watchers on this network. */
export function startRelayHost(sessionId: string, options: RelayHostOptions = { cameraName: '' }): Promise<void> {
  return relayHost.start(sessionId, options);
}

/** Stop sharing; every watcher is told the host stopped. */
export function stopRelayHost(): void {
  relayHost.stop();
}
