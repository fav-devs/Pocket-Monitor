import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Squircle } from '@/components/squircle';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { appBrand, launchLayout, launchTiming } from './brand';

/** App mark: the PM monogram on an ink squircle, with the record dot (`MonitorBrandMark`). */
export function BrandMark({ size = 72 }: { size?: number }) {
  const { colors } = useTheme();
  const dot = Math.max(5, Math.round(size * 0.11));
  return (
    <Squircle
      accessibilityLabel={appBrand.name}
      width={size}
      height={size}
      radius={Math.round(size * 0.3)}
      color={colors.ink}
    >
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: Math.round(size * 0.36),
          lineHeight: Math.round(size * 0.44),
          letterSpacing: -size * 0.01,
          color: colors.inkForeground,
        }}
      >
        {appBrand.monogram}
      </Text>
      <View
        style={{
          position: 'absolute',
          top: Math.round(size * 0.17),
          right: Math.round(size * 0.17),
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: colors.dotPink,
        }}
      />
    </Squircle>
  );
}

/** The app's name as the launch splash sets it, with an optional subtitle. */
export function BrandWordmark({ fontSize = 30, subtitle }: { fontSize?: number; subtitle?: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={{ gap: Math.round(fontSize * 0.12) }}>
      <Text style={[styles.wordmark, { fontSize, lineHeight: Math.round(fontSize * 1.2), letterSpacing: -fontSize * 0.025 }]}>
        {appBrand.name}
      </Text>
      {subtitle ? <Text style={[styles.subtitle, { fontSize: Math.max(12, Math.round(fontSize * 0.45)) }]}>{subtitle}</Text> : null}
    </View>
  );
}

/** Launch geometry over the brand marks (`MonitorBrandLaunchSplash`). */
export function LaunchSplashContent({ compact }: { compact?: boolean }) {
  const { width, height } = useWindowDimensions();
  const styles = useThemedStyles(createStyles);
  const layout = launchLayout(width, height, compact);
  return (
    <View style={[StyleSheet.absoluteFill, styles.page]}>
      <View
        style={[
          styles.lockup,
          {
            flexDirection: layout.landscape ? 'row' : 'column',
            gap: layout.spacing,
            paddingHorizontal: layout.horizontalInset,
          },
        ]}
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
  const styles = useThemedStyles(createStyles);
  const [visible, setVisible] = useState(() => !launchSplashShown);
  const opacity = useRef(new Animated.Value(1)).current;
  const lockup = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    launchSplashShown = true;
    // The mark settles in quietly while the app loads behind it.
    Animated.timing(lockup, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: launchTiming.fadeOutMs,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: false,
      }).start(() => setVisible(false));
    }, launchTiming.visibleMs);
    return () => clearTimeout(timer);
  }, [visible, opacity, lockup]);

  if (!visible) return null;
  return (
    <Animated.View
      testID="monitor-launch-splash"
      accessible
      accessibilityLabel={appBrand.name}
      style={[StyleSheet.absoluteFill, styles.page, { opacity, zIndex: 100 }]}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: lockup,
            transform: [{ scale: lockup.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }],
          },
        ]}
      >
        <LaunchSplashContent />
      </Animated.View>
    </Animated.View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    page: { backgroundColor: colors.background },
    lockup: {
      flex: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      paddingBottom: spacing.lg,
    },
    wordmark: { fontFamily: fonts.bold, color: colors.foreground },
    subtitle: { fontFamily: fonts.medium, color: colors.mutedForeground },
  };
}
