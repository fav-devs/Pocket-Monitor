import { AppLogo } from '@/components/app-logo';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { fonts, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { appBrand, launchLayout, launchTiming } from './brand';

/** App mark: the PM monogram on an ink squircle, with the record dot (`MonitorBrandMark`). */
export function BrandMark({ size = 72 }: { size?: number }) {
  return <AppLogo size={size} />;
}

/** The app's name as the launch splash sets it. */
export function BrandWordmark({ fontSize = 30 }: { fontSize?: number }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={{ gap: Math.round(fontSize * 0.12) }}>
      <Text style={[styles.wordmark, { fontSize, lineHeight: Math.round(fontSize * 1.2), letterSpacing: -fontSize * 0.025 }]}>
        {appBrand.name}
      </Text>
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

/** A page the browser or desktop web view isn't showing: no frames run, so no splash either. */
function documentHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Cold-start splash overlay (`MonitorLaunchSplashOverlay`). Shows once per process, for the
 * shared launch duration, then fades out and stops taking touches.
 *
 * It leaves on a plain timer, not on the fade's completion: the fade runs on animation frames,
 * which a hidden or occluded web view (a browser tab in the background, the desktop app's window
 * behind another) never delivers, and the splash used to wait on them for good.
 */
export function LaunchSplashOverlay() {
  const styles = useThemedStyles(createStyles);
  const [visible, setVisible] = useState(() => !launchSplashShown && !documentHidden());
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
    const fade = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: launchTiming.fadeOutMs,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: false,
      }).start();
    }, launchTiming.visibleMs);
    const gone = setTimeout(() => setVisible(false), launchTiming.visibleMs + launchTiming.fadeOutMs + 50);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
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
  };
}
