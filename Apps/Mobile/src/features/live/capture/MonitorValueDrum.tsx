import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { useMemo, useRef, useState } from 'react';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Icon } from '@/components/icon';
import { monitorPanel } from '@/constants/monitor';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { haptics } from '../haptics';

/** Finger travel per detent (`MonitorDrumMetrics`: independent 56-point detent policy). */
const DETENT = 56;
const HEIGHT = 64;
/** The exposure panel's denser rows. */
const HEIGHT_COMPACT = 42;

function drumMetrics(options: string[], compact: boolean, panel: boolean) {
  const length = Math.max(panel ? 3 : 4, ...options.map((o) => o.length));
  if (panel) {
    // Mimo's tick drum: values close together, the chosen one only a little larger.
    const selectedSize = length > 6 ? 16 : 18;
    return { selectedSize, cellWidth: Math.max(46, Math.round(length * 9 + 14)) };
  }
  const selectedSize = (length > 9 ? 20 : length > 6 ? 24 : 28) - (compact ? 6 : 0);
  const cellWidth = Math.max(compact ? 64 : 76, Math.round(length * selectedSize * 0.62 + 20));
  return { selectedSize, cellWidth };
}

export interface MonitorValueDrumProps {
  options: string[];
  index: number;
  onChange: (index: number) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** A 48pt row with smaller type (the exposure panel). */
  compact?: boolean;
  /**
   * Optional (additive). `panel`: Mimo's tick drum on the live view's dark panels — no well, a
   * ruler of ticks and a marker under the chosen value, fixed dark colours whatever the theme.
   */
  tone?: 'theme' | 'panel';
  /** Optional (additive). Show the previous / next chevrons. Default: on, off for `panel`. */
  chevrons?: boolean;
  /** Optional (additive). The chosen value in the panel's blue (Mimo's frame-rate drum). */
  chosenTint?: boolean;
}

/**
 * `MonitorValueDrum`: a horizontal value drum. Drag snaps one value per 56 pt, tap a value to
 * jump to it, or use the chevrons. The chosen value sits centred and large over a primary tick.
 * Commits on release (the camera sees one SET per gesture, not every detent).
 */
export function MonitorValueDrum({
  options,
  index,
  onChange,
  disabled,
  accessibilityLabel,
  compact = false,
  tone = 'theme',
  chevrons,
  chosenTint = false,
}: MonitorValueDrumProps) {
  const { colors } = useTheme();
  const panel = tone === 'panel';
  const showChevrons = chevrons ?? !panel;
  const ink = panel ? monitorPanel.text : colors.foreground;
  const muted = panel ? monitorPanel.muted : colors.mutedForeground;
  const styles = useThemedStyles(createStyles);
  const { selectedSize, cellWidth } = useMemo(() => drumMetrics(options, compact, tone === 'panel'), [options, compact, tone]);
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
      style={[styles.root, compact && styles.rootCompact, panel && styles.rootPanel, disabled && styles.disabled]}
    >
      {showChevrons ? (
        <Pressable
          accessibilityLabel="Previous value"
          disabled={disabled || index <= 0}
          onPress={() => step(-1)}
          style={[styles.chevron, compact && styles.chevronCompact, index <= 0 && styles.faint]}
        >
          <Icon icon={ArrowLeft01Icon} size={18} color={muted} strokeWidth={2} />
        </Pressable>
      ) : null}
      <GestureDetector gesture={pan}>
        <View
          collapsable={false}
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          style={[styles.window, compact && styles.windowCompact, panel && styles.windowPanel]}
        >
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
                style={[styles.cell, panel && styles.cellPanel, { left: center + offset * cellWidth - cellWidth / 2, width: cellWidth }]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.label,
                    { color: muted },
                    selected
                      ? { fontSize: selectedSize, fontFamily: fonts.semibold, color: chosenTint ? monitorPanel.chosen : ink }
                      : { opacity: Math.abs(offset) === 1 ? 0.75 : 0.4 },
                  ]}
                >
                  {label}
                </Text>
                {panel ? <View pointerEvents="none" style={[styles.rulerTick, selected && styles.rulerTickOn]} /> : null}
              </Pressable>
            );
          })}
          {panel ? (
            <View pointerEvents="none" style={[styles.marker, { left: center - 5 }]} />
          ) : (
            <View pointerEvents="none" style={[styles.tick, { left: center - 2 }]} />
          )}
        </View>
      </GestureDetector>
      {showChevrons ? (
        <Pressable
          accessibilityLabel="Next value"
          disabled={disabled || index >= options.length - 1}
          onPress={() => step(1)}
          style={[styles.chevron, compact && styles.chevronCompact, index >= options.length - 1 && styles.faint]}
        >
          <Icon icon={ArrowRight01Icon} size={18} color={muted} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flexDirection: 'row' as const, alignItems: 'center' as const, height: HEIGHT, borderRadius: 16, backgroundColor: colors.surface },
    rootCompact: { height: HEIGHT_COMPACT, borderRadius: 14 },
    rootPanel: { height: HEIGHT_COMPACT + 8, backgroundColor: 'transparent' },
    window: { flex: 1, height: HEIGHT, overflow: 'hidden' as const },
    windowCompact: { height: HEIGHT_COMPACT },
    windowPanel: { height: HEIGHT_COMPACT + 8 },
    cell: { position: 'absolute' as const, top: 0, bottom: 0, alignItems: 'center' as const, justifyContent: 'center' as const },
    cellPanel: { paddingBottom: 8 },
    label: { fontFamily: fonts.medium, fontSize: 15, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    tick: { position: 'absolute' as const, bottom: 4, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary },
    rulerTick: { position: 'absolute' as const, bottom: 9, width: 1, height: 4, backgroundColor: monitorPanel.faint },
    rulerTickOn: { height: 0 },
    // Mimo's ▲ under the chosen value.
    marker: {
      position: 'absolute' as const,
      bottom: 2,
      width: 0,
      height: 0,
      borderLeftWidth: 5,
      borderRightWidth: 5,
      borderBottomWidth: 6,
      borderLeftColor: 'transparent',
      borderRightColor: 'transparent',
      borderBottomColor: monitorPanel.text,
    },
    chevron: { width: 40, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    chevronCompact: { width: 32 },
    faint: { opacity: 0.3 },
    disabled: { opacity: 0.4 },
  };
}
