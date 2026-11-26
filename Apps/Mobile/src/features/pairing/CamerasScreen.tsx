import {
  Camera01Icon,
  Delete02Icon,
  EyeIcon,
  FolderVideoIcon,
  GridViewIcon,
  HotspotIcon,
  PencilEdit02Icon,
  PlayIcon,
  PlusSignIcon,
  Router01Icon,
  Settings02Icon,
  Video01Icon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCamera, useCameraSession } from '@/camera';
import { modelDisplayName } from '@/camera/defaults';
import type { CameraNetworkPath, DiscoveredCamera, SavedCamera } from '@/camera/types';
import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { IconChip } from '@/components/icon-chip';
import { SectionTitle } from '@/components/section-title';
import { SettingsGroup, SettingsRow } from '@/components/settings-ui';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { gridColumns, useScreenSize } from '@/constants/layout';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { BrandMark, LaunchSplashOverlay } from '@/features/startup/LaunchSplash';
import { useSavedCameras } from '@/state/savedCameras';
import { CameraTile } from './components/CameraTile';
import { ConfirmDialog, TextPromptDialog } from './components/Dialogs';
import { deleteWifiPassword } from './credentials';
import { pathKindTitle, relativeTime, rssiToBars } from './presentation';
import { DEMO_CAMERA, useConnectActions } from './useConnectActions';

const busyPhases = new Set(['scanning', 'bluetooth', 'authorizing', 'wifi-handoff', 'joining-wifi', 'datalink', 'live-start', 'recovering']);

const GRID_GAP = 10;
const GRID_PAD = 16;
const GRID_MIN_TILE = 160;
/** Tablets get roomier tiles: four across a portrait iPad. */
const GRID_MIN_TILE_LARGE = 200;

const pathIcons: Record<CameraNetworkPath['kind'], IconSvgElement> = {
  softap: Wifi01Icon,
  station: Router01Icon,
  hotspot: HotspotIcon,
};

/** Cameras (`CamerasPage`): saved bodies, nearby sightings, the demo, and the way to pair. */
export default function CamerasScreen() {
  const router = useRouter();
  const session = useCameraSession();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { width, large, landscape } = useScreenSize();

  const saved = useSavedCameras((s) => s.cameras);
  const rename = useSavedCameras((s) => s.rename);
  const remove = useSavedCameras((s) => s.remove);
  const phase = useCamera((s) => s.connection.phase);
  const liveId = useCamera((s) => (s.connection.phase === 'live' ? s.identity?.id ?? null : null));
  const { connectSaved, startDemo } = useConnectActions();

  const [nearby, setNearby] = useState<DiscoveredCamera[]>([]);
  const [scanning, setScanning] = useState(false);
  const [actionsFor, setActionsFor] = useState<SavedCamera | null>(null);
  const [renameTarget, setRenameTarget] = useState<SavedCamera | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SavedCamera | null>(null);

  const busy = busyPhases.has(phase);

  // Discovery runs while this page is in front and nothing is connecting.
  useFocusEffect(
    useCallback(() => {
      if (busy) return;
      setScanning(true);
      const stop = session.startScan((found) => setNearby(found));
      const settle = setTimeout(() => setScanning(false), 8000);
      return () => {
        clearTimeout(settle);
        stop();
        setScanning(false);
      };
    }, [session, busy]),
  );

  const sorted = useMemo(
    () => [...saved].sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0)),
    [saved],
  );
  const savedIds = new Set(saved.map((c) => c.id));
  const unsaved = nearby.filter((n) => !savedIds.has(n.id));
  const seen = new Map(nearby.map((n) => [n.id, n]));

  // Tiles: two across a phone, more on a landscape phone or a tablet.
  const sideLeft = Math.max(insets.left, GRID_PAD);
  const sideRight = Math.max(insets.right, GRID_PAD);
  const inner = width - sideLeft - sideRight;
  const cols = gridColumns(inner, large ? GRID_MIN_TILE_LARGE : GRID_MIN_TILE, GRID_GAP, 2, 6);
  const tileW = Math.floor((inner - GRID_GAP * (cols - 1)) / cols);
  const sideBySide = large || landscape;

  const openCamera = (camera: SavedCamera) => (liveId === camera.id ? router.push('/live') : connectSaved(camera));
  const demoLive = liveId === DEMO_CAMERA.id;

  const cameraActions = (camera: SavedCamera): SheetAction[] => {
    const live = liveId === camera.id;
    return [
      live
        ? { label: 'Open monitor', icon: Video01Icon, onPress: () => router.push('/live') }
        : { label: `Connect over ${pathKindTitle(camera.path.kind)}`, icon: pathIcons[camera.path.kind], onPress: () => connectSaved(camera) },
      {
        label: 'Add setup',
        icon: PlusSignIcon,
        onPress: () => router.push({ pathname: '/pair', params: { camera: camera.id, step: 'setup' } }),
      },
      // Let the action sheet finish closing before the next sheet opens.
      { label: 'Rename', icon: PencilEdit02Icon, onPress: () => setTimeout(() => setRenameTarget(camera), 250) },
      { label: 'Forget camera', icon: Delete02Icon, destructive: true, onPress: () => setTimeout(() => setRemoveTarget(camera), 250) },
    ];
  };

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <BrandMark size={32} />
        <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
          Cameras
        </Text>
      </View>
      <View style={styles.headerRight}>
        {scanning ? (
          <View accessible accessibilityLabel="Scanning for cameras" style={styles.iconBtn}>
            <Spinner size={20} opacity={1} color={colors.mutedForeground} />
          </View>
        ) : null}
        <HeaderButton icon={FolderVideoIcon} label="Media library" testID="cameras.media" onPress={() => router.push('/media')} />
        <HeaderButton icon={PlusSignIcon} label="Pair a new camera" testID="cameras.pair" disabled={busy} onPress={() => router.push('/pair')} />
        <Pressable
          testID="cameras.settings"
          accessibilityRole="button"
          accessibilityLabel="Settings"
          hitSlop={8}
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [styles.avatar, pressed && styles.pressed]}
        >
          <Icon icon={Settings02Icon} size={18} color={colors.foreground} />
        </Pressable>
      </View>
    </View>
  );

  const demoCard = (
    <Pressable
      testID={`cameras.card.${DEMO_CAMERA.id}`}
      accessibilityRole="button"
      accessibilityLabel={demoLive ? 'Open monitor Try the demo camera' : 'Start demo Try the demo camera'}
      disabled={busy}
      onPress={() => (demoLive ? router.push('/live') : startDemo())}
      style={({ pressed }) => [styles.feature, sideBySide && styles.flexCard, busy && styles.disabled, pressed && styles.pressed]}
    >
      <IconChip icon={PlayIcon} size={48} />
      <View style={styles.featureText}>
        <Text numberOfLines={1} style={styles.featureTitle}>
          Try the demo camera
        </Text>
        <Text numberOfLines={2} style={styles.featureDetail}>
          {demoLive ? 'Live' : 'Simulated'}
        </Text>
      </View>
      <View testID={`cameras.action.${DEMO_CAMERA.id}`} style={styles.featureAction}>
        <Text style={styles.featureActionText}>{demoLive ? 'Open monitor' : 'Start demo'}</Text>
      </View>
    </Pressable>
  );

  const moreWays = (
    <View style={sideBySide ? styles.flexCard : null}>
      <SettingsGroup>
        <SettingsRow
          icon={GridViewIcon}
          title="Multiview"
          chevron
          disabled={busy}
          onPress={() => router.push('/multiview')}
        />
        <SettingsRow
          icon={EyeIcon}
          title="Join as watcher"
          chevron
          onPress={() => router.push('/watcher')}
          last
        />
      </SettingsGroup>
    </View>
  );

  return (
    <View style={styles.page}>
      <View style={{ paddingTop: insets.top + spacing.sm, paddingLeft: sideLeft, paddingRight: sideRight }}>{header}</View>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.content,
          { paddingLeft: sideLeft, paddingRight: sideRight, paddingBottom: Math.max(insets.bottom, 12) + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {sorted.length ? (
          <View style={styles.section}>
            <SectionTitle title="Saved" />
            <View style={styles.grid}>
              {sorted.map((camera, i) => {
                const sighting = seen.get(camera.id);
                const live = liveId === camera.id;
                return (
                  <CameraTile
                    key={camera.id}
                    width={tileW}
                    disabled={busy}
                    accessibilityLabel={`${live ? 'Open monitor' : 'Connect'} ${camera.name}`}
                    accessibilityHint={live ? 'Live now' : sighting ? 'Nearby, ready to connect' : 'Turn the camera on to connect'}
                    item={{
                      id: camera.id,
                      name: camera.name,
                      detail: `${modelDisplayName(camera.model)} · ${relativeTime(camera.lastConnectedAt)}`,
                      badge: live
                        ? { label: 'Live', dot: colors.dotPink }
                        : sighting
                          ? { label: 'Nearby', dot: colors.success }
                          : i === 0 && camera.lastConnectedAt
                            ? { label: 'Last used' }
                            : undefined,
                      path: { icon: pathIcons[camera.path.kind], label: camera.path.ssid || pathKindTitle(camera.path.kind) },
                      signalBars: sighting ? rssiToBars(sighting.rssi) : undefined,
                      away: !sighting && !live,
                    }}
                    onPress={() => openCamera(camera)}
                    onMore={() => setActionsFor(camera)}
                  />
                );
              })}
            </View>
          </View>
        ) : null}

        {unsaved.length ? (
          <View style={styles.section}>
            <SectionTitle title="Nearby" dot={colors.primary} />
            <View style={styles.grid}>
              {unsaved.map((n) => (
                <CameraTile
                  key={n.id}
                  width={tileW}
                  disabled={busy}
                  accessibilityLabel={`Pair ${n.name}`}
                  accessibilityHint={n.pairable ? 'Needs approval on the camera' : 'Not in pairing mode yet'}
                  item={{
                    id: n.id,
                    name: n.name,
                    detail: n.pairable ? modelDisplayName(n.model) : 'Not in pairing mode',
                    badge: n.pairable ? { label: 'Pair', dot: colors.primary } : undefined,
                    signalBars: rssiToBars(n.rssi),
                    away: !n.pairable,
                  }}
                  onPress={() => router.push({ pathname: '/pair', params: { camera: n.id } })}
                />
              ))}
            </View>
          </View>
        ) : null}

        {!sorted.length && !unsaved.length ? (
          <View style={styles.empty}>
            <Squircle width={64} height={64} radius={20} color={colors.surface}>
              <Icon icon={Camera01Icon} size={28} color={colors.mutedForeground} />
            </Squircle>
            <Text style={styles.emptyTitle}>No cameras yet</Text>
            <Button title="Pair a camera" icon={PlusSignIcon} size="lg" disabled={busy} onPress={() => router.push('/pair')} style={styles.emptyButton} />
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionTitle title="More ways to monitor" dot={colors.accent} />
          <View style={[styles.extras, sideBySide && styles.extrasRow]}>
            {demoCard}
            {moreWays}
          </View>
        </View>
      </ScrollView>

      <ActionSheet
        visible={actionsFor !== null}
        title={actionsFor?.name ?? ''}
        onClose={() => setActionsFor(null)}
        actions={actionsFor ? cameraActions(actionsFor) : []}
      />
      <TextPromptDialog
        visible={!!renameTarget}
        title="Rename camera"
        initialValue={renameTarget?.name ?? ''}
        placeholder="Name"
        onCancel={() => setRenameTarget(null)}
        onSubmit={(name) => {
          if (renameTarget) rename(renameTarget.id, name);
          setRenameTarget(null);
        }}
      />
      <ConfirmDialog
        visible={!!removeTarget}
        title="Forget camera?"
        message={`Removes ${removeTarget?.name ?? 'the camera'} and its Wi-Fi password from this phone.`}
        confirmTitle="Forget"
        destructive
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) {
            remove(removeTarget.id);
            if (removeTarget.path.ssid) deleteWifiPassword(removeTarget.id, removeTarget.path.ssid);
          }
          setRemoveTarget(null);
        }}
      />
      <LaunchSplashOverlay />
    </View>
  );
}

function HeaderButton({
  icon,
  label,
  onPress,
  disabled,
  testID,
}: {
  icon: IconSvgElement;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.iconBtn, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Icon icon={icon} size={22} color={colors.foreground} />
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    page: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingBottom: spacing.md,
      gap: spacing.sm,
    },
    titleRow: { flex: 1, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, minWidth: 0 },
    title: { fontFamily: fonts.semibold, fontSize: 28, letterSpacing: -0.6, color: colors.foreground, flexShrink: 1 },
    headerRight: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md },
    iconBtn: { padding: 4 },
    avatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.surface,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    content: { gap: spacing.xl, paddingTop: spacing.xs },
    section: { gap: spacing.md },
    grid: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: GRID_GAP, rowGap: spacing.md },
    extras: { gap: spacing.md },
    extrasRow: { flexDirection: 'row' as const, alignItems: 'stretch' as const },
    flexCard: { flex: 1, minWidth: 0 },
    feature: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 14,
      padding: spacing.md,
      minHeight: 80,
      borderRadius: radius.lg,
      backgroundColor: colors.surface,
    },
    featureText: { flex: 1, minWidth: 0, gap: 3 },
    featureTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.foreground },
    featureDetail: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mutedForeground },
    featureAction: {
      minHeight: 36,
      paddingHorizontal: 14,
      borderRadius: radius.pill,
      backgroundColor: colors.ink,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    featureActionText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.inkForeground },
    empty: { alignItems: 'center' as const, gap: spacing.sm, paddingVertical: spacing.xl },
    emptyTitle: { fontFamily: fonts.semibold, fontSize: 20, color: colors.foreground, marginTop: spacing.sm },
    emptyButton: { marginTop: spacing.md, minWidth: 220 },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.45 },
  };
}
