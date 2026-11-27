import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { usePreferences } from '@/state/preferences';

/** `OperatorHaptics`. No-ops on web and when the operator turned record haptics off. */
export const haptics = {
  light: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  medium: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  heavy: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
  selection: () => fire(() => Haptics.selectionAsync()),
  success: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
};

function fire(run: () => Promise<void>) {
  if (Platform.OS === 'web') return;
  if (!usePreferences.getState().recordHaptics) return;
  try {
    run().catch(() => {});
  } catch {
    // Haptics are a courtesy.
  }
}
