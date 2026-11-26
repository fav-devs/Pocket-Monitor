import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { useMemo, useRef, useState } from 'react';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Icon } from '@/components/icon';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { haptics } from '../haptics';

/** Finger travel per detent (`MonitorDrumMetrics`: independent 56-point detent policy). */
const DETENT = 56;
const HEIGHT = 64;

function drumMetrics(options: string[]) {
  const length = Math.max(4, ...options.map((o) => o.length));
  const selectedSize = length > 9 ? 20 : length > 6 ? 24 : 28;
  const cellWidth = Math.max(76, Math.round(length * selectedSize * 0.62 + 20));
  return { selectedSize, cellWidth };
}

export interface MonitorValueDrumProps {
  options: string[];
  index: number;
  onChange: (index: number) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}

/**
 * `MonitorValueDrum`: a horizontal value drum. Drag snaps one value per 56 pt, tap a value to
 * jump to it, or use the chevrons. The chosen value sits centred and large over a primary tick.
 * Commits on release (the camera sees one SET per gesture, not every detent).
 */
export function MonitorValueDrum({ options, index, onChange, disabled, accessibilityLabel }: MonitorValueDrumProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { selectedSize, cellWidth } = useMemo(() => drumMetrics(options), [options]);
  const [width, setWidth] = useState(320);
  const [preview, setPreview] = useState<number | null>(null);
  const live = useRef({ index, options, onChange, start: index, last: index });
  live.current.index = index;
  live.current.options = options;
  live.current.onChange = onChange;

  const clampIndex = (i: number) => Math.min(live.current.options.length - 1, Math.max(0, i));

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(!disabled)
        .activeOffsetX([-6, 6])
        .failOffsetY([-12, 12])
        .onStart(() => {
          live.current.start = live.current.index;
          live.current.last = live.current.index;
        })
        .onUpdate((e) => {
          const next = clampIndex(live.current.start - Math.round(e.translationX / DETENT));
          if (next !== live.current.last) {
            live.current.last = next;
            haptics.selection();
          }
          setPreview(next);
        })
        .onEnd(() => {
          const next = live.current.last;
          if (next !== live.current.index) live.current.onChange(next);
        })
        .onFinalize(() => setPreview(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled],
  );

  const shown = preview ?? index;
  const center = width / 2;
  const span = Math.ceil(width / cellWidth / 2) + 1;
  const step = (d: number) => {
    const next = clampIndex(index + d);
    if (next === index) return;
    haptics.selection();
    onChange(next);
  };

  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: options[shown] ?? '' }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') step(1);
        if (e.nativeEvent.actionName === 'decrement') step(-1);
      }}
      style={[styles.root, disabled && styles.disabled]}
    >
      <Pressable
        accessibilityLabel="Previous value"
        disabled={disabled || index <= 0}
        onPress={() => step(-1)}
        style={[styles.chevron, index <= 0 && styles.faint]}
      >
        <Icon icon={ArrowLeft01Icon} size={18} color={colors.mutedForeground} strokeWidth={2} />
      </Pressable>
      <GestureDetector gesture={pan}>
        <View collapsable={false} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)} style={styles.window}>
          {options.map((label, i) => {
            const offset = i - shown;
            if (Math.abs(offset) > span) return null;
            const selected = offset === 0;
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
                style={[styles.cell, { left: center + offset * cellWidth - cellWidth / 2, width: cellWidth }]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.label,
                    selected
                      ? { fontSize: selectedSize, fontFamily: fonts.semibold, color: colors.foreground }
                      : { opacity: Math.abs(offset) === 1 ? 0.75 : 0.4 },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
          <View pointerEvents="none" style={[styles.tick, { left: center - 2 }]} />
        </View>
      </GestureDetector>
      <Pressable
        accessibilityLabel="Next value"
        disabled={disabled || index >= options.length - 1}
        onPress={() => step(1)}
        style={[styles.chevron, index >= options.length - 1 && styles.faint]}
      >
        <Icon icon={ArrowRight01Icon} size={18} color={colors.mutedForeground} strokeWidth={2} />
      </Pressable>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flexDirection: 'row' as const, alignItems: 'center' as const, height: HEIGHT, borderRadius: 16, backgroundColor: colors.surface },
    window: { flex: 1, height: HEIGHT, overflow: 'hidden' as const },
    cell: { position: 'absolute' as const, top: 0, bottom: 0, alignItems: 'center' as const, justifyContent: 'center' as const },
    label: { fontFamily: fonts.medium, fontSize: 15, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    tick: { position: 'absolute' as const, bottom: 5, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary },
    chevron: { width: 40, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    faint: { opacity: 0.3 },
    disabled: { opacity: 0.4 },
  };
}
