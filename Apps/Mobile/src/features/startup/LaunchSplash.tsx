import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View, useWindowDimensions } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { MText, fonts, withAlpha } from '@/theme';
import { appBrand, launchLayout, launchTiming } from './brand';

const markSurface = '#1C1C1C';

/** App mark: a drawn monogram plate (`MonitorBrandMark` fallback when no AppLogo raster). */
export function BrandMark({ size = 72 }: { size?: number }) {
  const corner = size * 0.22;
  return (
    <View
      accessibilityLabel={appBrand.name}
      style={{
        width: size,
        height: size,
        borderRadius: corner,
        backgroundColor: markSurface,
        borderWidth: Math.max(1, size * 0.018),
        borderColor: withAlpha(appBrand.accent, 0.55),
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOpacity: 0.35,
        shadowRadius: size * 0.08,
        shadowOffset: { width: 0, height: size * 0.04 },
      }}
    >
      <MText
        weight="bold"
        size={size * 0.34}
        color={appBrand.accent}
        tracking={size * 0.02}
        style={{ fontFamily: fonts.bold, lineHeight: size * 0.42 }}
      >
        {appBrand.monogram}
      </MText>
    </View>
  );
}

/** The app's name as the launch splash sets it, with an optional subtitle. */
export function BrandWordmark({ fontSize = 34, subtitle }: { fontSize?: number; subtitle?: string }) {
  return (
    <View style={{ gap: fontSize * 0.18 }}>
      <MText weight="bold" size={fontSize} color="#FFFFFF" style={{ lineHeight: fontSize * 1.2 }}>
        {appBrand.name}
      </MText>
      {subtitle ? (
        <MText weight="medium" size={fontSize * 0.38} color="#A0A5A5">
          {subtitle}
        </MText>
      ) : null}
    </View>
  );
}

/** Near-black diagonal with the brand glow from the top leading corner (`MonitorBrandBackdrop`). */
export function BrandBackdrop() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={['#080808', '#0E0E0E', '#080808']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <RadialGradient id="pm-launch-glow" cx="0" cy="0" r="420" gradientUnits="userSpaceOnUse">
            <Stop offset="0.05" stopColor={appBrand.glow} stopOpacity={0.28} />
            <Stop offset="1" stopColor={appBrand.glow} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#pm-launch-glow)" />
      </Svg>
    </View>
  );
}

/** Launch geometry over the brand marks (`MonitorBrandLaunchSplash`). */
export function LaunchSplashContent({ compact }: { compact?: boolean }) {
  const { width, height } = useWindowDimensions();
  const layout = launchLayout(width, height, compact);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: '#080808' }]}>
      <BrandBackdrop />
      <View
        style={{
          flex: 1,
          flexDirection: layout.landscape ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: layout.spacing,
          paddingHorizontal: layout.horizontalInset,
        }}
      >
        <BrandMark size={layout.logoSize} />
        <BrandWordmark fontSize={layout.wordmarkSize} />
      </View>
    </View>
  );
}

let launchSplashShown = false;

/**
 * Cold-start splash overlay (`MonitorLaunchSplashOverlay`). Shows once per process, for the
 * shared launch duration, then fades out and stops taking touches.
 */
export function LaunchSplashOverlay() {
  const [visible, setVisible] = useState(() => !launchSplashShown);
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!visible) return;
    launchSplashShown = true;
    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: launchTiming.fadeOutMs,
        useNativeDriver: false,
      }).start(() => setVisible(false));
    }, launchTiming.visibleMs);
    return () => clearTimeout(timer);
  }, [visible, opacity]);

  if (!visible) return null;
  return (
    <Animated.View
      testID="monitor-launch-splash"
      accessible
      accessibilityLabel={appBrand.name}
      style={[StyleSheet.absoluteFill, { opacity, zIndex: 100 }]}
    >
      <LaunchSplashContent />
    </Animated.View>
  );
}
