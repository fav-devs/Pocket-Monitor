/**
 * Wires `NativeCameraSession` to the real native modules, the saved-camera store and secure
 * credential storage. The only file in src/camera/native that imports app/runtime modules, so the
 * session itself stays testable under vitest with fakes.
 */
import { hasNativeCameraIO, PocketBluetooth, PocketDatalink, PocketWifi } from '@modules/pocket-native/src/native';
import { deleteWifiPassword, readWifiPassword, saveWifiPassword } from '@/features/pairing/credentials';
import { useSavedCameras } from '@/state/savedCameras';
import type { CameraSession } from '../session';
import { NativeCameraSession } from './NativeCameraSession';

/** True when this build links the camera radios (Bluetooth, Wi-Fi join, datalink). Never on web. */
export const nativeSessionAvailable = hasNativeCameraIO;

/** A real-camera session. Throws when the native modules are not linked (web, Expo Go). */
export function createNativeSession(): CameraSession {
  if (!hasNativeCameraIO || !PocketBluetooth || !PocketWifi || !PocketDatalink) {
    throw new Error('Camera radios are not available in this build (web or Expo Go). Use the demo camera.');
  }
  return new NativeCameraSession({
    io: { bluetooth: PocketBluetooth, wifi: PocketWifi, datalink: PocketDatalink },
    credentials: { read: readWifiPassword, save: saveWifiPassword, remove: deleteWifiPassword },
    savedCameras: () => useSavedCameras.getState().cameras,
    log: __DEV__ ? (line) => console.log(`[camera] ${line}`) : undefined,
  });
}
