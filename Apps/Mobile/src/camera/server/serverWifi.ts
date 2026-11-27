/**
 * The Wi-Fi path a server-owned `NativeCameraSession` uses (its `io.wifi`), per setup:
 *
 * - `station`: the phone is already on the camera's Wi-Fi. `join` must not issue a
 *   WifiNetworkSpecifier request for the home network (that would move the phone onto a
 *   local-only copy of it and bind the whole app there); it reports `already-associated` when the
 *   phone's Wi-Fi is that network (or its name is unreadable) and leaves routing alone.
 * - `dual`: the camera SoftAP is a local-only second connection (`PocketBackground.joinLocalOnly`),
 *   never bound to the process, so the relay stays on the primary Wi-Fi.
 * - `hotspot`: the session does not join anything (the camera joins the phone); the default
 *   module is fine.
 */
import type { PocketBackgroundNativeModule, PocketWifiNativeModule, WifiJoinResult } from '@modules/pocket-native/src/types';
import type { ServerSetup } from './setups';

type Background = Pick<PocketBackgroundNativeModule, 'joinLocalOnly' | 'leaveLocalOnly' | 'localOnlyAddress' | 'primaryWifi'>;

export function serverWifi(setup: ServerSetup, base: PocketWifiNativeModule, background: Background): PocketWifiNativeModule {
  if (setup === 'dual') {
    return {
      join: (ssid, password, options) => background.joinLocalOnly(ssid, password, { timeoutMs: options.timeoutMs }),
      leave: () => background.leaveLocalOnly(),
      currentSsid: () => base.currentSsid(),
      localAddress: () => background.localOnlyAddress(),
    };
  }
  if (setup === 'station') {
    return {
      join: async (ssid): Promise<WifiJoinResult> => {
        const primary = await background.primaryWifi().catch(() => null);
        if (!primary) return { joined: false, outcome: 'not-found', message: 'This phone is not on Wi-Fi' };
        if (primary.ssid && primary.ssid !== ssid) {
          return { joined: false, outcome: 'not-found', message: `This phone is on ${primary.ssid}, not ${ssid}` };
        }
        return { joined: true, outcome: 'already-associated' };
      },
      // The home Wi-Fi is the operator's; never drop it.
      leave: async () => {},
      currentSsid: () => base.currentSsid(),
      localAddress: async () => (await background.primaryWifi().catch(() => null))?.address ?? null,
    };
  }
  return base;
}
