import type { DesktopLutList } from '@/camera/desktop/picture';
import type { CustomLutEntry } from '@/state/assists';

/** A drop-folder cube's entry id in the phones' custom list (`file:<name>`). */
export const isDesktopFileLut = (id: string) => id.startsWith('file:');

/** Merges the drop folder's files into the custom list without touching the selection. */
export function mergeFolder(custom: CustomLutEntry[], list: DesktopLutList, now = Date.now()): CustomLutEntry[] {
  const files = new Map(list.files.map((f) => [f.id, f.name]));
  const kept = custom.filter((c) => !isDesktopFileLut(c.id) || files.has(c.id));
  const have = new Set(kept.map((c) => c.id));
  const added = list.files.filter((f) => !have.has(f.id)).map((f) => ({ id: f.id, name: f.name, size: 0, addedAt: now }));
  return [...kept, ...added];
}
