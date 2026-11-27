import { useCallback } from 'react';
import { useCameraSession } from '@/camera';
import { usePreferences } from '@/state/preferences';
import { isPhotoMode } from '../format';
import { haptics } from '../haptics';
import { useLiveUi } from '../liveUiStore';

/**
 * Record/shutter behaviour shared by the record button, keyboard and gamepad
 * (`MonitorCaptureButton` + `MonitorCapturePolicy`). Photo modes take a still; video toggles
 * recording, with the optional 3-2-1 countdown and the optional stop confirmation.
 */
export function useRecordControl(notice: (m: string, tone?: 'info' | 'warning' | 'error' | 'success') => void) {
  const session = useCameraSession();

  const capturePhoto = useCallback(() => {
    const s = session.getState();
    if (s.connection.phase !== 'live' || s.recording.capturingStill) return;
    haptics.medium();
    session.control.capturePhoto().catch(() => notice('Could not take the photo', 'error'));
  }, [session, notice]);

  const commitStop = useCallback(() => {
    useLiveUi.getState().set({ stopConfirmOpen: false });
    haptics.heavy();
    session.control.stopRecording().catch(() => notice('Recording did not stop. Check the camera.', 'error'));
  }, [session, notice]);

  const toggle = useCallback(
    (opts?: { skipConfirm?: boolean }) => {
      const s = session.getState();
      if (s.connection.phase !== 'live') return;
      if (isPhotoMode(s.format.shootingMode)) {
        capturePhoto();
        return;
      }
      if (s.recording.countdown != null) return;
      const prefs = usePreferences.getState();
      if (s.recording.recording) {
        if (prefs.confirmStopRecording && !opts?.skipConfirm) {
          useLiveUi.getState().set({ stopConfirmOpen: true });
          return;
        }
        commitStop();
        return;
      }
      haptics.heavy();
      session.control
        .startRecording({ countdown: prefs.recordCountdown })
        .catch(() => notice('Recording did not start. Check the card.', 'error'));
    },
    [session, capturePhoto, commitStop, notice],
  );

  return { toggle, capturePhoto, commitStop };
}
