import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, View } from 'react-native';
import type { CameraNotice } from '@/camera';
import { MText, colors, radius } from '@/theme';

const TONE: Record<CameraNotice['tone'], string> = {
  info: colors.text,
  success: colors.linkStable,
  warning: colors.linkWatch,
  error: colors.recording,
};

/**
 * `MonitorTransientNotice`: one glass capsule; a new notice replaces the visible one and
 * fades after 2.5 s. Never takes touches.
 */
export function MonitorTransientNotice({ notices, onExpire, top }: { notices: CameraNotice[]; onExpire: (id: string) => void; top: number }) {
  const latest = notices[notices.length - 1];
  const [shown, setShown] = useState<CameraNotice | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    if (!latest) return;
    setShown(latest);
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start();
    const t = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start(() => {
        expire.current(latest.id);
      });
    }, 2500);
    return () => clearTimeout(t);
  }, [latest, opacity]);

  if (!shown) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top, alignItems: 'center' }}>
      <Animated.View
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={{
          opacity,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: radius.pill,
          backgroundColor: colors.glassStrong,
          borderWidth: 1,
          borderColor: colors.border,
          maxWidth: 420,
        }}
      >
        <MText size={13} weight="medium" color={TONE[shown.tone]} numberOfLines={2} align="center">
          {shown.message}
        </MText>
      </Animated.View>
    </View>
  );
}
