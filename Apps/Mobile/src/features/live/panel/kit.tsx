import type { IconSvgElement } from '@hugeicons/react-native';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import type { ReactNode } from 'react';
import { Pressable, Switch, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from '@/components/icon';
import { monitorPanel as P } from '@/constants/monitor';
import { fonts, useThemedStyles } from '@/constants/theme';
import { haptics } from '../haptics';

/**
 * Controls for the live view's docked panels, after Mimo: plain rows on a dark panel, a title on
 * the left and a value button, switch or chevron on the right. Fixed dark colours (the monitor is
 * dark whatever the app theme). Every target is at least 44pt.
 */

/** Centred panel title (Mimo's "Video"). */
export function PanelTitle({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.titleRow}>
      {leading ? <View style={styles.titleLeading}>{leading}</View> : null}
      <Text numberOfLines={1} style={styles.title}>
        {children}
      </Text>
    </View>
  );
}

/** A section heading inside a panel (Mimo's "Resolution", "Video Frame Rate"). */
export function PanelHeading({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.headingRow}>
      <Text numberOfLines={1} style={styles.heading}>
        {children}
      </Text>
      {trailing ? <View style={styles.headingTrailing}>{trailing}</View> : null}
    </View>
  );
}

/** A small muted label over a drum (Mimo's "ISO MAX", "Shutter"). */
export function PanelLabel({ children, value, trailing }: { children: ReactNode; value?: string; trailing?: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.labelRow}>
      <Text numberOfLines={1} style={styles.label}>
        {children}
      </Text>
      {value ? <Text style={styles.labelValue}>{value}</Text> : null}
      {trailing ? <View style={styles.headingTrailing}>{trailing}</View> : null}
    </View>
  );
}

/** A plain row: title left, control right, a hairline under it. Tappable when `onPress` is given. */
export function PanelRow({
  title,
  children,
  onPress,
  disabled,
  testID,
  last,
  icon,
}: {
  title: string;
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
  last?: boolean;
  icon?: IconSvgElement;
}) {
  const styles = useThemedStyles(createStyles);
  const body = (
    <>
      {icon ? <Icon icon={icon} size={18} color={P.muted} /> : null}
      <Text numberOfLines={1} style={styles.rowTitle}>
        {title}
      </Text>
      <View style={styles.rowTrailing}>{children}</View>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => {
          haptics.light();
          onPress();
        }}
        style={({ pressed }) => [styles.row, !last && styles.rowLine, disabled && styles.dim, pressed && styles.pressed]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View testID={testID} style={[styles.row, !last && styles.rowLine, disabled && styles.dim]}>
      {body}
    </View>
  );
}

/** A row's value plus a chevron: the row opens a detail (Mimo's "White Balance  Auto ›"). */
export function RowValue({ value }: { value: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.rowValue}>
      <Text numberOfLines={1} style={styles.rowValueText}>
        {value}
      </Text>
      <Icon icon={ArrowRight01Icon} size={18} color={P.text} strokeWidth={2} />
    </View>
  );
}

/** Mimo's outlined value button: tap cycles the value. */
export function ValueButton({
  label,
  onPress,
  disabled,
  accessibilityLabel,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: label }}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => [styles.valueButton, disabled && styles.dim, pressed && styles.pressed]}
    >
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.valueButtonText}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PanelSwitch({ value, onChange, label, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <Switch
      accessibilityLabel={label}
      value={value}
      disabled={disabled}
      onValueChange={(v) => {
        haptics.selection();
        onChange(v);
      }}
      trackColor={{ true: P.chosen, false: P.switchOff }}
      thumbColor="#ffffff"
      {...({ activeThumbColor: '#ffffff' } as object)}
    />
  );
}

/** One of a few as joined boxes; the chosen one white with dark text (Mimo's M | AUTO). */
export function PanelSegments({
  options,
  selected,
  onSelect,
  disabled,
  accessibilityLabel,
  details,
  style,
}: {
  options: string[];
  selected: number;
  onSelect: (i: number) => void;
  disabled?: boolean;
  accessibilityLabel: string;
  details?: (string | undefined)[];
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={[styles.segments, disabled && styles.dim, style]}>
      {options.map((o, i) => {
        const on = i === selected;
        return (
          <Pressable
            key={`${o}-${i}`}
            accessibilityRole="radio"
            accessibilityLabel={o}
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => {
              haptics.selection();
              onSelect(i);
            }}
            style={({ pressed }) => [styles.segment, on && styles.segmentOn, pressed && !on && styles.pressed]}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={[styles.segmentText, on && styles.segmentTextOn]}>
              {o}
            </Text>
            {details?.[i] ? <Text style={[styles.segmentDetail, on && styles.segmentDetailOn]}>{details[i]}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A grid of cells (Mimo's resolution grid): the chosen cell's text in blue. */
export function PanelGrid({
  cells,
  columns = 3,
  disabled,
  accessibilityLabel,
}: {
  cells: { key: string; label: string; detail?: string; chosen: boolean; onPress: () => void }[];
  columns?: number;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={[styles.grid, disabled && styles.dim]}>
      {cells.map((c) => (
        <Pressable
          key={c.key}
          accessibilityRole="radio"
          accessibilityLabel={c.label}
          accessibilityState={{ checked: c.chosen, disabled }}
          disabled={disabled}
          onPress={() => {
            haptics.selection();
            c.onPress();
          }}
          style={({ pressed }) => [styles.cell, { width: `${100 / columns}%` as `${number}%` }, pressed && styles.pressed]}
        >
          <View style={styles.cellInner}>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={[styles.cellText, c.chosen && styles.cellTextOn]}>
              {c.label}
            </Text>
            {c.detail ? <Text style={styles.cellDetail}>{c.detail}</Text> : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/** A small round key with an icon (EV − / +, back from a detail). */
export function PanelKey({
  icon,
  label,
  onPress,
  disabled,
  size = 30,
}: {
  icon: IconSvgElement;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  size?: number;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => [styles.key, disabled && styles.faint, pressed && styles.pressed]}
    >
      <Icon icon={icon} size={size} color={P.text} strokeWidth={1.5} />
    </Pressable>
  );
}

/** A back chevron for a panel's detail page. */
export function PanelBack({ onPress, label = 'Back' }: { onPress: () => void; label?: string }) {
  return <PanelKey icon={ArrowLeft01Icon} label={label} size={22} onPress={onPress} />;
}

/** A short muted line where a label isn't enough. */
export function PanelHint({ children, tone }: { children: ReactNode; tone?: 'warning' }) {
  const styles = useThemedStyles(createStyles);
  return <Text style={[styles.hint, tone === 'warning' && styles.hintWarning]}>{children}</Text>;
}

/** A small on/off key beside a label (Auto, Angle): white when on. */
export function PanelToggleKey({ label, on, onPress, accessibilityLabel }: { label: string; on: boolean; onPress: () => void; accessibilityLabel: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: on }}
      hitSlop={{ top: 11, bottom: 11, left: 4, right: 4 }}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => [styles.toggle, on && styles.toggleOn, pressed && styles.pressed]}
    >
      <Text style={[styles.toggleText, on && styles.toggleTextOn]}>{label}</Text>
    </Pressable>
  );
}

function createStyles() {
  return {
    titleRow: { height: 48, alignItems: 'center' as const, justifyContent: 'center' as const, borderBottomWidth: 1, borderBottomColor: P.hairline },
    titleLeading: { position: 'absolute' as const, left: 8, top: 0, bottom: 0, justifyContent: 'center' as const },
    title: { fontFamily: fonts.semibold, fontSize: 17, color: P.text },
    headingRow: { flexDirection: 'row' as const, alignItems: 'center' as const, minHeight: 36, paddingHorizontal: 16 },
    heading: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: P.text },
    headingTrailing: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, marginLeft: 'auto' as const },
    labelRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, minHeight: 26, paddingHorizontal: 16, paddingTop: 8 },
    label: { fontFamily: fonts.semibold, fontSize: 13, color: P.muted },
    labelValue: { fontFamily: fonts.medium, fontSize: 12, color: P.muted, fontVariant: ['tabular-nums' as const] },
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, minHeight: 52, paddingHorizontal: 16 },
    rowLine: { borderBottomWidth: 1, borderBottomColor: P.hairline },
    rowTitle: { flex: 1, fontFamily: fonts.medium, fontSize: 15, color: P.text },
    rowTrailing: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
    rowValue: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
    rowValueText: { fontFamily: fonts.medium, fontSize: 15, color: P.text },
    valueButton: {
      minWidth: 104,
      height: 32,
      paddingHorizontal: 12,
      borderRadius: 6,
      borderWidth: 1.2,
      borderColor: P.outline,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    valueButtonText: { fontFamily: fonts.semibold, fontSize: 14, color: P.text },
    segments: { flexDirection: 'row' as const, borderRadius: 6, overflow: 'hidden' as const, backgroundColor: P.well },
    segment: { flex: 1, minHeight: 40, paddingHorizontal: 6, alignItems: 'center' as const, justifyContent: 'center' as const },
    segmentOn: { backgroundColor: '#ffffff' },
    segmentText: { fontFamily: fonts.bold, fontSize: 15, color: P.text },
    segmentTextOn: { color: P.dark },
    segmentDetail: { fontFamily: fonts.medium, fontSize: 10, color: P.muted, fontVariant: ['tabular-nums' as const] },
    segmentDetailOn: { color: 'rgba(0,0,0,0.6)' },
    grid: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, marginHorizontal: 16, borderRadius: 4, overflow: 'hidden' as const },
    cell: { padding: 1 },
    cellInner: { minHeight: 44, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 4 },
    cellText: { fontFamily: fonts.semibold, fontSize: 15, color: P.text },
    cellTextOn: { color: P.chosen },
    cellDetail: { fontFamily: fonts.medium, fontSize: 10, color: P.muted, fontVariant: ['tabular-nums' as const] },
    key: { width: 44, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    hint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: P.muted, paddingHorizontal: 16, paddingVertical: 6 },
    hintWarning: { color: '#fbbf24' },
    toggle: {
      height: 22,
      minWidth: 44,
      paddingHorizontal: 10,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: P.faint,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    toggleOn: { backgroundColor: '#ffffff', borderColor: '#ffffff' },
    toggleText: { fontFamily: fonts.semibold, fontSize: 12, color: P.text },
    toggleTextOn: { color: P.dark },
    dim: { opacity: 0.4 },
    faint: { opacity: 0.3 },
    pressed: { opacity: 0.65 },
  };
}
