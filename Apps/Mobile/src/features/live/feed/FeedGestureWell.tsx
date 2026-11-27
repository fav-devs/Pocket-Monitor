import { useRef, useState } from 'react';
import { View } from 'react-native';
import { GestureDetector, PointerType, usePanGesture } from 'react-native-gesture-handler';
import type { PicturePoint, PictureRect } from '@/camera';
import { onVideo } from '../chrome/primitives';
import type { Rect } from '../layout/fieldMonitorLayout';

/** `LiveFeedFocusGesture` constants. */
const TRACK_MINIMUM = 24;
const TRACK_HOLD_MS = 200;
const TRACK_HOLD_SLOP = 10;
const SWIPE_MIN = 44;
/** A still hold this long offers Edit layout (and is not a tap). */
const LONG_PRESS_MS = 600;

export interface FeedGestureHandlers {
  onTap: (point: PicturePoint) => void;
  onTrackBox: (box: PictureRect) => void;
  onDisp: (clean: boolean) => void;
  /** Optional (additive). A still long-press, in screen coordinates (offers Edit layout). */
  onLongPress?: (point: { x: number; y: number }) => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * `FeedGestureWell`: picture-sized touch layer above the video, below the chrome.
 * Short press = tap (focus / track), slight hold then drag = draw a tracking box (a mouse
 * drags at once), vertical swipe = DISP (down clean, up live).
 */
export function FeedGestureWell({ picture, enabled, handlers }: { picture: Rect; enabled: boolean; handlers: FeedGestureHandlers }) {
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const armed = useRef(false);
  const slop = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);
  const last = useRef({ dx: 0, dy: 0 });
  const h = useRef(handlers);
  h.current = handlers;
  const pic = useRef(picture);
  pic.current = picture;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (longTimer.current) clearTimeout(longTimer.current);
    longTimer.current = null;
  };

  const toPoint = (x: number, y: number): PicturePoint => ({
    x: clamp01(x / Math.max(1, pic.current.width)),
    y: clamp01(y / Math.max(1, pic.current.height)),
  });

  const pan = usePanGesture({
    minDistance: 0,
    runOnJS: true,
    enabled,
    onBegin: (e) => {
      start.current = { x: e.x, y: e.y };
      last.current = { dx: 0, dy: 0 };
      slop.current = 0;
      armed.current = e.pointerType === PointerType.MOUSE;
      longFired.current = false;
      clearTimer();
      if (h.current.onLongPress) {
        longTimer.current = setTimeout(() => {
          longTimer.current = null;
          if (slop.current > TRACK_HOLD_SLOP) return;
          longFired.current = true;
          h.current.onLongPress?.({ x: pic.current.x + start.current.x, y: pic.current.y + start.current.y });
        }, LONG_PRESS_MS);
      }
      if (!armed.current) {
        timer.current = setTimeout(() => {
          if (slop.current <= TRACK_HOLD_SLOP) armed.current = true;
        }, TRACK_HOLD_MS);
      }
    },
    onUpdate: (e) => {
      const dx = e.translationX;
      const dy = e.translationY;
      last.current = { dx, dy };
      slop.current = Math.max(slop.current, Math.hypot(dx, dy));
      if (longFired.current) return;
      if (armed.current && Math.hypot(dx, dy) >= TRACK_MINIMUM) {
        setDraft({ x0: start.current.x, y0: start.current.y, x1: start.current.x + dx, y1: start.current.y + dy });
      }
    },
    onFinalize: (e) => {
      clearTimer();
      const { dx, dy } = last.current;
      const dist = Math.hypot(dx, dy);
      setDraft(null);
      if (e.canceled || longFired.current) return;
      if (armed.current) {
        if (dist >= TRACK_MINIMUM) {
          const a = toPoint(start.current.x, start.current.y);
          const b = toPoint(start.current.x + dx, start.current.y + dy);
          h.current.onTrackBox({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
        } else {
          h.current.onTap(toPoint(start.current.x, start.current.y));
        }
        return;
      }
      if (Math.abs(dy) > Math.abs(dx) + 8 && Math.abs(dy) > SWIPE_MIN) {
        h.current.onDisp(dy > 0);
        return;
      }
      if (dist < TRACK_MINIMUM) h.current.onTap(toPoint(start.current.x, start.current.y));
    },
  });

  return (
    <GestureDetector gesture={pan}>
      <View
        testID="monitor.feed.well"
        accessibilityLabel="Live picture. Tap to track or focus, hold and drag to draw a tracking box."
        style={{ position: 'absolute', left: picture.x, top: picture.y, width: picture.width, height: picture.height }}
      >
        {draft ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: Math.min(draft.x0, draft.x1),
              top: Math.min(draft.y0, draft.y1),
              width: Math.abs(draft.x1 - draft.x0),
              height: Math.abs(draft.y1 - draft.y0),
              borderWidth: 1.5,
              borderStyle: 'dashed',
              borderColor: onVideo.ink,
              borderRadius: 4,
              backgroundColor: 'rgba(255,255,255,0.06)',
            }}
          />
        ) : null}
      </View>
    </GestureDetector>
  );
}
