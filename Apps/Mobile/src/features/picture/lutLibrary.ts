import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';
import { useEffect, useSyncExternalStore } from 'react';
import { PocketVideo } from '@modules/pocket-native/src/native';
import { BUILT_IN_LOOKS, formatCube, lookCube, validatedImport, type BuiltInLook, type CubeLUT } from '@/core/media';
import { useAssists, type CustomLutEntry } from '@/state/assists';

/**
 * LUT registry shared by the web renderer and the native module. Generated looks are built on
 * demand; imported `.cube` files are stored with expo-file-system on device (documents/luts)
 * and kept in memory (plus localStorage when small) on web. Unofficial DJI cubes are never
 * bundled: Auto uses the generated display transforms instead.
 */

const cubes = new Map<string, CubeLUT>();
const registeredNative = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l();
}

export function subscribeLuts(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const lutVersion = () => version;

/** Re-render when any cube loads (web texture upload, picker list). */
export function useLutVersion() {
  return useSyncExternalStore(subscribeLuts, lutVersion, lutVersion);
}

/** The cube for a registered id, or null while it is still loading / missing. */
export function getLut(id: string | null): CubeLUT | null {
  if (!id) return null;
  const hit = cubes.get(id);
  if (hit) return hit;
  if (id.startsWith('look:')) {
    const look = id.slice(5) as BuiltInLook;
    if (BUILT_IN_LOOKS.includes(look)) {
      const cube = lookCube(look, 17);
      cubes.set(id, cube);
      return cube;
    }
  }
  return null;
}

// ───────────────────────────── Storage ─────────────────────────────

const isWeb = Platform.OS === 'web';
const WEB_KEY = (id: string) => `pm.lut.${id}`;
const WEB_MAX_PERSIST = 2_000_000;

type FsModule = typeof import('expo-file-system');
let fsModule: FsModule | null | undefined;
function fs(): FsModule | null {
  if (fsModule !== undefined) return fsModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fsModule = isWeb ? null : (require('expo-file-system') as FsModule);
  } catch {
    fsModule = null;
  }
  return fsModule;
}

function lutDir() {
  const m = fs();
  if (!m) return null;
  try {
    const dir = new m.Directory(m.Paths.document, 'luts');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
  } catch {
    return null;
  }
}

async function writeCubeText(id: string, text: string) {
  if (isWeb) {
    if (text.length <= WEB_MAX_PERSIST) {
      try {
        globalThis.localStorage?.setItem(WEB_KEY(id), text);
      } catch {
        // Quota: keep it in memory for this session only.
      }
    }
    return;
  }
  const m = fs();
  const dir = lutDir();
  if (!m || !dir) return;
  const file = new m.File(dir, `${id}.cube`);
  if (!file.exists) file.create();
  file.write(text);
}

async function readCubeText(id: string): Promise<string | null> {
  if (isWeb) {
    try {
      return globalThis.localStorage?.getItem(WEB_KEY(id)) ?? null;
    } catch {
      return null;
    }
  }
  const m = fs();
  const dir = lutDir();
  if (!m || !dir) return null;
  try {
    const file = new m.File(dir, `${id}.cube`);
    return file.exists ? await file.text() : null;
  } catch {
    return null;
  }
}

async function deleteCubeText(id: string) {
  if (isWeb) {
    try {
      globalThis.localStorage?.removeItem(WEB_KEY(id));
    } catch {
      // ignore
    }
    return;
  }
  const m = fs();
  const dir = lutDir();
  if (!m || !dir) return;
  try {
    const file = new m.File(dir, `${id}.cube`);
    if (file.exists) file.delete();
  } catch {
    // ignore
  }
}

// ───────────────────────────── Loading ─────────────────────────────

const loading = new Map<string, Promise<CubeLUT | null>>();

/** Load (custom) or build (look) the cube for `id` and register it with the native module. */
export function ensureLut(id: string | null): Promise<CubeLUT | null> {
  if (!id) return Promise.resolve(null);
  const ready = getLut(id);
  if (ready) {
    registerNative(id, ready);
    return Promise.resolve(ready);
  }
  if (!id.startsWith('custom:')) return Promise.resolve(null);
  const pending = loading.get(id);
  if (pending) return pending;
  const p = (async () => {
    const text = await readCubeText(id.slice(7));
    if (!text) return null;
    try {
      const cube = validatedImport(text);
      cubes.set(id, cube);
      registerNative(id, cube, text);
      emit();
      return cube;
    } catch {
      return null;
    }
  })().finally(() => loading.delete(id));
  loading.set(id, p);
  return p;
}

function registerNative(id: string, cube: CubeLUT, text?: string) {
  if (!PocketVideo || registeredNative.has(id)) return;
  registeredNative.add(id);
  PocketVideo.loadLut(id, text ?? formatCube(cube)).catch(() => registeredNative.delete(id));
}

/** Keep the active LUT loaded and registered. */
export function useEnsureLut(id: string | null) {
  useEffect(() => {
    void ensureLut(id);
  }, [id]);
}

// ───────────────────────────── Import ─────────────────────────────

export type ImportResult = { ok: true; entry: CustomLutEntry } | { ok: false; canceled?: boolean; error?: string };

function slug(name: string) {
  return (
    name
      .replace(/\.cube$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'lut'
  );
}

/** Import a `.cube` text under a display name: validate, store, register, select. */
export async function importCubeText(name: string, text: string): Promise<ImportResult> {
  let cube: CubeLUT;
  try {
    cube = validatedImport(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'That file is not a 3D .cube LUT.' };
  }
  const id = `${slug(name)}-${Date.now().toString(36)}`;
  const entry: CustomLutEntry = { id, name: cube.title || name.replace(/\.cube$/i, ''), size: cube.size, addedAt: Date.now() };
  cubes.set(`custom:${id}`, cube);
  try {
    await writeCubeText(id, text);
  } catch {
    // Still usable this session.
  }
  registerNative(`custom:${id}`, cube, text);
  useAssists.getState().addCustomLut(entry);
  emit();
  return { ok: true, entry };
}

/** Pick a `.cube` with the system document picker (web: file input). */
export async function pickAndImportCube(): Promise<ImportResult> {
  let result: DocumentPicker.DocumentPickerResult;
  try {
    result = await DocumentPicker.getDocumentAsync({ type: isWeb ? '.cube' : '*/*', copyToCacheDirectory: true, multiple: false });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not open the file picker.' };
  }
  if (result.canceled || !result.assets?.length) return { ok: false, canceled: true };
  const asset = result.assets[0];
  if (!/\.cube$/i.test(asset.name)) return { ok: false, error: 'Choose a .cube LUT file.' };
  if (asset.size != null && asset.size > 16 * 1024 * 1024) return { ok: false, error: 'That .cube file is larger than 16 MB.' };
  let text: string | null = null;
  try {
    if (asset.file) text = await asset.file.text();
    else if (isWeb) text = await (await fetch(asset.uri)).text();
    else {
      const m = fs();
      if (m) text = await new m.File(asset.uri).text();
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not read that file.' };
  }
  if (text == null) return { ok: false, error: 'Could not read that file.' };
  return importCubeText(asset.name, text);
}

export async function deleteCustomLut(id: string) {
  const key = `custom:${id}`;
  cubes.delete(key);
  if (PocketVideo && registeredNative.has(key)) {
    registeredNative.delete(key);
    try {
      PocketVideo.unloadLut(key);
    } catch {
      // ignore
    }
  }
  await deleteCubeText(id);
  useAssists.getState().removeCustomLut(id);
  emit();
}
