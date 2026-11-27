import { useEffect, useRef } from 'react';
import { useCamera, useCameraSession } from '@/camera';
import { useBackgroundRuntime } from './backgroundStore';
import { backgroundIos, loadBackgroundCapabilities, quietly } from './nativeBackground';

/**
 * Prepares Picture in Picture for the live native video session (decoded frames into an
 * AVSampleBufferDisplayLayer under the live picture) and keeps the auto-start switch in sync.
 * Released when the camera is no longer live or the live screen goes away.
 */
export function usePictureInPictureMonitor(autoStart: boolean) {
  const session = useCameraSession();
  const sessionId = useCamera(() => (session.video.kind === 'native' ? session.video.sessionId : null));
  const keep = useCamera((s) => s.connection.phase === 'live' || s.connection.phase === 'recovering');
  const target = keep ? sessionId : null;
  const prepared = useRef(false);

  useEffect(() => {
    const ios = backgroundIos;
    if (!ios) return;
    void loadBackgroundCapabilities();
    const sub = ios.addListener('onPipState', (pip) => useBackgroundRuntime.getState().set({ pip }));
    return () => {
      sub.remove();
      if (prepared.current) {
        prepared.current = false;
        quietly(ios.pipRelease());
      }
      useBackgroundRuntime.getState().set({ pip: { prepared: false, possible: false, active: false } });
    };
  }, []);

  useEffect(() => {
    quietly(backgroundIos?.setPipAutoStart(autoStart));
  }, [autoStart]);

  useEffect(() => {
    const ios = backgroundIos;
    if (!ios) return;
    // A new id re-prepares in place (native swaps the frame feed); only "no session" releases, so
    // a release can never land after the next prepare.
    if (target) {
      prepared.current = true;
      quietly(ios.pipPrepare(target));
    } else if (prepared.current) {
      prepared.current = false;
      quietly(ios.pipRelease());
    }
  }, [target]);
}
