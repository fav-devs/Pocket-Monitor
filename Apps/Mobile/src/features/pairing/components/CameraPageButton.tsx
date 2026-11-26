import type { LucideIcon } from 'lucide-react-native';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { MText, colors, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';

export const onAccentInk = '#08191F';

export interface CameraPageButtonProps {
  title: string;
  onPress?: () => void;
  primary?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** Stretch to the container width. */
  block?: boolean;
  testID?: string;
}

/** The app's standard action button (`CameraPageButtonStyle`). Destructive uses record red. */
export function CameraPageButton({
  title,
  onPress,
  primary,
  destructive,
  disabled,
  icon: Icon,
  accessibilityLabel,
  style,
  block,
  testID,
}: CameraPageButtonProps) {
  const fg = primary ? onAccentInk : destructive ? colors.recording : colors.secondary;
  const bg = primary ? colors.accent : destructive ? withAlpha(colors.recording, 0.12) : 'rgba(255,255,255,0.06)';
  return (
    <PressableScale
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel ?? title}
      style={[
        {
          minHeight: 44,
          paddingHorizontal: 17,
          borderRadius: 11,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          alignSelf: block ? 'stretch' : 'auto',
        },
        style,
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        {Icon ? <Icon size={14} color={fg} strokeWidth={2} /> : null}
        <MText size={13} weight="semibold" color={fg} numberOfLines={1}>
          {title}
        </MText>
      </View>
    </PressableScale>
  );
}
