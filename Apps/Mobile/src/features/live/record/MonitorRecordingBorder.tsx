import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { colors } from '@/theme';

const useNative = Platform.OS !== 'web';

/** `MonitorRecordingBorder`: REC tally on the screen bezel, a 4pt red stroke with a slow pulse. */
export function MonitorRecordingBorder({ cornerRadius = 52 }: { cornerRadius?: number }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: useNative }),
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: useNative }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        borderWidth: 4,
        borderColor: colors.recording,
        borderRadius: Platform.OS === 'web' ? 0 : cornerRadius,
        opacity: pulse,
        shadowColor: colors.recording,
        shadowOpacity: 0.55,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 0 },
      }}
    />
  );
}
