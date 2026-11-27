/**
 * Phones' gestures: whether this build can read hands (`PocketHands`), where the settings live
 * (the app's preferences, `gestureSettings`), and what the runtime shows (the status pill, the
 * record hold, the last gesture's notice).
 *
 * The Gestures page, the gimbal panel's rows and the hand view are the desktop's
 * (`src/camera/desktop/gestures.ts` store): this file registers the phone's settings backend with
 * that store, so they work here unchanged. Inside the desktop app Rust keeps the settings and reads
 * the hands; nothing here runs there.
 */
import { create } from 'zustand';
import { PocketHands } from '@modules/pocket-native/src/native';
import { normaliseAppSettings, setGestureSettingsBackend, useDesktopGestures } from '@/camera/desktop/gestures';
import { isTauri } from '@/camera/desktop/tauri';
import type { PhoneGestureStatus } from './status';
import { usePreferences, type PhoneGesturePreferences } from '@/state/preferences';

function available(): boolean {
  if (!PocketHands || isTauri()) return false;
  try {
    return PocketHands.isAvailable();
  } catch {
    return false;
  }
}

/** This build reads hands itself: a phone with `PocketHands`, or the web demo's made-up hands. */
export const phoneGesturesSupported = available();

/** The phone's gesture settings in the desktop shape the shared pages read. */
export function phoneGestureSettings(prefs: PhoneGesturePreferences | undefined) {
  return normaliseAppSettings({ ...prefs, gestures: !!prefs?.gestures, openCameraAtLaunch: false });
}

if (phoneGesturesSupported) {
  setGestureSettingsBackend({
    sources: ['cameraFeed', 'frontCamera'],
    load: () => phoneGestureSettings(usePreferences.getState().gestureSettings),
    save: (settings) => {
      const next: PhoneGesturePreferences = {
        gestures: settings.gestures,
        gestureMap: settings.gestureMap,
        gestureSource: settings.gestureSource === 'frontCamera' ? 'frontCamera' : 'cameraFeed',
        handControl: settings.handControl,
        stickIsRight: settings.stickIsRight,
        autoFaceTrack: settings.autoFaceTrack,
      };
      usePreferences.getState().set('gestureSettings', next);
    },
  });
  // Preferences load from storage after start-up; the pages follow them.
  usePreferences.subscribe((state, before) => {
    if (state.gestureSettings !== before.gestureSettings) {
      useDesktopGestures.setState({ settings: phoneGestureSettings(state.gestureSettings) });
    }
  });
}

export type { PhoneGestureStatus } from './status';
export { NOTICE_MS, noticeLabel, statusLine } from './status';

export const usePhoneGestures = create<PhoneGestureStatus>()(() => ({
  state: 'off',
  source: 'cameraFeed',
  provider: null,
  ms: null,
  error: null,
  microphone: 'off',
  hold: null,
  notice: null,
}));

