import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { useTheme } from '@/constants/theme';
import { haptics } from '../haptics';
import { maxX, maxY, midX, midY, type Rect } from './fieldMonitorLayout';
import {
  ITEM_SIZES,
  SIZE_SCALE,
  boxFromNormalized,
  clampBox,
  normalizeCenter,
  resolveOverlap,
  snapBox,
  snapTargets,
  type Box,
  type LayoutSlot,
  type MovableId,
  type SlotLayout,
  type SnapTargets,
} from './layoutModel';
import { useLayoutEditor, useLiveLayouts } from './layoutStore';

type Align = 'start' | 'center' | 'end';

/** Where an item sits by default: a rect from the geometry and how its content aligns in it. */
export interface MovableSpec {
  rect: Rect;
  h?: Align;
  v?: Align;
}

export interface MovablePlacement {
  /** The item's visual box (scaled) on screen. */
  box: Box;
  /** Transform scale for the content (S / M / L); 1 for items that size themselves (the stick). */
  scale: number;
  /** The S / M / L factor itself. */
  sizeScale: number;
  measured: boolean;
}

interface Size {
  width: number;
  height: number;
}

/** Items that take their size as a prop rather than a transform. */
const SELF_SIZED: MovableId[] = ['stick'];

function aligned(spec: MovableSpec, size: Size): Box {
  const r = spec.rect;
  const h = spec.h ?? 'center';
  const v = spec.v ?? 'center';
  const x = h === 'start' ? r.x : h === 'end' ? maxX(r) - size.width : midX(r) - size.width / 2;
  const y = v === 'start' ? r.y : v === 'end' ? maxY(r) - size.height : midY(r) - size.height / 2;
  return { x, y, width: size.width, height: size.height };
}

export interface MovableLayout {
  slot: LayoutSlot;
  stage: Rect;
  fixed: Rect[];
  placement: (id: MovableId) => MovablePlacement;
  /** Visual boxes of every mounted item. */
  boxes: Partial<Record<MovableId, Box>>;
  report: (id: MovableId, size: Size | null) => void;
  commit: (id: MovableId, box: Box) => void;
  /** Snap lines for one item: the stage, the fixed controls and every other item. */
  targetsFor: (id: MovableId) => SnapTargets;
}

/**
 * Resolves every movable item's box from the active layout (normalized centres, S / M / L) or
 * its default spot, and commits drags back. Sizes are measured, so content-sized items (status,
 * readout) keep their default alignment until moved.
 */
export function useMovableLayout(slot: LayoutSlot, stage: Rect, fixed: Rect[], specs: Record<MovableId, MovableSpec>, saved: SlotLayout): MovableLayout {
  // Measured sizes outlive an unmount (DISP 2 still knows where the quick icons were);
  // `mounted` says which items take part in snapping and overlap.
  const [sizes, setSizes] = useState<Partial<Record<MovableId, Size>>>({});
  const [mounted, setMounted] = useState<Partial<Record<MovableId, true>>>({});
  const report = useCallback((id: MovableId, size: Size | null) => {
    if (!size) {
      setMounted((m) => {
        if (!m[id]) return m;
        const next = { ...m };
        delete next[id];
        return next;
      });
      return;
    }
    setMounted((m) => (m[id] ? m : { ...m, [id]: true }));
    setSizes((s) => {
      const cur = s[id];
      if (cur && Math.abs(cur.width - size.width) < 0.5 && Math.abs(cur.height - size.height) < 0.5) return s;
      return { ...s, [id]: size };
    });
  }, []);

  const resolved = useMemo(() => {
    const out: Partial<Record<MovableId, MovablePlacement>> = {};
    for (const id of Object.keys(specs) as MovableId[]) {
      const spec = specs[id];
      const stored = saved.items[id];
      const sizeScale = SIZE_SCALE[stored?.size && ITEM_SIZES[id].includes(stored.size) ? stored.size : 'M'];
      const scale = SELF_SIZED.includes(id) ? 1 : sizeScale;
      const measured = sizes[id];
      const base = measured ?? { width: spec.rect.width, height: spec.rect.height };
      const size = { width: base.width * scale, height: base.height * scale };
      const box = stored?.cx != null && stored.cy != null ? boxFromNormalized({ cx: stored.cx, cy: stored.cy }, size, stage) : aligned(spec, size);
      out[id] = { box: clampBox(box, stage), scale, sizeScale, measured: !!measured };
    }
    return out;
  }, [specs, saved, sizes, stage]);

  const boxes = useMemo(() => {
    const b: Partial<Record<MovableId, Box>> = {};
    for (const id of Object.keys(mounted) as MovableId[]) if (resolved[id]) b[id] = resolved[id]!.box;
    return b;
  }, [resolved, mounted]);

  const live = useRef({ boxes, fixed, stage, slot });
  live.current = { boxes, fixed, stage, slot };

  const commit = useCallback((id: MovableId, box: Box) => {
    const { boxes: all, fixed: f, stage: st, slot: sl } = live.current;
    const others = (Object.keys(all) as MovableId[]).filter((k) => k !== id).map((k) => all[k]!);
    const clear = resolveOverlap(box, st, [...f, ...others]);
    useLayoutEditor.getState().checkpoint(sl);
    useLiveLayouts.getState().setItem(sl, id, normalizeCenter(clear, st));
  }, []);

  const targetsFor = useCallback(
    (id: MovableId) => {
      const others = (Object.keys(boxes) as MovableId[]).filter((k) => k !== id).map((k) => boxes[k]!);
      return snapTargets(stage, [...fixed, ...others]);
    },
    [boxes, stage, fixed],
  );

  const placement = useCallback(
    (id: MovableId) => resolved[id] ?? { box: { ...stage, width: 0, height: 0 }, scale: 1, sizeScale: 1, measured: false },
    [resolved, stage],
  );

  return { slot, stage, fixed, placement, boxes, report, commit, targetsFor };
}

/** Snap guides shared by every item while one is dragged (UI thread). */
interface Guides {
  x: SharedValue<number>;
  y: SharedValue<number>;
}
const GuidesContext = createContext<Guides | null>(null);

export function GuidesProvider({ children }: { children: ReactNode }) {
  const x = useSharedValue(-1);
  const y = useSharedValue(-1);
  const value = useMemo(() => ({ x, y }), [x, y]);
  return <GuidesContext.Provider value={value}>{children}</GuidesContext.Provider>;
}

/** The lines an item snapped to while dragging: thin primary lines across the stage. */
export function SnapGuides({ stage }: { stage: Rect }) {
  const g = useContext(GuidesContext);
  const { colors } = useTheme();
  const vx = useAnimatedStyle(() => ({ opacity: g && g.x.value >= 0 ? 1 : 0, left: g ? g.x.value - 0.5 : 0 }));
  const hy = useAnimatedStyle(() => ({ opacity: g && g.y.value >= 0 ? 1 : 0, top: g ? g.y.value - 0.5 : 0 }));
  if (!g) return null;
  return (
    <>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: stage.y, height: stage.height, width: 1, backgroundColor: colors.primary }, vx]} />
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: stage.x, width: stage.width, height: 1, backgroundColor: colors.primary }, hy]} />
    </>
  );
}

/**
 * One movable piece of chrome. Normally it is just its content at its saved spot. In Edit layout
 * a shield covers it (so its own taps and gestures never fire): drag moves it on the UI thread
 * with snapping (stage edges and centre lines, other items, an 8pt grid), tap selects it. The
 * drop is cleared of overlaps and saved, normalized to the stage, into the active layout.
 */
export function MovableItem({
  id,
  layout,
  label,
  children,
  hidden = false,
}: {
  id: MovableId;
  layout: MovableLayout;
  label: string;
  children: ReactNode;
  /** Mounted (so it keeps its measured size) but not shown, e.g. a hidden cluster. */
  hidden?: boolean;
}) {
  const { colors } = useTheme();
  const editing = useLayoutEditor((s) => s.editing);
  const selected = useLayoutEditor((s) => s.selected === id);
  const guides = useContext(GuidesContext);
  const { box, scale, measured } = layout.placement(id);
  const [natural, setNatural] = useState<Size | null>(null);
  const w = natural?.width ?? box.width / scale;
  const h = natural?.height ?? box.height / scale;

  const bx = useSharedValue(box.x);
  const by = useSharedValue(box.y);
  const dragging = useSharedValue(false);
  const lift = useSharedValue(0);
  const sx = useSharedValue(0);
  const sy = useSharedValue(0);

  useEffect(() => {
    if (dragging.value) return;
    if (editing && measured) {
      bx.value = withTiming(box.x, { duration: 140 });
      by.value = withTiming(box.y, { duration: 140 });
    } else {
      bx.value = box.x;
      by.value = box.y;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.x, box.y]);

  const { report } = layout;
  useEffect(() => () => report(id, null), [id, report]);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    // Nothing to show (e.g. no timecode at standby): it stops taking part in snapping and overlap.
    if (width < 1 || height < 1) {
      report(id, null);
      return;
    }
    setNatural({ width, height });
    report(id, { width, height });
  };

  const dx = (w - w * scale) / 2;
  const dy = (h - h * scale) / 2;
  const style = useAnimatedStyle(() => ({
    left: bx.value - dx,
    top: by.value - dy,
    transform: [{ scale: scale * (1 + lift.value * 0.04) }],
  }));

  const stage = layout.stage;
  const { targetsFor } = layout;
  const targets = useMemo(() => targetsFor(id), [targetsFor, id]);
  const vw = w * scale;
  const vh = h * scale;
  const commit = layout.commit;
  const select = useLayoutEditor((s) => s.select);

  const gesture = useMemo(() => {
    const gx = guides?.x;
    const gy = guides?.y;
    const st = { x: stage.x, y: stage.y, width: stage.width, height: stage.height };
    const t = { xs: targets.xs, ys: targets.ys };
    const onPick = () => {
      haptics.selection();
      select(id);
    };
    const onDrop = (x: number, y: number) => commit(id, { x, y, width: vw, height: vh });
    const pan = Gesture.Pan()
      .minDistance(2)
      .onBegin(() => {
        sx.value = bx.value;
        sy.value = by.value;
      })
      .onStart(() => {
        dragging.value = true;
        lift.value = withTiming(1, { duration: 120 });
        runOnJS(onPick)();
      })
      .onUpdate((e) => {
        const r = snapBox({ x: sx.value + e.translationX, y: sy.value + e.translationY, width: vw, height: vh }, st, t);
        bx.value = r.x;
        by.value = r.y;
        if (gx) gx.value = r.guideX;
        if (gy) gy.value = r.guideY;
      })
      .onEnd(() => {
        runOnJS(onDrop)(bx.value, by.value);
      })
      .onFinalize(() => {
        dragging.value = false;
        lift.value = withTiming(0, { duration: 120 });
        if (gx) gx.value = -1;
        if (gy) gy.value = -1;
      });
    const tap = Gesture.Tap().onEnd((_e, ok) => {
      if (ok) runOnJS(onPick)();
    });
    return Gesture.Race(pan, tap);
  }, [guides, stage, targets, vw, vh, id, commit, select, bx, by, sx, sy, dragging, lift]);

  return (
    <Animated.View
      pointerEvents="box-none"
      onLayout={onLayout}
      style={[{ position: 'absolute', opacity: hidden || !measured ? (editing && measured ? 0.5 : 0) : 1 }, style]}
    >
      <View pointerEvents={editing ? 'none' : 'box-none'}>{children}</View>
      {editing ? (
        <GestureDetector gesture={gesture}>
          <View
            testID={`monitor.layout.item.${id}`}
            accessibilityRole="adjustable"
            accessibilityLabel={`Move ${label}`}
            style={{
              position: 'absolute',
              left: -4,
              top: -4,
              right: -4,
              bottom: -4,
              borderRadius: 12,
              borderWidth: selected ? 1.5 : 1,
              borderStyle: selected ? 'solid' : 'dashed',
              borderColor: selected ? colors.accent : 'rgba(255,255,255,0.6)',
              backgroundColor: selected ? 'rgba(254,219,46,0.10)' : 'rgba(255,255,255,0.06)',
            }}
          >
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                alignSelf: 'center',
                top: -3,
                width: 18,
                height: 5,
                borderRadius: 3,
                backgroundColor: selected ? colors.accent : 'rgba(255,255,255,0.85)',
              }}
            />
          </View>
        </GestureDetector>
      ) : null}
    </Animated.View>
  );
}
