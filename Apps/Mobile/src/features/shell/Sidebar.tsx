import {
  Camera01Icon,
  ComputerVideoIcon,
  EyeIcon,
  FolderVideoIcon,
  GridViewIcon,
  ServerStack01Icon,
  Settings02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { router } from 'expo-router';
import { useEffect, useRef, type ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useCamera } from '@/camera';
import { desktopCameraEnabled } from '@/camera/bootstrap';
import { AppLogo } from '@/components/app-logo';
import { chromeRegion, dragRegion, isHovered, macOverlayTitleBar } from '@/components/desktop';
import { Icon } from '@/components/icon';
import { SIDEBAR_WIDTH, TOOLBAR_HEIGHT } from '@/constants/layout';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { useGlass, useGlassControl } from '@/features/glass';
import { connectionPhaseLabel } from '@/features/pairing/presentation';
import { punchThrough } from '@/features/picture/desktop/hole';
import { appBrand } from '@/features/startup/brand';
import { activeDestination, settingsDestination, shellDestinations, type ShellDestination, type ShellDestinationId } from './destinations';

const icons: Record<ShellDestinationId, IconSvgElement> = {
  cameras: Camera01Icon,
  monitor: ComputerVideoIcon,
  media: FolderVideoIcon,
  multiview: GridViewIcon,
  watcher: EyeIcon,
  server: ServerStack01Icon,
  settings: Settings02Icon,
};

const busyPhases = new Set(['scanning', 'bluetooth', 'authorizing', 'wifi-handoff', 'joining-wifi', 'datalink', 'live-start', 'recovering']);

/**
 * Goes to a top-level place the way a sidebar does: back to the Cameras root, then the place on
 * top of it, so history never piles up and Cameras (which follows the desktop launch) stays put.
 */
export function openDestination(href: ShellDestination['href']) {
  router.dismissTo('/');
  if (href !== '/') router.push(href);
}

/**
 * Makes everything under `ref`'s view transparent while `on`, so a window material behind the
 * web view shows through (the view itself keeps its own style). Undone when off or unmounted.
 */
export function useSeeThrough(ref: { current: unknown }, on: boolean) {
  useEffect(() => {
    const node = ref.current as HTMLElement | null;
    if (!on || !node?.parentElement) return;
    return punchThrough(node.parentElement);
  }, [on, ref]);
}

/** The wide layout's sidebar (macOS Finder / System Settings): the app, its places, the link. */
export function Sidebar({ pathname, material = false }: { pathname: string; material?: boolean }) {
  const styles = useThemedStyles(createStyles);
  const active = activeDestination(pathname);
  const phase = useCamera((s) => s.connection.phase);
  const monitorReady = phase === 'live' || phase === 'recovering';
  const places = shellDestinations({ server: !desktopCameraEnabled });
  const ref = useRef<ComponentRef<typeof View> | null>(null);
  useSeeThrough(ref, material);

  return (
    <View ref={ref} style={[styles.sidebar, material && styles.sidebarClear]} accessibilityRole="menu" {...chromeRegion()}>
      {macOverlayTitleBar ? <View style={styles.titleBarStrip} {...dragRegion('self')} /> : null}
      <View style={[styles.brand, macOverlayTitleBar && styles.brandUnderLights]} {...dragRegion('deep')}>
        <AppLogo size={26} />
        <Text numberOfLines={1} style={styles.brandName}>
          {appBrand.name}
        </Text>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.nav} showsVerticalScrollIndicator={false}>
        {places.map((d) => (
          <NavItem
            key={d.id}
            destination={d}
            selected={active === d.id}
            disabled={d.id === 'monitor' && !monitorReady && active !== 'monitor'}
          />
        ))}
      </ScrollView>
      <View style={styles.foot}>
        <NavItem destination={settingsDestination} selected={active === 'settings'} />
        <LinkStatus />
      </View>
    </View>
  );
}

function NavItem({ destination, selected, disabled = false }: { destination: ShellDestination; selected: boolean; disabled?: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { material } = useGlass();
  const glass = useGlassControl('item', { radius: 9 });
  const glassOn = selected && glass.on;
  const tint = selected && !glassOn ? colors.inkForeground : colors.foreground;
  return (
    <Pressable
      {...(selected ? glass.props : material ? { dataSet: { pocketMaterialHover: '' } } : {})}
      testID={`shell.nav.${destination.id}`}
      accessibilityRole="menuitem"
      accessibilityLabel={destination.title}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      hitSlop={{ top: 3, bottom: 3 }}
      onPress={() => {
        if (!selected || destination.id === 'settings') openDestination(destination.href);
      }}
      style={(state) => [
        styles.item,
        isHovered(state) && !selected && !material && styles.itemHover,
        selected && !glassOn && styles.itemOn,
        state.pressed && !selected && styles.itemPressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon icon={icons[destination.id]} size={18} color={tint} strokeWidth={selected ? 1.9 : 1.6} />
      <Text numberOfLines={1} style={[styles.itemLabel, selected && styles.itemLabelOn, glassOn && styles.itemLabelGlass]}>
        {destination.title}
      </Text>
    </Pressable>
  );
}

/** The current camera and its link, compactly; opens the monitor when live. */
function LinkStatus() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const phase = useCamera((s) => s.connection.phase);
  const name = useCamera((s) => s.identity?.name);
  const live = phase === 'live';
  const busy = busyPhases.has(phase);
  const dot = live ? colors.success : busy ? colors.warning : phase === 'failed' ? colors.destructive : colors.mutedForeground;
  const title = live || busy ? (name ?? 'Camera') : 'No camera';
  const detail = connectionPhaseLabel(phase);
  const glass = useGlassControl('card', { radius: 12 });
  return (
    <Pressable
      {...glass.props}
      testID="shell.status"
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${detail}`}
      accessibilityHint={live ? 'Opens the monitor' : 'Opens Cameras'}
      onPress={() => openDestination(live ? '/live' : '/')}
      style={(state) => [
        styles.status,
        glass.on && styles.statusGlass,
        isHovered(state) && !glass.on && styles.itemHover,
        state.pressed && styles.itemPressed,
      ]}
    >
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <View style={styles.statusText}>
        <Text numberOfLines={1} style={styles.statusTitle}>
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.statusMeta}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    flex: { flex: 1 },
    sidebar: {
      width: SIDEBAR_WIDTH,
      backgroundColor: colors.panel,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.border,
    },
    sidebarClear: { backgroundColor: 'transparent' },
    // The traffic lights sit in the default 28 pt title bar; the strip keeps them clear of the brand.
    titleBarStrip: { height: 36 },
    brand: {
      height: TOOLBAR_HEIGHT,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      paddingHorizontal: 18,
    },
    brandUnderLights: { height: 40, paddingTop: 0 },
    brandName: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, letterSpacing: -0.2, color: colors.foreground },
    nav: { paddingHorizontal: 10, paddingTop: spacing.sm, gap: 2 },
    item: {
      height: 38,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      paddingHorizontal: 10,
      borderRadius: 9,
    },
    itemHover: { backgroundColor: colors.surfaceStrong },
    itemOn: { backgroundColor: colors.ink },
    itemPressed: { opacity: 0.8 },
    itemLabel: { flex: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.foreground },
    itemLabelOn: { fontFamily: fonts.semibold, color: colors.inkForeground },
    itemLabelGlass: { color: colors.foreground },
    disabled: { opacity: 0.4 },
    foot: {
      paddingHorizontal: 10,
      paddingTop: spacing.sm,
      paddingBottom: 12,
      gap: 8,
    },
    status: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      minHeight: 48,
      paddingHorizontal: 12,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    statusGlass: { borderWidth: 0, backgroundColor: 'transparent' },
    dot: { width: 8, height: 8, borderRadius: 4 },
    statusText: { flex: 1, minWidth: 0, gap: 1 },
    statusTitle: { fontFamily: fonts.semibold, fontSize: 13, color: colors.foreground },
    statusMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
  };
}
