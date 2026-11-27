import { Stack } from 'expo-router';
import { useContext, useMemo } from 'react';
import { View } from 'react-native';
import { ContentFrameContext, SETTINGS_LIST_WIDTH, useWideLayout } from '@/constants/layout';
import { useTheme } from '@/constants/theme';
import { SettingsNav } from './SettingsNav';

/**
 * Settings pages push over the list like ai-cut's settings stack; every orientation stays allowed.
 * In the wide layout Settings is a split view: the section list stays in a column on the left and
 * the chosen section fills the rest (the tree keeps its shape across the breakpoint).
 */
export default function SettingsLayout() {
  const { colors } = useTheme();
  const wide = useWideLayout();
  const outer = useContext(ContentFrameContext);
  const frame = useMemo(
    () => (wide && outer ? { width: Math.max(0, outer.width - SETTINGS_LIST_WIDTH), height: outer.height } : outer),
    [wide, outer],
  );
  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.background }}>
      {wide ? <SettingsNav /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <ContentFrameContext.Provider value={frame}>
          <Stack screenOptions={{ headerShown: false, animation: wide ? 'none' : undefined, contentStyle: { backgroundColor: colors.background } }} />
        </ContentFrameContext.Provider>
      </View>
    </View>
  );
}

/** A section opened straight from a link still has the list under it to go back to. */
export const unstable_settings = { initialRouteName: 'index' };
