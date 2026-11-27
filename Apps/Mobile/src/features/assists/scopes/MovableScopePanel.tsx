import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import {
  PANEL,
  SCOPE_SCALE_RANGE,
  clampAvoiding,
  clampScopeScale,
  defaultScopeScale,
  fittedSize,
  isUsable,
  panelBounds,
  panelSize,
  type Insets,
  type Point,
  type Rect,
  type Size,
} from '@/core/media';
import { WIDE_LAYOUT_MIN_WIDTH } from '@/constants/wide';
import { activeLayout, layoutSlot, panelSnap, slotOf } from '@/features/live/layout/layoutModel';
import { useLiveLayouts } from '@/features/live/layout/layoutStore';
import type { ScopePanelId } from '@/state/assists';

export interface MovableScopePanelProps {
  /** A scope or meter (`ScopePanelId`), or another floating plate such as the EV meter. */
  id: ScopePanelId | 'evMeter';
  baseSize: Size;
  /** Overlay canvas in its own coordinates. */
  canvas: Rect;
  clearance?: Partial<Insets>;
  obstacles?: Rect[];
  /** Fraction-of-bounds default centre for a panel the operator never placed. */
  defaultCenter: (bounds: Rect, size: Size) => Point;
  resizable?: boolean;
  enabled?: boolean;
  /** Meters (traffic lights, ND) clamp their own scale range; scopes use 0.6…1.6. */
  fixedScale?: number;
  onOpenOptions?: () => void;
  accessibilityLabel: string;
  children: (size: Size) => ReactNode;
}

/** Hold still this long for the options (long enough that a busy frame never beats the first drag move). */
const LONG_PRESS_MS = 450;
const SLOP = 4;
const [MIN_SCALE, MAX_SCALE] = SCOPE_SCALE_RANGE;

/**
 * `MonitorMovableScopePanel`: a floating plate over the picture that can always be moved. Drag
 * the plate (a grabber shows on touch and hover) and it snaps to the corners, edges and centre
 * lines and stays inside its bounds; hold still for its options; pinch or drag the corner grip to
 * resize scopes. Dragging and resizing run on the UI thread; the drop is cleared of chrome and
 * saved, normalized to the bounds, into the active live layout (per orientation).
 */
export function MovableScopePanel({
  id,
  baseSize,
  canvas,
  clearance,
  obstacles = [],
  defaultCenter,
  resizable = true,
  enabled = true,
  fixedScale,
  onOpenOptions,
  accessibilityLabel,
  children,
}: MovableScopePanelProps) {
  const slot = layoutSlot(canvas.width, canvas.height, WIDE_LAYOUT_MIN_WIDTH);
  const placement = useLiveLayouts((s) => slotOf(activeLayout(s), slot).panels[id]);
  const bounds = useMemo(() => panelBounds(canvas, clearance), [canvas, clearance]);
  const portrait = canvas.height > canvas.width;
  const scale = fixedScale ?? clampScopeScale(placement?.scale ?? defaultScopeScale(portrait, Math.min(canvas.width, canvas.height) >= 700));
  const size = fittedSize(panelSize(baseSize, scale), bounds, resizable);
  const preferred =
    placement?.cx != null && placement.cy != null
      ? { x: bounds.x + placement.cx * bounds.width, y: bounds.y + placement.cy * bounds.height }
      : defaultCenter(bounds, size);
  const center = clampAvoiding(preferred, size, bounds, resizable, obstacles);

  const cx = useSharedValue(center.x);
  const cy = useSharedValue(center.y);
  const sx = useSharedValue(0);
  const sy = useSharedValue(0);
  /** Live resize preview (a transform) until the new size is committed. */
  const zoom = useSharedValue(1);
  const z0 = useSharedValue(1);
  const grab = useSharedValue(0);
  const busy = useSharedValue(false);

  useEffect(() => {
    if (busy.value) return;
    cx.value = center.x;
    cy.value = center.y;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.x, center.y]);
  // The committed size replaces the preview transform before paint.
  useLayoutEffect(() => {
    zoom.value = 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  const live = useRef({ size, bounds, canvas, obstacles, resizable, scale, onOpenOptions, slot });
  live.current = { size, bounds, canvas, obstacles, resizable, scale, onOpenOptions, slot };

  const hasOptions = !!onOpenOptions;
  const gestures = useMemo(() => {
    const b = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const w = size.width;
    const h = size.height;
    // Room for the corner grip under a resizable plate (`PANEL.gripBottomExtent`).
    const snapBounds = resizable ? { ...b, height: Math.max(h, b.height - PANEL.gripBottomExtent) } : b;
    const commitMove = (x: number, y: number) => {
      const l = live.current;
      const end = clampAvoiding({ x, y }, l.size, l.bounds, l.resizable, l.obstacles);
      cx.value = withTiming(end.x, { duration: 120 });
      cy.value = withTiming(end.y, { duration: 120 });
      useLiveLayouts.getState().setPanel(l.slot, id, {
        cx: Math.round(((end.x - l.bounds.x) / Math.max(1, l.bounds.width)) * 10000) / 10000,
        cy: Math.round(((end.y - l.bounds.y) / Math.max(1, l.bounds.height)) * 10000) / 10000,
      });
    };
    const commitScale = (factor: number) => {
      const l = live.current;
      const next = clampScopeScale(l.scale * factor);
      if (Math.abs(next - l.scale) < 0.01) {
        zoom.value = withTiming(1, { duration: 120 });
        return;
      }
      useLiveLayouts.getState().setPanel(l.slot, id, { scale: Math.round(next * 100) / 100 });
    };
    const openOptions = () => live.current.onOpenOptions?.();
    const lo = MIN_SCALE / scale;
    const hi = MAX_SCALE / scale;

    const show = () => {
      'worklet';
      grab.value = withTiming(1, { duration: 120 });
    };
    const hide = () => {
      'worklet';
      grab.value = withDelay(900, withTiming(0, { duration: 220 }));
    };

    const pan = Gesture.Pan()
      .enabled(enabled)
      .minDistance(SLOP)
      .onBegin(() => {
        sx.value = cx.value;
        sy.value = cy.value;
        show();
      })
      .onStart(() => {
        busy.value = true;
      })
      .onUpdate((e) => {
        const p = panelSnap({ x: sx.value + e.translationX, y: sy.value + e.translationY }, { width: w * zoom.value, height: h * zoom.value }, snapBounds);
        cx.value = p.x;
        cy.value = p.y;
      })
      .onEnd(() => {
        runOnJS(commitMove)(cx.value, cy.value);
      })
      .onFinalize(() => {
        busy.value = false;
        hide();
      });
    const hold = Gesture.LongPress()
      .enabled(enabled && hasOptions)
      .minDuration(LONG_PRESS_MS)
      .maxDistance(SLOP)
      .onStart(() => {
        runOnJS(openOptions)();
      });
    const pinch = Gesture.Pinch()
      .enabled(enabled && resizable && fixedScale == null)
      .onStart(() => {
        busy.value = true;
        z0.value = zoom.value;
        show();
      })
      .onUpdate((e) => {
        zoom.value = Math.min(hi, Math.max(lo, z0.value * e.scale));
      })
      .onEnd(() => {
        runOnJS(commitScale)(zoom.value);
      })
      .onFinalize(() => {
        busy.value = false;
        hide();
      });
    const reach = baseSize.width + baseSize.height;
    const grip = Gesture.Pan()
      .enabled(enabled && resizable && fixedScale == null)
      .minDistance(0)
      .onBegin(() => {
        busy.value = true;
        z0.value = zoom.value;
        show();
      })
      .onUpdate((e) => {
        zoom.value = Math.min(hi, Math.max(lo, z0.value + (e.translationX + e.translationY) / (reach * scale)));
      })
      .onEnd(() => {
        runOnJS(commitScale)(zoom.value);
      })
      .onFinalize(() => {
        busy.value = false;
        hide();
      });
    return { body: Gesture.Simultaneous(pinch, Gesture.Race(pan, hold)), grip };
    // Callers pass a fresh `onOpenOptions` on every render (scopes redraw at frame rate); it is read
    // through `live` so the gestures are not rebuilt (which would cancel a drag in flight).
  }, [id, bounds, size.width, size.height, resizable, enabled, fixedScale, hasOptions, scale, baseSize.width, baseSize.height, cx, cy, sx, sy, zoom, z0, grab, busy]);

  const frame = useAnimatedStyle(() => ({
    left: cx.value - size.width / 2,
    top: cy.value - size.height / 2,
    transform: [{ scale: zoom.value }],
    shadowOpacity: busy.value ? 0.5 : 0,
  }));
  const grabber = useAnimatedStyle(() => ({ opacity: grab.value }));

  if (!isUsable(bounds) || canvas.width <= 0) return null;
  const showGrip = resizable && fixedScale == null;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[{ position: 'absolute', width: size.width, height: size.height, shadowColor: '#000', shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }, frame]}
    >
      <GestureDetector gesture={gestures.body}>
        <View
          testID={`monitor.panel.${id}`}
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={onOpenOptions ? 'Drag to move. Hold for options.' : 'Drag to move.'}
          style={{ width: size.width, height: size.height }}
          // Mouse / trackpad: the grabber shows while the pointer is over the plate.
          onPointerEnter={() => {
            grab.value = withTiming(1, { duration: 120 });
          }}
          onPointerLeave={() => {
            if (!busy.value) grab.value = withDelay(400, withTiming(0, { duration: 220 }));
          }}
        >
          {children(size)}
          <Animated.View
            pointerEvents="none"
            style={[
              { position: 'absolute', top: 3, alignSelf: 'center', width: 28, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.75)' },
              grabber,
            ]}
          />
        </View>
      </GestureDetector>
      {showGrip ? (
        <GestureDetector gesture={gestures.grip}>
          <View
            accessibilityLabel={`Resize ${accessibilityLabel}`}
            style={{ position: 'absolute', left: size.width - 30, top: size.height - 30, width: 44, height: 44, paddingLeft: 12, paddingTop: 12 }}
          >
            <Svg width={14} height={14}>
              <Path d="M13 4 V9 A4 4 0 0 1 9 13 H4" stroke="rgba(255,255,255,0.55)" strokeWidth={2} strokeLinecap="round" fill="none" />
            </Svg>
          </View>
        </GestureDetector>
      ) : null}
    </Animated.View>
  );
}
