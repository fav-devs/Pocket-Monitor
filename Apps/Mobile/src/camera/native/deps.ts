/**
 * The seam between `NativeCameraSession` and the outside world. The session never imports a
 * native module, a store or secure storage directly: `createNativeSession()` wires the real ones,
 * tests pass fakes. Everything here is types only.
 */
import type {
  PocketBluetoothNativeModule,
  PocketDatalinkNativeModule,
  PocketWifiNativeModule,
} from '@modules/pocket-native/src/types';
import type { SavedCamera } from '../types';
import type { SessionClock } from './clock';

export interface NativeCameraIO {
  bluetooth: PocketBluetoothNativeModule;
  wifi: PocketWifiNativeModule;
  datalink: PocketDatalinkNativeModule;
}

/** Camera Wi-Fi passwords (secure storage on phones). */
export interface CredentialStore {
  read(cameraId: string, ssid: string): Promise<string | undefined>;
  save(cameraId: string, ssid: string, password: string): Promise<void>;
  remove(cameraId: string, ssid: string): Promise<void>;
}

/**
 * Optional (additive, Multiview). How a station / hotspot camera is found on the shared network
 * when it has no saved host, or the saved host does not answer. Absent: the session only tries the
 * saved host, exactly as before.
 */
export interface StationDiscovery {
  /** Hosts to look for the camera on, after the saved host (e.g. `candidateHosts` from src/core). */
  candidates(ctx: { hotspot: boolean; localAddress: string | null; savedHost?: string }): string[] | Promise<string[]>;
  /** Accept a host only when the camera's Wi-Fi identity read over the datalink matches BLE's. */
  verifyIdentity?: boolean;
  /** The camera answered (and was identified) at `host`. */
  onHost?(cameraId: string, host: string): void;
  /** Reachability probe per candidate (UDP handshake), ms. Default 1500. */
  probeTimeoutMs?: number;
  /** Probes in flight at once. Default 8. */
  probeWidth?: number;
}

export interface NativeSessionDeps {
  /** Optional (additive): Multiview station discovery. */
  station?: StationDiscovery;
  io: NativeCameraIO;
  credentials: CredentialStore;
  /** Cameras remembered on this device (read-only; the pairing screens own writes). */
  savedCameras(): SavedCamera[];
  /** Monotonic milliseconds. Defaults to `performance.now()` / `Date.now()`. */
  now?: () => number;
  /** Diagnostic journal line (no credentials, no payload bytes). Defaults to a no-op. */
  log?: (line: string) => void;
  /** Random source for handshake ids. Defaults to `Math.random`. */
  random?: () => number;
  /**
   * Optional (additive). Every session timer (watchdog, heartbeat, path poll, stick pump,
   * exchange timeouts, waits) runs on this clock. Defaults to the global JS timers. Server mode
   * passes `sessionClock`, which it moves onto the service's native heartbeat in the background
   * (`./clock.ts`). When given and `now` is not, `now` is `clock.now()`.
   */
  clock?: SessionClock;
}
