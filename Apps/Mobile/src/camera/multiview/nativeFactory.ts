/**
 * Real-camera Multiview tiles: one `NativeCameraSession` per camera on the shared network (the
 * phone's Wi-Fi or its Personal Hotspot), each with its own datalink session id, decoder and
 * watchdog. The camera is provisioned the upstream way inside the session's own spine: Bluetooth
 * pairing, then the station join over BLE (`runStationJoin`), then discovery on the subnet with a
 * Wi-Fi identity check (`deps.station`). Only this file imports native modules for Multiview.
 */
import { hasNativeCameraIO, PocketBluetooth, PocketDatalink, PocketWifi } from '@modules/pocket-native/src/native';
import { candidateHosts, type RestoreResult } from '@/core/multicam';
import { deleteWifiPassword, readWifiPassword, saveWifiPassword } from '@/features/pairing/credentials';
import { useSavedCameras } from '@/state/savedCameras';
import { NativeCameraSession } from '../native/NativeCameraSession';
import type { CameraSession } from '../session';
import type { MultiviewCamera } from './types';

/** Secure-storage key for the shared network's password (one per SSID). */
const NETWORK_KEY = 'multiview-network';

export const multiviewNativeAvailable = hasNativeCameraIO;

/** This phone's current Wi-Fi name, when the platform lets the app read it. */
export async function currentWifiName(): Promise<string | null> {
  if (!PocketWifi) return null;
  return PocketWifi.currentSsid().catch(() => null);
}

export const readNetworkPassword = (ssid: string) => readWifiPassword(NETWORK_KEY, ssid);
export const saveNetworkPassword = (ssid: string, password: string) => saveWifiPassword(NETWORK_KEY, ssid, password);

export interface NativeTileHooks {
  /** Addresses other tiles already use: never probed for this camera. */
  hostsInUse(): string[];
  /** The camera answered at `host`. */
  onHost(cameraId: string, host: string): void;
}

export function createNativeTileSession(_camera: MultiviewCamera, hooks: NativeTileHooks): CameraSession {
  if (!hasNativeCameraIO || !PocketBluetooth || !PocketWifi || !PocketDatalink) {
    throw new Error('Camera radios are not available in this build.');
  }
  return new NativeCameraSession({
    io: { bluetooth: PocketBluetooth, wifi: PocketWifi, datalink: PocketDatalink },
    credentials: { read: readWifiPassword, save: saveWifiPassword, remove: deleteWifiPassword },
    savedCameras: () => useSavedCameras.getState().cameras,
    station: {
      candidates: ({ hotspot, localAddress }) => candidateHosts({ localAddress, hotspot, excluding: hooks.hostsInUse() }),
      verifyIdentity: true,
      onHost: hooks.onHost,
    },
    log: __DEV__ ? (line) => console.log(`[multiview] ${line}`) : undefined,
  });
}

/** Close: the camera returns to its own access point over BLE before its link closes. */
export function restoreNativeAccessPoint(session: CameraSession): Promise<RestoreResult> {
  return session instanceof NativeCameraSession ? session.restoreAccessPoint() : Promise.resolve('restored');
}

/** A camera left on the shared network by an earlier stage: return it with a fresh BLE session. */
export async function returnCameraToOwnWifi(camera: MultiviewCamera): Promise<RestoreResult> {
  const session = createNativeTileSession(camera, { hostsInUse: () => [], onHost: () => {} });
  try {
    if (!(session instanceof NativeCameraSession)) return 'failed';
    return await session.restoreAccessPoint({ id: camera.id, name: camera.name, model: camera.model, rssi: -60, pairable: true, saved: true });
  } finally {
    await session.disconnect().catch(() => {});
  }
}
