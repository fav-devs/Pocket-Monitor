import { useEffect } from 'react';
import { Platform } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { recordRed } from '@/constants/monitor';

/** `MonitorRecordingBorder`: REC tally on the screen bezel, a 4pt record-red stroke with a slow pulse. */
export function MonitorRecordingBorder({ cornerRadius = 52 }: { cornerRadius?: number }) {
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.45, { duration: 700, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          borderWidth: 4,
          borderColor: recordRed,
          borderRadius: Platform.OS === 'web' ? 0 : cornerRadius,
          shadowColor: recordRed,
          shadowOpacity: 0.55,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 0 },
        },
        style,
      ]}
    />
  );
}
