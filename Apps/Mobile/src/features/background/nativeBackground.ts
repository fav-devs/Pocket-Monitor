import { PocketBackgroundIos } from '@modules/pocket-native/src/native';
import { useBackgroundRuntime } from './backgroundStore';

/** The iOS background module, or null (web, Android, builds without it). */
export const backgroundIos = PocketBackgroundIos;

let capabilitiesRequest: Promise<void> | null = null;

/** Loads `iosCapabilities()` once into the runtime store. */
export function loadBackgroundCapabilities(): Promise<void> {
  if (!backgroundIos) return Promise.resolve();
  capabilitiesRequest ??= backgroundIos
    .iosCapabilities()
    .then((capabilities) => useBackgroundRuntime.getState().set({ capabilities }))
    .catch(() => {
      capabilitiesRequest = null;
    });
  return capabilitiesRequest;
}

/** Native promises must never reject into UI code. */
export function quietly(p: Promise<unknown> | undefined): void {
  p?.catch(() => {});
}
