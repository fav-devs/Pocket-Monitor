import { useEffect, useState, useSyncExternalStore } from 'react';
import { isTauri } from '@/camera/desktop/tauri';
import { lutList, lutLoad, lutSelect, type DesktopLutList } from '@/camera/desktop/picture';
import { formatCube } from '@/core/media';
import { ensureLut } from '@/features/picture/lutLibrary';
import { useAssists, type CustomLutEntry, type LutSelection } from '@/state/assists';

/**
 * The LUT picker's desktop backend. On the desktop the cubes live in Rust (`luts.rs`):
 *
 * - every `.cube` in the LUT drop folder shows in the picker's Custom tab as an entry whose id
 *   is `file:<name>`, so its `lutId` is `custom:file:<name>` (Rust reads that as the folder file);
 * - Import writes the cube into the drop folder (validated by the core) instead of web storage;
 * - cubes imported earlier into web storage (`custom:<slug>`) are handed to Rust with
 *   `lut_load` the first time the picture uses them;
 * - the pick is also remembered natively (`lut_select`).
 */

export const isDesktopFileLut = (id: string) => id.startsWith('file:');

/** Merges the drop folder's files into the custom list without touching the selection. */
export function mergeFolder(custom: CustomLutEntry[], list: DesktopLutList, now = Date.now()): CustomLutEntry[] {
  const files = new Map(list.files.map((f) => [f.id, f.name]));
  const kept = custom.filter((c) => !isDesktopFileLut(c.id) || files.has(c.id));
  const have = new Set(kept.map((c) => c.id));
  const added = list.files.filter((f) => !have.has(f.id)).map((f) => ({ id: f.id, name: f.name, size: 0, addedAt: now }));
  return [...kept, ...added];
}

async function syncFolder(): Promise<DesktopLutList | null> {
  let list: DesktopLutList;
  try {
    list = await lutList();
  } catch {
    return null;
  }
  useAssists.setState((s) => {
    const custom = mergeFolder(s.options.lut.custom, list);
    if (custom.length === s.options.lut.custom.length && custom.every((c, i) => c.id === s.options.lut.custom[i]?.id)) return s;
    return { options: { ...s.options, lut: { ...s.options.lut, custom } } };
  });
  return list;
}

function pickCubeFile(): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cube';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // A cancelled dialog fires no change; focus coming back is the only sign.
    window.addEventListener('focus', () => setTimeout(() => resolve(input.files?.[0] ?? null), 500), { once: true });
    input.click();
  });
}

export type DesktopImport = { ok: true; entry: CustomLutEntry } | { ok: false; canceled?: boolean; error?: string };

/** Pick a `.cube`, validate it in the core and write it into the drop folder; selects it. */
export async function importDesktopCube(): Promise<DesktopImport> {
  const file = await pickCubeFile();
  if (!file) return { ok: false, canceled: true };
  if (!/\.cube$/i.test(file.name)) return { ok: false, error: 'Choose a .cube LUT file.' };
  if (file.size > 16 * 1024 * 1024) return { ok: false, error: 'That .cube file is larger than 16 MB.' };
  let loaded;
  try {
    loaded = await lutLoad(file.name, await file.text());
  } catch (e) {
    return { ok: false, error: typeof e === 'string' ? e : e instanceof Error ? e.message : 'That file is not a 3D .cube LUT.' };
  }
  const entry: CustomLutEntry = { id: loaded.id, name: loaded.name, size: loaded.size, addedAt: Date.now() };
  // Adds and selects it, as an import does on the phones.
  useAssists.getState().addCustomLut(entry);
  void lutSelect(`custom:${entry.id}`).catch(() => {});
  return { ok: true, entry };
}

const registered = new Set<string>();

/**
 * Hands a web-storage cube (`custom:<slug>`) to Rust before the picture needs it. Folder files
 * and built-in looks need nothing; Rust has them.
 */
export async function ensureDesktopLut(lutId: string | null): Promise<void> {
  if (!lutId || !isTauri() || !lutId.startsWith('custom:') || lutId.startsWith('custom:file:') || registered.has(lutId)) return;
  registered.add(lutId);
  const cube = await ensureLut(lutId);
  if (!cube) {
    registered.delete(lutId);
    return;
  }
  const key = lutId.slice('custom:'.length);
  const name = useAssists.getState().options.lut.custom.find((c) => c.id === key)?.name ?? key;
  try {
    await lutLoad(`${name}.cube`, formatCube(cube), lutId);
  } catch {
    registered.delete(lutId);
  }
}

/** The LUT 50/50 split (a desktop extra on `PictureEffects`): off, graded top half, graded right half. */
export type DesktopSplit = 'off' | 'across' | 'down';
let split: DesktopSplit = 'off';
const splitListeners = new Set<() => void>();
export function setDesktopSplit(next: DesktopSplit) {
  split = next;
  for (const l of splitListeners) l();
}
export function useDesktopSplit(): DesktopSplit {
  return useSyncExternalStore(
    (cb) => {
      splitListeners.add(cb);
      return () => splitListeners.delete(cb);
    },
    () => split,
    () => 'off',
  );
}

export interface DesktopLuts {
  /** Where to drop `.cube` files, once known. */
  folder: string | null;
  importCube: () => Promise<DesktopImport>;
  isFile: (id: string) => boolean;
  /** Remember the pick natively. */
  select: (selection: LutSelection) => void;
  split: DesktopSplit;
  setSplit: (next: DesktopSplit) => void;
}

/** The picker's desktop backend; null outside the desktop app. Syncs the drop folder on mount. */
export function useDesktopLuts(): DesktopLuts | null {
  const desktop = isTauri();
  const [folder, setFolder] = useState<string | null>(null);
  const current = useDesktopSplit();
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void syncFolder().then((list) => {
      if (live && list) setFolder(list.folder);
    });
    return () => {
      live = false;
    };
  }, [desktop]);
  if (!desktop) return null;
  return {
    folder,
    importCube: importDesktopCube,
    isFile: isDesktopFileLut,
    select: (selection) => void lutSelect(selection).catch(() => {}),
    split: current,
    setSplit: setDesktopSplit,
  };
}
