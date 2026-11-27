import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type {
  PocketBackgroundIosModule,
  PocketBackgroundNativeModule,
  PocketBluetoothNativeModule,
  PocketDatalinkNativeModule,
  PocketGamepadNativeModule,
  PocketHeadMotionNativeModule,
  PocketRelayNativeModule,
  PocketVideoNativeModule,
  PocketWifiNativeModule,
} from './types';

/**
 * Byte payloads arrive as `Uint8Array` from Swift (`Data`) but as a bare `ArrayBuffer` from
 * Kotlin (`ByteArray`). Everything above this file sees `Uint8Array`.
 */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return new Uint8Array(0);
}

type Listener = (event: never) => void;
type Subscription = { remove(): void };
type Emitter = { addListener(event: string, cb: Listener): Subscription };

/** Wraps `addListener` so the named events have their byte fields normalized. */
function withByteEvents<T extends Emitter>(
  module: T | null,
  fields: Record<string, readonly string[]>,
): T | null {
  if (!module) return null;
  const addListener = module.addListener.bind(module);
  const wrapped = Object.create(module) as T;
  wrapped.addListener = ((event: string, cb: (e: Record<string, unknown>) => void) => {
    const keys = fields[event];
    if (!keys) return addListener(event, cb as Listener);
    return addListener(event, ((e: Record<string, unknown>) => {
      const next = { ...e };
      for (const key of keys) {
        if (next[key] != null) next[key] = toBytes(next[key]);
      }
      cb(next);
    }) as Listener);
  }) as T['addListener'];
  return wrapped;
}

const bluetooth = requireOptionalNativeModule<PocketBluetoothNativeModule>('PocketBluetooth');
const datalink = requireOptionalNativeModule<PocketDatalinkNativeModule>('PocketDatalink');
const video = requireOptionalNativeModule<PocketVideoNativeModule>('PocketVideo');

/** Each is null when the native code is not linked (web, Expo Go, or a platform without it). */
export const PocketBluetooth = withByteEvents(bluetooth as unknown as Emitter | null, {
  onAdvert: ['manufacturerData'],
  onNotify: ['bytes'],
}) as unknown as PocketBluetoothNativeModule | null;

export const PocketDatalink = withByteEvents(datalink as unknown as Emitter | null, {
  onDuml: ['bytes'],
}) as unknown as PocketDatalinkNativeModule | null;

export const PocketVideo: PocketVideoNativeModule | null = video
  ? Object.assign(Object.create(video) as PocketVideoNativeModule, {
      sampleFrame: async (sessionId: string, width: number, height: number) => {
        const sample = await video.sampleFrame(sessionId, width, height);
        return sample ? { ...sample, rgba: toBytes(sample.rgba) } : null;
      },
    })
  : null;

export const PocketWifi = requireOptionalNativeModule<PocketWifiNativeModule>('PocketWifi');
export const PocketGamepad = requireOptionalNativeModule<PocketGamepadNativeModule>('PocketGamepad');
export const PocketHeadMotion = requireOptionalNativeModule<PocketHeadMotionNativeModule>('PocketHeadMotion');
/** Watcher relay (host and watcher). Null on web and in builds without the module. */
export const PocketRelay = requireOptionalNativeModule<PocketRelayNativeModule>('PocketRelay');

/**
 * Server mode (Android foreground service). On iOS the same JS name is the background module
 * (Live Activity, Picture in Picture, grace task): use `PocketBackgroundIos` there. Null on web and
 * in builds without it.
 */
export const PocketBackground = requireOptionalNativeModule<PocketBackgroundNativeModule>('PocketBackground');

/** The iOS background module (Live Activity, PiP, record control, grace). Null off iOS. */
export const PocketBackgroundIos: PocketBackgroundIosModule | null =
  Platform.OS === 'ios' ? (PocketBackground as unknown as PocketBackgroundIosModule | null) : null;

export const hasNativeCameraIO = PocketBluetooth != null && PocketWifi != null && PocketDatalink != null;
