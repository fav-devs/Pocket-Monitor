import { useFocusEffect, useRouter } from 'expo-router';
import { Eye, Film, LayoutGrid, MonitorPlay, Plus, Settings } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCamera, useCameraSession } from '@/camera';
import { modelDisplayName } from '@/camera/defaults';
import type { DiscoveredCamera, SavedCamera } from '@/camera/types';
import { LaunchSplashOverlay } from '@/features/startup/LaunchSplash';
import { appBrand } from '@/features/startup/brand';
import { useSavedCameras } from '@/state/savedCameras';
import { MText, colors, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { ActionMenu } from './components/ActionMenu';
import { CameraCard, type CameraCardItem } from './components/CameraCard';
import { ConfirmDialog, TextPromptDialog } from './components/Dialogs';
import { HeaderIconFace } from './components/HeaderIconButton';
import { GroupTitle, PulseDot } from './components/StatusBits';
import { deleteWifiPassword } from './credentials';
import { pathKindTitle, relativeTime, rssiToBars, savedSubtitle } from './presentation';
import { DEMO_CAMERA, useConnectActions } from './useConnectActions';

const busyPhases = new Set(['scanning', 'bluetooth', 'authorizing', 'wifi-handoff', 'joining-wifi', 'datalink', 'live-start', 'recovering']);

/** Your cameras (`CamerasPage`): saved bodies, nearby sightings, the demo, and the way to pair. */
export default function CamerasScreen() {
  const router = useRouter();
  const session = useCameraSession();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const tablet = Math.min(width, height) >= 600;
  const landscape = width > height;
  const fullLabels = landscape || tablet;

  const saved = useSavedCameras((s) => s.cameras);
  const rename = useSavedCameras((s) => s.rename);
  const remove = useSavedCameras((s) => s.remove);
  const phase = useCamera((s) => s.connection.phase);
  const liveId = useCamera((s) => (s.connection.phase === 'live' ? s.identity?.id ?? null : null));
  const { connectSaved, startDemo } = useConnectActions();

  const [nearby, setNearby] = useState<DiscoveredCamera[]>([]);
  const [scanning, setScanning] = useState(false);
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

  const pairedItem = (camera: SavedCamera, index: number): CameraCardItem => {
    const sighting = seen.get(camera.id);
    const live = liveId === camera.id;
    return {
      id: camera.id,
      name: camera.name,
      subtitle: savedSubtitle(camera),
      badge: live ? 'LIVE' : index === 0 && camera.lastConnectedAt ? 'LAST USED' : undefined,
      status: live ? 'Live now' : sighting ? 'Nearby · ready to connect' : 'Turn the camera on to connect',
      actionTitle: live ? 'Open monitor' : 'Connect',
      primary: index === 0,
      available: !!sighting || live,
      signalBars: sighting ? rssiToBars(sighting.rssi) : undefined,
      details: [
        { title: 'Network', value: camera.path.ssid || pathKindTitle(camera.path.kind) },
        { title: 'Last connected', value: relativeTime(camera.lastConnectedAt) },
      ],
      chips: [{ id: camera.path.kind, title: pathKindTitle(camera.path.kind), active: true, onPress: () => connectSaved(camera) }],
      onAddSetup: () => router.push({ pathname: '/pair', params: { camera: camera.id, step: 'setup' } }),
    };
  };

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: fullLabels ? 12 : 8 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <MText size={8.5} weight="bold" tracking={1.7} color={colors.accent} uppercase numberOfLines={1}>
          {appBrand.name}
        </MText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MText size={tablet ? 24 : 19} weight="semibold" tracking={-0.2} numberOfLines={1} accessibilityRole="header">
            Your cameras
          </MText>
          {scanning ? (
            <View accessible accessibilityLabel="Scanning for cameras" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <PulseDot />
              {fullLabels ? (
                <MText size={9.5} weight="bold" tracking={1.1} color={colors.accent}>
                  SCANNING
                </MText>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
      <ActionMenu
        accessibilityLabel="Open Multiview"
        disabled={busy}
        onPrimary={() => router.push('/multiview')}
        items={[
          { id: 'multiview', title: 'Open Multiview', onPress: () => router.push('/multiview') },
          { id: 'watch', title: 'Watch a feed', onPress: () => router.push('/watcher') },
        ]}
      >
        <HeaderIconFace icon={LayoutGrid} title={fullLabels ? 'Multi-view' : undefined} tablet={tablet} accented />
      </ActionMenu>
      <PressableScale accessibilityLabel="Watch a feed" testID="cameras.watchFeed" onPress={() => router.push('/watcher')}>
        <HeaderIconFace icon={Eye} tablet={tablet} />
      </PressableScale>
      <PressableScale accessibilityLabel="Media library" testID="cameras.media" onPress={() => router.push('/media')}>
        <HeaderIconFace icon={Film} tablet={tablet} />
      </PressableScale>
      <PressableScale accessibilityLabel="Settings" testID="cameras.settings" onPress={() => router.push('/settings')}>
        <HeaderIconFace icon={Settings} tablet={tablet} />
      </PressableScale>
    </View>
  );

  // Two columns on tablets and wide landscape phones, one otherwise.
  const twoColumns = tablet || width >= 700;
  const grid = (cards: React.ReactNode[]) =>
    twoColumns ? (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {cards.map((card, i) => (
          <View key={i} style={{ flexBasis: '45%', flexGrow: 1, maxWidth: cards.length === 1 ? '50%' : undefined }}>
            {card}
          </View>
        ))}
      </View>
    ) : (
      <View style={{ gap: 8 }}>{cards}</View>
    );

  const demoLive = liveId === DEMO_CAMERA.id;
  const demoCard: CameraCardItem = {
    id: DEMO_CAMERA.id,
    name: 'Try the demo camera',
    subtitle: `Simulated ${modelDisplayName(DEMO_CAMERA.model)} · no camera needed`,
    badge: 'DEMO',
    status: demoLive
      ? 'Demo is live'
      : 'Live picture, controls, assists and media from a simulated camera. Nothing is sent anywhere.',
    actionTitle: demoLive ? 'Open monitor' : 'Start demo',
    icon: MonitorPlay,
  };

  const pairButton = (
    <PressableScale
      testID="cameras.pair"
      accessibilityLabel="Pair a new camera"
      disabled={busy}
      onPress={() => router.push('/pair')}
      style={{
        flex: landscape ? 1 : undefined,
        height: 46,
        borderRadius: 11,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 9,
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderWidth: 1,
        borderColor: withAlpha(colors.secondary, 0.22),
      }}
    >
      <Plus size={14} color={colors.text} strokeWidth={2.2} />
      <MText size={13} weight="semibold">
        Pair a new camera
      </MText>
    </PressableScale>
  );

  const sideInset = Math.max(insets.left, insets.right);
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={{
          flex: 1,
          gap: 12,
          paddingTop: insets.top + 14,
          paddingBottom: insets.bottom + 12,
          paddingLeft: (landscape ? sideInset : insets.left) + 18,
          paddingRight: (landscape ? sideInset : insets.right) + 18,
        }}
      >
        {header}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 14, paddingBottom: 2 }} showsVerticalScrollIndicator={false}>
          {sorted.length ? (
            <View style={{ gap: 8 }}>
              <GroupTitle title="Paired" note="tap to reconnect" />
              {grid(
                sorted.map((camera, i) => {
                  const live = liveId === camera.id;
                  return (
                    <CameraCard
                      key={camera.id}
                      item={pairedItem(camera, i)}
                      disabled={busy}
                      onActivate={() => (live ? router.push('/live') : connectSaved(camera))}
                      menuItems={[
                        { id: 'rename', title: 'Rename', onPress: () => setRenameTarget(camera) },
                        { id: 'remove', title: 'Remove', destructive: true, onPress: () => setRemoveTarget(camera) },
                      ]}
                    />
                  );
                }),
              )}
            </View>
          ) : null}
          {unsaved.length ? (
            <View style={{ gap: 8 }}>
              <GroupTitle title="Nearby" note="announcing over Bluetooth" />
              {grid(
                unsaved.map((n) => (
                  <CameraCard
                    key={n.id}
                    disabled={busy}
                    item={{
                      id: n.id,
                      name: n.name,
                      subtitle: modelDisplayName(n.model),
                      status: n.pairable ? 'Needs approval on the camera' : 'Not in pairing mode yet',
                      actionTitle: 'Pair',
                      signalBars: rssiToBars(n.rssi),
                    }}
                    onActivate={() => router.push({ pathname: '/pair', params: { camera: n.id } })}
                  />
                )),
              )}
            </View>
          ) : null}
          {!sorted.length && !unsaved.length ? (
            <View style={{ padding: 16, gap: 8, borderRadius: 13, backgroundColor: colors.surface }}>
              <MText size={15} weight="semibold">
                No cameras saved yet
              </MText>
              <MText size={12} color={colors.muted}>
                Pair a new camera to start monitoring.
              </MText>
            </View>
          ) : null}
          <View style={{ gap: 8 }}>
            <GroupTitle title="Demo" note="no camera needed" />
            {grid([
              <CameraCard
                key="demo"
                item={demoCard}
                disabled={busy}
                onActivate={() => (demoLive ? router.push('/live') : startDemo())}
              />,
            ])}
          </View>
        </ScrollView>
        <View style={{ flexDirection: landscape ? 'row' : 'column', gap: 12 }}>{pairButton}</View>
      </View>

      <TextPromptDialog
        visible={!!renameTarget}
        title="Rename camera"
        message="Give this camera a name you'll recognize."
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
        title="Remove camera?"
        message={`This removes ${removeTarget?.name ?? 'the camera'} from this phone. You can pair it again later.`}
        confirmTitle="Remove"
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
