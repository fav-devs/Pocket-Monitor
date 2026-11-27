import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useCamera,
  useCameraSession,
  useNotices,
  useSessionEvents,
  type CameraModelId,
  type DiscoveredCamera,
  type PicturePoint,
  type PictureRect,
} from '@/camera';
import { BackgroundMonitor, PictureInPictureButton, hasBackgroundFeatures } from '@/features/background';
import AssistOverlays from '@/features/assists/AssistOverlays';
import {
  expoExponent,
  useGamepadInput,
  useGimbalDrivePump,
  useKeyboardShortcuts,
  type LiveInputActions,
  type StickMapping,
} from '@/features/input';
import LivePicture from '@/features/picture/LivePicture';
import { desktopCameraEnabled } from '@/camera/bootstrap';
import { gesturesAvailable } from '@/camera/desktop/gestures';
import { useAssists } from '@/state/assists';
import { usePreferences } from '@/state/preferences';
import { useTheme } from '@/constants/theme';
import { monitorStrip } from '@/constants/monitor';
import { CaptureReadout } from './capture/CaptureReadout';
import { LiveSheetHost } from './chrome/LiveSheetHost';
import { MonitorTransientNotice } from './chrome/MonitorTransientNotice';
import { Slot, onVideo, rectStyle } from './chrome/primitives';
import { SessionRecoveryOverlay } from './chrome/SessionRecoveryOverlay';
import { BackButton, DispButton, LeadingControls, LockGroup, MediaButton, QuickIcons, useQuickCount } from './chrome/StripControls';
import { PortraitAspectToggle } from './chrome/SystemButtons';
import { FeedGestureWell } from './feed/FeedGestureWell';
import { FocusEvBox } from './feed/FocusEvBox';
import { DesktopGestureHold, HandViewOverlay } from './feed/HandViewOverlay';
import { MonitorTrackingOverlay } from './feed/MonitorTrackingOverlay';
import { GimbalLockChip, LiveGimbalButton } from './gimbal/LiveGimbalControls';
import { LiveGimbalStick } from './gimbal/LiveGimbalStick';
import { MotionPathOverlay, MotionRunPill } from './gimbal/MotionControl';
import { ZoomChip } from './gimbal/ZoomChip';
import { cancelZoomRamp, stepStop } from './gimbal/zoom';
import {
  IOS_INSET_OVERLAP,
  LIVE_STICK,
  LIVE_STICK_TABLET,
  computeFieldMonitorLayout,
  maxX,
  maxY,
  midX,
  midY,
  rect,
} from './layout/fieldMonitorLayout';
import { EditLayoutPrompt, LayoutEditBar } from './layout/LayoutEditor';
import { GuidesProvider, MovableItem, SnapGuides, useMovableLayout, type MovableSpec } from './layout/MovableItem';
import { SIZE_SCALE, layoutSlot, type MovableId } from './layout/layoutModel';
import { useLayoutEditor, useSlotLayout } from './layout/layoutStore';
import { useLiveUi } from './liveUiStore';
import { LiveRecordButton, RecordCountdownOverlay } from './record/LiveRecordButton';
import { MonitorRecordingBorder } from './record/MonitorRecordingBorder';
import { StopConfirmSheet } from './record/StopConfirmSheet';
import { useRecordControl } from './record/useRecordControl';
import { ShootingModeRail } from './record/ShootingModeRail';
import { CameraStatusCluster, RecordingReadout } from './status/LiveStatusChrome';
import { isPhotoMode } from './format';
import { WIDE_LAYOUT_MIN_WIDTH } from '@/constants/wide';
import { addMarker } from '@/features/markers/capture';
import { MarkerButton, MarkerToast } from '@/features/markers/LiveMarker';
import { currentTake, useClipMeta } from '@/state/clipMeta';

const ASPECT: Record<string, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2 };

/** Dev / web preview: `/live?demo=1` (or `?demo=osmo-pocket-3`) connects the demo camera. */
const DEMO_TARGETS: Record<string, DiscoveredCamera> = {
  'osmo-pocket-4-pro': { id: 'demo-pocket-4-pro', name: 'Pocket 4 Pro', model: 'osmo-pocket-4-pro', rssi: -48, pairable: true, saved: false },
  'osmo-pocket-3': { id: 'demo-pocket-3', name: 'Pocket 3', model: 'osmo-pocket-3', rssi: -61, pairable: true, saved: false },
  'osmo-nano': { id: 'demo-nano', name: 'Nano', model: 'osmo-nano', rssi: -72, pairable: true, saved: false },
};

function demoTarget(param?: string): DiscoveredCamera {
  return DEMO_TARGETS[param as CameraModelId] ?? DEMO_TARGETS['osmo-pocket-4-pro'];
}

/** Brief white flash after a still (instant review stand-in). */
function ShutterFlash({ trigger }: { trigger: number }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!trigger) return;
    opacity.setValue(0.7);
    Animated.timing(opacity, { toValue: 0, duration: 260, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [trigger, opacity]);
  return <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: onVideo.ink, opacity }} />;
}

/**
 * The live field monitor (`MonitorOperatorLiveScreen`), laid out like DJI Mimo's camera screen.
 * Landscape: the picture between two black letterbox strips that carry the chrome — back,
 * AUTO/M, the format chip, tracking, assists and `…` down the leading strip; the rotated mode
 * rail, the record disc and media down the trailing strip. Over the picture only status, a
 * column of quick icons (flip, DISP, recenter, lock), the gimbal cluster, the focus box with its
 * EV sun and the exposure readout. Panels dock against the leading strip, dark and compact.
 * Portrait: the picture on top, the same controls in rows under it.
 */
export default function LiveScreen() {
  const { colors } = useTheme();
  const session = useCameraSession();
  const router = useRouter();
  const params = useLocalSearchParams<{ demo?: string; safe?: string }>();
  const deviceInsets = useSafeAreaInsets();
  // Web preview only: `?safe=left,top,right,bottom[,ios]` stands in for a phone's safe area.
  const previewSafe = Platform.OS === 'web' && params.safe ? params.safe.split(',') : null;
  const insets = previewSafe
    ? { left: +previewSafe[0] || 0, top: +previewSafe[1] || 0, right: +previewSafe[2] || 0, bottom: +previewSafe[3] || 0 }
    : deviceInsets;
  const iosInsets = Platform.OS === 'ios' || previewSafe?.[4] === 'ios';
  const { width, height } = useWindowDimensions();

  const phase = useCamera((s) => s.connection.phase);
  const aspectKey = useCamera((s) => s.format.aspect);
  const recording = useCamera((s) => s.recording.recording);
  const gimbalAvailable = useCamera((s) => s.capabilities.gimbal && s.gimbal.available);
  const lockedAllAxes = useCamera((s) => s.gimbal.lockedAllAxes);
  const programActive = useCamera((s) => ['preparing', 'running'].includes(s.gimbal.program.status));
  const hasWaypoints = useCamera((s) => !!(s.gimbal.program.a || s.gimbal.program.b || s.gimbal.program.c));
  const takeMarkers = useClipMeta((s) => (recording ? (currentTake(s.takes)?.markers.length ?? 0) : 0));

  const prefs = usePreferences();
  const ui = useLiveUi();
  const [notices, pushNotice, dismissNotice] = useNotices();
  const [flash, setFlash] = useState(0);
  const live = phase === 'live';

  const noticeRef = useRef((m: string, t?: 'info' | 'warning' | 'error' | 'success') => pushNotice({ message: m, tone: t ?? 'info' }));
  noticeRef.current = (m, t) => pushNotice({ message: m, tone: t ?? 'info' });
  const stableNotice = useCallback((m: string, t?: 'info' | 'warning' | 'error' | 'success') => noticeRef.current(m, t), []);

  const record = useRecordControl(stableNotice);

  // A fresh live view starts at DISP 1, unlocked, nothing open.
  useEffect(() => {
    useLiveUi.getState().reset();
  }, []);

  // Dev / web preview path: connect the demo camera when asked by query param.
  const connectDemo = useCallback(
    (model?: string) => {
      if (session.kind !== 'demo') return;
      session.connect(demoTarget(model)).catch(() => stableNotice('Demo camera did not start', 'error'));
    },
    [session, stableNotice],
  );
  useEffect(() => {
    if (!params.demo) return;
    const p = session.getState().connection.phase;
    if (p === 'idle' || p === 'disconnected') connectDemo(params.demo === '1' ? undefined : params.demo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.demo, session]);

  // Keep the screen awake while live (Settings → Display).
  useEffect(() => {
    if (!prefs.keepScreenAwake || !live) return;
    activateKeepAwakeAsync('pm.live').catch(() => {});
    return () => {
      deactivateKeepAwake('pm.live').catch(() => {});
    };
  }, [prefs.keepScreenAwake, live]);

  // The monitor follows the phone in every orientation.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    ScreenOrientation.unlockAsync().catch(() => {});
  }, []);

  useSessionEvents((e) => {
    if (e.type === 'photo-captured') {
      setFlash((n) => n + 1);
      stableNotice('Photo saved to camera', 'success');
    }
  });

  useGimbalDrivePump(session, live);

  // Layout: the geometry, then the active saved layout's positions for this orientation.
  const slot = layoutSlot(width, height, WIDE_LAYOUT_MIN_WIDTH);
  const saved = useSlotLayout(slot);
  const editing = useLayoutEditor((s) => s.editing);
  const quickCount = useQuickCount();
  const lockCount = hasBackgroundFeatures ? 2 : 1;
  const stickSide = (Math.min(width, height) >= 600 ? LIVE_STICK_TABLET : LIVE_STICK) * SIZE_SCALE[saved.items.stick?.size ?? 'M'];
  const layout = useMemo(
    () =>
      computeFieldMonitorLayout({
        width,
        height,
        safeArea: { top: insets.top, leading: insets.left, bottom: insets.bottom, trailing: insets.right },
        sourceAspect: ASPECT[aspectKey] ?? 16 / 9,
        fill: prefs.pictureFit === 'fill',
        insetOverlap: iosInsets ? IOS_INSET_OVERLAP : 0,
        quickCount,
        lockCount,
        stickSide: Math.round(stickSide),
      }),
    [width, height, insets.top, insets.left, insets.bottom, insets.right, iosInsets, aspectKey, prefs.pictureFit, quickCount, lockCount, stickSide],
  );
  const belowStatus = maxY(layout.status) + (layout.portrait ? 12 : 8);
  const specs = useMemo<Record<MovableId, MovableSpec>>(
    () => ({
      quick: { rect: layout.quick, h: layout.portrait ? 'start' : 'center', v: layout.portrait ? 'center' : 'start' },
      lock: { rect: layout.lock, h: layout.portrait ? 'end' : 'center', v: 'center' },
      status: { rect: layout.status, h: 'end' },
      statusLead: { rect: layout.statusLead, h: 'start' },
      values: { rect: layout.values, v: 'end' },
      zoom: { rect: layout.zoom },
      gimbal: { rect: layout.gimbal },
      stick: { rect: layout.stick },
      runPill: { rect: rect(layout.stage.x, belowStatus, layout.stage.width, 44), v: 'start' },
      marker: { rect: layout.marker, h: 'start', v: 'start' },
    }),
    [layout, belowStatus],
  );
  const movable = useMovableLayout(slot, layout.stage, layout.fixed, specs, saved);
  // Scopes and meters float inside the stage (the visible picture in landscape), clear of record and media.
  const panelClearance = useMemo(
    () => ({ left: layout.stage.x, top: layout.stage.y, right: width - maxX(layout.stage), bottom: height - maxY(layout.stage) }),
    [layout.stage, width, height],
  );
  const panelObstacles = useMemo(
    () => [...layout.fixed, ...(Object.values(movable.boxes).filter(Boolean) as typeof layout.fixed)],
    [layout.fixed, movable.boxes],
  );
  // Edit layout's bar: wherever along the stage it covers the least chrome (top when it is clear).
  const editBarTop = useMemo(() => {
    const st = layout.stage;
    const barW = Math.min(st.width - 16, 400);
    // Top first, then bottom, then evenly down the stage.
    const top = st.y + 6;
    const bottom = maxY(st) - 50;
    const candidates = [top, bottom, ...[1, 2, 3, 4].map((k) => top + ((bottom - top) * k) / 5)];
    const covered = (y: number) => {
      const bar = { x: midX(st) - barW / 2, y, width: barW, height: 44 };
      return [...Object.values(movable.boxes), ...layout.fixed].reduce((sum, b) => {
        if (!b) return sum;
        const ix = Math.max(0, Math.min(maxX(bar), maxX(b)) - Math.max(bar.x, b.x));
        const iy = Math.max(0, Math.min(maxY(bar), maxY(b)) - Math.max(bar.y, b.y));
        return sum + ix * iy;
      }, 0);
    };
    return candidates.reduce((best, y) => (covered(y) < covered(best) - 1 ? y : best), candidates[0]);
  }, [layout, movable.boxes]);
  const [prompt, setPrompt] = useState<{ x: number; y: number } | null>(null);
  const closePrompt = useCallback(() => setPrompt(null), []);

  const [drawn, setDrawn] = useState<LayoutRectangle | null>(null);
  const pictureRect: PictureRect = useMemo(
    () =>
      drawn && drawn.width > 1
        ? { x: layout.picture.x + drawn.x, y: layout.picture.y + drawn.y, width: drawn.width, height: drawn.height }
        : { ...layout.picture },
    [drawn, layout.picture],
  );

  // Stick mapping: expo throw, tilt invert, picture-relative pan (selfie XOR mirror), Direction Lock.
  const getMapping = useCallback((): StickMapping => {
    const p = usePreferences.getState();
    const s = session.getState();
    const a = useAssists.getState();
    const mirror = a.isOn('MIRROR', 'live') && a.options.mirror.horizontal;
    const selfie = s.gimbal.face === 'selfie';
    return {
      exponent: expoExponent(p.stickExpo),
      invertPan: p.stickPictureRelative ? selfie !== mirror : false,
      invertTilt: p.stickInvertTilt,
      directionLock: p.directionLock,
    };
  }, [session]);

  const exit = useCallback(() => {
    useLiveUi.getState().reset();
    session.disconnect().catch(() => {});
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [session, router]);

  const doubleTap = useCallback(() => {
    if (usePreferences.getState().doubleTapLevel) session.gimbal.level().catch(() => {});
    else session.gimbal.recenter().catch(() => {});
  }, [session]);

  // Keyboard and gamepad actions.
  const actions: LiveInputActions = useMemo(
    () => ({
      toggleRecord: (o) => record.toggle(o),
      capturePhoto: () => record.capturePhoto(),
      recenter: () => session.gimbal.recenter().catch(() => {}),
      flip: () => {
        if (!session.getState().capabilities.selfieFlip) return;
        session.gimbal.flip().catch(() => {});
      },
      cycleGimbalMode: () => {
        const g = session.getState().gimbal;
        const i = g.modeOptions.indexOf(g.mode);
        session.gimbal.setMode(g.modeOptions[(i + 1) % g.modeOptions.length]).catch(() => {});
      },
      zoomRate: (rate) => {
        cancelZoomRamp();
        session.control.zoomBy(rate);
      },
      zoomWide: () => {
        cancelZoomRamp();
        session.control.setZoom(session.getState().zoom.min).catch(() => {});
      },
      zoomStep: (dir) => {
        const target = stepStop(session.getState().zoom, dir);
        if (target == null) return;
        cancelZoomRamp();
        session.control.setZoom(target).catch(() => {});
      },
      toggleFaceTrack: () => {
        const t = session.getState().tracking;
        if (!t.available) return;
        if (t.status !== 'idle') session.control.stopTracking().catch(() => {});
        else {
          stableNotice('Tracking the face in frame');
          session.control.startTracking({ x: 0.5, y: 0.45 }).catch(() => {});
        }
      },
      stopTracking: () => session.control.stopTracking().catch(() => {}),
      stepResolution: (dir) => {
        const s = session.getState();
        if (s.recording.recording) return stableNotice('Stop recording to change format', 'warning');
        const opts = s.format.options;
        if (opts.length < 2) return;
        const i = opts.findIndex((o) => o.resolution === s.format.resolution);
        const next = opts[(i + dir + opts.length) % opts.length];
        const fps = next.fps.includes(s.format.fps) ? s.format.fps : next.fps[0];
        session.control.setFormat({ resolution: next.resolution, fps }).catch(() => {});
      },
      stepFrameRate: (dir) => {
        const s = session.getState();
        if (s.recording.recording) return stableNotice('Stop recording to change format', 'warning');
        const opt = s.format.options.find((o) => o.resolution === s.format.resolution);
        if (!opt || opt.fps.length < 2) return;
        const i = opt.fps.indexOf(s.format.fps);
        session.control.setFormat({ fps: opt.fps[(i + dir + opt.fps.length) % opt.fps.length] }).catch(() => {});
      },
      stepIso: (dir) => {
        const e = session.getState().exposure;
        const opts = e.isoOptions;
        const cur = e.iso ?? opts[0];
        const i = opts.reduce((b, o, k) => (Math.abs(o - cur) < Math.abs(opts[b] - cur) ? k : b), 0);
        const next = opts[Math.min(opts.length - 1, Math.max(0, i + dir))];
        session.control.setIso(next).catch(() => {});
        stableNotice(`ISO ${next}`);
      },
      stepShutter: (dir) => {
        const e = session.getState().exposure;
        const opts = [...e.shutterOptions].sort((a, b) => b - a); // fastest first
        const cur = e.shutterDenom ?? opts[opts.length - 1];
        const i = opts.reduce((b, o, k) => (Math.abs(o - cur) < Math.abs(opts[b] - cur) ? k : b), 0);
        // +1 closes (faster, toward the front); −1 opens (slower).
        const next = opts[Math.min(opts.length - 1, Math.max(0, i - dir))];
        session.control.setShutter(next).catch(() => {});
        stableNotice(`Shutter 1/${next}`);
      },
      openGallery: () => router.push('/media'),
      addMarker: (source) => {
        addMarker(source);
      },
      toggleAssist: (a) => {
        const tool = a === 'zebra' ? 'ZEBRA' : a === 'peaking' ? 'PEAK' : a === 'lut' ? 'LUT' : 'MIRROR';
        const store = useAssists.getState();
        store.toggle(tool, 'live');
        stableNotice(`${tool} ${store.isOn(tool, 'live') ? 'off' : 'on'}`);
      },
      toggleChrome: () => {
        const s = useLiveUi.getState();
        s.set({ disp: s.disp === 'live' ? 'clean' : 'live', captureSheet: null, zoomDialOpen: false });
      },
      closeViewfinder: () => {
        if (useLayoutEditor.getState().editing) {
          useLayoutEditor.getState().end();
          return;
        }
        const s = useLiveUi.getState();
        if (s.captureSheet || s.zoomDialOpen || s.gimbalPanel !== 'none' || s.stopConfirmOpen) {
          s.set({ captureSheet: null, zoomDialOpen: false, gimbalPanel: 'none', stopConfirmOpen: false });
          return;
        }
        exit();
      },
      notice: stableNotice,
    }),
    [record, session, router, exit, stableNotice],
  );

  useKeyboardShortcuts(actions, live);
  useGamepadInput(actions, getMapping, live && prefs.gamepadEnabled);

  // Feed touches: tap focus / tap track, hold-drag track box, swipe DISP.
  const feedHandlers = useMemo(
    () => ({
      onTap: (pt: PicturePoint) => {
        // Mimo: a tap on the picture while a panel is open closes the panel.
        const u = useLiveUi.getState();
        if (u.captureSheet || u.gimbalPanel === 'sheet') {
          u.set({ captureSheet: null, gimbalPanel: 'none', zoomDialOpen: false });
          return;
        }
        const s = session.getState();
        const p = usePreferences.getState();
        const box = s.tracking.status !== 'idle' ? s.tracking.box : undefined;
        if (box && pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height) {
          session.control.stopTracking().catch(() => {});
          return;
        }
        if (p.tapToTrack && s.capabilities.tracking && s.tracking.available) {
          session.control.startTracking(pt).catch(() => {});
          return;
        }
        if (p.tapToFocus || s.focus.mode !== 'mf') session.control.focusAt(pt).catch(() => {});
      },
      onTrackBox: (box: PictureRect) => {
        const s = session.getState();
        if (!s.capabilities.tracking || !s.tracking.available) {
          stableNotice('This camera cannot track', 'warning');
          return;
        }
        session.control.startTracking(box).catch(() => {});
      },
      onDisp: (clean: boolean) => useLiveUi.getState().set({ disp: clean ? 'clean' : 'live', captureSheet: null, zoomDialOpen: false }),
      onLongPress: (pt: { x: number; y: number }) => setPrompt(pt),
    }),
    [session, stableNotice],
  );

  const photo = useCamera((st) => isPhotoMode(st.format.shootingMode));
  const chromeShown = editing || (ui.disp === 'live' && !(prefs.hideChromeWhileRecording && recording));
  const locked = ui.locked;
  const chromeOpacity = Math.min(1, Math.max(0.3, prefs.chromeOpacity ?? 1));
  const portrait = layout.portrait;
  const w = layout.viewport.width;
  const h = layout.viewport.height;
  const fill = { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0 };
  const lockable = { ...fill, opacity: locked ? 0.4 : 1 };
  const recordSize = layout.record.width;

  return (
    <GuidesProvider>
    <View style={{ flex: 1, backgroundColor: colors.preview }}>
      <StatusBar hidden={Platform.OS !== 'web'} style="light" />
      {/* The letterbox strips (landscape): solid black under the chrome; the picture is never cropped by them. */}
      {!portrait ? (
        <>
          <View pointerEvents="none" style={[rectStyle(layout.leadStrip), { backgroundColor: monitorStrip }]} />
          <View pointerEvents="none" style={[rectStyle(layout.trailStrip), { backgroundColor: monitorStrip }]} />
        </>
      ) : null}
      {/* Picture */}
      <View pointerEvents="none" style={[rectStyle(layout.picture), { backgroundColor: colors.preview, overflow: 'hidden' }]}>
        <LivePicture source={session.video} resizeMode={prefs.pictureFit} onPictureRect={setDrawn} />
      </View>

      {/* Feed touches sit above the picture and under the chrome. */}
      <FeedGestureWell picture={pictureRect} enabled={live && !locked && !editing} handlers={feedHandlers} />
      <MonitorTrackingOverlay picture={pictureRect} focusBox={false} />
      {desktopCameraEnabled || gesturesAvailable() ? (
        <>
          <HandViewOverlay picture={pictureRect} />
          <DesktopGestureHold picture={pictureRect} />
        </>
      ) : null}
      {(ui.gimbalPanel !== 'none' || programActive) && hasWaypoints ? <MotionPathOverlay picture={pictureRect} /> : null}
      {/* Guides, meters and the movable scope panels: over the feed touches so a panel can always be dragged. */}
      <View pointerEvents="box-none" style={fill}>
        <AssistOverlays
          pictureRect={pictureRect}
          context="live"
          sheetPlacement={layout.sheet}
          locked={locked}
          clearance={panelClearance}
          obstacles={panelObstacles}
        />
      </View>
      <RecordCountdownOverlay />
      <ShutterFlash trigger={flash} />
      {/* Edit layout: a tap on the picture clears the selection. */}
      {editing ? (
        <Pressable
          accessibilityLabel="Clear selection"
          onPress={() => useLayoutEditor.getState().select(null)}
          style={[rectStyle(layout.stage), { backgroundColor: 'rgba(0,0,0,0.18)' }]}
        />
      ) : null}

      {/* Operator chrome */}
      {chromeShown ? (
        <View pointerEvents="box-none" style={[fill, { opacity: editing ? 1 : chromeOpacity }]}>
          {/* Fixed: the strips (a row in portrait) and the bottom edge. Dimmed and inert while editing. */}
          <View pointerEvents={locked || editing ? 'none' : 'box-none'} style={[fill, { opacity: editing ? 0.35 : locked ? 0.4 : 1 }]}>
            <Slot rect={layout.back} style={{ alignItems: 'center', justifyContent: 'center' }}>
              <BackButton onPress={exit} />
            </Slot>
            <LeadingControls layout={layout} notice={stableNotice} />
            <ShootingModeRail
              rect={layout.modeRail}
              axis={portrait ? 'horizontal' : 'vertical'}
              center={portrait ? w / 2 - layout.modeRail.x : midY(layout.record) - layout.modeRail.y}
              notice={stableNotice}
            />
            <MediaButton rect={layout.media} onPress={() => router.push('/media')} />
            {portrait ? (
              <Slot rect={layout.aspectToggle} style={{ alignItems: 'center', justifyContent: 'center' }}>
                <PortraitAspectToggle
                  fill={prefs.pictureFit === 'fill'}
                  onPress={() => prefs.set('pictureFit', prefs.pictureFit === 'fill' ? 'fit' : 'fill')}
                />
              </Slot>
            ) : null}
          </View>

          {/* Movable (saved layouts): everything floating over the picture. */}
          <View pointerEvents={locked && !editing ? 'none' : 'box-none'} style={lockable}>
            {!editing ? <FocusEvBox picture={pictureRect} enabled={live && !locked} /> : null}
            {!photo ? (
              <MovableItem id="statusLead" layout={movable} label="Recording time">
                <RecordingReadout idle="timecode" ghost={editing} />
              </MovableItem>
            ) : null}
            {recording || editing ? (
              <MovableItem id="marker" layout={movable} label="Marker">
                <MarkerButton count={takeMarkers} ghost={editing} />
              </MovableItem>
            ) : null}
            <MovableItem id="status" layout={movable} label="Status">
              <CameraStatusCluster />
            </MovableItem>
            <MovableItem id="values" layout={movable} label="Exposure">
              <CaptureReadout exposureOnly />
            </MovableItem>
            <MovableItem id="zoom" layout={movable} label="Zoom">
              <ZoomChip size={layout.zoom.width} disabled={!live} onOpenDial={() => ui.set({ zoomDialOpen: true, captureSheet: null, gimbalPanel: 'none' })} />
            </MovableItem>
            {gimbalAvailable ? (
              <>
                <MovableItem id="gimbal" layout={movable} label="Gimbal button">
                  <LiveGimbalButton size={layout.gimbal.width} disabled={!live} />
                </MovableItem>
                <MovableItem id="stick" layout={movable} label="Stick">
                  <LiveGimbalStick
                    look="chevrons"
                    size={layout.stick.width}
                    enabled={live && !locked && !programActive && !editing}
                    getMapping={getMapping}
                    onDoubleTap={doubleTap}
                    onTripleTap={() => actions.flip()}
                  />
                </MovableItem>
                {lockedAllAxes && !editing ? (
                  <View
                    pointerEvents="box-none"
                    style={{ position: 'absolute', right: w - movable.placement('gimbal').box.x + 8, top: movable.placement('gimbal').box.y + 8 }}
                  >
                    <GimbalLockChip
                      onUnlock={() => {
                        session.gimbal.setLockedAllAxes(false);
                        stableNotice('Gimbal unlocked');
                      }}
                    />
                  </View>
                ) : null}
              </>
            ) : null}
            <MovableItem id="quick" layout={movable} label="Quick icons">
              <QuickIcons vertical={!portrait} onFlip={() => actions.flip()} />
            </MovableItem>
          </View>

          {/* The lock stays reachable while locked. */}
          <MovableItem id="lock" layout={movable} label="Lock">
            <LockGroup vertical={!portrait} extra={hasBackgroundFeatures ? <PictureInPictureButton /> : null} />
          </MovableItem>
        </View>
      ) : (
        // DISP 2: only DISP (where the quick icons were, to come back) and record.
        <Slot
          rect={{ x: movable.placement('quick').box.x, y: movable.placement('quick').box.y, width: 48, height: 48 }}
          style={{ alignItems: 'center', justifyContent: 'center' }}
        >
          <DispButton />
        </Slot>
      )}

      {/* Record survives DISP 2. */}
      <View pointerEvents={locked || editing ? 'none' : 'box-none'} style={[fill, { opacity: editing ? 0.35 : locked ? 0.4 : 1 }]}>
        <Slot rect={layout.record} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <LiveRecordButton
            size={recordSize}
            onPress={() => record.toggle()}
            onHold={() => ui.set({ captureSheet: 'mode', gimbalPanel: 'none', zoomDialOpen: false })}
          />
        </Slot>
      </View>

      {ui.gimbalPanel === 'runPill' ? (
        <MovableItem id="runPill" layout={movable} label="Motion Control">
          <MotionRunPill />
        </MovableItem>
      ) : null}
      {editing ? (
        <>
          <SnapGuides stage={layout.stage} />
          <LayoutEditBar slot={slot} top={editBarTop} />
        </>
      ) : null}
      {prompt && !editing ? <EditLayoutPrompt point={prompt} bounds={{ width: w, height: h }} onClose={closePrompt} /> : null}
      <LiveSheetHost layout={layout} chromeShown={chromeShown} notice={stableNotice} onOpenSettings={() => router.push('/settings')} />
      {/* iOS: Live Activity, Picture in Picture, record control, grace task. Not on web / Android. */}
      {hasBackgroundFeatures ? <BackgroundMonitor onDisconnect={exit} /> : null}

      {prefs.showRecordingBorder && recording ? <MonitorRecordingBorder /> : null}
      {/* The marker toast sits low on the picture, clear of REC, the Marker button and the notices. */}
      <MarkerToast
        top={(portrait && !layout.fillsPicture ? maxY(layout.picture) : layout.values.y) - 104}
        maxWidth={Math.min(440, layout.stage.width - 16)}
      />
      <MonitorTransientNotice notices={notices} onExpire={dismissNotice} top={ui.gimbalPanel === 'runPill' ? belowStatus + 52 : belowStatus} />
      <StopConfirmSheet onStop={record.commitStop} />
      {!live ? (
        <SessionRecoveryOverlay
          onRetry={() => session.retry().catch(() => stableNotice('Retry failed', 'error'))}
          onExit={exit}
          onDemo={session.kind === 'demo' ? () => connectDemo() : undefined}
        />
      ) : null}
    </View>
    </GuidesProvider>
  );
}
