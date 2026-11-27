import { Unlink01Icon } from '@hugeicons/core-free-icons';
import { router, usePathname } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { gesturesAvailable } from '@/camera/desktop/gestures';
import { chromeRegion, dragRegion, isHovered } from '@/components/desktop';
import { Icon } from '@/components/icon';
import { ToolbarButton } from '@/components/page-toolbar';
import { SETTINGS_LIST_WIDTH, TOOLBAR_HEIGHT } from '@/constants/layout';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { connectionPhaseLabel } from '@/features/pairing/presentation';
import { appVersion } from './diagnostics';
import { sectionFromPath, sectionInfo, settingsGroups, visibleSectionIds, type SettingsSectionId } from './sections';

/**
 * Settings' section list in the wide layout (the split view's second column, like macOS System
 * Settings): the link and Disconnect on top, then every group's sections. The chosen section
 * fills the page next to it.
 */
export function SettingsNav() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const pathname = usePathname();
  const selected = sectionFromPath(pathname);
  const session = useCameraSession();
  const phase = useCamera((s) => s.connection.phase);
  const cameraName = useCamera((s) => s.identity?.name);
  const live = phase === 'live';
  const desktop = gesturesAvailable();

  const open = (id: SettingsSectionId) => {
    if (id !== selected) router.replace(`/settings/${id}`);
  };
  const disconnect = () => {
    session.disconnect().catch(() => {});
    router.dismissTo('/');
  };

  return (
    <View style={styles.column} {...chromeRegion()}>
      <View style={styles.head} {...dragRegion('deep')}>
        <Text accessibilityRole="header" style={styles.heading}>
          Settings
        </Text>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.list}>
        <View style={styles.link} accessible accessibilityRole="summary">
          <View style={[styles.dot, { backgroundColor: live ? colors.success : colors.mutedForeground }]} />
          <View style={styles.linkText}>
            <Text numberOfLines={1} style={styles.linkTitle}>
              {live ? (cameraName ?? 'Active link') : 'No camera connected'}
            </Text>
            <Text numberOfLines={1} style={styles.linkMeta}>
              {connectionPhaseLabel(phase)}
            </Text>
          </View>
          {live ? (
            <View testID="monitor.system.disconnect">
              <ToolbarButton icon={Unlink01Icon} title="Disconnect" onPress={disconnect} destructive />
            </View>
          ) : null}
        </View>
        {settingsGroups.map((group) => {
          const ids = visibleSectionIds(group.ids, desktop);
          if (!ids.length) return null;
          return (
            <View key={group.label} style={styles.group}>
              <Text style={styles.groupLabel}>{group.label}</Text>
              {ids.map((id) => {
                const info = sectionInfo(id);
                if (!info) return null;
                const on = id === selected;
                return (
                  <Pressable
                    key={id}
                    testID={`monitor.settings.tab.${info.title}`}
                    accessibilityRole="tab"
                    accessibilityLabel={info.title}
                    accessibilityState={{ selected: on }}
                    hitSlop={{ top: 3, bottom: 3 }}
                    onPress={() => open(id)}
                    style={(state) => [styles.item, isHovered(state) && !on && styles.itemHover, on && styles.itemOn]}
                  >
                    <Icon icon={info.icon} size={17} color={on ? colors.foreground : colors.mutedForeground} strokeWidth={on ? 1.8 : 1.5} />
                    <Text numberOfLines={1} style={[styles.itemLabel, on && styles.itemLabelOn]}>
                      {info.title}
                    </Text>
                    {id === 'about' ? <Text style={styles.itemValue}>{appVersion()}</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    flex: { flex: 1 },
    column: {
      width: SETTINGS_LIST_WIDTH,
      backgroundColor: colors.background,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.border,
    },
    head: {
      height: TOOLBAR_HEIGHT,
      justifyContent: 'center' as const,
      paddingHorizontal: 20,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    heading: { fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.3, color: colors.foreground },
    list: { paddingHorizontal: 10, paddingTop: 12, paddingBottom: spacing.lg, gap: 14 },
    link: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      minHeight: 52,
      paddingLeft: 12,
      paddingRight: 8,
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
    dot: { width: 8, height: 8, borderRadius: 4 },
    linkText: { flex: 1, minWidth: 0, gap: 1 },
    linkTitle: { fontFamily: fonts.semibold, fontSize: 13, color: colors.foreground },
    linkMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
    group: { gap: 2 },
    groupLabel: {
      fontFamily: fonts.medium,
      fontSize: 12,
      color: colors.mutedForeground,
      paddingHorizontal: 10,
      paddingBottom: 4,
    },
    item: {
      height: 36,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      paddingHorizontal: 10,
      borderRadius: 9,
    },
    itemHover: { backgroundColor: colors.surface },
    itemOn: { backgroundColor: colors.surfaceStrong },
    itemLabel: { flex: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.foreground },
    itemLabelOn: { fontFamily: fonts.semibold },
    itemValue: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
  };
}
