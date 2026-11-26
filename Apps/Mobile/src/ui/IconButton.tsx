import type { LucideIcon } from 'lucide-react-native';
import { colors, radius, withAlpha } from '@/theme';
import { PressableScale } from './PressableScale';

export interface IconButtonProps {
  icon: LucideIcon;
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  active?: boolean;
  size?: number;
  iconSize?: number;
  tint?: string;
  /** 'raised' solid surface, 'glass' translucent for live chrome, 'bare' no fill. */
  variant?: 'raised' | 'glass' | 'bare';
  disabled?: boolean;
}

/** `MonitorIconButton`: 20pt glyph in a 44pt rounded target. */
export function IconButton({
  icon: Icon,
  label,
  onPress,
  onLongPress,
  active,
  size = 44,
  iconSize = 20,
  tint,
  variant = 'raised',
  disabled,
}: IconButtonProps) {
  const fg = tint ?? (active ? colors.accent : colors.secondary);
  const bg = active
    ? withAlpha(colors.accent, 0.14)
    : variant === 'raised'
      ? colors.raised
      : variant === 'glass'
        ? colors.glass
        : 'transparent';
  return (
    <PressableScale
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      style={{ width: size, height: size, borderRadius: radius.md, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon size={iconSize} color={fg} strokeWidth={1.8} />
    </PressableScale>
  );
}
