// Per-weight imports: the package index would bundle all sixteen faces.
import { SNPro_400Regular } from '@expo-google-fonts/sn-pro/400Regular';
import { SNPro_500Medium } from '@expo-google-fonts/sn-pro/500Medium';
import { SNPro_600SemiBold } from '@expo-google-fonts/sn-pro/600SemiBold';
import { SNPro_700Bold } from '@expo-google-fonts/sn-pro/700Bold';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CameraProvider } from '@/camera';
import { isWideWindow } from '@/constants/layout';
import { AppThemeProvider, useTheme } from '@/constants/theme';
import { AppShell } from '@/features/shell/AppShell';
import { FeedSharingHost } from '@/features/watcher/useFeedSharing';
import '@/camera/bootstrap';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  return (
    <AppThemeProvider>
      <RootLayoutInner />
    </AppThemeProvider>
  );
}

function RootLayoutInner() {
  const { colors, scheme, navigationTheme } = useTheme();
  // Wide layout: pairing and connecting open as a dialog over the page under them.
  const wide = isWideWindow(useWindowDimensions().width);
  const flowOptions = wide
    ? ({ presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } } as const)
    : null;
  const [loaded, error] = useFonts({
    SNPro_400Regular,
    SNPro_500Medium,
    SNPro_600SemiBold,
    SNPro_700Bold,
  });

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync().catch(() => {});
  }, [loaded, error]);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, [colors.background]);

  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        {/* Sheets render in the modal provider's own host, so every context a sheet reads
            (theme, camera) must sit above it. */}
        <ThemeProvider value={navigationTheme}>
          <CameraProvider>
            <BottomSheetModalProvider>
              <FeedSharingHost />
              <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
              <AppShell>
                <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
                  {/* The monitor and playback are always on black, whatever the theme. */}
                  <Stack.Screen name="live" options={{ gestureEnabled: false, contentStyle: { backgroundColor: '#000' } }} />
                  <Stack.Screen name="pair" options={flowOptions ?? { presentation: 'modal', animation: 'slide_from_bottom' }} />
                  <Stack.Screen name="connect" options={flowOptions ?? {}} />
                  <Stack.Screen name="multiview" options={{ gestureEnabled: false, contentStyle: { backgroundColor: '#000' } }} />
                </Stack>
              </AppShell>
            </BottomSheetModalProvider>
          </CameraProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
