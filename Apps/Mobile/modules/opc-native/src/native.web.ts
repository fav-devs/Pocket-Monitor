import type {
  OpcBluetoothNativeModule,
  OpcDatalinkNativeModule,
  OpcGamepadNativeModule,
  OpcHeadMotionNativeModule,
  OpcVideoNativeModule,
  OpcWifiNativeModule,
} from './types';

// Web has no camera I/O. The app runs the demo session; gamepads use the browser Gamepad API
// (src/features/input), not this module.
export const OpcBluetooth: OpcBluetoothNativeModule | null = null;
export const OpcWifi: OpcWifiNativeModule | null = null;
export const OpcDatalink: OpcDatalinkNativeModule | null = null;
export const OpcVideo: OpcVideoNativeModule | null = null;
export const OpcGamepad: OpcGamepadNativeModule | null = null;
export const OpcHeadMotion: OpcHeadMotionNativeModule | null = null;
export const hasNativeCameraIO = false;
