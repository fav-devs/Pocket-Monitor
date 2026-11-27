import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Text, View } from 'react-native';
import type { CameraNotice } from '@/camera';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { onVideo } from './primitives';

/**
 * `MonitorTransientNotice`: one ai-cut toast (`rgba(0,0,0,0.65)`, radius 12, 14 medium,
 * centred); a coloured dot marks success / warning / error. A new notice replaces the visible
 * one and fades after 2.5 s. Never takes touches.
 */
export function MonitorTransientNotice({ notices, onExpire, top }: { notices: CameraNotice[]; onExpire: (id: string) => void; top: number }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
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
  const dot = shown.tone === 'success' ? colors.success : shown.tone === 'warning' ? colors.warning : shown.tone === 'error' ? colors.destructive : null;
  return (
    <View pointerEvents="none" style={[styles.host, { top }]}>
      <Animated.View accessibilityLiveRegion="polite" accessibilityRole="alert" style={[styles.toast, { opacity }]}>
        {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
        <Text numberOfLines={2} style={styles.text}>
          {shown.message}
        </Text>
      </Animated.View>
    </View>
  );
}

function createStyles(_colors: ThemeColors) {
  return {
    host: { position: 'absolute' as const, left: 32, right: 32, alignItems: 'center' as const },
    toast: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      maxWidth: 420,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 12,
      backgroundColor: onVideo.notice,
    },
    dot: { width: 7, height: 7, borderRadius: 3.5 },
    text: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 14, color: onVideo.ink, textAlign: 'center' as const },
  };
}
