/**
 * Chooses which CameraSession the app starts with. Imported once by the root layout.
 *
 * - Inside the Tauri desktop app (`window.__TAURI_INTERNALS__`): the desktop session, which
 *   drives the camera through the Rust backend. `EXPO_PUBLIC_DESKTOP=0` at build time keeps
 *   the demo camera even there.
 * - Web, Expo Go and any build without the camera radios linked: always the demo camera.
 * - Phone builds with `hasNativeCameraIO`: the native session, unless the operator turned on
 *   Settings → Demo mode. Preferences hydrate asynchronously, so the choice is re-made when
 *   `demoMode` becomes known or changes (an idle session is swapped; a connected one is
 *   disconnected first by the provider).
 */
import { Platform } from 'react-native';
import { hasNativeCameraIO } from '@modules/pocket-native/src/native';
import { usePreferences } from '@/state/preferences';
import { createDemoSession, currentCameraSession, registerSessionFactory, replaceCameraSession } from './CameraProvider';
import { createNativeSession } from './native/createNativeSession';
import { DesktopCameraSession } from './desktop/DesktopCameraSession';
import { isTauri } from './desktop/tauri';
import type { CameraSession } from './session';

export const isWeb = Platform.OS === 'web';

/** True inside the Pocket Monitor desktop app (Tauri), unless the build opted out. */
export const desktopCameraEnabled = isWeb && isTauri() && process.env.EXPO_PUBLIC_DESKTOP !== '0';

/** True when this build can drive a real camera. */
export const nativeCameraEnabled = !isWeb && hasNativeCameraIO;

function preferredSession(): CameraSession {
  if (nativeCameraEnabled && !usePreferences.getState().demoMode) {
    try {
      return createNativeSession();
    } catch {
      // Modules reported present but failed to construct: fall back to the demo camera.
    }
  }
  return createDemoSession();
}

if (nativeCameraEnabled) {
  registerSessionFactory(preferredSession);
  usePreferences.subscribe((next, prev) => {
    if (next.demoMode === prev.demoMode) return;
    const want = next.demoMode ? 'demo' : 'native';
    if (currentCameraSession()?.kind === want) return;
    replaceCameraSession(preferredSession());
  });
}

if (desktopCameraEnabled) {
  // One session for the app's life: a web reload re-attaches to the Rust link.
  let desktop: DesktopCameraSession | null = null;
  registerSessionFactory(() => (desktop ??= new DesktopCameraSession()));
}
