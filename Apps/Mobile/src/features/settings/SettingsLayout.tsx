import { Stack } from 'expo-router';
import { useTheme } from '@/constants/theme';

/** Settings pages push over the list like ai-cut's settings stack; every orientation stays allowed. */
export default function SettingsLayout() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}

/** A section opened straight from a link still has the list under it to go back to. */
export const unstable_settings = { initialRouteName: 'index' };
