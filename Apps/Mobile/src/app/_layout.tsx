import {
  SNPro_400Regular,
  SNPro_500Medium,
  SNPro_600SemiBold,
  SNPro_700Bold,
} from '@expo-google-fonts/sn-pro';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CameraProvider } from '@/camera';
import { AppThemeProvider, useTheme } from '@/constants/theme';
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
        <BottomSheetModalProvider>
          <ThemeProvider value={navigationTheme}>
            <CameraProvider>
              <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
              <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
                {/* The monitor and playback are always on black, whatever the theme. */}
                <Stack.Screen name="live" options={{ gestureEnabled: false, contentStyle: { backgroundColor: '#000' } }} />
                <Stack.Screen name="pair" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
              </Stack>
            </CameraProvider>
          </ThemeProvider>
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
