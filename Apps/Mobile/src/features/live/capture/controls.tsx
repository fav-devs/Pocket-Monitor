import type { IconSvgElement } from '@hugeicons/react-native';
import { MinusSignIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import type { ReactNode } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { Chip } from '@/components/chip';
import { ChipRow } from '@/components/field-section';
import { Icon } from '@/components/icon';
import { Squircle } from '@/components/squircle';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { haptics } from '../haptics';

/**
 * `ModeBar`: one of a few as joined segments on a pill track, the chosen one inked (the shared
 * SegmentedControl's look), with an optional detail line under each and a disabled state.
 */
export function ModeBar({
  tabs,
  selected,
  onSelect,
  details,
  disabled,
  accessibilityLabel,
}: {
  tabs: string[];
  selected: number;
  onSelect: (index: number) => void;
  details?: (string | undefined)[];
  disabled?: boolean;
  /** Kept for call sites; labels show as given. */
  uppercase?: boolean;
  accessibilityLabel?: string;
}) {
  const styles = useThemedStyles(createStyles);
  const tall = !!details?.some(Boolean);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={[styles.track, disabled && styles.disabled]}>
      {tabs.map((title, i) => {
        const on = i === selected;
        return (
          <Pressable
            key={`${title}-${i}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled }}
            accessibilityLabel={title}
            disabled={disabled}
            onPress={() => {
              haptics.selection();
              onSelect(i);
            }}
            style={({ pressed }) => [styles.segment, tall && styles.segmentTall, on && styles.segmentOn, pressed && !on && styles.pressed]}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.segmentLabel, on && styles.segmentLabelOn]}>
              {title}
            </Text>
            {details?.[i] ? (
              <Text numberOfLines={1} style={[styles.segmentDetail, on && styles.segmentDetailOn]}>
                {details[i]}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A small squircle key (Auto, − G, + M). Chosen is ink. */
export function StepButton({
  label,
  onPress,
  disabled,
  active,
  accessibilityLabel,
  flex,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  accessibilityLabel?: string;
  flex?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      hitSlop={4}
      style={({ pressed }) => [styles.step, flex && { flex: 1 }, active && styles.stepOn, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text numberOfLines={1} style={[styles.stepLabel, active && styles.stepLabelOn]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A labelled on/off row inside a sheet (settings switch colours). */
export function ToggleRow({
  title,
  detail,
  value,
  onChange,
  disabled,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.toggleRow, disabled && styles.disabled]}>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={title}
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          haptics.selection();
          onChange(v);
        }}
        trackColor={{ true: colors.primary, false: colors.surfaceStrong }}
      />
    </View>
  );
}

/** Caps 11pt muted heading over a group of controls (FieldSection's title). */
export function FieldLabel({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return <Text style={styles.fieldLabel}>{children}</Text>;
}

/** A short muted line under a control, where the label isn't enough. */
export function Hint({ children, tone }: { children: ReactNode; tone?: 'warning' | 'error' }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Text style={[styles.hint, tone === 'warning' && { color: colors.warning }, tone === 'error' && { color: colors.destructive }]}>
      {children}
    </Text>
  );
}

/** Wrapping row of choice chips (WB presets, colour modes, shooting modes). */
export function ChoiceChips<T extends string | number>({
  options,
  value,
  label,
  onSelect,
  disabled,
}: {
  options: T[];
  value: T | null;
  label: (v: T) => string;
  onSelect: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <ChipRow>
      {options.map((o) => (
        <Chip
          key={String(o)}
          label={label(o)}
          selected={o === value}
          disabled={disabled}
          onPress={() => {
            haptics.selection();
            onSelect(o);
          }}
        />
      ))}
    </ChipRow>
  );
}

/** ai-cut editor tool: a 44pt squircle well with a 22pt icon over an 11pt caption. */
export function ToolWell({
  icon,
  label,
  onPress,
  selected = false,
  disabled = false,
  accessibilityLabel = label,
}: {
  icon: IconSvgElement;
  label: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={() => {
        haptics.light();
        onPress();
      }}
      style={({ pressed }) => [styles.tool, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Squircle width={44} height={44} radius={15} color={selected ? colors.ink : colors.surface}>
        <Icon icon={icon} size={22} color={selected ? colors.inkForeground : colors.foreground} strokeWidth={selected ? 2 : 1.7} />
      </Squircle>
      <Text numberOfLines={1} style={[styles.toolLabel, selected && { color: colors.foreground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Title, then − value + in squircle wells (ramp time, leg durations, tint). */
export function StepperRow({
  title,
  detail,
  value,
  onMinus,
  onPlus,
  minusDisabled,
  plusDisabled,
  disabled,
  minusLabel,
  plusLabel,
  valueLabel,
}: {
  title: string;
  detail?: string;
  value: string;
  onMinus: () => void;
  onPlus: () => void;
  minusDisabled?: boolean;
  plusDisabled?: boolean;
  disabled?: boolean;
  minusLabel: string;
  plusLabel: string;
  valueLabel?: string;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.stepperRow, disabled && styles.disabled]}>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      <StepperKey icon={MinusSignIcon} label={minusLabel} disabled={disabled || minusDisabled} onPress={onMinus} />
      <Text style={styles.stepperValue} accessibilityLabel={valueLabel}>
        {value}
      </Text>
      <StepperKey icon={PlusSignIcon} label={plusLabel} disabled={disabled || plusDisabled} onPress={onPlus} />
    </View>
  );
}

function StepperKey({ icon, label, disabled, onPress }: { icon: IconSvgElement; label: string; disabled?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => [disabled && styles.faint, pressed && styles.pressed]}
    >
      <Squircle width={36} height={36} radius={12} color={colors.surface}>
        <Icon icon={icon} size={16} color={colors.foreground} strokeWidth={2} />
      </Squircle>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    flex: { flex: 1, minWidth: 0 },
    track: {
      flexDirection: 'row' as const,
      padding: 3,
      borderRadius: radius.pill,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    segment: {
      flex: 1,
      minHeight: 34,
      paddingHorizontal: 4,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      borderRadius: radius.pill,
    },
    segmentTall: { minHeight: 42 },
    segmentOn: { backgroundColor: colors.ink },
    segmentLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.foreground },
    segmentLabelOn: { color: colors.inkForeground },
    segmentDetail: { fontFamily: fonts.medium, fontSize: 10.5, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    segmentDetailOn: { color: colors.inkForeground, opacity: 0.7 },
    step: {
      minWidth: 52,
      minHeight: 36,
      paddingHorizontal: 12,
      borderRadius: 12,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: colors.surface,
    },
    stepOn: { backgroundColor: colors.ink },
    stepLabel: { fontFamily: fonts.semibold, fontSize: 13, color: colors.foreground },
    stepLabelOn: { color: colors.inkForeground },
    toggleRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md, minHeight: 44 },
    stepperRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, minHeight: 44 },
    stepperValue: {
      minWidth: 52,
      textAlign: 'center' as const,
      fontFamily: fonts.semibold,
      fontSize: 15,
      color: colors.foreground,
      fontVariant: ['tabular-nums' as const],
    },
    rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    rowDetail: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground, marginTop: 1 },
    fieldLabel: {
      fontFamily: fonts.semibold,
      fontSize: 11,
      letterSpacing: 1.2,
      textTransform: 'uppercase' as const,
      color: colors.mutedForeground,
    },
    hint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.mutedForeground },
    tool: { alignItems: 'center' as const, gap: 6, minWidth: 60, flex: 1 },
    toolLabel: { fontFamily: fonts.medium, fontSize: 11, lineHeight: 13, color: colors.mutedForeground, textAlign: 'center' as const },
    disabled: { opacity: 0.4 },
    faint: { opacity: 0.35 },
    pressed: { opacity: 0.7 },
  };
}
