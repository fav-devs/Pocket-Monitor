/**
 * Marker capture while recording. One tracker per app (mounted by `MarkerHost`) follows the
 * session's REC state and the camera's elapsed time ({@link RecordingClock}), opens a take when
 * REC starts (with the active shoot, the format and the files already listed, for matching) and
 * closes it at stop. {@link addMarker} — the live view's Marker button, `M`, the gamepad's Menu
 * button, the "Add marker" gesture, the desktop's Rust keys and pad — puts a marker on the take
 * at the camera's own position and shows the marker toast.
 *
 * Marker labels and notes are never logged.
 */
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { create } from 'zustand';
import type { CameraSession, CameraState } from '@/camera';
import { type ClipMarker, type MarkerSource, RecordingClock, colorForTag, knownIdsOf, newId } from '@/core/markers';
import { useMediaLibrary } from '@/features/media/libraryStore';
import { currentTake, type MarkerRef, useClipMeta } from '@/state/clipMeta';

/** How long the toast stays up after the last touch. */
export const TOAST_MS = 4000;

export interface MarkerToastState {
  shown: { ref: MarkerRef; markerId: string; number: number; time: number; key: number } | null;
  /** A short line instead of a marker ("Not recording"). */
  line: { text: string; key: number } | null;
  show: (shown: Omit<NonNullable<MarkerToastState['shown']>, 'key'>) => void;
  say: (text: string) => void;
  /** Keeps the toast up (a chip was tapped). */
  touch: () => void;
  hide: () => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastKey = 0;

export const useMarkerToast = create<MarkerToastState>()((set, get) => {
  const arm = () => {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ shown: null, line: null }), TOAST_MS);
  };
  return {
    shown: null,
    line: null,
    show: (shown) => {
      set({ shown: { ...shown, key: ++toastKey }, line: null });
      arm();
    },
    say: (text) => {
      set({ line: { text, key: ++toastKey }, shown: null });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set({ line: null }), 1800);
    },
    touch: () => {
      if (get().shown) arm();
    },
    hide: () => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ shown: null, line: null });
    },
  };
});

const clock = new RecordingClock();
let lastState: { recording: boolean; at: number } = { recording: false, at: 0 };

function cameraInfo(s: CameraState) {
  const id = s.identity;
  return {
    cameraId: id?.id,
    cameraName: id?.name,
    cameraModel: id?.model && id.model !== 'unknown' ? id.model : undefined,
    cameraSerial: id?.serial,
  };
}

function openTake(session: CameraSession, s: CameraState, now: number) {
  const meta = useClipMeta.getState();
  // A take left open (the app stopped mid-take) is closed where it was last seen.
  for (const t of meta.takes) if (t.stoppedAt == null) meta.finishTake(t.id, Math.max(t.startedAt, now - 1000), undefined);
  const lib = useMediaLibrary.getState();
  const listed = lib.service === session.media && lib.status === 'ready' ? lib.items : [];
  const fmt = s.format;
  const option = fmt.options.find((o) => o.resolution === fmt.resolution);
  meta.beginTake({
    id: newId('t', now),
    startedAt: clock.startedAt(now) ?? now,
    timeSource: clock.position(now)?.source ?? 'phone',
    ...cameraInfo(s),
    fps: fmt.fps || undefined,
    resolution: fmt.resolution || undefined,
    width: option?.width,
    height: option?.height,
    colorMode: fmt.colorMode,
    codec: fmt.codec,
    shootId: meta.activeShootId,
    ...knownIdsOf(listed),
    markers: [],
  });
}

/** Follows REC on `session` for the life of the returned unsubscribe. */
export function trackRecording(session: CameraSession): () => void {
  const onState = (s: CameraState) => {
    const now = Date.now();
    const recording = s.recording.recording;
    if (!recording && lastState.recording) {
      // Stop: the take's length by the clock before it resets.
      const pos = clock.position(now);
      const take = currentTake(useClipMeta.getState().takes);
      if (take) {
        const startedAt = clock.startedAt(now) ?? take.startedAt;
        useClipMeta.setState((st) => ({
          takes: st.takes.map((t) => (t.id === take.id ? { ...t, startedAt, timeSource: pos?.source ?? t.timeSource } : t)),
        }));
        useClipMeta.getState().finishTake(take.id, now, pos?.seconds);
      }
    }
    clock.update(recording, s.recording.elapsedSec, now);
    if (recording && !lastState.recording) openTake(session, s, now);
    lastState = { recording, at: now };
  };
  onState(session.getState());
  const unsub = session.subscribe(onState);
  return () => {
    unsub();
  };
}

/** The take position now, for tests and the live readout. */
export function takePosition(now = Date.now()) {
  return clock.position(now);
}

/**
 * Puts a marker on the take being recorded at the camera's position and shows the toast.
 * Not recording: says so and returns null.
 */
export function addMarker(source: MarkerSource, now = Date.now()): ClipMarker | null {
  const pos = clock.position(now);
  const take = currentTake(useClipMeta.getState().takes);
  if (!pos || !take) {
    useMarkerToast.getState().say('Not recording');
    return null;
  }
  const marker: ClipMarker = { id: newId('m', now), time: pos.seconds, label: '', tag: null, color: colorForTag(null), createdAt: now, source };
  const ref: MarkerRef = { kind: 'take', takeId: take.id };
  useClipMeta.getState().addMarker(ref, marker);
  const count = (useClipMeta.getState().takes.find((t) => t.id === take.id)?.markers.length ?? 1);
  useMarkerToast.getState().show({ ref, markerId: marker.id, number: count, time: marker.time });
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  return marker;
}

/** Tags (or untags, when it is already the tag) a marker from the toast, and recolours it. */
export function tagMarker(ref: MarkerRef, markerId: string, tag: string) {
  const store = useClipMeta.getState();
  const list = ref.kind === 'take' ? store.takes.find((t) => t.id === ref.takeId)?.markers : store.clips[ref.itemId]?.markers;
  const current = list?.find((m) => m.id === markerId);
  const next = current?.tag && current.tag.toLowerCase() === tag.toLowerCase() ? null : tag;
  store.updateMarker(ref, markerId, { tag: next, color: colorForTag(next) });
  useMarkerToast.getState().touch();
}
