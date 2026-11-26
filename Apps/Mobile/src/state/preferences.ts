import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './storage';

/**
 * Operator preferences (Settings → Operator / Display / Input). Additive changes only:
 * add a field with a default, never rename one (persisted data would be lost).
 */
export interface OperatorPreferences {
  // Recording
  recordCountdown: boolean;
  confirmStopRecording: boolean;
  recordHaptics: boolean;
  // Display
  keepScreenAwake: boolean;
  hideChromeWhileRecording: boolean;
  showRecordingBorder: boolean;
  hdrChrome: boolean;
  pictureFit: 'fit' | 'fill';
  chromeOpacity: number;
  // Gimbal input
  stickExpo: number;
  stickInvertTilt: boolean;
  stickPictureRelative: boolean;
  doubleTapLevel: boolean;
  directionLock: boolean;
  // Gamepad
  gamepadEnabled: boolean;
  // Head tracking (iOS AirPods)
  headTrackingEnabled: boolean;
  // Tracking
  tapToTrack: boolean;
  tapToFocus: boolean;
  // Diagnostics
  showLinkStats: boolean;
  /** Use the demo camera instead of real hardware (always on for web). */
  demoMode: boolean;
}

export const defaultPreferences: OperatorPreferences = {
  recordCountdown: false,
  confirmStopRecording: false,
  recordHaptics: true,
  keepScreenAwake: true,
  hideChromeWhileRecording: false,
  showRecordingBorder: true,
  hdrChrome: false,
  pictureFit: 'fit',
  chromeOpacity: 1,
  stickExpo: 0.5,
  stickInvertTilt: false,
  stickPictureRelative: true,
  doubleTapLevel: true,
  directionLock: false,
  gamepadEnabled: true,
  headTrackingEnabled: false,
  tapToTrack: true,
  tapToFocus: false,
  showLinkStats: false,
  demoMode: false,
};

interface PreferencesStore extends OperatorPreferences {
  set: <K extends keyof OperatorPreferences>(key: K, value: OperatorPreferences[K]) => void;
  reset: () => void;
}

export const usePreferences = create<PreferencesStore>()(
  persist(
    (set) => ({
      ...defaultPreferences,
      set: (key, value) => set({ [key]: value } as Partial<OperatorPreferences>),
      reset: () => set(defaultPreferences),
    }),
    { name: 'pm.preferences.v1', storage: persistStorage },
  ),
);
