import { Unlink01Icon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { router, usePathname } from 'expo-router';
import { useRef, type ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { gesturesAvailable } from '@/camera/desktop/gestures';
import { chromeRegion, dragRegion, isHovered } from '@/components/desktop';
import { Icon } from '@/components/icon';
import { ToolbarButton } from '@/components/page-toolbar';
import { SETTINGS_LIST_WIDTH, TOOLBAR_HEIGHT } from '@/constants/layout';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { useGlass, useGlassControl } from '@/features/glass';
import { connectionPhaseLabel } from '@/features/pairing/presentation';
import { useSeeThrough } from '@/features/shell/Sidebar';
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
  const gestures = gesturesAvailable();
  const { material } = useGlass();
  const ref = useRef<ComponentRef<typeof View> | null>(null);
  useSeeThrough(ref, material);
  const card = useGlassControl('card', { radius: 12 });

  const open = (id: SettingsSectionId) => {
    if (id !== selected) router.replace(`/settings/${id}`);
  };
  const disconnect = () => {
    session.disconnect().catch(() => {});
    router.dismissTo('/');
  };

  return (
    <View ref={ref} style={[styles.column, material && styles.clear]} {...chromeRegion()}>
      <View style={styles.head} {...dragRegion('deep')}>
        <Text accessibilityRole="header" style={styles.heading}>
          Settings
        </Text>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.list}>
        <View {...card.props} style={[styles.link, card.on && styles.linkGlass]}>
          <View style={styles.linkRow} accessible accessibilityRole="summary">
            <View style={[styles.dot, { backgroundColor: live ? colors.success : colors.mutedForeground }]} />
            <View style={styles.linkText}>
              <Text numberOfLines={1} style={styles.linkTitle}>
                {live ? (cameraName ?? 'Active link') : 'No camera connected'}
              </Text>
              <Text numberOfLines={1} style={styles.linkMeta}>
                {connectionPhaseLabel(phase)}
              </Text>
            </View>
          </View>
          {live ? (
            <View testID="monitor.system.disconnect" style={styles.disconnect}>
              <ToolbarButton icon={Unlink01Icon} title="Disconnect" onPress={disconnect} destructive glass={false} />
            </View>
          ) : null}
        </View>
        {settingsGroups.map((group) => {
          const ids = visibleSectionIds(group.ids, gestures);
          if (!ids.length) return null;
          return (
            <View key={group.label} style={styles.group}>
              <Text style={styles.groupLabel}>{group.label}</Text>
              {ids.map((id) => {
                const info = sectionInfo(id);
                if (!info) return null;
                return <SectionTab key={id} id={id} title={info.title} icon={info.icon} on={id === selected} onPress={() => open(id)} />;
              })}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function SectionTab({ id, title, icon, on, onPress }: { id: SettingsSectionId; title: string; icon: IconSvgElement; on: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { material } = useGlass();
  const glass = useGlassControl('item', { radius: 9 });
  const glassOn = on && glass.on;
  return (
    <Pressable
      {...(on ? glass.props : material ? { dataSet: { pocketMaterialHover: '' } } : {})}
      testID={`monitor.settings.tab.${title}`}
      accessibilityRole="tab"
      accessibilityLabel={title}
      accessibilityState={{ selected: on }}
      hitSlop={{ top: 3, bottom: 3 }}
      onPress={onPress}
      style={(state) => [styles.item, isHovered(state) && !on && !material && styles.itemHover, on && !glassOn && styles.itemOn]}
    >
      <Icon icon={icon} size={17} color={on ? colors.foreground : colors.mutedForeground} strokeWidth={on ? 1.8 : 1.5} />
      <Text numberOfLines={1} style={[styles.itemLabel, on && styles.itemLabelOn]}>
        {title}
      </Text>
      {id === 'about' ? <Text style={styles.itemValue}>{appVersion()}</Text> : null}
    </Pressable>
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
    clear: { backgroundColor: 'transparent' },
    link: { borderRadius: 12, backgroundColor: colors.surface, paddingVertical: 8 },
    linkGlass: { backgroundColor: 'transparent' },
    linkRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      minHeight: 36,
      paddingHorizontal: 12,
    },
    disconnect: { alignItems: 'flex-start' as const, paddingHorizontal: 4, paddingTop: 2 },
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
