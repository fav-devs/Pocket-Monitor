import type {
  PocketBackgroundIosModule,
  PocketBackgroundNativeModule,
  PocketBluetoothNativeModule,
  PocketDatalinkNativeModule,
  PocketGamepadNativeModule,
  PocketHeadMotionNativeModule,
  PocketRelayNativeModule,
  PocketVideoNativeModule,
  PocketWifiNativeModule,
} from './types';

// Web has no camera I/O. The app runs the demo session; gamepads use the browser Gamepad API
// (src/features/input), not this module.
export const PocketBluetooth: PocketBluetoothNativeModule | null = null;
export const PocketWifi: PocketWifiNativeModule | null = null;
export const PocketDatalink: PocketDatalinkNativeModule | null = null;
export const PocketVideo: PocketVideoNativeModule | null = null;
export const PocketGamepad: PocketGamepadNativeModule | null = null;
export const PocketHeadMotion: PocketHeadMotionNativeModule | null = null;
/** Web has no sockets for the relay: the watcher screen runs its demo hosts instead. */
export const PocketRelay: PocketRelayNativeModule | null = null;
/** Server mode is Android-only; the web preview simulates it (src/camera/server/simulated.ts). */
export const PocketBackground: PocketBackgroundNativeModule | null = null;
/** No Live Activity / Picture in Picture on web. */
export const PocketBackgroundIos: PocketBackgroundIosModule | null = null;
export const hasNativeCameraIO = false;

export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}
