/**
 * A watcher joins the host camera's Wi-Fi from the host's join code (docs/watcher-relay.md "Join
 * and network boundary"). The credentials come from the scanned code and are never stored or logged.
 * Web has no Wi-Fi join: the operator joins in system settings.
 */
import { PocketWifi } from '@modules/pocket-native/src/native';
import type { WifiJoinResult } from '@modules/pocket-native/src/types';

export const watcherWifiJoinAvailable = PocketWifi != null;

export async function joinHostWifi(ssid: string, password: string): Promise<WifiJoinResult> {
  if (!PocketWifi) return { joined: false, outcome: 'failed', message: 'Join the camera Wi-Fi in Settings.' };
  try {
    return await PocketWifi.join(ssid, password, { joinOnce: false, timeoutMs: 20_000 });
  } catch (e) {
    return { joined: false, outcome: 'failed', message: e instanceof Error ? e.message : undefined };
  }
}

export function wifiJoinCopy(result: WifiJoinResult): string | null {
  switch (result.outcome) {
    case 'joined':
    case 'already-associated':
      return null;
    case 'user-denied':
      return 'Wi-Fi join was declined.';
    case 'wrong-password':
      return 'That code’s Wi-Fi password was refused.';
    case 'not-found':
      return 'That camera Wi-Fi is not in range.';
    case 'timeout':
      return 'The camera Wi-Fi did not answer.';
    default:
      return result.message ?? 'Could not join the camera Wi-Fi.';
  }
}
