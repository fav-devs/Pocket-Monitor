import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native';
import type { ReactNode } from 'react';
import { Pressable, type StyleProp, Switch, Text, View, type ViewStyle } from 'react-native';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';

/** Fill for a favorite star: the app's accent yellow reads on any picture. */
export const favoriteColor = '#fedb2e';
/** Over a picture: the pill and its text (ai-cut's duration / source badges). */
export const artPillColor = 'rgba(0,0,0,0.55)';

/** A Hugeicon that can be filled (a favorite star, the play triangle). */
export function Glyph({ icon, size = 20, color, filled = false, strokeWidth = 1.5 }: { icon: IconSvgElement; size?: number; color: string; filled?: boolean; strokeWidth?: number }) {
  return <HugeiconsIcon icon={icon} size={size} color={color} strokeWidth={strokeWidth} fill={filled ? color : 'none'} />;
}

/** A small pill over a picture: duration, "3 frames", "On phone". */
export function ArtPill({ text, icon, style }: { text?: string; icon?: IconSvgElement; style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View pointerEvents="none" style={[styles.artPill, !text && styles.artPillIcon, style]}>
      {icon ? <Icon icon={icon} size={11} color="#ffffff" strokeWidth={2} /> : null}
      {text ? (
        <Text numberOfLines={1} style={styles.artPillText}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

/** A thin progress bar; `onVideo` draws it white on a translucent track. */
export function ProgressBar({ fraction, height = 4, onVideo, style }: { fraction: number; height?: number; onVideo?: boolean; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(f * 100) }}
      style={[{ height, borderRadius: height, overflow: 'hidden', backgroundColor: onVideo ? 'rgba(255,255,255,0.25)' : colors.surfaceStrong }, style]}
    >
      <View style={{ width: `${f * 100}%`, minWidth: f > 0 ? height : 0, height, borderRadius: height, backgroundColor: onVideo ? '#ffffff' : colors.primary }} />
    </View>
  );
}

/** "Native exporter": a quiet tag beside a control that this build can't run. */
export function Tag({ text }: { text: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{text}</Text>
    </View>
  );
}

/** A row with a title, an optional one-line help and a switch (sheet bodies and settings cards). */
export function SwitchRow({
  title,
  help,
  value,
  onChange,
  disabled,
  tag,
  icon,
  last,
  inset = true,
}: {
  title: string;
  help?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  tag?: string;
  /** In a settings card: the 36pt icon well. */
  icon?: IconSvgElement;
  last?: boolean;
  /** Card padding (settings); false for a flat sheet body. */
  inset?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      onPress={() => !disabled && onChange(!value)}
      style={[styles.switchRow, inset && styles.cardRow, !last && inset && styles.rowBorder]}
    >
      {icon ? (
        <Squircle width={36} height={36} radius={12} color={colors.surfaceStrong} style={disabled ? styles.dim : undefined}>
          <Icon icon={icon} size={18} color={colors.foreground} />
        </Squircle>
      ) : null}
      <View style={[styles.switchText, disabled && styles.dim]}>
        <View style={styles.titleLine}>
          <Text style={styles.rowTitle}>{title}</Text>
          {tag ? <Tag text={tag} /> : null}
        </View>
        {help ? <Text style={styles.rowHelp}>{help}</Text> : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: colors.primary, false: colors.surfaceStrong }}
        thumbColor="#ffffff"
        accessibilityLabel={title}
        {...({ activeThumbColor: '#ffffff' } as object)}
      />
    </Pressable>
  );
}

/** A text action in `primary` ("Clear", "Reload"), 44pt tall. */
export function TextAction({ title, onPress, disabled, label, tone = 'primary' }: { title: string; onPress: () => void; disabled?: boolean; label?: string; tone?: 'primary' | 'muted' | 'destructive' }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const color = tone === 'muted' ? colors.mutedForeground : tone === 'destructive' ? colors.destructive : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.textAction, (pressed || disabled) && { opacity: disabled ? 0.4 : 0.7 }]}
    >
      <Text style={[styles.textActionLabel, { color }]}>{title}</Text>
    </Pressable>
  );
}

/** A spinner and a short line ("Loading projects…"). */
export function Busy({ label }: { label: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.busy}>
      <Spinner opacity={1} color={colors.mutedForeground} />
      <Text style={styles.rowHelp}>{label}</Text>
    </View>
  );
}

/** Header icon button (ai-cut home): a bare 22pt icon, or a 32pt round surface well. */
export function HeaderButton({
  icon,
  label,
  onPress,
  disabled,
  round,
  badge,
  busy,
  children,
}: {
  icon: IconSvgElement;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  round?: boolean;
  /** A count in a small dot. */
  badge?: number;
  busy?: boolean;
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.headerButton, round && styles.headerRound, (pressed || disabled) && { opacity: disabled ? 0.35 : 0.7 }]}
    >
      {busy ? <Spinner opacity={1} size={round ? 16 : 20} color={colors.foreground} /> : <Icon icon={icon} size={round ? 17 : 22} color={colors.foreground} />}
      {badge ? (
        <View pointerEvents="none" style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      {children}
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    artPill: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: 999,
      backgroundColor: artPillColor,
    },
    artPillIcon: { paddingHorizontal: 5, paddingVertical: 5 },
    artPillText: { fontFamily: fonts.semibold, fontSize: 10, color: '#ffffff', fontVariant: ['tabular-nums' as const] },
    tag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.surfaceStrong },
    tagText: { fontFamily: fonts.medium, fontSize: 11, color: colors.mutedForeground },
    switchRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, minHeight: 52, paddingVertical: 10 },
    cardRow: { paddingHorizontal: spacing.md },
    rowBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    switchText: { flex: 1, minWidth: 0, gap: 2 },
    titleLine: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, flexWrap: 'wrap' as const },
    rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    rowHelp: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mutedForeground },
    dim: { opacity: 0.45 },
    textAction: { minHeight: 44, justifyContent: 'center' as const, paddingHorizontal: 2 },
    textActionLabel: { fontFamily: fonts.semibold, fontSize: 14 },
    busy: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, minHeight: 32 },
    headerButton: { minWidth: 32, minHeight: 32, alignItems: 'center' as const, justifyContent: 'center' as const, padding: 4 },
    headerRound: { width: 32, height: 32, borderRadius: 16, padding: 0, backgroundColor: colors.surface },
    badge: {
      position: 'absolute' as const,
      top: -2,
      right: -4,
      minWidth: 16,
      height: 16,
      paddingHorizontal: 4,
      borderRadius: 8,
      backgroundColor: colors.primary,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    badgeText: { fontFamily: fonts.semibold, fontSize: 10, color: '#ffffff' },
    radiusLg: { borderRadius: radius.lg },
  };
}
