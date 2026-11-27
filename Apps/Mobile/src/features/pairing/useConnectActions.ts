import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { DemoCameraSession, useCameraSession, useSetCameraSession } from '@/camera';
import type { CameraSession } from '@/camera/session';
import type { DiscoveredCamera, SavedCamera } from '@/camera/types';
import { readWifiPassword } from './credentials';
import { usePendingConnect } from './pairingStore';

export const DEMO_CAMERA: SavedCamera = {
  id: 'demo-camera',
  name: 'Demo camera',
  model: 'osmo-pocket-4-pro',
  path: { kind: 'softap', ssid: 'OsmoPocket4P-DEMO' },
};

/** Starts a connect without awaiting it: the connect screen follows the session's phases. */
function launch(session: CameraSession, target: DiscoveredCamera | SavedCamera, wifiPassword?: string) {
  session.connect(target, wifiPassword ? { wifiPassword } : undefined).catch(() => {
    // The session reports the failure through connection.phase / connection.error.
  });
}

/** Connect entry points shared by Cameras, the pair wizard and Settings. */
export function useConnectActions() {
  const session = useCameraSession();
  const setSession = useSetCameraSession();
  const router = useRouter();
  const begin = usePendingConnect((s) => s.begin);

  const connectSaved = useCallback(
    async (camera: SavedCamera) => {
      begin(camera);
      const password = camera.path.ssid ? await readWifiPassword(camera.id, camera.path.ssid) : undefined;
      launch(session, camera, password);
      router.push('/connect');
    },
    [begin, router, session],
  );

  /** First pair from the wizard: connect the sighting, remember it once it is live. */
  const connectNew = useCallback(
    (sighting: DiscoveredCamera, record: SavedCamera, wifiPassword?: string) => {
      begin(record, { firstPair: true });
      launch(session, sighting, wifiPassword);
      router.replace('/connect');
    },
    [begin, router, session],
  );

  /** "Try the demo camera": always the simulated camera, whatever session the app runs. */
  const startDemo = useCallback(() => {
    let target: CameraSession = session;
    if (session.kind !== 'demo') {
      target = new DemoCameraSession();
      setSession(target);
    }
    begin(DEMO_CAMERA, { demo: true });
    launch(target, DEMO_CAMERA);
    router.push('/connect');
  }, [begin, router, session, setSession]);

  return { connectSaved, connectNew, startDemo };
}
