import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { MText, colors } from '@/theme';
import { haptics } from '../haptics';

/** Finger travel per detent (`MonitorDrumMetrics`: independent 56-point detent policy). */
const DETENT = 56;

function drumMetrics(options: string[]) {
  const length = Math.max(4, ...options.map((o) => o.length));
  const selectedScale = length > 9 ? 1.4 : length > 6 ? 1.6 : 1.95;
  const cellWidth = Math.max(84, Math.round(length * 9.1 * selectedScale * 0.8 + 26));
  return { selectedScale, cellWidth };
}

export interface MonitorValueDrumProps {
  options: string[];
  index: number;
  onChange: (index: number) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}

/**
 * `MonitorValueDrum`: a horizontal label drum. Drag snaps one value per 56 pt, tap a label to
 * jump to it, or use the chevrons. The selected value sits centred, larger, in accent.
 * Commits on release (the camera sees one SET per gesture, not every detent).
 */
export function MonitorValueDrum({ options, index, onChange, disabled, accessibilityLabel }: MonitorValueDrumProps) {
  const { selectedScale, cellWidth } = useMemo(() => drumMetrics(options), [options]);
  const [width, setWidth] = useState(320);
  const [preview, setPreview] = useState<number | null>(null);
  const startIndex = useRef(index);
  const lastDetent = useRef(index);
  const indexRef = useRef(index);
  indexRef.current = index;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const clampIndex = (i: number) => Math.min(optionsRef.current.length - 1, Math.max(0, i));

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) => !disabled && Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          startIndex.current = indexRef.current;
          lastDetent.current = indexRef.current;
        },
        onPanResponderMove: (_e, g) => {
          const next = clampIndex(startIndex.current - Math.round(g.dx / DETENT));
          if (next !== lastDetent.current) {
            lastDetent.current = next;
            haptics.selection();
          }
          setPreview(next);
        },
        onPanResponderRelease: () => {
          const next = lastDetent.current;
          setPreview(null);
          if (next !== indexRef.current) onChangeRef.current(next);
        },
        onPanResponderTerminate: () => setPreview(null),
      }),
    [disabled],
  );

  const shown = preview ?? index;
  const center = width / 2;
  const span = Math.ceil(width / cellWidth / 2) + 1;

  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: options[shown] ?? '' }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') onChange(clampIndex(index + 1));
        if (e.nativeEvent.actionName === 'decrement') onChange(clampIndex(index - 1));
      }}
      style={{ flexDirection: 'row', alignItems: 'center', height: 60, opacity: disabled ? 0.4 : 1 }}
    >
      <Pressable
        accessibilityLabel="Previous value"
        disabled={disabled || index <= 0}
        onPress={() => onChange(clampIndex(index - 1))}
        style={{ width: 32, height: 44, alignItems: 'center', justifyContent: 'center', opacity: index <= 0 ? 0.3 : 1 }}
      >
        <ChevronLeft size={18} color={colors.muted} />
      </Pressable>
      <View
        {...responder.panHandlers}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        style={{ flex: 1, height: 60, overflow: 'hidden' }}
      >
        {options.map((label, i) => {
          const offset = i - shown;
          if (Math.abs(offset) > span) return null;
          const selected = offset === 0;
          const size = selected ? Math.min(26, 13 * selectedScale) : 13;
          return (
            <Pressable
              key={`${label}-${i}`}
              accessibilityElementsHidden
              importantForAccessibility="no"
              disabled={disabled}
              onPress={() => {
                if (i !== index) {
                  haptics.selection();
                  onChange(i);
                }
              }}
              style={{
                position: 'absolute',
                left: center + offset * cellWidth - cellWidth / 2,
                width: cellWidth,
                top: 0,
                bottom: 0,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MText
                size={size}
                weight={selected ? 'semibold' : 'medium'}
                mono
                numberOfLines={1}
                color={selected ? colors.accent : Math.abs(offset) === 1 ? colors.secondary : colors.muted}
              >
                {label}
              </MText>
            </Pressable>
          );
        })}
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: center - 1, bottom: 2, width: 2, height: 6, borderRadius: 1, backgroundColor: colors.accent }}
        />
      </View>
      <Pressable
        accessibilityLabel="Next value"
        disabled={disabled || index >= options.length - 1}
        onPress={() => onChange(clampIndex(index + 1))}
        style={{ width: 32, height: 44, alignItems: 'center', justifyContent: 'center', opacity: index >= options.length - 1 ? 0.3 : 1 }}
      >
        <ChevronRight size={18} color={colors.muted} />
      </Pressable>
    </View>
  );
}
