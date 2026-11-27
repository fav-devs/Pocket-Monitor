import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanResponder, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import {
  canvasSlot,
  centerFromStored,
  clampAvoiding,
  clampScopeScale,
  defaultScopeScale,
  fittedSize,
  isUsable,
  panelBounds,
  panelSize,
  snap4,
  storedCenterFrom,
  type Insets,
  type Point,
  type Rect,
  type Size,
} from '@/core/media';
import { useTheme } from '@/constants/theme';
import { useAssists, type ScopePanelId } from '@/state/assists';

export interface MovableScopePanelProps {
  id: ScopePanelId;
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

const LONG_PRESS_MS = 300;
const SLOP = 4;

/** `MonitorMovableScopePanel`: direct drag (4pt snap), stationary hold for options, corner resize. */
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
  const { colors } = useTheme();
  const slot = canvasSlot(canvas.width, canvas.height);
  const placement = useAssists((s) => s.panels[id][slot]);
  const setPanel = useAssists((s) => s.setPanel);
  const bounds = useMemo(() => panelBounds(canvas, clearance), [canvas, clearance]);
  const scale = fixedScale ?? clampScopeScale(placement.scale ?? defaultScopeScale(slot === 'portrait', Math.min(canvas.width, canvas.height) >= 700));
  const size = fittedSize(panelSize(baseSize, scale), bounds, resizable);
  const [session, setSession] = useState<Point | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const preferred = session ?? (placement.center ? centerFromStored(placement.center, canvas) : defaultCenter(bounds, size));
  const center = clampAvoiding(preferred, size, bounds, resizable, obstacles);

  const live = useRef({ center, size, bounds, canvas, obstacles, resizable, enabled, scale, onOpenOptions, slot });
  live.current = { center, size, bounds, canvas, obstacles, resizable, enabled, scale, onOpenOptions, slot };

  // A rotation or layout change cancels an in-flight drag.
  useEffect(() => {
    setSession(null);
    setDragging(false);
  }, [canvas.width, canvas.height]);

  const body = useMemo(() => {
    let origin: Point | null = null;
    let moved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.enabled,
      onMoveShouldSetPanResponder: (_e, g) => live.current.enabled && Math.hypot(g.dx, g.dy) > SLOP,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        origin = live.current.center;
        moved = false;
        clear();
        timer = setTimeout(() => {
          if (!moved) live.current.onOpenOptions?.();
        }, LONG_PRESS_MS);
      },
      onPanResponderMove: (_e, g) => {
        if (!origin) return;
        if (!moved && Math.hypot(g.dx, g.dy) <= SLOP) return;
        if (!moved) {
          moved = true;
          clear();
          setDragging(true);
        }
        const l = live.current;
        setSession(clampAvoiding(snap4({ x: origin.x + g.dx, y: origin.y + g.dy }), l.size, l.bounds, l.resizable, l.obstacles));
      },
      onPanResponderRelease: (_e, g) => {
        clear();
        const l = live.current;
        if (moved && origin) {
          const end = clampAvoiding(snap4({ x: origin.x + g.dx, y: origin.y + g.dy }), l.size, l.bounds, l.resizable, l.obstacles);
          setPanel(id, l.slot, { center: storedCenterFrom(end, l.canvas) });
        }
        origin = null;
        moved = false;
        setDragging(false);
        setSession(null);
      },
      onPanResponderTerminate: () => {
        clear();
        origin = null;
        setDragging(false);
        setSession(null);
      },
    });
  }, [id, setPanel]);

  const grip = useMemo(() => {
    let start = 1;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.enabled,
      onMoveShouldSetPanResponder: () => live.current.enabled,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        start = live.current.scale;
        setResizing(true);
      },
      onPanResponderMove: (_e, g) => {
        const reach = baseSize.width + baseSize.height;
        setPanel(id, live.current.slot, { scale: clampScopeScale(start + (g.dx + g.dy) / reach) });
      },
      onPanResponderRelease: () => setResizing(false),
      onPanResponderTerminate: () => setResizing(false),
    });
  }, [id, baseSize.width, baseSize.height, setPanel]);

  if (!isUsable(bounds) || canvas.width <= 0) return null;
  const left = center.x - size.width / 2;
  const top = center.y - size.height / 2;
  const showGrip = resizable && fixedScale == null;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left, top, width: size.width, height: size.height }}>
      <View
        accessibilityLabel={accessibilityLabel}
        accessibilityHint="Drag to move. Hold for options."
        style={{
          width: size.width,
          height: size.height,
          shadowColor: '#000',
          shadowOpacity: dragging || resizing ? 0.5 : 0,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
        }}
        {...body.panHandlers}
      >
        {children(size)}
      </View>
      {showGrip ? (
        <View
          accessibilityLabel={`Resize ${accessibilityLabel}`}
          style={{ position: 'absolute', left: size.width - 30, top: size.height - 30, width: 44, height: 44, paddingLeft: 12, paddingTop: 12 }}
          {...grip.panHandlers}
        >
          <Svg width={14} height={14}>
            <Path d="M13 4 V9 A4 4 0 0 1 9 13 H4" stroke={resizing ? colors.primary : 'rgba(255,255,255,0.55)'} strokeWidth={2} strokeLinecap="round" fill="none" />
          </Svg>
        </View>
      ) : null}
    </View>
  );
}
