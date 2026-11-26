import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
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
import AssistBar from '@/features/assists/AssistBar';
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
import { useAssists } from '@/state/assists';
import { usePreferences } from '@/state/preferences';
import { useTheme } from '@/constants/theme';
import { CaptureControlBar, captureTileCount } from './capture/CaptureControlBar';
import { MonitorExposureGauge } from './capture/MonitorExposureGauge';
import { LiveSheetHost } from './chrome/LiveSheetHost';
import { MonitorTransientNotice } from './chrome/MonitorTransientNotice';
import { Slot, onVideo, rectStyle } from './chrome/primitives';
import { SessionRecoveryOverlay } from './chrome/SessionRecoveryOverlay';
import {
  LiveDispToggle,
  LiveLockButton,
  LiveMediaButton,
  LiveSettingsButton,
  PortraitAspectToggle,
} from './chrome/SystemButtons';
import { FeedGestureWell } from './feed/FeedGestureWell';
import { MonitorTrackingOverlay } from './feed/MonitorTrackingOverlay';
import { GimbalLockChip, LiveGimbalButton } from './gimbal/LiveGimbalControls';
import { LiveGimbalStick } from './gimbal/LiveGimbalStick';
import { MotionPathOverlay, MotionRunPill } from './gimbal/MotionControl';
import { ZoomChip } from './gimbal/ZoomChip';
import { cancelZoomRamp, stepStop } from './gimbal/zoom';
import { computeFieldMonitorLayout, maxY } from './layout/fieldMonitorLayout';
import { useLiveUi } from './liveUiStore';
import { LiveRecordButton, RecordCountdownOverlay } from './record/LiveRecordButton';
import { MonitorRecordingBorder } from './record/MonitorRecordingBorder';
import { StopConfirmSheet } from './record/StopConfirmSheet';
import { useRecordControl } from './record/useRecordControl';
import { LiveStatusChrome } from './status/LiveStatusChrome';

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
 * The live field monitor (`MonitorOperatorLiveScreen`) in the Sondr camera style: a black root
 * with the picture in charge, status pills on top, a rail of circle buttons around the record
 * ring, the capture readout strip and the gimbal cluster floating over it. Panels open in the
 * shared preview Sheet so the picture stays visible.
 */
export default function LiveScreen() {
  const { colors } = useTheme();
  const session = useCameraSession();
  const router = useRouter();
  const params = useLocalSearchParams<{ demo?: string; bx?: string }>();
  const bx = (k: string) => (params.bx ?? '').split(',').includes(k);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const phase = useCamera((s) => s.connection.phase);
  const aspectKey = useCamera((s) => s.format.aspect);
  const valueCount = useCamera(captureTileCount);
  const recording = useCamera((s) => s.recording.recording);
  const gimbalAvailable = useCamera((s) => s.capabilities.gimbal && s.gimbal.available);
  const lockedAllAxes = useCamera((s) => s.gimbal.lockedAllAxes);
  const programActive = useCamera((s) => ['preparing', 'running'].includes(s.gimbal.program.status));
  const hasWaypoints = useCamera((s) => !!(s.gimbal.program.a || s.gimbal.program.b || s.gimbal.program.c));

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

  // Layout
  const layout = useMemo(
    () =>
      computeFieldMonitorLayout({
        width,
        height,
        safeArea: { top: insets.top, leading: insets.left, bottom: insets.bottom, trailing: insets.right },
        sourceAspect: ASPECT[aspectKey] ?? 16 / 9,
        fill: prefs.pictureFit === 'fill',
        valueCount,
      }),
    [width, height, insets.top, insets.left, insets.bottom, insets.right, aspectKey, prefs.pictureFit, valueCount],
  );

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
    }),
    [session, stableNotice],
  );

  const chromeShown = ui.disp === 'live' && !(prefs.hideChromeWhileRecording && recording);
  const locked = ui.locked;
  const chromeOpacity = Math.min(1, Math.max(0.3, prefs.chromeOpacity ?? 1));
  const portrait = layout.portrait;
  const w = layout.viewport.width;
  const h = layout.viewport.height;
  const fill = { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0 };
  const lockable = { ...fill, opacity: locked ? 0.4 : 1 };
  const belowStatus = maxY(layout.status) + (portrait ? 12 : 8);

  return (
    <View style={{ flex: 1, backgroundColor: colors.preview }}>
      <StatusBar hidden={Platform.OS !== 'web'} style="light" />
      {/* Picture */}
      <View pointerEvents="none" style={[rectStyle(layout.picture), { backgroundColor: colors.preview, overflow: 'hidden' }]}>
        <LivePicture source={session.video} resizeMode={prefs.pictureFit} onPictureRect={setDrawn} />
      </View>
      <View pointerEvents="box-none" style={fill}>
        <AssistOverlays pictureRect={pictureRect} context="live" />
      </View>

      {/* Feed touches sit above the picture and under the chrome. */}
      <FeedGestureWell picture={pictureRect} enabled={live && !locked} handlers={feedHandlers} />
      <MonitorTrackingOverlay picture={pictureRect} />
      {(ui.gimbalPanel !== 'none' || programActive) && hasWaypoints ? <MotionPathOverlay picture={pictureRect} /> : null}
      <RecordCountdownOverlay />
      <ShutterFlash trigger={flash} />

      {/* Operator chrome */}
      {chromeShown ? (
        <View pointerEvents="box-none" style={[fill, { opacity: chromeOpacity }]}>
          <View pointerEvents={locked ? 'none' : 'box-none'} style={lockable}>
            {bx('status') ? null : <LiveStatusChrome layout={layout} onBack={exit} />}
            <Slot rect={layout.exposureGauge} pointerEvents="none">
              {bx('gauge') ? null : <MonitorExposureGauge width={layout.exposureGauge.width} height={layout.exposureGauge.height} />}
            </Slot>
            {bx('strip') ? null : <CaptureControlBar layout={layout} />}
            <View pointerEvents="box-none" style={{ position: 'absolute', left: layout.assists.x, bottom: h - maxY(layout.assists) }}>
              {bx('assist') ? null : <AssistBar orientation={portrait ? 'portrait' : 'landscape'} />}
            </View>
            {portrait ? (
              <Slot rect={layout.aspectToggle}>
                <PortraitAspectToggle
                  fill={prefs.pictureFit === 'fill'}
                  onPress={() => prefs.set('pictureFit', prefs.pictureFit === 'fill' ? 'fit' : 'fill')}
                />
              </Slot>
            ) : null}

            {/* Gimbal cluster: stick trailing-bottom, zoom above it, the controls button leading of zoom. */}
            <Slot rect={layout.zoom}>
              <ZoomChip size={layout.zoom.width} disabled={!live} onOpenDial={() => ui.set({ zoomDialOpen: true, captureSheet: null, gimbalPanel: 'none' })} />
            </Slot>
            {gimbalAvailable && !bx('stick') ? (
              <>
                <Slot rect={layout.gimbal}>
                  <LiveGimbalButton size={layout.gimbal.width} disabled={!live} />
                </Slot>
                <Slot rect={layout.stick}>
                  <LiveGimbalStick
                    size={layout.stick.width}
                    enabled={live && !locked && !programActive}
                    getMapping={getMapping}
                    onDoubleTap={doubleTap}
                    onTripleTap={() => actions.flip()}
                  />
                </Slot>
                {lockedAllAxes ? (
                  <View pointerEvents="box-none" style={{ position: 'absolute', right: w - layout.stick.x + 8, top: maxY(layout.stick) - 28 }}>
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

            <Slot rect={layout.settings}>
              <LiveSettingsButton onPress={() => router.push('/settings')} />
            </Slot>
            <Slot rect={layout.media}>
              <LiveMediaButton onPress={() => router.push('/media')} />
            </Slot>
          </View>

          {/* Lock stays reachable while locked. */}
          <Slot rect={layout.lock}>
            <LiveLockButton />
          </Slot>
        </View>
      ) : null}

      {/* DISP and record survive DISP 2. */}
      <View pointerEvents={locked ? 'none' : 'box-none'} style={lockable}>
        <Slot rect={layout.display}>
          <LiveDispToggle />
        </Slot>
        <Slot rect={layout.record} style={{ alignItems: 'center', justifyContent: 'center' }}>
          {bx('rec') ? null : <LiveRecordButton
            onPress={() => record.toggle()}
            onHold={() => ui.set({ captureSheet: 'mode', gimbalPanel: 'none', zoomDialOpen: false })}
          />}
        </Slot>
      </View>

      {ui.gimbalPanel === 'runPill' ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: belowStatus, alignItems: 'center' }}>
          <MotionRunPill />
        </View>
      ) : null}
      {bx('sheet') ? null : <LiveSheetHost layout={layout} chromeShown={chromeShown} notice={stableNotice} />}

      {prefs.showRecordingBorder && recording ? <MonitorRecordingBorder /> : null}
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
  );
}
