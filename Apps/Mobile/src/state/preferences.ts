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
  /** Show shutter as a cinema angle (180°) instead of a speed (1/50) in video. */
  shutterUsesAngle?: boolean;
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
  // Settings → Motion Control / Input (added by settings; optional with defaults)
  /** Joystick sensitivity 1 (slowest) … 5 (reaches full speed soonest). 4 is the captured feel. */
  stickSensitivity?: number;
  /** On-screen stick size. */
  stickSize?: 'small' | 'medium' | 'large';
  stickInvertPan?: boolean;
  /** Ignore small movements near the centre, percent of throw. */
  stickDeadzonePercent?: number;
  stickResponse?: 'standard' | 'linear' | 'fine';
  /** Which gamepad analog stick pans and tilts. */
  gamepadStick?: 'left' | 'right';
  /** Volume buttons start/stop recording. */
  remoteShutter?: boolean;
  /** Rotate the feed with the phone. */
  autoRotateFeed?: boolean;
  /** Live view: show the camera's timecode beside REC (when the camera reports one). */
  showTimecode?: boolean;
}

export const defaultPreferences: OperatorPreferences = {
  recordCountdown: false,
  confirmStopRecording: false,
  recordHaptics: true,
  shutterUsesAngle: false,
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
  stickSensitivity: 4,
  stickSize: 'medium',
  stickInvertPan: false,
  stickDeadzonePercent: 8,
  stickResponse: 'standard',
  gamepadStick: 'left',
  remoteShutter: false,
  autoRotateFeed: true,
  showTimecode: true,
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
