import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { usePreferences } from '@/state/preferences';

/** Selection pulse for settings controls (`OperatorSettingsHaptics.selection`), when Haptics is on. */
export function settingsFeedback() {
  if (Platform.OS === 'web') return;
  if (!usePreferences.getState().recordHaptics) return;
  Haptics.selectionAsync().catch(() => {});
}

/** `#rrggbb` at an alpha, for soft tints of theme colours. */
export function tint(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
