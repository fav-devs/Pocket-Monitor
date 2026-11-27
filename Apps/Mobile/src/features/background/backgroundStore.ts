import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from '@/state/storage';
import type { IosBackgroundCapabilities, PictureInPictureState } from '@modules/pocket-native/src/types';

/** Settings → Operator → Background (iOS). Additive only: persisted. */
export interface BackgroundPreferences {
  /** Lock Screen / Dynamic Island while a camera is live. */
  liveActivity: boolean;
  /** Start Picture in Picture when the app leaves the foreground while live. */
  autoPictureInPicture: boolean;
}

const defaults: BackgroundPreferences = {
  liveActivity: true,
  autoPictureInPicture: true,
};

interface BackgroundPreferencesStore extends BackgroundPreferences {
  set: <K extends keyof BackgroundPreferences>(key: K, value: BackgroundPreferences[K]) => void;
}

export const useBackgroundPreferences = create<BackgroundPreferencesStore>()(
  persist(
    (set) => ({
      ...defaults,
      set: (key, value) => set({ [key]: value } as Partial<BackgroundPreferences>),
    }),
    { name: 'pm.background.v1', storage: persistStorage },
  ),
);

/** Runtime state from the native module (not persisted). */
interface BackgroundRuntime {
  capabilities: IosBackgroundCapabilities | null;
  /** Last `onPipState` (the PiP button reads it). */
  pip: PictureInPictureState;
  set: (patch: Partial<Omit<BackgroundRuntime, 'set'>>) => void;
}

export const useBackgroundRuntime = create<BackgroundRuntime>()((set) => ({
  capabilities: null,
  pip: { prepared: false, possible: false, active: false },
  set: (patch) => set(patch),
}));
