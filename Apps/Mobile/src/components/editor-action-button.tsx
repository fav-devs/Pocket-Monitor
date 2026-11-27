import type { ReactNode } from 'react';
import { Platform, Pressable } from 'react-native';
import type { IconSvgElement } from '@hugeicons/react-native';
import { ArrowLeft01Icon, ComputerPhoneSyncIcon, KeyframeIcon, Layers01Icon, PauseIcon, PlayIcon, Redo02Icon, Undo02Icon } from '@hugeicons/core-free-icons';
import { Icon } from './icon';
import { Squircle } from './squircle';
import { useTheme } from '@/constants/theme';
import { EDITOR_PRESS_GLASS, PressGlassButton } from './press-glass-button';


const SYMBOLS = new Map<IconSvgElement, string>([
  [ArrowLeft01Icon, 'chevron.left'], [ComputerPhoneSyncIcon, 'desktopcomputer'],
  [KeyframeIcon, 'diamond'], [Layers01Icon, 'square.3.layers.3d'],
  [PauseIcon, 'pause.fill'], [PlayIcon, 'play.fill'],
  [Undo02Icon, 'arrow.uturn.backward'], [Redo02Icon, 'arrow.uturn.forward'],
]);

/** Press-only glass on supported iOS builds, with the existing platform fallbacks. */
export function EditorActionButton({ icon, symbol = SYMBOLS.get(icon), label, onPress, disabled = false, active = false,
  primary = false, size = primary ? 40 : 36, radius = EDITOR_PRESS_GLASS.radius, iconSize = 18, iconNode, expanded, selected = active, color, plain = false, children,
}: {
  icon: IconSvgElement; symbol?: string; label: string; onPress: () => void;
  disabled?: boolean; active?: boolean; primary?: boolean; size?: number; radius?: number;
  iconSize?: number; /** Drawn in place of the icon (a ◇ that is hollow or filled). */ iconNode?: ReactNode; expanded?: boolean; selected?: boolean; color?: string; plain?: boolean; children?: ReactNode | ((pressed: boolean) => ReactNode);
}) {
  const { colors } = useTheme();
  const filled = primary || active;
  const surface = plain ? 'transparent' : filled ? colors.ink : colors.surface;
  const foreground = color ?? (filled && !plain ? colors.inkForeground : colors.foreground);
  if (Platform.OS === 'ios') return <PressGlassButton label={label} size={size} radius={radius}
    surfaceColor={surface} tintColor={EDITOR_PRESS_GLASS.tintColor}
    expansion={EDITOR_PRESS_GLASS.expansion} duration={EDITOR_PRESS_GLASS.duration}
    disabled={disabled} selected={selected} expanded={expanded} onPress={onPress}>
    {pressed => (typeof children === 'function' ? children(pressed) : children) ?? iconNode ?? <Icon icon={icon} size={iconSize} color={color ?? (pressed ? colors.foreground : foreground)} />}
  </PressGlassButton>;
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, selected, expanded }} disabled={disabled} onPress={onPress} hitSlop={4}
    style={({ pressed }) => ({ flexShrink: 0, opacity: disabled ? 0.3 : pressed ? 0.65 : 1 })}>
    {(typeof children === 'function' ? children(false) : children) ?? <Squircle width={size} height={size} radius={radius} color={surface}>
      {iconNode ?? <Icon icon={icon} size={iconSize} color={foreground} />}
    </Squircle>}
  </Pressable>;
}
