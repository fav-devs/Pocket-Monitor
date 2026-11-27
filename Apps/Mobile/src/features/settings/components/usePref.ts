import { defaultPreferences, usePreferences, type OperatorPreferences } from '@/state/preferences';

/** One preference as [value, setter], with the default filled in for optional fields. */
export function usePref<K extends keyof OperatorPreferences>(key: K): [NonNullable<OperatorPreferences[K]>, (v: OperatorPreferences[K]) => void] {
  const value = usePreferences((s) => s[key]);
  const set = usePreferences((s) => s.set);
  return [(value ?? defaultPreferences[key]) as NonNullable<OperatorPreferences[K]>, (v) => set(key, v)];
}

/** Resets a list of preferences to their defaults (a card's reset button). */
export function resetPrefs(keys: (keyof OperatorPreferences)[]) {
  const { set } = usePreferences.getState();
  keys.forEach((k) => set(k, defaultPreferences[k]));
}
