import { BlurView } from 'expo-blur';
import { Platform, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { colors, radius as radii } from '@/theme';

export interface GlassSurfaceProps extends ViewProps {
  radius?: number;
  intensity?: number;
  style?: StyleProp<ViewStyle>;
  strong?: boolean;
}

/** Floating live chrome material (`MonitorGlassSurface`): blur + dark tint + hairline. */
export function GlassSurface({ radius = radii.md, intensity = 30, strong, style, children, ...rest }: GlassSurfaceProps) {
  const tint = strong ? colors.glassStrong : colors.glass;
  const frame: ViewStyle = { borderRadius: radius, overflow: 'hidden', borderWidth: 1, borderColor: colors.border };
  if (Platform.OS === 'android') {
    // Android blur is expensive over a live video surface; use a solid translucent fill.
    return (
      <View {...rest} style={[frame, { backgroundColor: colors.glassStrong }, style]}>
        {children}
      </View>
    );
  }
  return (
    <BlurView {...rest} intensity={intensity} tint="dark" style={[frame, { backgroundColor: tint }, style]}>
      {children}
    </BlurView>
  );
}
