import type { IconSvgElement } from '@hugeicons/react-native';
import type { ComponentType } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from '@/components/icon';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';

/** Legacy ink for text on an accent fill; kept for callers that still import it. */
export const onAccentInk = '#111111';

/** A glyph component (older screens) or a Hugeicons icon. */
type ButtonIcon = IconSvgElement | ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

export interface CameraPageButtonProps {
  title: string;
  onPress?: () => void;
  primary?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  icon?: ButtonIcon;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** Stretch to the container width. */
  block?: boolean;
  testID?: string;
}

/**
 * A compact page action in the app's button style: ink when primary, a soft red well when
 * destructive, a plain surface otherwise. Page CTAs use `Button size="lg"` instead.
 */
export function CameraPageButton({
  title,
  onPress,
  primary,
  destructive,
  disabled,
  icon,
  accessibilityLabel,
  style,
  block,
  testID,
}: CameraPageButtonProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const fg = primary ? colors.inkForeground : destructive ? colors.destructive : colors.foreground;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        primary ? styles.primary : destructive ? styles.destructive : styles.plain,
        block && styles.block,
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      <View style={styles.content}>
        {icon ? <ButtonGlyph icon={icon} color={fg} /> : null}
        <Text numberOfLines={1} style={[styles.label, { color: fg }]}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

function ButtonGlyph({ icon, color }: { icon: ButtonIcon; color: string }) {
  if (Array.isArray(icon)) return <Icon icon={icon as IconSvgElement} size={16} color={color} strokeWidth={2} />;
  const Glyph = icon as ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  return <Glyph size={15} color={color} strokeWidth={2} />;
}

function createStyles(colors: ThemeColors) {
  return {
    base: {
      minHeight: 44,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md - 2,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    primary: { backgroundColor: colors.ink },
    destructive: { backgroundColor: colors.destructiveSoft },
    plain: { backgroundColor: colors.surface },
    block: { alignSelf: 'stretch' as const },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.75 },
    content: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm - 1 },
    label: { fontFamily: fonts.semibold, fontSize: 14 },
  };
}
