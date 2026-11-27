import {
  Add01Icon,
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowShrink02Icon,
  DashboardSquare01Icon,
  GridViewIcon,
  HotspotIcon,
  LayoutLeftIcon,
  Settings02Icon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BackHandler, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraSessionScope, useCameraSession, type CameraNotice, type DiscoveredCamera } from '@/camera';
import { nativeCameraEnabled } from '@/camera/bootstrap';
import { DEMO_MULTIVIEW_CAMERAS, createDemoTileSession } from '@/camera/multiview/demo';
import { MultiviewCoordinator } from '@/camera/multiview/MultiviewCoordinator';
import {
  createNativeTileSession,
  currentWifiName,
  readNetworkPassword,
  restoreNativeAccessPoint,
  returnCameraToOwnWifi,
  saveNetworkPassword,
} from '@/camera/multiview/nativeFactory';
import { cameraFromJournal, lookFor } from '@/camera/multiview/stage';
import { useMultiviewStage } from '@/camera/multiview/stageStore';
import type { MultiviewCamera, MultiviewNetwork } from '@/camera/multiview/types';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { captureTileCount } from '@/features/live/capture/CaptureControlBar';
import { MonitorTransientNotice } from '@/features/live/chrome/MonitorTransientNotice';
import { PillText, RailButton, Slot, VideoPill, onVideo, textShadow } from '@/features/live/chrome/primitives';
import { useLiveUi } from '@/features/live/liveUiStore';
import { MonitorRecordLamp } from '@/features/live/record/LiveRecordButton';
import { usePreferences } from '@/state/preferences';
import { useSavedCameras } from '@/state/savedCameras';
import { addChoices } from './addChoices';
import { FocusedControls } from './FocusedControls';
import { computeMultiviewLayout } from './multiviewLayout';
import { AddCameraSheet, CameraSettingsSheet, ExitSheet, GroupStopSheet } from './MultiviewSheets';
import { MultiviewTile } from './MultiviewTile';

const IDLE = new Set(['idle', 'disconnected', 'failed']);

/** One coordinator for the screen's life; leaving closes every link (cameras keep recording). */
function useCoordinator(native: boolean): MultiviewCoordinator {
  const ref = useRef<MultiviewCoordinator | null>(null);
  if (!ref.current) {
    const c: MultiviewCoordinator = new MultiviewCoordinator({
      createSession: (camera) =>
        native && !camera.demoScene
          ? createNativeTileSession(camera, {
              hostsInUse: () =>
                c
                  .getSnapshot()
                  .tiles.flatMap((t) => (t.camera && t.camera.id !== camera.id && t.camera.path?.host ? [t.camera.path.host] : [])),
              onHost: (id, host) => c.setCameraHost(id, host),
            })
          : createDemoTileSession(camera),
      takesTurn: (camera) => !camera.demoScene,
      connectOptions: async (camera) => (camera.path ? { wifiPassword: await readNetworkPassword(camera.path.ssid) } : undefined),
      restoreAccessPoint: (session) => restoreNativeAccessPoint(session),
      onMembersChanged: (cameras) => useMultiviewStage.getState().members(cameras),
      log: __DEV__ ? (line) => console.log(`[multiview] ${line}`) : undefined,
    });
    ref.current = c;
  }
  useEffect(() => {
    const c = ref.current!;
    c.start();
    return () => c.dispose();
  }, []);
  return ref.current;
}

/** A stage button over black (the monitor is always dark): white primary, translucent secondary. */
function VideoButton({ title, onPress, primary = false, busy = false, testID }: { title: string; onPress: () => void; primary?: boolean; busy?: boolean; testID?: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.videoButton, primary && styles.videoButtonPrimary, pressed && { opacity: 0.75 }]}
    >
      {busy ? <Spinner color={primary ? onVideo.dark : onVideo.ink} opacity={0.3} /> : null}
      <Text style={[styles.videoButtonText, primary && styles.videoButtonTextPrimary]}>{title}</Text>
    </Pressable>
  );
}

/** The group record ring: Record all / Stop all, with each camera's confirmation on its tile. */
function GroupRecordButton({ recording, busy, ready, onPress }: { recording: boolean; busy: boolean; ready: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      testID="multiview.record"
      accessibilityRole="button"
      accessibilityLabel={recording ? 'Stop recording on all cameras' : 'Record on all cameras'}
      accessibilityState={{ disabled: !ready || busy, busy }}
      accessibilityValue={{ text: recording ? 'Recording' : 'Standby' }}
      onPress={busy ? undefined : onPress}
      style={({ pressed }) => ({ opacity: ready || recording ? 1 : 0.4, transform: [{ scale: pressed ? 0.94 : 1 }] })}
    >
      <MonitorRecordLamp recording={recording} photo={false} />
      {busy ? (
        <View pointerEvents="none" style={styles.recordBusy}>
          <Spinner size={22} color={onVideo.ink} opacity={0.35} />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Multiview: up to four cameras on one screen. Each tile is its own camera session with its own
 * look; tap a tile to see it large with that camera's live controls; the ring records on every
 * camera with a per-camera confirmation. On-video chrome after the live monitor.
 */
export default function MultiviewScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const params = useLocalSearchParams<{ demo?: string }>();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const demoMode = usePreferences((p) => p.demoMode);
  const keepAwake = usePreferences((p) => p.keepScreenAwake);
  const confirmStop = usePreferences((p) => p.confirmStopRecording);
  const native = nativeCameraEnabled && !demoMode;
  const appSession = useCameraSession();
  const stage = useMultiviewStage();
  const saved = useSavedCameras((s) => s.cameras);
  const coordinator = useCoordinator(native);
  const snap = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);

  const [notices, setNotices] = useState<CameraNotice[]>([]);
  const pushNotice = useCallback((message: string, tone: CameraNotice['tone'] = 'info') => {
    setNotices((all) => [...all.slice(-2), { id: `${Date.now()}-${Math.random()}`, message, tone }]);
  }, []);
  useEffect(() => coordinator.onNotice((n) => setNotices((all) => [...all.slice(-2), n])), [coordinator]);

  const [addSlot, setAddSlot] = useState<number | null | undefined>(undefined);
  const [settingsSlot, setSettingsSlot] = useState<number | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [returning, setReturning] = useState(false);
  const [nearby, setNearby] = useState<DiscoveredCamera[]>([]);
  const [wifiName, setWifiName] = useState<string | null>(null);

  const selected = stage.selected;
  const selectedTile = snap.tiles[selected];
  const focusedSession = stage.layout === 'center' ? selectedTile?.session : null;
  const valueCount = focusedSession ? captureTileCount(focusedSession.getState()) : 7;
  const layout = useMemo(
    () =>
      computeMultiviewLayout({
        width,
        height,
        safeArea: { top: insets.top, leading: insets.left, bottom: insets.bottom, trailing: insets.right },
        arrangement: stage.layout,
        selected,
        valueCount,
      }),
    [width, height, insets.top, insets.left, insets.bottom, insets.right, stage.layout, selected, valueCount],
  );

  // A new focus starts with no capture sheet open on the previous camera.
  useEffect(() => {
    useLiveUi.getState().reset();
  }, [selected, stage.layout]);

  // The monitor follows the phone in every orientation; keep awake while cameras are on stage.
  useEffect(() => {
    if (Platform.OS !== 'web') ScreenOrientation.unlockAsync().catch(() => {});
  }, []);
  useEffect(() => {
    if (!keepAwake || snap.members === 0) return;
    activateKeepAwakeAsync('pm.multiview').catch(() => {});
    return () => {
      deactivateKeepAwake('pm.multiview').catch(() => {});
    };
  }, [keepAwake, snap.members]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);
  const requestExit = useCallback(() => {
    if (snap.members === 0) return leave();
    setExitError(null);
    setExitOpen(true);
  }, [snap.members, leave]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      requestExit();
      return true;
    });
    return () => sub.remove();
  }, [requestExit]);

  // Real cameras: this phone leaves a camera's own Wi-Fi for the shared network.
  const freeRadio = useCallback(() => {
    if (appSession.kind === 'native' && !IDLE.has(appSession.getState().connection.phase)) appSession.disconnect().catch(() => {});
  }, [appSession]);

  const add = useCallback(
    (camera: MultiviewCamera, slot: number | null = null) => {
      if (camera.path) freeRadio();
      void coordinator.add(camera, slot);
    },
    [coordinator, freeRadio],
  );

  // Dev / web preview: `/multiview?demo=4` fills the stage with demo cameras.
  useEffect(() => {
    if (native || !params.demo) return;
    const n = Math.min(4, Math.max(1, Number(params.demo) || 4));
    DEMO_MULTIVIEW_CAMERAS.slice(0, n).forEach((c, i) => void coordinator.add(c, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Add sheet: nearby cameras over Bluetooth, and this phone's Wi-Fi name for the network form.
  const addOpen = addSlot !== undefined;
  useEffect(() => {
    if (!addOpen || !native) return;
    currentWifiName().then(setWifiName, () => {});
    if (appSession.kind !== 'native') return;
    return appSession.startScan(setNearby);
  }, [addOpen, native, appSession]);

  const onStage = snap.tiles.flatMap((t) => (t.camera ? [t.camera.id] : []));
  const demoChoices = DEMO_MULTIVIEW_CAMERAS.filter((c) => !onStage.includes(c.id)).slice(0, 4 - snap.members);
  const groups = useMemo(
    () => (stage.network ? addChoices(saved, nearby, stage.network, onStage) : { onNetwork: [], toMove: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved, nearby, stage.network, onStage.join()],
  );

  const pick = (camera: MultiviewCamera) => {
    const slot = addSlot ?? null;
    setAddSlot(undefined);
    add(camera, slot);
  };

  const useNetwork = async (network: MultiviewNetwork, password: string) => {
    if (password) await saveNetworkPassword(network.ssid, password);
    stage.setNetwork(network);
  };

  const onTilePress = (slot: number) => {
    const tile = snap.tiles[slot];
    if (!tile.camera) return setAddSlot(slot);
    if (stage.layout === 'grid') stage.focus(slot);
    else if (slot !== selected) stage.select(slot);
  };

  const canRecord = coordinator.canRecordTogether();
  const onRecord = () => {
    if (snap.anyRecording && confirmStop) return setStopOpen(true);
    void coordinator.record();
  };

  const confirmExit = async () => {
    const { pending } = await coordinator.close();
    const owed = stage.pendingReset.map((c) => c.id);
    stage.returned(owed.filter((id) => !pending.some((p) => p.id === id) && snap.tiles.some((t) => t.camera?.id === id)));
    if (pending.length) {
      setExitError(`${pending.map((p) => p.name).join(', ')} still on ${stage.network?.ssid ?? 'the shared network'}.`);
      return;
    }
    setExitOpen(false);
    leave();
  };

  // Cameras an earlier stage left on the shared network.
  const owed = stage.pendingReset.filter((c) => !onStage.includes(c.id));
  const returnOwed = async () => {
    setReturning(true);
    const back: string[] = [];
    for (const j of owed) {
      const r = await returnCameraToOwnWifi(cameraFromJournal(j, stage.network)).catch(() => 'failed' as const);
      if (r === 'restored') back.push(j.id);
    }
    stage.returned(back);
    setReturning(false);
    pushNotice(back.length === owed.length ? 'Cameras back on their own Wi-Fi' : `${owed.length - back.length} still on ${stage.network?.ssid ?? 'the shared network'}`, back.length === owed.length ? 'success' : 'warning');
  };
  const lastStage = stage.cameras.filter((c) => (native ? !c.demoScene : !!c.demoScene));
  const restoreLast = () => lastStage.forEach((j) => add(cameraFromJournal(j, stage.network), j.slot));

  const settingsTile = settingsSlot != null ? snap.tiles[settingsSlot] : null;
  const network = stage.network;
  const networkCaption = native ? (network ? network.ssid : 'Network') : 'Demo';
  const isFull = snap.members >= 4;
  const notify = pushNotice;

  return (
    <View testID="multiview.screen" style={styles.root}>
      <StatusBar hidden={Platform.OS !== 'web'} style="light" />

      {/* Tiles: four persistent slots; layout changes move them, never recreate a picture. */}
      {snap.members > 0
        ? snap.tiles.map((tile) => (
            <MultiviewTile
              key={tile.slot}
              tile={tile}
              rect={layout.tiles[tile.slot]}
              look={lookFor(stage, tile.camera?.id)}
              fill={stage.fill}
              selected={tile.slot === selected}
              large={layout.main === tile.slot}
              onPress={() => onTilePress(tile.slot)}
              onLongPress={() => tile.camera && setSettingsSlot(tile.slot)}
              onReconnect={() => void coordinator.reconnect(tile.slot)}
            />
          ))
        : null}

      {/* The selected camera's live controls (Center stage), driving that camera only. */}
      {focusedSession ? (
        <CameraSessionScope session={focusedSession}>
          <FocusedControls layout={layout} notice={notify} enabled={!snap.closing} />
        </CameraSessionScope>
      ) : null}

      {/* Empty stage. */}
      {snap.members === 0 ? (
        <View style={[styles.emptyStage, { left: layout.stage.x, top: layout.stage.y, width: layout.stage.width, height: layout.stage.height }]}>
          <Squircle width={56} height={56} radius={18} color={onVideo.well} style={styles.centre}>
            <Icon icon={DashboardSquare01Icon} size={26} color={onVideo.ink} />
          </Squircle>
          <Text style={styles.emptyTitle}>No cameras</Text>
          <Text style={styles.emptyLine}>Up to four on one screen.</Text>
          <View style={styles.emptyActions}>
            {!native ? (
              <VideoButton testID="multiview.empty.demo" title="Add demo cameras" primary onPress={() => DEMO_MULTIVIEW_CAMERAS.forEach((c, i) => add(c, i))} />
            ) : lastStage.length && network ? (
              <VideoButton title={`Reconnect last ${lastStage.length === 1 ? 'camera' : `${lastStage.length} cameras`}`} primary onPress={restoreLast} />
            ) : null}
            <VideoButton testID="multiview.empty.add" title="Add camera" primary={native && !(lastStage.length && network)} onPress={() => setAddSlot(null)} />
            {native && owed.length ? (
              <VideoButton title={`Return ${owed.length === 1 ? 'camera' : `${owed.length} cameras`} to own Wi-Fi`} busy={returning} onPress={returnOwed} />
            ) : null}
          </View>
        </View>
      ) : null}

      {/* System chrome. */}
      <Slot rect={layout.exit}>
        <RailButton testID="multiview.exit" icon={ArrowLeft01Icon} label="Close Multiview" caption="Exit" onPress={requestExit} />
      </Slot>
      {layout.portrait ? (
        <View pointerEvents="box-none" style={[styles.networkRow, { left: layout.network.x, top: layout.network.y, width: layout.network.width }]}>
          <VideoPill label={native ? `Network ${networkCaption}` : 'Demo cameras'} onPress={native ? () => setAddSlot(null) : undefined}>
            <Icon icon={network?.hotspot ? HotspotIcon : Wifi01Icon} size={14} color={onVideo.ink} />
            <PillText>{networkCaption}</PillText>
          </VideoPill>
          <VideoPill label={`${snap.members} of 4 cameras`}>
            <PillText mono>{`${snap.members}/4`}</PillText>
          </VideoPill>
        </View>
      ) : (
        <Slot rect={layout.network}>
          <RailButton
            testID="multiview.network"
            icon={network?.hotspot ? HotspotIcon : Wifi01Icon}
            label={native ? `Network ${networkCaption}` : 'Demo cameras'}
            caption={networkCaption.length > 8 ? `${networkCaption.slice(0, 7)}…` : networkCaption}
            onPress={native ? () => setAddSlot(null) : undefined}
            disabled={!native}
          />
        </Slot>
      )}
      <Slot rect={layout.layoutButton}>
        <RailButton
          testID="multiview.layout"
          icon={stage.layout === 'grid' ? GridViewIcon : LayoutLeftIcon}
          label="Layout"
          caption={stage.layout === 'grid' ? 'Grid' : 'Stage'}
          accessibilityValue={{ text: stage.layout === 'grid' ? 'Grid' : 'Center stage' }}
          onPress={stage.toggleLayout}
          disabled={snap.members === 0}
        />
      </Slot>
      <Slot rect={layout.fitButton}>
        <RailButton
          testID="multiview.fit"
          icon={stage.fill ? ArrowExpand01Icon : ArrowShrink02Icon}
          label="Picture fit"
          caption={stage.fill ? 'Fill' : 'Fit'}
          onPress={stage.toggleFill}
          disabled={snap.members === 0}
        />
      </Slot>
      <Slot rect={layout.cameraButton}>
        <RailButton
          testID="multiview.cameraSettings"
          icon={Settings02Icon}
          label="Camera settings"
          caption="Camera"
          onPress={() => selectedTile?.camera && setSettingsSlot(selected)}
          disabled={!selectedTile?.camera}
        />
      </Slot>
      <Slot rect={layout.addButton}>
        <RailButton testID="multiview.add" icon={Add01Icon} label="Add camera" caption="Add" onPress={() => setAddSlot(null)} disabled={isFull || snap.closing} />
      </Slot>
      <Slot rect={layout.record} style={styles.centre}>
        <GroupRecordButton
          recording={snap.anyRecording}
          busy={snap.groupBusy}
          ready={canRecord}
          onPress={() => (canRecord || snap.anyRecording ? onRecord() : pushNotice(coordinator.recordBlocker() || 'Add a camera first', 'warning'))}
        />
      </Slot>

      <MonitorTransientNotice
        notices={notices}
        onExpire={(id) => setNotices((all) => all.filter((n) => n.id !== id))}
        top={layout.stage.y + (layout.portrait ? 4 : 8)}
      />

      <AddCameraSheet
        visible={addOpen}
        onClose={() => setAddSlot(undefined)}
        demo={!native}
        demoChoices={demoChoices}
        groups={groups}
        network={network}
        networkLocked={snap.members > 0}
        currentSsid={wifiName}
        scanning={native && appSession.kind === 'native'}
        onPick={pick}
        onAddAllDemo={() => {
          setAddSlot(undefined);
          demoChoices.forEach((c) => add(c));
        }}
        onNetwork={useNetwork}
      />
      <CameraSettingsSheet
        tile={settingsTile}
        session={settingsTile?.session ?? null}
        look={lookFor(stage, settingsTile?.camera?.id)}
        onClose={() => setSettingsSlot(null)}
        onLook={(patch) => settingsTile?.camera && stage.setLook(settingsTile.camera.id, patch)}
        onRecord={() => settingsSlot != null && void coordinator.record(settingsSlot)}
        onControls={() => {
          if (settingsSlot == null) return;
          stage.focus(settingsSlot);
          setSettingsSlot(null);
        }}
        onReconnect={() => {
          if (settingsSlot == null) return;
          void coordinator.reconnect(settingsSlot);
          setSettingsSlot(null);
        }}
        onRemove={() => {
          if (settingsSlot != null && coordinator.remove(settingsSlot)) setSettingsSlot(null);
        }}
        canRemove={!!settingsTile && !settingsTile.recordBusy && !snap.groupBusy}
      />
      <ExitSheet
        visible={exitOpen}
        restore={coordinator.restoresNetworks || !!exitError}
        closing={snap.closing}
        onCancel={() => setExitOpen(false)}
        onConfirm={exitError ? leave : confirmExit}
      />
      {exitError && exitOpen && !snap.closing ? (
        <View pointerEvents="none" style={styles.exitError}>
          <Text style={styles.exitErrorText}>{exitError}</Text>
        </View>
      ) : null}
      <GroupStopSheet
        visible={stopOpen}
        count={snap.tiles.filter((t) => t.recording).length}
        onCancel={() => setStopOpen(false)}
        onStop={() => {
          setStopOpen(false);
          void coordinator.record();
        }}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, backgroundColor: colors.preview },
    centre: { alignItems: 'center' as const, justifyContent: 'center' as const },
    recordBusy: { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0, alignItems: 'center' as const, justifyContent: 'center' as const },
    networkRow: { position: 'absolute' as const, height: 32, flexDirection: 'row' as const, gap: 6, justifyContent: 'center' as const, alignItems: 'center' as const },
    emptyStage: { position: 'absolute' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 8, paddingHorizontal: 24 },
    emptyTitle: { fontFamily: fonts.semibold, fontSize: 20, color: onVideo.ink, marginTop: 8 },
    emptyLine: { fontFamily: fonts.regular, fontSize: 14, color: onVideo.inkMuted, textAlign: 'center' as const },
    emptyActions: { marginTop: 16, gap: 10, width: '100%' as const, maxWidth: 320 },
    videoButton: {
      minHeight: 50,
      borderRadius: 16,
      flexDirection: 'row' as const,
      gap: 8,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      paddingHorizontal: 20,
      backgroundColor: onVideo.well,
    },
    videoButtonPrimary: { backgroundColor: onVideo.chosen },
    videoButtonText: { fontFamily: fonts.semibold, fontSize: 15, color: onVideo.ink },
    videoButtonTextPrimary: { color: onVideo.dark },
    exitError: { position: 'absolute' as const, left: 24, right: 24, top: 24, alignItems: 'center' as const },
    exitErrorText: { fontFamily: fonts.medium, fontSize: 14, color: onVideo.ink, backgroundColor: onVideo.notice, borderRadius: 12, overflow: 'hidden' as const, paddingHorizontal: 14, paddingVertical: 8, textAlign: 'center' as const, ...textShadow },
  };
}
