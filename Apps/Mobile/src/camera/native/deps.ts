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

export interface NativeSessionDeps {
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
}
