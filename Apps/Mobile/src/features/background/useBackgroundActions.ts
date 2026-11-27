import { useEffect, useRef } from 'react';
import { useCameraSession } from '@/camera';
import { isPhotoMode } from '@/features/live/format';
import { backgroundIos } from './nativeBackground';

/** After an action, re-assert the control's value once the camera had time to answer. */
const CONTROL_SETTLE_MS = 5000;

/**
 * Actions from the Live Activity buttons and the record control (`onAction`, App Intents that run
 * in the app process). Record follows the record button's rules without its sheets: photo modes
 * take a still, no countdown, no stop confirmation (the operator asked explicitly).
 */
export function useBackgroundActions(onDisconnect: () => void) {
  const session = useCameraSession();
  const disconnect = useRef(onDisconnect);
  disconnect.current = onDisconnect;

  useEffect(() => {
    const ios = backgroundIos;
    if (!ios) return;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const sub = ios.addListener('onAction', ({ action }) => {
      if (action === 'disconnect') {
        disconnect.current();
        return;
      }
      const s = session.getState();
      if (s.connection.phase === 'live') {
        if (isPhotoMode(s.format.shootingMode)) {
          if (action === 'record' && !s.recording.capturingStill) session.control.capturePhoto().catch(() => {});
        } else if (action === 'record' && !s.recording.recording && s.recording.countdown == null) {
          session.control.startRecording({ countdown: false }).catch(() => {});
        } else if (action === 'stop' && s.recording.recording) {
          session.control.stopRecording().catch(() => {});
        }
      }
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        const now = session.getState();
        const live = now.connection.phase === 'live' || now.connection.phase === 'recovering';
        ios.setRecordControlState(live, live && now.recording.recording, live ? (now.identity?.name ?? null) : null);
      }, CONTROL_SETTLE_MS);
    });
    return () => {
      sub.remove();
      if (settle) clearTimeout(settle);
    };
  }, [session]);
}
