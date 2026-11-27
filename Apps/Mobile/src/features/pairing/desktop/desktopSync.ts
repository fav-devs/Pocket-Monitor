/**
 * The desktop app's remembered cameras and old settings, brought into the web stores
 * (`docs/desktop-expo-port.md` A1, X1–X7). Only runs inside Tauri.
 *
 * - `syncKnownCameras`: the backend's files (`desktop-camera-v1`, `desktop-station-v1`,
 *   `desktop-lan-camera-v1`, the old viewfinder's) are the truth for what this PC remembers;
 *   the saved-camera store mirrors them with `desktop-*` ids.
 * - `seedWebStoresOnce`: on the first run on a PC the old viewfinder was used on, its zebra,
 *   peaking, scopes, guides and stick feel become the web stores' values, once.
 */
import { isDesktopCameraId, knownCameras, knownToSaved, type KnownCamera } from '@/camera/desktop/connect';
import { invoke, isTauri } from '@/camera/desktop/tauri';
import { defaultAssistOptions, useAssists } from '@/state/assists';
import { usePreferences } from '@/state/preferences';
import { useSavedCameras } from '@/state/savedCameras';

/**
 * Mirrors the backend's remembered cameras into the saved-camera store: `desktop-*` records
 * follow the files (names and last-connected times kept), and a record from a first pair
 * that the backend now remembers under its own id is folded into it.
 */
export async function syncKnownCameras(): Promise<KnownCamera[]> {
  if (!isTauri()) return [];
  const known = await knownCameras();
  const store = useSavedCameras.getState();
  const before = new Map(store.cameras.map((c) => [c.id, c]));
  const keep = new Set<string>(known.map((k) => k.id));
  for (const camera of store.cameras) {
    if (isDesktopCameraId(camera.id) && !keep.has(camera.id)) store.remove(camera.id);
  }
  for (const k of known) {
    const previous = before.get(k.id);
    const record = knownToSaved(k, previous);
    // The first pair's own record (Bluetooth id, same network): the desktop one replaces it.
    for (const camera of useSavedCameras.getState().cameras) {
      if (isDesktopCameraId(camera.id)) continue;
      if (camera.path.kind !== record.path.kind || camera.path.ssid !== record.path.ssid) continue;
      if (!previous) record.name = camera.name;
      const last = Math.max(record.lastConnectedAt ?? 0, camera.lastConnectedAt ?? 0);
      if (last) record.lastConnectedAt = last;
      useSavedCameras.getState().remove(camera.id);
    }
    if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) useSavedCameras.getState().upsert(record);
  }
  return known;
}

interface WebSeed {
  preferences?: Record<string, unknown>;
  assists?: { on?: Record<string, boolean>; options?: Record<string, unknown> };
}

type Persisted = { persist?: { hasHydrated(): boolean; onFinishHydration(fn: () => void): () => void } };

function hydrated(store: Persisted) {
  return new Promise<void>((resolve) => {
    if (!store.persist || store.persist.hasHydrated()) return resolve();
    const stop = store.persist.onFinishHydration(() => {
      stop();
      resolve();
    });
  });
}

/** Lays one seed's patches over the stores: groups are merged, not replaced. */
export function applyWebSeed(seed: WebSeed) {
  if (seed.preferences) usePreferences.setState(seed.preferences as never);
  const on = seed.assists?.on ?? {};
  const options = seed.assists?.options ?? {};
  useAssists.setState((s) => {
    const merged = { ...s.options } as Record<string, unknown>;
    const defaults = defaultAssistOptions as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(options)) {
      const base = merged[key] ?? defaults[key];
      merged[key] =
        value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object'
          ? { ...(base as object), ...(value as object) }
          : value;
    }
    return { on: { ...s.on, ...on }, options: merged as unknown as typeof s.options };
  });
}

let seeding: Promise<void> | null = null;

/** Applies the backend's one-time seed when one is owed; the backend keeps the marker. */
export function seedWebStoresOnce(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  seeding ??= (async () => {
    const seed = await invoke<WebSeed | null>('prefs_web_seed').catch(() => null);
    if (!seed) return;
    await Promise.all([hydrated(usePreferences as unknown as Persisted), hydrated(useAssists as unknown as Persisted)]);
    applyWebSeed(seed);
    await invoke('prefs_web_seeded').catch(() => {});
  })();
  return seeding;
}
