import { Camera01Icon, SmartPhone01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { SignalBars } from './StatusBits';

const WELL = 36;
const WELL_RADIUS = 12;

/** A flat `surface` card that groups rows (the Settings group look), with an optional label over it. */
export function ListGroup({ label, children }: { label?: string; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.groupBlock}>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <View style={styles.group}>{children}</View>
    </View>
  );
}

export interface Instruction {
  title: string;
  icon: 'camera' | 'phone';
  lines: readonly string[];
}

/** "On the camera" / "On iPhone" note: a small heading and a few short lines (`instructionCard`). */
export function InstructionCard({ instruction }: { instruction: Instruction }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.card}>
      <View style={styles.cardHeading}>
        <Squircle width={28} height={28} radius={9} color={colors.surfaceStrong}>
          <Icon icon={instruction.icon === 'camera' ? Camera01Icon : SmartPhone01Icon} size={15} color={colors.foreground} />
        </Squircle>
        <Text style={styles.cardTitle}>{instruction.title}</Text>
      </View>
      {instruction.lines.map((line) => (
        <View key={line} style={styles.bullet}>
          <View style={styles.bulletDot} />
          <Text style={styles.bulletText}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

/** A plain informational row in a `ListGroup`: icon or number well, title, detail. */
export function InfoRow({
  icon,
  number,
  title,
  detail,
  last,
  trailing,
}: {
  icon?: IconSvgElement;
  number?: number;
  title: string;
  detail?: string;
  last?: boolean;
  trailing?: ReactNode;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <Squircle width={WELL} height={WELL} radius={WELL_RADIUS} color={colors.surfaceStrong}>
        {number ? (
          <Text style={styles.number}>{String(number)}</Text>
        ) : (
          <Icon icon={icon ?? Tick02Icon} size={18} color={colors.foreground} strokeWidth={1.7} />
        )}
      </Squircle>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text style={styles.rowMeta}>{detail}</Text> : null}
      </View>
      {trailing}
    </View>
  );
}

/** One choosable row in a `ListGroup`: squircle icon well, title, detail, radio tick. */
export function ChoiceRow({
  icon,
  title,
  subtitle,
  meta,
  selected,
  disabled,
  badge,
  bars,
  onPress,
  last,
  testID,
  accessibilityLabel,
}: {
  icon: IconSvgElement;
  title: string;
  subtitle?: string;
  /** A second, quieter line (a tag, "Added · Studio"). */
  meta?: string;
  selected: boolean;
  disabled?: boolean;
  badge?: string;
  bars?: number;
  onPress: () => void;
  last?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ selected, checked: selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [pressed && styles.pressed]}
    >
      <View style={[styles.row, !last && styles.rowBorder, disabled && styles.disabled]}>
        <Squircle width={WELL} height={WELL} radius={WELL_RADIUS} color={selected ? colors.ink : colors.surfaceStrong}>
          <Icon icon={icon} size={18} color={selected ? colors.inkForeground : colors.foreground} strokeWidth={1.7} />
        </Squircle>
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {title}
          </Text>
          {subtitle ? <Text style={styles.rowMeta}>{subtitle}</Text> : null}
          {meta ? <Text style={[styles.rowMeta, styles.rowTag]}>{meta}</Text> : null}
        </View>
        {badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
        {bars !== undefined ? <SignalBars count={bars} /> : null}
        <View style={[styles.radio, selected && styles.radioOn]}>
          {selected ? <Icon icon={Tick02Icon} size={14} color={colors.inkForeground} strokeWidth={2.4} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

export interface DeviceRowItem {
  id: string;
  name: string;
  subtitle: string;
  selected: boolean;
  bars?: number;
  disabled?: boolean;
  badge?: string;
}

/** One camera in the scan list (`CameraPairingDeviceRow`). */
export function DeviceRow({ device, onPress, last }: { device: DeviceRowItem; onPress: () => void; last?: boolean }) {
  return (
    <ChoiceRow
      testID={`pair.device.${device.id}`}
      accessibilityLabel={`Select ${device.name}`}
      icon={Camera01Icon}
      title={device.name}
      subtitle={device.subtitle}
      selected={device.selected}
      disabled={device.disabled}
      badge={device.badge}
      bars={device.bars}
      onPress={onPress}
      last={last}
    />
  );
}

/** A quiet one-row note, with a spinner while something is still happening (`emptyTitle`). */
export function NoteCard({ title, detail, busy }: { title: string; detail?: string; busy?: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.card, styles.note]}>
      {busy ? <Spinner size={18} opacity={1} color={colors.mutedForeground} /> : null}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text style={styles.rowMeta}>{detail}</Text> : null}
      </View>
    </View>
  );
}

/** Label / value rows for what is being connected (`presentation.summary`). */
export function SummaryGrid({ items }: { items: { title: string; value: string }[]; columns?: number }) {
  const styles = useThemedStyles(createStyles);
  return (
    <ListGroup>
      {items.map((d, i) => (
        <View key={d.title} style={[styles.summaryRow, i < items.length - 1 && styles.rowBorder]}>
          <Text style={styles.summaryLabel}>{d.title}</Text>
          <Text numberOfLines={2} style={styles.summaryValue}>
            {d.value}
          </Text>
        </View>
      ))}
    </ListGroup>
  );
}

function createStyles(colors: ThemeColors) {
  const hairline = StyleSheet.hairlineWidth;
  return {
    groupBlock: { gap: spacing.sm },
    groupLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground, paddingHorizontal: 4 },
    group: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' as const },
    card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: 10 },
    cardHeading: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, marginBottom: 2 },
    cardTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.foreground },
    bullet: { flexDirection: 'row' as const, gap: 10, paddingLeft: 11 },
    bulletDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.mutedForeground, marginTop: 8 },
    bulletText: { flex: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.foreground },
    note: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingVertical: 14 },
    row: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 12,
      paddingHorizontal: spacing.md,
      paddingVertical: 12,
      minHeight: 60,
    },
    rowBorder: { borderBottomWidth: hairline, borderBottomColor: colors.border },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    rowMeta: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mutedForeground },
    rowTag: { fontFamily: fonts.medium },
    number: { fontFamily: fonts.semibold, fontSize: 14, color: colors.foreground },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong },
    badgeText: { fontFamily: fonts.medium, fontSize: 11, color: colors.mutedForeground },
    radio: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: colors.borderStrong,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    radioOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    summaryRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 13,
      minHeight: 48,
    },
    summaryLabel: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground },
    summaryValue: { flex: 1, textAlign: 'right' as const, fontFamily: fonts.medium, fontSize: 14, color: colors.foreground },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.45 },
  };
}
