import { requireOptionalNativeModule } from 'expo';
import type {
  PocketBluetoothNativeModule,
  PocketDatalinkNativeModule,
  PocketGamepadNativeModule,
  PocketHeadMotionNativeModule,
  PocketVideoNativeModule,
  PocketWifiNativeModule,
} from './types';

/** Each is null when the native code is not linked (web, Expo Go, or a platform without it). */
export const PocketBluetooth = requireOptionalNativeModule<PocketBluetoothNativeModule>('PocketBluetooth');
export const PocketWifi = requireOptionalNativeModule<PocketWifiNativeModule>('PocketWifi');
export const PocketDatalink = requireOptionalNativeModule<PocketDatalinkNativeModule>('PocketDatalink');
export const PocketVideo = requireOptionalNativeModule<PocketVideoNativeModule>('PocketVideo');
export const PocketGamepad = requireOptionalNativeModule<PocketGamepadNativeModule>('PocketGamepad');
export const PocketHeadMotion = requireOptionalNativeModule<PocketHeadMotionNativeModule>('PocketHeadMotion');

export const hasNativeCameraIO = PocketBluetooth != null && PocketWifi != null && PocketDatalink != null;
