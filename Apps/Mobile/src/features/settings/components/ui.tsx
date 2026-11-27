import { ArrowLeft01Icon, MinusSignIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/icon';
import { SegmentedControl } from '@/components/segmented-control';
import { SettingsRow } from '@/components/settings-ui';
import { Squircle } from '@/components/squircle';
import { CONTENT_MAX_WIDTH, centredColumn } from '@/constants/layout';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { settingsFeedback } from './feedback';

/**
 * Settings building blocks over the shared `settings-ui` kit. `SettingsScreenPage` and `Group` look exactly like
 * `SettingsPage` and `SettingsGroup`; they add what Operator Setup needs on top: a back target when there is no
 * history, a group's trailing reset and a footnote under a group.
 */

const WELL = 36;
const WELL_RADIUS = 12;

/** `SettingsPage` with an explicit back target for a page opened straight from a link. */
export function SettingsScreenPage({
  title,
  children,
  fallback = '/',
}: {
  title: string;
  children: ReactNode;
  /** Where Back goes when there is nothing to go back to. */
  fallback?: '/' | '/live' | '/settings';
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[
        styles.content,
        centredColumn(CONTENT_MAX_WIDTH),
        {
          paddingTop: insets.top + spacing.sm,
          paddingBottom: Math.max(insets.bottom, 12) + spacing.xl,
          paddingLeft: Math.max(insets.left, spacing.md),
          paddingRight: Math.max(insets.right, spacing.md),
        },
      ]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.heading}>
        <Pressable
          testID="monitor.page.back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace(fallback);
          }}
          hitSlop={10}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Icon icon={ArrowLeft01Icon} size={24} color={colors.foreground} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {children}
    </ScrollView>
  );
}

/** `SettingsGroup` with an optional trailing control in the label row and a footnote under the card. */
export function Group({
  label,
  trailing,
  note,
  children,
}: {
  label?: string;
  trailing?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.groupBlock}>
      {label || trailing ? (
        <View style={styles.groupHead}>
          <Text style={styles.groupLabel} accessibilityRole="header">
            {label}
          </Text>
          {trailing ? <View style={styles.groupTrailing}>{trailing}</View> : null}
        </View>
      ) : null}
      <View style={styles.group}>{children}</View>
      {note ? <Note>{note}</Note> : null}
    </View>
  );
}

/** A muted footnote on the page (under a group). */
export function Note({ children, color }: { children: ReactNode; color?: string }) {
  const styles = useThemedStyles(createStyles);
  return <Text style={[styles.note, color ? { color } : null]}>{children}</Text>;
}

/** The app's switch: primary track when on. */
export function SettingSwitch({
  value,
  onChange,
  label,
  disabled,
  testID,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Switch
      testID={testID}
      accessibilityLabel={label}
      value={value}
      disabled={disabled}
      onValueChange={(v) => {
        settingsFeedback();
        onChange(v);
      }}
      trackColor={{ true: colors.primary, false: colors.surfaceStrong }}
      thumbColor="#ffffff"
      {...{ activeThumbColor: '#ffffff' }}
    />
  );
}

type RowBase = {
  icon: IconSvgElement;
  iconColor?: string;
  title: string;
  subtitle?: string;
  last?: boolean;
  disabled?: boolean;
};

/** Icon, title and a switch. */
export function SwitchRow({
  value,
  onChange,
  testID,
  ...row
}: RowBase & { value: boolean; onChange: (v: boolean) => void; testID?: string }) {
  return (
    <SettingsRow
      {...row}
      accessory={<SettingSwitch value={value} onChange={onChange} label={row.title} disabled={row.disabled} testID={testID} />}
    />
  );
}

/** Icon, title and a read-only value. */
export function ValueRow({ value, valueColor, ...row }: RowBase & { value: string; valueColor?: string }) {
  return <SettingsRow {...row} accessory={<ValueText value={value} color={valueColor} />} />;
}

/** A row that opens a page, a sheet or a link. */
export function LinkRow({
  onPress,
  value,
  testID,
  ...row
}: RowBase & { onPress: () => void; value?: string; testID?: string }) {
  return (
    <View testID={testID}>
      <SettingsRow {...row} chevron onPress={onPress} accessory={value ? <ValueText value={value} /> : undefined} />
    </View>
  );
}

/** A row that runs an action, named in primary (or destructive) text at its end. */
export function ActionRow({
  action,
  onPress,
  destructive,
  testID,
  ...row
}: RowBase & { action: string; onPress: () => void; destructive?: boolean; testID?: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View testID={testID}>
      <SettingsRow
        {...row}
        iconColor={row.iconColor ?? (destructive ? colors.destructive : undefined)}
        onPress={() => {
          settingsFeedback();
          onPress();
        }}
        accessory={<Text style={[styles.action, destructive && { color: colors.destructive }]}>{action}</Text>}
      />
    </View>
  );
}

/** Muted value at a row's end. */
export function ValueText({ value, color }: { value: string; color?: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Text numberOfLines={1} style={[styles.value, color ? { color } : null]}>
      {value}
    </Text>
  );
}

/** A row whose control (segments, a slider, chips) sits under its title, across the card. */
export function FieldRow({
  icon,
  iconColor,
  title,
  subtitle,
  value,
  last,
  disabled,
  children,
}: RowBase & { value?: string; children: ReactNode }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.field, !last && styles.rowBorder]}>
      <View style={[styles.fieldHead, disabled && styles.disabled]}>
        <Squircle width={WELL} height={WELL} radius={WELL_RADIUS} color={colors.surfaceStrong}>
          <Icon icon={icon} size={18} color={iconColor ?? colors.foreground} />
        </Squircle>
        <View style={styles.fieldText}>
          <Text numberOfLines={1} style={styles.fieldTitle}>
            {title}
          </Text>
          {subtitle ? <Text style={styles.fieldMeta}>{subtitle}</Text> : null}
        </View>
        {value ? <Text style={styles.fieldValue}>{value}</Text> : null}
      </View>
      <View style={disabled && styles.disabled} pointerEvents={disabled ? 'none' : 'auto'}>
        {children}
      </View>
    </View>
  );
}

/** The shared segmented control, with the settings selection pulse. */
export function Segments<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <SegmentedControl
      accessibilityLabel={label}
      options={options}
      value={value}
      onChange={(v) => {
        if (v === value) return;
        settingsFeedback();
        onChange(v);
      }}
    />
  );
}

/** − value + for bounded numbers that want exact steps (seconds, percent). */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v) => String(v),
  label,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  label: string;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const round = (v: number) => Math.round(v / step) * step;
  const set = (v: number) => {
    const next = Math.min(max, Math.max(min, round(v)));
    if (next === value) return;
    settingsFeedback();
    onChange(Number(next.toFixed(4)));
  };
  const button = (dir: -1 | 1) => {
    const off = disabled || (dir < 0 ? value <= min : value >= max);
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${dir < 0 ? 'Decrease' : 'Increase'} ${label}`}
        accessibilityState={{ disabled: off }}
        disabled={off}
        hitSlop={4}
        onPress={() => set(value + dir * step)}
        style={({ pressed }) => [off && styles.disabled, pressed && styles.pressed]}
      >
        <Squircle width={36} height={36} radius={WELL_RADIUS} color={colors.surfaceStrong}>
          <Icon icon={dir < 0 ? MinusSignIcon : PlusSignIcon} size={16} color={colors.foreground} strokeWidth={2} />
        </Squircle>
      </Pressable>
    );
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: format(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => set(value + (e.nativeEvent.actionName === 'increment' ? step : -step))}
      style={styles.stepper}
    >
      {button(-1)}
      <Text style={styles.stepperValue}>{format(value)}</Text>
      {button(1)}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  const hairline = StyleSheet.hairlineWidth;
  return {
    page: { flex: 1, backgroundColor: colors.background },
    content: { paddingHorizontal: spacing.md, gap: spacing.lg },
    heading: { gap: spacing.sm },
    back: { alignSelf: 'flex-start' as const, paddingVertical: 4, marginLeft: -4 },
    title: { fontFamily: fonts.bold, fontSize: 32, letterSpacing: -0.8, color: colors.foreground },
    groupBlock: { gap: 8 },
    groupHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, paddingHorizontal: 4 },
    groupLabel: { flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground },
    groupTrailing: { marginVertical: -10 },
    group: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' as const },
    note: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mutedForeground, paddingHorizontal: 4 },
    rowBorder: { borderBottomWidth: hairline, borderBottomColor: colors.border },
    action: { fontFamily: fonts.semibold, fontSize: 14, color: colors.primary },
    value: {
      fontFamily: fonts.medium,
      fontSize: 14,
      color: colors.mutedForeground,
      maxWidth: 180,
      textAlign: 'right' as const,
      fontVariant: ['tabular-nums' as const],
    },
    field: { paddingHorizontal: spacing.md, paddingTop: 13, paddingBottom: spacing.md, gap: 14 },
    fieldHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12 },
    fieldText: { flex: 1, minWidth: 0, gap: 2 },
    fieldTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    fieldMeta: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mutedForeground },
    fieldValue: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: colors.foreground,
      fontVariant: ['tabular-nums' as const],
    },
    stepper: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
    stepperValue: {
      minWidth: 48,
      textAlign: 'center' as const,
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: colors.foreground,
      fontVariant: ['tabular-nums' as const],
    },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.45 },
  };
}
