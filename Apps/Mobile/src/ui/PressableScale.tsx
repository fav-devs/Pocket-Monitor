import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { motion } from '@/theme';

export interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /** Disable the press scale (keeps the opacity dip). */
  noScale?: boolean;
}

/** `MonitorButtonStyle`: dim + slight scale while pressed, 44pt hit slop by default. */
export function PressableScale({ style, noScale, hitSlop = 6, ...rest }: PressableScaleProps) {
  return (
    <Pressable
      hitSlop={hitSlop}
      accessibilityRole="button"
      {...rest}
      style={({ pressed }) => [
        style,
        pressed && { opacity: motion.pressOpacity, transform: noScale ? undefined : [{ scale: motion.pressScale }] },
        rest.disabled && { opacity: 0.4 },
      ]}
    />
  );
}
