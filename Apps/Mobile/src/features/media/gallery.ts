/**
 * Gallery derivation: category, filters, sort, burst stacks and day sections. Pure.
 */
import type { CameraMediaItem, ColorMode } from '@/camera';
import type { MediaSort } from '@/state/media';
import { colorModeLabel, dayKey, dayLabel, resolutionLabel } from './format';
import type { MediaCategory, MediaFilters } from './libraryStore';

/** One card: a single item, or a burst/panorama stack shown by its first frame. */
export interface GalleryEntry {
  /** The cover item's id. */
  id: string;
  cover: CameraMediaItem;
  members: CameraMediaItem[];
}

export interface GallerySection {
  key: string;
  title: string | null;
  entries: GalleryEntry[];
}

export interface FilterChoice<T> {
  value: T;
  label: string;
  count: number;
}

export interface FilterOptions {
  resolutions: FilterChoice<string>[];
  frameRates: FilterChoice<number>[];
  colors: FilterChoice<ColorMode>[];
}

export const categoryTitles: Record<MediaCategory, string> = {
  all: 'All',
  video: 'Videos',
  photo: 'Photos',
  favorites: 'Favorites',
};

export const sortTitles: Record<MediaSort, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  largest: 'Largest',
  longest: 'Longest',
};

export const sortOrder: MediaSort[] = ['newest', 'oldest', 'largest', 'longest'];

export function inCategory(item: CameraMediaItem, category: MediaCategory): boolean {
  switch (category) {
    case 'all':
      return true;
    case 'video':
      return item.kind === 'video';
    case 'photo':
      return item.kind === 'photo';
    case 'favorites':
      return item.favorite;
  }
}

function passesFilters(item: CameraMediaItem, f: MediaFilters): boolean {
  if (f.resolutions.length) {
    const res = resolutionLabel(item.width, item.height);
    if (!res || !f.resolutions.includes(res)) return false;
  }
  if (f.frameRates.length) {
    if (item.kind !== 'video' || !item.fps || !f.frameRates.includes(Math.round(item.fps))) return false;
  }
  if (f.colors.length) {
    if (!item.colorMode || !f.colors.includes(item.colorMode)) return false;
  }
  return true;
}

/** Groups bursts into stacks (when asked), keeping the first-listed member as the cover. */
export function buildEntries(items: CameraMediaItem[], stackBursts: boolean): GalleryEntry[] {
  if (!stackBursts) return items.map((i) => ({ id: i.id, cover: i, members: [i] }));
  const entries: GalleryEntry[] = [];
  const stacks = new Map<string, GalleryEntry>();
  for (const item of items) {
    if (item.groupId) {
      const stack = stacks.get(item.groupId);
      if (stack) {
        stack.members.push(item);
        continue;
      }
      const entry = { id: item.id, cover: item, members: [item] };
      stacks.set(item.groupId, entry);
      entries.push(entry);
    } else {
      entries.push({ id: item.id, cover: item, members: [item] });
    }
  }
  return entries;
}

function entrySize(e: GalleryEntry) {
  return e.members.reduce((n, m) => n + m.sizeBytes, 0);
}

export function sortEntries(entries: GalleryEntry[], sort: MediaSort): GalleryEntry[] {
  const copy = [...entries];
  switch (sort) {
    case 'newest':
      return copy.sort((a, b) => b.cover.createdAt - a.cover.createdAt);
    case 'oldest':
      return copy.sort((a, b) => a.cover.createdAt - b.cover.createdAt);
    case 'largest':
      return copy.sort((a, b) => entrySize(b) - entrySize(a));
    case 'longest':
      return copy.sort((a, b) => (b.cover.durationSec ?? -1) - (a.cover.durationSec ?? -1));
  }
}

export interface GalleryModel {
  entries: GalleryEntry[];
  sections: GallerySection[];
  counts: Record<MediaCategory, number>;
  filterOptions: FilterOptions;
}

export function deriveGallery(
  items: CameraMediaItem[],
  options: { category: MediaCategory; filters: MediaFilters; sort: MediaSort; stackBursts: boolean; groupByDay: boolean },
): GalleryModel {
  const all = buildEntries(items, options.stackBursts);
  const counts: Record<MediaCategory, number> = {
    all: all.length,
    video: all.filter((e) => e.cover.kind === 'video').length,
    photo: all.filter((e) => e.cover.kind === 'photo').length,
    favorites: all.filter((e) => e.members.some((m) => m.favorite)).length,
  };
  const inTab = all.filter((e) =>
    options.category === 'favorites' ? e.members.some((m) => m.favorite) : inCategory(e.cover, options.category),
  );
  const filterOptions = buildFilterOptions(inTab.map((e) => e.cover));
  const entries = sortEntries(
    inTab.filter((e) => passesFilters(e.cover, options.filters)),
    options.sort,
  );
  const dated = options.groupByDay && (options.sort === 'newest' || options.sort === 'oldest');
  const sections: GallerySection[] = [];
  if (!dated) sections.push({ key: 'all', title: null, entries });
  else {
    for (const entry of entries) {
      const key = dayKey(entry.cover.createdAt);
      const last = sections[sections.length - 1];
      if (last && last.key === key) last.entries.push(entry);
      else sections.push({ key, title: dayLabel(entry.cover.createdAt), entries: [entry] });
    }
  }
  return { entries, sections, counts, filterOptions };
}

function buildFilterOptions(items: CameraMediaItem[]): FilterOptions {
  const res = new Map<string, number>();
  const fps = new Map<number, number>();
  const colors = new Map<ColorMode, number>();
  for (const i of items) {
    const r = resolutionLabel(i.width, i.height);
    if (r) res.set(r, (res.get(r) ?? 0) + 1);
    if (i.kind === 'video' && i.fps) fps.set(Math.round(i.fps), (fps.get(Math.round(i.fps)) ?? 0) + 1);
    if (i.colorMode) colors.set(i.colorMode, (colors.get(i.colorMode) ?? 0) + 1);
  }
  return {
    resolutions: [...res.entries()].map(([value, count]) => ({ value, label: value, count })),
    frameRates: [...fps.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, label: `${value}p`, count })),
    colors: [...colors.entries()].map(([value, count]) => ({ value, label: colorModeLabel(value) ?? value, count })),
  };
}

/** Every camera item behind the selected entries (a stack selects all its frames). */
export function selectedItems(entries: GalleryEntry[], selected: string[]): CameraMediaItem[] {
  const ids = new Set(selected);
  return entries.filter((e) => ids.has(e.id)).flatMap((e) => e.members);
}

/** Items navigable from playback in gallery order (stacks contribute their cover only). */
export function playbackOrder(entries: GalleryEntry[]): CameraMediaItem[] {
  return entries.map((e) => e.cover);
}
