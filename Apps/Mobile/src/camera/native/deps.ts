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

/**
 * Optional (additive). Where camera media lands on this device (expo-file-system on phones,
 * `mediaFileStore.ts`). Paths are relative to the store's area root: `cache` for thumbnails and
 * playback proxies (the OS may purge them), `document` for downloaded originals. Absent (tests,
 * Multiview tiles): thumbnails stay empty and downloads report "not available", as before.
 */
export interface MediaFileStore {
  /** The file when it exists and is not empty. */
  existing(area: MediaFileArea, path: string): { uri: string; size: number } | null;
  /**
   * GET `url` into `path` (written to a `.part` file, renamed when whole). Rejects on a non-2xx
   * answer with the status in the message, on a transport error, and on `signal` abort.
   */
  download(
    url: string,
    area: MediaFileArea,
    path: string,
    options?: { onProgress?: (bytesDone: number, bytesTotal: number) => void; signal?: AbortSignal },
  ): Promise<{ uri: string; size: number }>;
  remove(area: MediaFileArea, path: string): void;
}

export type MediaFileArea = 'cache' | 'document';

export interface NativeSessionDeps {
  /** Optional (additive): camera media files on this device. */
  mediaFiles?: MediaFileStore;
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
