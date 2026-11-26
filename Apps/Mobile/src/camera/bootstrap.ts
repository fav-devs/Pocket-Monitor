/**
 * Chooses which CameraSession the app starts with. Imported once by the root layout.
 * Web (and any build without the native module) always runs the demo camera.
 * The native session registers itself here once `src/camera/native` is built.
 */
import { Platform } from 'react-native';

export const isWeb = Platform.OS === 'web';
