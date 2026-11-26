import { requireOptionalNativeModule } from 'expo';
import type {
  OpcBluetoothNativeModule,
  OpcDatalinkNativeModule,
  OpcGamepadNativeModule,
  OpcHeadMotionNativeModule,
  OpcVideoNativeModule,
  OpcWifiNativeModule,
} from './types';

/** Each is null when the native code is not linked (web, Expo Go, or a platform without it). */
export const OpcBluetooth = requireOptionalNativeModule<OpcBluetoothNativeModule>('OpcBluetooth');
export const OpcWifi = requireOptionalNativeModule<OpcWifiNativeModule>('OpcWifi');
export const OpcDatalink = requireOptionalNativeModule<OpcDatalinkNativeModule>('OpcDatalink');
export const OpcVideo = requireOptionalNativeModule<OpcVideoNativeModule>('OpcVideo');
export const OpcGamepad = requireOptionalNativeModule<OpcGamepadNativeModule>('OpcGamepad');
export const OpcHeadMotion = requireOptionalNativeModule<OpcHeadMotionNativeModule>('OpcHeadMotion');

export const hasNativeCameraIO = OpcBluetooth != null && OpcWifi != null && OpcDatalink != null;
