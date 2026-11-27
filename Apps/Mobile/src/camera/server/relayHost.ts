/**
 * SEAM — server mode ⇄ the watcher relay host (owned by the relay work: `PocketRelay` in
 * modules/pocket-native, `src/camera/watcher`, Settings feed sharing). Server mode does not build a
 * relay of its own; it calls these two functions and reads the status.
 *
 * What runs where while serving with the screen off:
 * - Native (`relay/RelayHost.kt`): listener socket, NSD `_pocket-mon._tcp`, per-watcher send
 *   windows, and the relay picture: the host holds the camera's decoder session (it keeps decoding
 *   with the picture view unmounted) and, while a watcher is attached, re-encodes it with the
 *   hardware HEVC encoder (`relay/RelayEncoder.kt`, keyframe every 2 s and on join). No JS timer is
 *   involved, so it keeps running in the background.
 * - JS (here): the ≤ 5 Hz host state message (REC tally, format, ISO…). It runs on the session
 *   clock, which server mode moves onto the service's native heartbeat in the background.
 *
 * Relay owner: Settings → Feed sharing (passcode, control requests, priority) is merged in by
 * `startRelayHost` and later changes reach the running host through `useFeedSharing`; the native
 * status carries `watcherNames`; on Android the listener binds to
 * `PocketServerNetworks.relayNetwork()` when the phone is on both networks (NSD there on 14+).
 */
import { PocketRelay } from '@modules/pocket-native/src/native';
import { feedSharingHostSettings } from '@/features/watcher/hostSettings';
import { createRelayHost, type RelayHostOptions, type RelayHostPort } from './relayHostPort';

export type { RelayHostOptions, RelayHostPort, RelayHostStatus } from './relayHostPort';

/** The app's relay host. */
export const relayHost: RelayHostPort = createRelayHost(PocketRelay);

/** Share `sessionId` (the camera's native video session) with watchers on this network. */
export function startRelayHost(sessionId: string, options: RelayHostOptions = { cameraName: '' }): Promise<void> {
  // Settings → Feed sharing (passcode, control requests, priority) apply to server mode too; later
  // changes reach the running host through `useFeedSharing` (`updateHost`).
  return relayHost.start(sessionId, { ...feedSharingHostSettings(), ...options });
}

/** Stop sharing; every watcher is told the host stopped. */
export function stopRelayHost(): void {
  relayHost.stop();
}
