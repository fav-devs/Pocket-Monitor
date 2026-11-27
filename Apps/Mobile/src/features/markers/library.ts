/**
 * The library's view of clip metadata: search over tags, notes, marker labels and the shoot;
 * the tag and shoot filters; and shoot sections for "Group by shoot". Pure.
 */
import type { CameraMediaItem } from '@/camera';
import { type ClipMeta, type Shoot, allTags, tagKey } from '@/core/markers';

export interface MetaFilter {
  /** Clips carrying every one of these tags (clip tags or marker tags). */
  tags: string[];
  /** One shoot's clips; `none` for clips in no shoot; null for all. */
  shootId: string | null;
}

export const emptyMetaFilter: MetaFilter = { tags: [], shootId: null };

export const metaFilterCount = (f: MetaFilter) => f.tags.length + (f.shootId ? 1 : 0);

type MetaLookup = (item: CameraMediaItem) => ClipMeta | undefined;

/** Search: the file name, then the clip's tags, notes, marker labels and its shoot's name and folder. */
export function matchesQuery(item: CameraMediaItem, meta: ClipMeta | undefined, shoot: Shoot | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.fileName.toLowerCase().includes(q)) return true;
  if (!meta && !shoot) return false;
  const words = [
    ...allTags(meta),
    meta?.notes ?? '',
    ...(meta?.markers.map((m) => m.label) ?? []),
    shoot?.name ?? '',
    shoot?.folderPath ?? '',
  ];
  return words.some((w) => w.toLowerCase().includes(q));
}

export function passesMetaFilter(meta: ClipMeta | undefined, f: MetaFilter): boolean {
  if (f.shootId === 'none' && meta?.shootId) return false;
  if (f.shootId && f.shootId !== 'none' && meta?.shootId !== f.shootId) return false;
  if (f.tags.length) {
    const have = allTags(meta).map(tagKey);
    if (!f.tags.every((t) => have.includes(tagKey(t)))) return false;
  }
  return true;
}

/** Tags on the listed clips, most used first (ties by name). */
export function tagsIn(items: CameraMediaItem[], lookup: MetaLookup): string[] {
  const counts = new Map<string, { tag: string; n: number }>();
  for (const i of items) {
    for (const t of allTags(lookup(i))) {
      const k = tagKey(t);
      const cur = counts.get(k);
      if (cur) cur.n += 1;
      else counts.set(k, { tag: t, n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).map((x) => x.tag);
}

/** "Group by shoot": a section per shoot (newest shoot first), clips in no shoot last. */
export function shootSectionOf(lookup: MetaLookup, shoots: Shoot[]) {
  const order = new Map([...shoots].sort((a, b) => b.createdAt - a.createdAt).map((s, i) => [s.id, i]));
  return (item: CameraMediaItem): { key: string; title: string; order: number } => {
    const id = lookup(item)?.shootId;
    const shoot = id ? shoots.find((s) => s.id === id) : undefined;
    if (!shoot) return { key: 'shoot:none', title: 'No shoot', order: Number.MAX_SAFE_INTEGER };
    return { key: `shoot:${shoot.id}`, title: shoot.name, order: order.get(shoot.id) ?? 0 };
  };
}
