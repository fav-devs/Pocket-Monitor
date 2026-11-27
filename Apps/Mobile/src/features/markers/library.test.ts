import { describe, expect, it } from 'vitest';
import type { CameraMediaItem } from '@/camera';
import type { ClipMeta, Shoot } from '@/core/markers';
import { deriveGallery } from '@/features/media/gallery';
import { matchesQuery, passesMetaFilter, shootSectionOf, tagsIn } from './library';

const emptyFilters = { resolutions: [], frameRates: [], colors: [] };

const item = (id: string, createdAt: number): CameraMediaItem => ({ id, kind: 'video', fileName: `${id}.MP4`, createdAt, sizeBytes: 1, durationSec: 5, favorite: false });
const meta = (over: Partial<ClipMeta>): ClipMeta => ({ identity: { fileName: 'x', createdAt: 0 }, markers: [], tags: [], notes: '', shootId: null, updatedAt: 0, ...over });
const shoots: Shoot[] = [
  { id: 's1', name: 'Tokyo', folderPath: 'Vlog/Tokyo/Day 2', createdAt: 1 },
  { id: 's2', name: 'Osaka', folderPath: '', createdAt: 2 },
];
const metas: Record<string, ClipMeta> = {
  a: meta({ tags: ['B-roll'], shootId: 's1', notes: 'ramen stall' }),
  b: meta({ markers: [{ id: 'm', time: 1, label: 'Big laugh', tag: 'Hook', color: 'yellow', createdAt: 0 }], shootId: 's2' }),
};
const lookup = (i: CameraMediaItem) => metas[i.id];

describe('the library and clip metadata', () => {
  it('search reads tags, notes, marker labels and the shoot', () => {
    expect(matchesQuery(item('a', 0), metas.a, shoots[0], 'ramen')).toBe(true);
    expect(matchesQuery(item('a', 0), metas.a, shoots[0], 'day 2')).toBe(true);
    expect(matchesQuery(item('b', 0), metas.b, shoots[1], 'laugh')).toBe(true);
    expect(matchesQuery(item('b', 0), metas.b, shoots[1], 'hook')).toBe(true);
    expect(matchesQuery(item('c', 0), undefined, undefined, 'hook')).toBe(false);
    expect(matchesQuery(item('c', 0), undefined, undefined, 'C.MP')).toBe(true);
  });

  it('filters by tag (clip or marker) and by shoot', () => {
    expect(passesMetaFilter(metas.b, { tags: ['hook'], shootId: null })).toBe(true);
    expect(passesMetaFilter(metas.a, { tags: ['hook'], shootId: null })).toBe(false);
    expect(passesMetaFilter(metas.a, { tags: [], shootId: 's1' })).toBe(true);
    expect(passesMetaFilter(undefined, { tags: [], shootId: 'none' })).toBe(true);
    expect(passesMetaFilter(metas.a, { tags: [], shootId: 'none' })).toBe(false);
    expect(tagsIn([item('a', 0), item('b', 0)], lookup)).toEqual(['B-roll', 'Hook']);
  });

  it('groups by shoot, newest shoot first, no shoot last', () => {
    const items = [item('a', 3), item('b', 2), item('c', 1)];
    const model = deriveGallery(items, { category: 'all', filters: emptyFilters, sort: 'newest', stackBursts: true, groupByDay: true, sectionOf: shootSectionOf(lookup, shoots) });
    expect(model.sections.map((s) => [s.title, s.entries.map((e) => e.id)])).toEqual([
      ['Osaka', ['b']],
      ['Tokyo', ['a']],
      ['No shoot', ['c']],
    ]);
  });
});
