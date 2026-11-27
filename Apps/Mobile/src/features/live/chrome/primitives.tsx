import type { IconSvgElement } from '@hugeicons/react-native';
import type { ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Icon } from '@/components/icon';
import { fonts, type ThemeColors, useThemedStyles } from '@/constants/theme';
import type { Rect } from '../layout/fieldMonitorLayout';

/**
 * On-video chrome (after the Sondr camera screen). The monitor is
 * always dark whatever the app theme, so these read white over the picture; theme colours are
 * used for accent, recording and status.
 */
export const onVideo = {
  ink: '#ffffff',
  inkMuted: 'rgba(255,255,255,0.62)',
  inkFaint: 'rgba(255,255,255,0.32)',
  /** Text on a white (chosen) or accent fill. */
  dark: '#111111',
  rail: 'rgba(0,0,0,0.25)',
  pill: 'rgba(0,0,0,0.45)',
  plate: 'rgba(0,0,0,0.45)',
  notice: 'rgba(0,0,0,0.65)',
  well: 'rgba(255,255,255,0.18)',
  chosen: '#ffffff',
  guide: 'rgba(255,255,255,0.35)',
} as const;

/** `#rrggbb` at `alpha`. */
export function withAlphaHex(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** White text over video. */
export const textShadow: TextStyle = { textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 };

export function rectStyle(r: Rect): ViewStyle {
  return { position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height };
}

/** Absolutely placed slot at a layout rect. */
export function Slot({
  rect,
  children,
  style,
  pointerEvents = 'box-none',
}: {
  rect: Rect;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  pointerEvents?: 'box-none' | 'none' | 'auto' | 'box-only';
}) {
  return (
    <View pointerEvents={pointerEvents} style={[rectStyle(rect), style]}>
      {children}
    </View>
  );
}

/**
 * ai-cut camera rail button: a 40pt translucent circle with a white icon and an 11pt caption
 * under it. Active fills the circle with accent and darkens the icon.
 */
export function RailButton({
  icon,
  label,
  caption = label,
  onPress,
  onLongPress,
  active = false,
  disabled = false,
  testID,
  accessibilityValue,
  children,
}: {
  icon?: IconSvgElement;
  label: string;
  caption?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  active?: boolean;
  disabled?: boolean;
  testID?: string;
  accessibilityValue?: { text: string };
  /** Drawn in the circle in place of the icon. */
  children?: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={accessibilityValue}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={4}
      style={({ pressed }) => [styles.railButton, disabled && styles.dim, pressed && styles.pressed]}
    >
      <View style={[styles.railCircle, active && styles.railCircleActive]}>
        {children ?? (icon ? <Icon icon={icon} size={20} color={active ? onVideo.dark : onVideo.ink} strokeWidth={1.8} /> : null)}
      </View>
      {caption ? (
        <Text numberOfLines={1} style={styles.railCaption}>
          {caption}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * A status pill over video: `rgba(0,0,0,0.45)`, capsule, 12–13pt white. Tappable pills that
 * open a sheet turn white with dark text while it is open.
 */
export function VideoPill({
  label,
  onPress,
  disabled,
  chosen = false,
  testID,
  accessibilityValue,
  style,
  children,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  chosen?: boolean;
  testID?: string;
  accessibilityValue?: { text: string };
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={label} accessibilityValue={accessibilityValue} style={[styles.pill, chosen && styles.pillChosen, style]}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={accessibilityValue}
      accessibilityState={{ selected: chosen, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 3, right: 3 }}
      style={({ pressed }) => [styles.pill, chosen && styles.pillChosen, pressed && styles.pressed, style]}
    >
      {children}
    </Pressable>
  );
}

/** Pill text: 12pt semibold white, or dark on a chosen pill. */
export function PillText({ children, chosen, color, mono }: { children: ReactNode; chosen?: boolean; color?: string; mono?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Text numberOfLines={1} style={[styles.pillText, mono && styles.mono, { color: chosen ? onVideo.dark : (color ?? onVideo.ink) }]}>
      {children}
    </Text>
  );
}

/** A dark translucent plate under meters and scopes (no border). */
export function VideoPlate({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(createStyles);
  return <View style={[styles.plate, style]}>{children}</View>;
}

function createStyles(colors: ThemeColors) {
  return {
    railButton: { width: 56, alignItems: 'center' as const, gap: 4 },
    railCircle: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: onVideo.rail,
    },
    railCircleActive: { backgroundColor: colors.accent },
    railCaption: { fontFamily: fonts.medium, fontSize: 11, lineHeight: 14, color: onVideo.ink, ...textShadow },
    pill: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 5,
      height: 28,
      paddingHorizontal: 10,
      borderRadius: 999,
      backgroundColor: onVideo.pill,
    },
    pillChosen: { backgroundColor: onVideo.chosen },
    pillText: { fontFamily: fonts.semibold, fontSize: 12, color: onVideo.ink },
    mono: { fontVariant: ['tabular-nums' as const] },
    plate: { borderRadius: 12, backgroundColor: onVideo.plate },
    dim: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
  };
}
