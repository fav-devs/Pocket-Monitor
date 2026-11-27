/**
 * Server mode network setups (pure). How the camera, this phone and the watchers share a network:
 *
 * - `station` — *Camera on your Wi-Fi* (recommended). The camera joins the home / venue Wi-Fi in
 *   station mode (the pairing flow's Wi-Fi setup); the phone holds the datalink on that LAN and
 *   the watchers are on the same LAN.
 * - `dual` — *Phone on both networks*. Wi-Fi STA/STA concurrency for local-only connections: the
 *   camera SoftAP is a second, local-only connection; the phone's internet Wi-Fi stays up for the
 *   watchers. Offered only when `WifiManager.isStaConcurrencyForLocalOnlyConnectionsSupported()`.
 * - `hotspot` — *Phone hotspot*. The camera (pairing flow's Hotspot setup) and the watchers join
 *   this phone's hotspot. Android has no API to turn the hotspot on for us: the operator does.
 */
import type { CameraNetworkPath, SavedCamera } from '../types';

export type ServerSetup = 'station' | 'dual' | 'hotspot';

export const serverSetupOrder: ServerSetup[] = ['station', 'dual', 'hotspot'];

/** The saved path each setup connects with. */
export const setupPathKind: Record<ServerSetup, CameraNetworkPath['kind']> = {
  station: 'station',
  dual: 'softap',
  hotspot: 'hotspot',
};

export function availableSetups(caps: { staConcurrencyLocalOnly: boolean } | null): ServerSetup[] {
  return serverSetupOrder.filter((s) => s !== 'dual' || !!caps?.staConcurrencyLocalOnly);
}

/** The setup a camera is already prepared for, else the recommended one that is available. */
export function defaultSetup(camera: SavedCamera | null, available: ServerSetup[]): ServerSetup {
  const kind = camera?.path.kind;
  if (kind === 'station' && available.includes('station')) return 'station';
  if (kind === 'hotspot' && available.includes('hotspot')) return 'hotspot';
  if (kind === 'softap' && available.includes('dual')) return 'dual';
  return available[0] ?? 'station';
}

export type SetupReadiness =
  | { ready: true }
  /** Pick (or pair) a camera first. */
  | { ready: false; need: 'camera' }
  /** The camera has no path for this setup yet: run the pairing flow's "Add setup". */
  | { ready: false; need: 'add-setup'; pathKind: CameraNetworkPath['kind'] }
  /** Station: this phone is not on the camera's Wi-Fi. */
  | { ready: false; need: 'join-wifi'; ssid: string };

/**
 * Whether `camera` can be served with `setup`. `phoneSsid` is the phone's current Wi-Fi name
 * (null when unreadable: assume it matches rather than block the operator).
 */
export function setupReadiness(setup: ServerSetup, camera: SavedCamera | null, phoneSsid: string | null): SetupReadiness {
  if (!camera) return { ready: false, need: 'camera' };
  const want = setupPathKind[setup];
  if (camera.path.kind !== want) return { ready: false, need: 'add-setup', pathKind: want };
  if (setup === 'station' && phoneSsid && camera.path.ssid && phoneSsid !== camera.path.ssid) {
    return { ready: false, need: 'join-wifi', ssid: camera.path.ssid };
  }
  return { ready: true };
}

/** A live session can be kept when it already uses the network this setup needs. */
export function sessionFitsSetup(setup: ServerSetup, transport: string, phase: string): boolean {
  if (phase !== 'live' && phase !== 'live-start') return false;
  // Camera Wi-Fi sessions bind the whole app to the camera AP; the relay could not reach the
  // watchers' network, so `dual` always reconnects through its local-only link.
  return (setup === 'station' && transport === 'station') || (setup === 'hotspot' && transport === 'hotspot');
}
