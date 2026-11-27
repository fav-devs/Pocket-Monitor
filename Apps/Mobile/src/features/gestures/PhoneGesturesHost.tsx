/**
 * Phones' hand gestures, mounted once at the root (`<PhoneGesturesHost />`, beside the feed-sharing
 * host). It runs the {@link GestureRuntime} while gestures are on, the live view is on screen, a
 * camera is live and the app is in front — never in the background (Android server mode or iOS
 * Picture in Picture keep the app alive without the live view) — and draws the two things the
 * gestures add over the live view: a small status pill ("Gestures · 12 ms", or what a gesture just
 * did) and the record gesture's hold bar. The hand view itself is the desktop's
 * `HandViewOverlay`, which the live screen mounts where gestures are available.
 *
 * Not mounted in the desktop app (Rust reads the hands there) or in builds without `PocketHands`.
 */
import { WavingHand01Icon } from '@hugeicons/core-free-icons';
import { Camera } from 'expo-camera';
import { usePathname } from 'expo-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PocketHands } from '@modules/pocket-native/src/native';
import { useCamera, useCameraSession } from '@/camera';
import { gestureMapOf, useDesktopGestures, type DesktopHandOverlay } from '@/camera/desktop/gestures';
import { Icon } from '@/components/icon';
import { fonts } from '@/constants/theme';
import { onVideo } from '@/features/live/chrome/primitives';
import { GestureHoldPill } from '@/features/live/feed/HandViewOverlay';
import { usePreferences } from '@/state/preferences';
import { phoneGesturesSupported, statusLine, usePhoneGestures, NOTICE_MS } from './phoneGestures';
import { GestureRuntime } from './runtime';

const LIVE_PHASES = new Set(['live', 'recovering']);

const seconds = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

function subscribeAppState(cb: () => void) {
  const sub = AppState.addEventListener('change', cb);
  return () => sub.remove();
}

/** The app is in front (`active`); web counts as always in front. */
function useForeground(): boolean {
  const state = useSyncExternalStore(subscribeAppState, () => AppState.currentState, () => 'active');
  return Platform.OS === 'web' || state === 'active';
}

async function permit(what: 'camera' | 'microphone'): Promise<boolean> {
  // The web demo's hands need neither.
  if (Platform.OS === 'web') return true;
  try {
    const answer = what === 'camera' ? await Camera.requestCameraPermissionsAsync() : await Camera.requestMicrophonePermissionsAsync();
    return answer.granted;
  } catch {
    return false;
  }
}

export function PhoneGesturesHost() {
  if (!phoneGesturesSupported || !PocketHands) return null;
  return <Host />;
}

function Host() {
  const session = useCameraSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const settings = useDesktopGestures((s) => s.settings);
  const handView = useDesktopGestures((s) => s.handView);
  const phase = useCamera((s) => s.connection.phase);
  const onLive = usePathname() === '/live';
  const foreground = useForeground();
  const runtime = useRef<GestureRuntime | null>(null);

  useEffect(() => {
    const hands = PocketHands;
    if (!hands) return;
    const created = new GestureRuntime({
      hands,
      session: () => sessionRef.current,
      now: seconds,
      status: (patch) => usePhoneGestures.setState(patch),
      overlay: (overlay) => {
        if (overlay == null || useDesktopGestures.getState().handView) useDesktopGestures.setState({ overlay: overlay as DesktopHandOverlay | null });
      },
      permit,
      recordCountdown: () => usePreferences.getState().recordCountdown,
    });
    runtime.current = created;
    return () => {
      created.dispose();
      runtime.current = null;
    };
  }, []);

  const video = session.video;
  // The web demo has no native decoder: its made-up hands need no session to read.
  const sessionId = video.kind === 'native' ? video.sessionId : Platform.OS === 'web' && video.kind === 'demo' ? 'demo' : null;
  const map = useMemo(() => gestureMapOf(settings), [settings]);
  const active = !!settings?.gestures && onLive && foreground && LIVE_PHASES.has(phase);

  useEffect(() => {
    runtime.current?.configure({
      active,
      source: settings?.gestureSource === 'frontCamera' ? 'frontCamera' : 'cameraFeed',
      sessionId,
      map,
      handControl: settings?.handControl ?? true,
      stickIsRight: settings?.stickIsRight ?? true,
      autoFaceTrack: !!settings?.autoFaceTrack,
      handView,
    });
  }, [active, settings, sessionId, map, handView]);

  return onLive ? <GesturePills /> : null;
}

/** The status pill (top centre) and the record hold (low over the picture). Never takes a touch. */
function GesturePills() {
  const status = usePhoneGestures();
  const handView = useDesktopGestures((s) => s.handView);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // A notice shows for a moment; re-render once it is due to go.
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!status.notice) return;
    const left = NOTICE_MS - (seconds() * 1000 - status.notice.at);
    if (left <= 0) return;
    const id = setTimeout(() => setClock((n) => n + 1), left + 20);
    return () => clearTimeout(id);
  }, [status.notice]);

  const now = seconds() * 1000;
  const noticeOn = !!status.notice && now - status.notice.at < NOTICE_MS;
  // The hand view prints the timing itself; the pill then only carries what gestures do.
  const line = handView && !noticeOn ? null : statusLine(status, now);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} testID="gestures.host">
      {line ? (
        <View style={{ position: 'absolute', top: Math.max(insets.top, 8) + 4, left: 0, right: 0, alignItems: 'center' }}>
          <View
            testID="gestures.status"
            accessibilityRole="text"
            accessibilityLabel={line}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: noticeOn ? onVideo.notice : onVideo.pill,
            }}
          >
            <Icon icon={WavingHand01Icon} size={14} color={onVideo.ink} strokeWidth={1.7} />
            <Text numberOfLines={1} style={{ fontFamily: fonts.medium, fontSize: 12, color: onVideo.ink, fontVariant: ['tabular-nums'] }}>
              {line}
            </Text>
          </View>
        </View>
      ) : null}
      {status.hold ? (
        <View style={{ position: 'absolute', left: 0, right: 0, top: height * 0.68 }}>
          <GestureHoldPill text={status.hold.text} fraction={status.hold.fraction} />
        </View>
      ) : null}
    </View>
  );
}
