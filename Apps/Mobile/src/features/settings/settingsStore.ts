import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from '@/state/storage';

/**
 * Settings that only the Settings pages read: feed sharing (watcher relay host; a stub until the
 * relay is built), support consent and the cache switch. Operator preferences that live screens
 * read stay in `usePreferences`.
 */
export type BroadcastPriority = 'Lowest delay' | 'Balanced' | 'Steadier picture';

export interface SettingsLocalValues {
  shareThisFeed: boolean;
  watcherPasscode: string;
  controlRequests: boolean;
  broadcastPriority: BroadcastPriority;
  cacheFullResolution: boolean;
  automaticReports: boolean;
}

const defaults: SettingsLocalValues = {
  shareThisFeed: false,
  watcherPasscode: '',
  controlRequests: false,
  broadcastPriority: 'Balanced',
  cacheFullResolution: false,
  automaticReports: false,
};

interface SettingsLocalStore extends SettingsLocalValues {
  set: <K extends keyof SettingsLocalValues>(key: K, value: SettingsLocalValues[K]) => void;
  reset: () => void;
}

export const useSettingsLocal = create<SettingsLocalStore>()(
  persist(
    (set) => ({
      ...defaults,
      set: (key, value) => set({ [key]: value } as Partial<SettingsLocalValues>),
      reset: () => set(defaults),
    }),
    { name: 'pm.settingsLocal.v1', storage: persistStorage },
  ),
);

/** Watcher passcode rule (`MonitorWatcherPasscodeRule`): empty (open feed) or 4…12 characters. */
export function passcodeEntry(text: string): { passcode: string | null; tooShort: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { passcode: '', tooShort: false };
  if (trimmed.length < 4) return { passcode: null, tooShort: true };
  return { passcode: trimmed.slice(0, 12), tooShort: false };
}

export const passcodeTooShortHint = 'At least 4 characters, or empty for an open feed.';
