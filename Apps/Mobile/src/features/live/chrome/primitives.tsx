import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { colors, radius, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import type { Rect } from '../layout/fieldMonitorLayout';

/** `monitorReadoutShadow`: readouts stay legible on a bright picture. */
export const readoutShadow: TextStyle = {
  textShadowColor: 'rgba(0,0,0,0.65)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
};

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

/** `MonitorChromeButton`: 48pt dark rounded plate, 26pt glyph. Lock, settings, media. */
export function ChromeButton({
  icon: Icon,
  label,
  onPress,
  onLongPress,
  size = 48,
  active,
  disabled,
  tint,
  children,
  testID,
}: {
  icon?: LucideIcon;
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  size?: number;
  active?: boolean;
  disabled?: boolean;
  tint?: string;
  children?: ReactNode;
  testID?: string;
}) {
  return (
    <PressableScale
      testID={testID}
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      style={{
        width: size,
        height: size,
        borderRadius: radius.md + 2,
        backgroundColor: active ? withAlpha(colors.accent, 0.18) : 'rgba(20,21,22,0.78)',
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {Icon ? <Icon size={Math.round((size * 29) / 54)} color={tint ?? (active ? colors.accent : colors.text)} strokeWidth={1.7} /> : null}
      {children}
    </PressableScale>
  );
}

/** Pill capsule on picture (`glassCapsule`). */
export function Capsule({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        {
          borderRadius: radius.pill,
          backgroundColor: 'rgba(0,0,0,0.65)',
          paddingHorizontal: 8,
          paddingVertical: 4,
          flexDirection: 'row',
          alignItems: 'center',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
