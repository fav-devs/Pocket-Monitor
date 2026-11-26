import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CameraProvider } from '@/camera';
import { colors } from '@/theme';
import '@/camera/bootstrap';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [loaded, error] = useFonts({
    'Sora-Regular': require('../../assets/fonts/Sora-Regular.ttf'),
    'Sora-Medium': require('../../assets/fonts/Sora-Medium.ttf'),
    'Sora-SemiBold': require('../../assets/fonts/Sora-SemiBold.ttf'),
    'Sora-Bold': require('../../assets/fonts/Sora-Bold.ttf'),
  });

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync().catch(() => {});
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <SafeAreaProvider>
        <CameraProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.canvas },
              animation: 'fade',
            }}
          >
            <Stack.Screen name="live" options={{ animation: 'fade', gestureEnabled: false }} />
            <Stack.Screen name="pair" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          </Stack>
        </CameraProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
