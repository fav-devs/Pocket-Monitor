/**
 * Server mode, wired to the app: the real Android service on Android, a simulated one in the
 * web preview, nothing on iOS (another owner handles iOS background work; the screen says
 * Android-only there).
 */
import * as Linking from 'expo-linking';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { PocketBackground, PocketWifi } from '@modules/pocket-native/src/native';
import type { PocketBackgroundNativeModule } from '@modules/pocket-native/src/types';
import { readWifiPassword } from '@/features/pairing/credentials';
import { useSavedCameras } from '@/state/savedCameras';
import { createDefaultSession, currentCameraSession, replaceCameraSession } from '../CameraProvider';
import { DemoCameraSession } from '../demo/DemoCameraSession';
import { sessionClock } from '../native/clock';
import { createNativeSession } from '../native/createNativeSession';
import type { StationDiscovery } from '../native/deps';
import type { CameraSession } from '../session';
import type { SavedCamera } from '../types';
import { relayHost } from './relayHost';
import { ServerController, type ServerState } from './ServerController';
import { serverWifi } from './serverWifi';
import type { ServerSetup } from './setups';
import { createSimulatedBackground, createSimulatedRelay } from './simulated';

export * from './setups';
export * from './notification';
export { ServerCopy, type ServerState, type ServerStatus } from './ServerController';
export type { RelayHostStatus } from './relayHostPort';

/** `android`: real service. `preview`: web, simulated. `unsupported`: iOS / builds without it. */
export type ServerPlatform = 'android' | 'preview' | 'unsupported';

export const serverPlatform: ServerPlatform =
  Platform.OS === 'android' && PocketBackground != null ? 'android' : Platform.OS === 'web' ? 'preview' : 'unsupported';

const simulated = serverPlatform === 'preview' ? createSimulatedBackground() : null;

/** The service module in use (null on iOS). */
export const serverBackground: PocketBackgroundNativeModule | null = serverPlatform === 'android' ? PocketBackground : simulated;

const POKE_PORT = 7001;

/** Station / hotspot: the camera's address on this phone's networks (saved once found). */
function stationDiscovery(background: PocketBackgroundNativeModule): StationDiscovery {
  return {
    candidates: () => background.findCameraHosts({ port: POKE_PORT, timeoutMs: 300, max: 8 }).catch(() => []),
    verifyIdentity: true,
    onHost: (cameraId, host) => {
      const store = useSavedCameras.getState();
      const camera = store.cameras.find((c) => c.id === cameraId);
      if (camera && camera.path.kind === 'station' && camera.path.host !== host) store.upsert({ ...camera, path: { ...camera.path, host } });
    },
  };
}

function createServerSession(setup: ServerSetup, camera: SavedCamera): CameraSession {
  if (serverPlatform !== 'android' || !PocketBackground || !PocketWifi) return new DemoCameraSession(camera.model);
  return createNativeSession({
    wifi: serverWifi(setup, PocketWifi, PocketBackground),
    station: setup === 'dual' ? undefined : stationDiscovery(PocketBackground),
  });
}

function openUrl(): string | null {
  try {
    return Linking.createURL('/server');
  } catch {
    return null;
  }
}

const noBackground: PocketBackgroundNativeModule = {
  capabilities: () => ({ sdk: 0, staConcurrencyLocalOnly: false, notificationsAllowed: false, bluetoothAllowed: false, ignoringBatteryOptimizations: false, serving: false }),
  requestPermissions: async () => ({ notifications: false, bluetooth: false }),
  startServer: async () => {
    throw new Error('Server mode is Android-only');
  },
  updateServer: () => {},
  stopServer: async () => {},
  isServing: () => false,
  joinLocalOnly: async () => ({ joined: false, outcome: 'failed' }),
  leaveLocalOnly: async () => {},
  localOnlyAddress: async () => null,
  primaryWifi: async () => null,
  findCameraHosts: async () => [],
  deviceStatus: () => ({ batteryPercent: null, charging: false, plugged: false, thermal: 'none' }),
  addListener: (() => ({ remove() {} })) as PocketBackgroundNativeModule['addListener'],
};

export const serverController = new ServerController({
  background: serverBackground ?? noBackground,
  clock: sessionClock,
  appState: {
    current: () => AppState.currentState ?? 'active',
    subscribe: (cb) => {
      const sub = AppState.addEventListener('change', cb);
      return () => sub.remove();
    },
  },
  relay: serverPlatform === 'preview' ? createSimulatedRelay() : relayHost,
  currentSession: currentCameraSession,
  createSession: createServerSession,
  installSession: replaceCameraSession,
  releaseSession: (session) => {
    if (currentCameraSession() === session) replaceCameraSession(createDefaultSession());
  },
  readPassword: readWifiPassword,
  openUrl: openUrl(),
  log: __DEV__ ? (line) => console.log(`[server] ${line}`) : undefined,
});

export function useServer(): ServerState {
  return useSyncExternalStore(
    (cb) => serverController.subscribe(cb),
    () => serverController.getState(),
    () => serverController.getState(),
  );
}

/** The app is in the foreground (screen on, app in front). */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => (AppState.currentState ?? 'active') === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/**
 * False while serving with the app in the background: a picture view should not stay mounted
 * (no decode with the screen off). The Server screen uses it; other pictures can adopt it.
 */
export function usePictureAllowed(): boolean {
  const server = useServer();
  const active = useAppActive();
  return active || (server.status !== 'serving' && server.status !== 'starting');
}
