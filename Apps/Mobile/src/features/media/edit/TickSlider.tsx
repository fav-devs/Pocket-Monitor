import { useRef, useState } from 'react';
import { PanResponder, Text, View } from 'react-native';
import { fonts } from '@/constants/theme';

/** The whole range spans this many points of ruler, in 25 ticks (every fifth is long). */
const RULER = 300;
const TICKS = 25;

/**
 * Mimo's tick drum for a strength: a ruler of ticks slides under a fixed white marker in the
 * middle. Drag left to raise, right to lower. `onChange` fires live while dragging (preview),
 * `onEnd` once on release. Values are 0…100. Fixed on-video colours (white on black).
 */
export function TickSlider({
  value,
  onChange,
  onEnd,
  label,
  disabled,
  min = 0,
  max = 100,
  format = (v: number) => String(Math.round(v)),
}: {
  value: number;
  onChange: (value: number) => void;
  onEnd?: (value: number) => void;
  label: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  /** The readout over the marker. */
  format?: (value: number) => string;
}) {
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ppu = RULER / Math.max(1, max - min);
  const cb = useRef({ value, onChange, onEnd, min, max, disabled, ppu });
  cb.current = { value, onChange, onEnd, min, max, disabled, ppu };
  const drag = useRef<{ start: number; last: number } | null>(null);

  const clamp = (v: number) => Math.round(Math.min(cb.current.max, Math.max(cb.current.min, v)));
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !cb.current.disabled,
      onMoveShouldSetPanResponder: () => !cb.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        drag.current = { start: cb.current.value, last: cb.current.value };
        setDragging(true);
      },
      onPanResponderMove: (_e, g) => {
        const d = drag.current;
        if (!d) return;
        const next = clamp(d.start - g.dx / cb.current.ppu);
        if (next !== d.last) {
          d.last = next;
          cb.current.onChange(next);
        }
      },
      onPanResponderRelease: () => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        if (d) cb.current.onEnd?.(d.last);
      },
      onPanResponderTerminate: () => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        if (d) cb.current.onEnd?.(d.last);
      },
    }),
  ).current;

  const tickEvery = (max - min) / TICKS;
  const offset = width / 2 - (value - min) * ppu;
  const step = (delta: number) => {
    const next = clamp(value + delta);
    onChange(next);
    onEnd?.(next);
  };

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: Math.round(value), text: format(value) }}
      accessibilityState={{ disabled: !!disabled }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 5 : -5)}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      {...responder.panHandlers}
      style={{ height: 56, justifyContent: 'flex-end', overflow: 'hidden', opacity: disabled ? 0.35 : 1 }}
    >
      {width > 0 ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: offset, bottom: 8, height: 22, flexDirection: 'row', alignItems: 'flex-end' }}>
          {Array.from({ length: TICKS + 1 }, (_, i) => {
            const v = min + i * tickEvery;
            const major = i % 5 === 0;
            const passed = v <= value + 1e-6;
            return (
              <View
                key={i}
                style={{
                  position: 'absolute',
                  left: i * tickEvery * ppu - 1,
                  bottom: 0,
                  width: 2,
                  height: major ? 14 : 9,
                  borderRadius: 1,
                  backgroundColor: passed ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)',
                }}
              />
            );
          })}
        </View>
      ) : null}
      <View pointerEvents="none" style={{ position: 'absolute', left: width / 2 - 1.5, bottom: 6, width: 3, height: 26, borderRadius: 1.5, backgroundColor: '#ffffff' }} />
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, alignItems: 'center' }}>
        <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: '#ffffff', opacity: dragging ? 1 : 0.75, fontVariant: ['tabular-nums'] }}>{format(value)}</Text>
      </View>
    </View>
  );
}
