/**
 * The watcher's monitor (`MonitorOperatorWatcherLiveView` + `MonitorWatcherChrome`) in the live
 * monitor's own pieces: the same picture (`LivePicture` on the relay source), assists running
 * locally on it (`AssistOverlays`, the `AssistBar` tool strip), notices and the REC border. The
 * host's picture is never altered from here.
 *
 * Chrome: a header capsule (Leave · host title · WATCHING fps · REC · Clean view), a telemetry
 * strip, and the control strip: "Request control" until the host grants it, then ISO, shutter and
 * zoom from the host's advertised choices, REC and Release. Taps focus only with control, on the
 * fitted picture, compensating for a local mirror. Audio is not relayed.
 */
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useCamera, useNotices, type PictureRect } from '@/camera';
import type { WatcherInfo } from '@/camera/watcher/mapping';
import type { WatcherCameraSession } from '@/camera/watcher/WatcherCameraSession';
import { Button } from '@/components/button';
import { Chip } from '@/components/chip';
import { ChipRow } from '@/components/field-section';
import { Sheet } from '@/components/sheet';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import AssistBar from '@/features/assists/AssistBar';
import AssistOverlays from '@/features/assists/AssistOverlays';
import { MonitorTransientNotice } from '@/features/live/chrome/MonitorTransientNotice';
import { onVideo, textShadow } from '@/features/live/chrome/primitives';
import { FeedGestureWell } from '@/features/live/feed/FeedGestureWell';
import { MonitorRecordingBorder } from '@/features/live/record/MonitorRecordingBorder';
import LivePicture from '@/features/picture/LivePicture';
import { useAssists } from '@/state/assists';
import { usePreferences } from '@/state/preferences';

type Setting = 'iso' | 'shutter' | 'zoom';

const TITLES: Record<Setting, string> = { iso: 'ISO', shutter: 'Shutter', zoom: 'Zoom' };

function zoomLabel(f: number) {
  const r = Math.round(f * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}×`;
}

/** The notice over the picture when the feed is not live (upstream `MonitorWatcherNotice`). */
function connectionNotice(info: WatcherInfo): { message: string; canChooseFeed: boolean } | null {
  switch (info.phase) {
    case 'reconnecting':
      return { message: `Reconnecting… ${info.attempt} of 3`, canChooseFeed: false };
    case 'connecting':
      return { message: 'Joining…', canChooseFeed: false };
    case 'failed':
      return { message: info.error ?? 'The shared feed stopped.', canChooseFeed: true };
    case 'needs-passcode':
      return { message: 'This feed needs a passcode.', canChooseFeed: true };
    default:
      return null;
  }
}

export function WatcherLiveView({
  session,
  info,
  onLeave,
  onChooseFeed,
}: {
  session: WatcherCameraSession;
  info: WatcherInfo;
  onLeave: () => void;
  onChooseFeed: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const portrait = height >= width;
  const recording = useCamera((s) => s.recording.recording);
  const exposure = useCamera((s) => s.exposure);
  const format = useCamera((s) => s.format);
  const zoom = useCamera((s) => s.zoom.factor);
  const battery = useCamera((s) => s.power.batteryPercent);
  const prefs = usePreferences();
  const [notices, , dismissNotice] = useNotices();
  const [clean, setClean] = useState(false);
  const [menu, setMenu] = useState<Setting | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [drawn, setDrawn] = useState<LayoutRectangle | null>(null);
  const live = info.phase === 'live';
  const canControl = live && info.control === 'held';

  useEffect(() => {
    if (!prefs.keepScreenAwake || !live) return;
    activateKeepAwakeAsync('pm.watch').catch(() => {});
    return () => {
      deactivateKeepAwake('pm.watch').catch(() => {});
    };
  }, [prefs.keepScreenAwake, live]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    ScreenOrientation.unlockAsync().catch(() => {});
  }, []);

  // A lost lease closes the control menus.
  useEffect(() => {
    if (!canControl) {
      setMenu(null);
      setConfirmStop(false);
    }
  }, [canControl]);

  const pictureArea = useMemo(() => {
    const top = portrait ? insets.top + 64 : 0;
    const bottom = portrait ? insets.bottom + 150 : 0;
    return { x: 0, y: top, width, height: Math.max(1, height - top - bottom) };
  }, [portrait, insets.top, insets.bottom, width, height]);

  const pictureRect: PictureRect = drawn && drawn.width > 1 ? { x: pictureArea.x + drawn.x, y: pictureArea.y + drawn.y, width: drawn.width, height: drawn.height } : pictureArea;

  const feedHandlers = useMemo(
    () => ({
      onTap: (pt: { x: number; y: number }) => {
        if (!canControl) return;
        const a = useAssists.getState();
        const mirrored = a.isOn('MIRROR', 'live') && a.options.mirror.horizontal;
        session.control.focusAt({ x: mirrored ? 1 - pt.x : pt.x, y: pt.y }).catch(() => {});
      },
      onTrackBox: () => {},
      onDisp: (next: boolean) => setClean(next),
    }),
    [canControl, session],
  );

  const record = () => {
    if (!canControl) return;
    if (recording && prefs.confirmStopRecording) setConfirmStop(true);
    else (recording ? session.control.stopRecording() : session.control.startRecording()).catch(() => {});
  };

  const choices: Record<Setting, { id: number; label: string; selected: boolean }[]> = {
    iso: info.options.iso.map((v) => ({ id: v, label: String(v), selected: !exposure.isoAuto && exposure.iso === v })),
    shutter: info.options.shutter.map((d) => ({ id: d, label: `1/${d}`, selected: exposure.shutterDenom === d })),
    zoom: info.options.zoom.map((f) => ({ id: f, label: zoomLabel(f), selected: Math.abs(zoom - f) < 0.05 })),
  };
  const choose = (setting: Setting, id: number) => {
    const c = session.control;
    const run = setting === 'iso' ? c.setIso(id) : setting === 'shutter' ? c.setShutter(id) : c.setZoom(id);
    run.catch(() => {});
    setMenu(null);
  };

  const readings: [string, string | null][] = [
    ['ISO', exposure.isoAuto ? 'Auto' : exposure.iso != null ? String(exposure.iso) : null],
    ['SHUTTER', exposure.shutterDenom ? `1/${exposure.shutterDenom}` : null],
    ['FORMAT', format.resolution ? `${format.resolution} · ${format.fps}` : null],
    ['COLOR', format.colorMode === 'normal' ? 'Normal' : format.colorMode.toUpperCase()],
    ['ZOOM', zoomLabel(zoom)],
    ['BATTERY', battery >= 0 ? `${battery}%` : null],
  ];
  const notice = connectionNotice(info);
  const holder = info.control === 'held' ? 'You' : info.control === 'held-by' ? info.holder : 'Host';
  const side = { left: Math.max(insets.left, 12), right: Math.max(insets.right, 12) };

  return (
    <View style={styles.root}>
      <StatusBar hidden={Platform.OS !== 'web'} style="light" />
      <View pointerEvents="none" style={[styles.abs, { left: pictureArea.x, top: pictureArea.y, width: pictureArea.width, height: pictureArea.height }]}>
        <LivePicture source={session.video} resizeMode={prefs.pictureFit} onPictureRect={setDrawn} demoScene={session.simulated ? 'studio' : undefined} />
      </View>
      <View pointerEvents="box-none" style={styles.fill}>
        <AssistOverlays pictureRect={pictureRect} context="live" />
      </View>
      <FeedGestureWell picture={pictureRect} enabled={live} handlers={feedHandlers} />

      {/* Header */}
      <View pointerEvents="box-none" style={[styles.abs, { top: insets.top + 8, ...side }]}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="Leave" hitSlop={8} onPress={onLeave} style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}>
            <Text style={styles.headerActionText}>Leave</Text>
          </Pressable>
          <View style={styles.headerTitle}>
            <Text style={styles.title} numberOfLines={1}>
              {info.title || info.hostName}
            </Text>
            {!clean ? (
              <Text style={styles.caption} numberOfLines={1}>
                {live && info.receivedFps > 0 ? `WATCHING · ${info.receivedFps} fps` : 'WATCHING'}
              </Text>
            ) : null}
          </View>
          {recording ? (
            <View style={styles.rec} accessibilityLabel="Camera recording">
              <View style={[styles.recDot, { backgroundColor: colors.dotPink }]} />
              <Text style={[styles.recText, { color: colors.dotPink }]}>REC</Text>
            </View>
          ) : null}
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setClean((c) => !c)} style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}>
            <Text style={styles.headerActionText}>{clean ? 'Controls' : 'Clean view'}</Text>
          </Pressable>
        </View>
        {!clean ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.telemetry} contentContainerStyle={styles.telemetryContent}>
            {readings.map(([label, value]) => (
              <View key={label} style={styles.reading}>
                <Text style={styles.readingLabel}>{label}</Text>
                <Text style={styles.readingValue}>{value ?? '--'}</Text>
              </View>
            ))}
          </ScrollView>
        ) : null}
      </View>

      {notice ? (
        <View pointerEvents="box-none" style={[styles.noticeWrap, side]}>
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{notice.message}</Text>
            {notice.canChooseFeed ? <Button title="Choose a feed" onPress={onChooseFeed} /> : null}
          </View>
        </View>
      ) : null}

      {/* Controls and the tool strip */}
      {!clean ? (
        <View pointerEvents="box-none" style={[styles.abs, { bottom: Math.max(insets.bottom, 12), ...side }, portrait ? styles.bottomPortrait : styles.bottomLandscape]}>
          <View style={styles.controls}>
            <Text style={[styles.controlLabel, canControl && { color: colors.accent }]} numberOfLines={1}>
              {`CONTROL · ${holder.toUpperCase()}`}
            </Text>
            {canControl ? (
              <>
                {(['iso', 'shutter', 'zoom'] as const)
                  .filter((s) => choices[s].length > 0)
                  .map((s) => (
                    <Pressable key={s} accessibilityRole="button" hitSlop={8} onPress={() => setMenu(s)} style={({ pressed }) => [styles.controlKey, pressed && styles.pressed]}>
                      <Text style={styles.controlKeyText}>{TITLES[s]}</Text>
                    </Pressable>
                  ))}
                <Pressable accessibilityRole="button" hitSlop={8} onPress={() => session.releaseControl()} style={({ pressed }) => [styles.controlKey, pressed && styles.pressed]}>
                  <Text style={styles.controlKeyText}>Release</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={recording ? 'Stop recording' : 'Record'}
                  hitSlop={8}
                  onPress={record}
                  style={({ pressed }) => [styles.controlKey, pressed && styles.pressed]}
                >
                  <Text style={[styles.controlKeyText, { color: colors.dotPink }]}>{recording ? 'Stop REC' : 'REC'}</Text>
                </Pressable>
              </>
            ) : info.control === 'available' || info.control === 'requested' ? (
              <Pressable
                accessibilityRole="button"
                disabled={info.control === 'requested' || !live}
                hitSlop={8}
                onPress={() => session.requestControl()}
                style={({ pressed }) => [styles.requestKey, info.control === 'requested' && styles.dim, pressed && styles.pressed]}
              >
                <Text style={styles.requestText}>{info.control === 'requested' ? 'Requested…' : 'Request control'}</Text>
              </Pressable>
            ) : null}
          </View>
          <View pointerEvents="box-none" style={portrait ? styles.stripPortrait : undefined}>
            <AssistBar orientation="landscape" />
          </View>
        </View>
      ) : null}

      {prefs.showRecordingBorder && recording ? <MonitorRecordingBorder /> : null}
      <MonitorTransientNotice notices={notices} onExpire={dismissNotice} top={insets.top + (clean ? 64 : 120)} />

      <Sheet visible={menu != null} title={menu ? TITLES[menu] : ''} onClose={() => setMenu(null)} variant="preview" passthrough expandable={false} topInset={Math.max(insets.top + 40, height - 240)}>
        <ChipRow>
          {menu
            ? choices[menu].map((c) => <Chip key={c.id} label={c.label} selected={c.selected} onPress={() => choose(menu, c.id)} />)
            : null}
        </ChipRow>
      </Sheet>
      <Sheet visible={confirmStop && recording} title="Stop recording?" onClose={() => setConfirmStop(false)} expandable={false}>
        <View style={styles.confirm}>
          <Button title="Keep recording" variant="secondary" size="lg" onPress={() => setConfirmStop(false)} style={{ flex: 1 }} />
          <Button
            title="Stop"
            size="lg"
            destructive
            onPress={() => {
              setConfirmStop(false);
              session.control.stopRecording().catch(() => {});
            }}
            style={{ flex: 1 }}
          />
        </View>
      </Sheet>
    </View>
  );
}

// On-video chrome: always dark, whatever the system theme.
function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, backgroundColor: colors.preview },
    abs: { position: 'absolute' as const },
    fill: { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0 },
    pressed: { opacity: 0.7 },
    dim: { opacity: 0.55 },
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 10,
      minHeight: 48,
      paddingHorizontal: 6,
      borderRadius: 999,
      backgroundColor: onVideo.pill,
    },
    headerAction: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, justifyContent: 'center' as const, alignItems: 'center' as const },
    headerActionText: { fontFamily: fonts.semibold, fontSize: 13, color: onVideo.ink },
    headerTitle: { flex: 1, minWidth: 0, gap: 1 },
    title: { fontFamily: fonts.semibold, fontSize: 13, color: onVideo.ink },
    caption: { fontFamily: fonts.medium, fontSize: 10, letterSpacing: 0.4, color: onVideo.inkMuted },
    rec: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 5 },
    recDot: { width: 7, height: 7, borderRadius: 4 },
    recText: { fontFamily: fonts.semibold, fontSize: 12 },
    telemetry: { marginTop: 8, alignSelf: 'flex-start' as const, maxWidth: '100%' as const, borderRadius: 12, backgroundColor: onVideo.notice },
    telemetryContent: { flexDirection: 'row' as const, gap: 16, paddingHorizontal: 12, paddingVertical: 7 },
    reading: { gap: 2 },
    readingLabel: { fontFamily: fonts.medium, fontSize: 9, letterSpacing: 0.4, color: onVideo.inkMuted },
    readingValue: { fontFamily: fonts.semibold, fontSize: 12, color: onVideo.ink, fontVariant: ['tabular-nums' as const] },
    noticeWrap: { position: 'absolute' as const, top: 0, bottom: 0, justifyContent: 'center' as const, alignItems: 'center' as const },
    notice: { maxWidth: 360, gap: 12, alignItems: 'center' as const, padding: 16, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.85)' },
    noticeText: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: onVideo.ink, textAlign: 'center' as const, ...textShadow },
    bottomPortrait: { gap: 10 },
    bottomLandscape: { flexDirection: 'row-reverse' as const, alignItems: 'flex-end' as const, justifyContent: 'space-between' as const, gap: 12 },
    stripPortrait: { alignSelf: 'flex-start' as const },
    controls: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      flexWrap: 'wrap' as const,
      gap: 4,
      minHeight: 44,
      paddingHorizontal: 12,
      borderRadius: 22,
      backgroundColor: 'rgba(0,0,0,0.72)',
      alignSelf: 'flex-start' as const,
      maxWidth: '100%' as const,
    },
    controlLabel: { fontFamily: fonts.semibold, fontSize: 10, letterSpacing: 0.4, color: onVideo.inkMuted, marginRight: 6 },
    controlKey: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' as const },
    controlKeyText: { fontFamily: fonts.semibold, fontSize: 12, color: onVideo.ink },
    requestKey: { minHeight: 44, justifyContent: 'center' as const, paddingHorizontal: 8 },
    requestText: { fontFamily: fonts.semibold, fontSize: 12, color: colors.accent },
    confirm: { flexDirection: 'row' as const, gap: 12, paddingVertical: 8 },
  };
}
