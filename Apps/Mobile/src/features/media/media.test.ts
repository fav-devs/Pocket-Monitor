import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DragSelection } from './dragSelection';
import { byteLabel, durationLabel, storageReadout, timecodeLabel, transferCaption, transferRateLabel } from './format';
import { base64Url, sha256, utf8 } from './frameioPkce';
import { buildEntries, deriveGallery } from './gallery';
import { layoutMasonry, masonryIndexAt } from './masonry';
import { TransferRateEstimator } from './transferRate';
import type { CameraMediaItem } from '@/camera';

describe('labels', () => {
  it('formats decimal bytes like ByteCountLabel', () => {
    expect(byteLabel(0)).toBe('0 B');
    expect(byteLabel(999)).toBe('999 B');
    expect(byteLabel(1500)).toBe('2 KB');
    expect(byteLabel(20_600_000)).toBe('20.6 MB');
    expect(byteLabel(999_960_000)).toBe('1 GB');
    expect(byteLabel(60_000_000_000)).toBe('60 GB');
  });
  it('formats transfer rates like MediaTransferRate', () => {
    expect(transferRateLabel(420_000)).toBe('420 KB/s');
    expect(transferRateLabel(4_250_000)).toBe('4.3 MB/s');
    expect(transferRateLabel(42_400_000)).toBe('42 MB/s');
    expect(transferCaption(0.18, '42 MB/s')).toBe('18% · 42 MB/s');
    expect(transferCaption(null)).toBeNull();
  });
  it('formats clip clocks', () => {
    expect(durationLabel(21)).toBe('0:21');
    expect(durationLabel(3723)).toBe('1:02:03');
    expect(timecodeLabel(6.5, 25)).toBe('00:00:06:12');
    expect(timecodeLabel(6.5)).toBe('00:00:06');
  });
  it('reads storage like StorageReadout', () => {
    expect(storageReadout(60_000, 128_000)).toBe('60 GB · 47%');
    expect(storageReadout(0, 0)).toBe('—');
  });
});

describe('masonry', () => {
  it('places each card in the shortest column, leftmost on a tie', () => {
    const m = layoutMasonry([16 / 9, 4 / 3, 16 / 9, 16 / 9], 2, 210, 10, 44);
    expect(m.frames.map((f) => f.column)).toEqual([0, 1, 0, 1]);
    expect(masonryIndexAt(m, 5, 5)).toBe(0);
    expect(masonryIndexAt(m, 105, 5)).toBeNull();
  });
});

describe('drag selection', () => {
  it('sweeps and reverts only crossed items', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const s = DragSelection.begin(ids, 'b', new Set(['d']))!;
    expect([...s.selected].sort()).toEqual(['b', 'd']);
    s.move(3);
    expect([...s.selected].sort()).toEqual(['b', 'c', 'd']);
    s.move(0);
    expect([...s.selected].sort()).toEqual(['a', 'b', 'd']);
  });
});

describe('transfer rate', () => {
  it('measures, then reports stalls', () => {
    const e = new TransferRateEstimator(0);
    expect(e.rate(100).kind).toBe('measuring');
    e.record(1_000_000, 500);
    e.record(2_000_000, 1000);
    const r = e.rate(1000);
    expect(r.kind).toBe('rate');
    if (r.kind === 'rate') expect(r.bytesPerSecond).toBe(2_000_000);
    expect(e.rate(4100).kind).toBe('stalled');
  });
});

describe('pkce', () => {
  it('matches Node crypto for S256 challenges', () => {
    for (const v of ['dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk', 'a'.repeat(64), 'ü-ünïcode~verifier_0123456789']) {
      expect(base64Url(sha256(utf8(v)))).toBe(createHash('sha256').update(v).digest('base64url'));
    }
  });
  it('hashes the empty string', () => {
    const hex = Array.from(sha256(new Uint8Array())).map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('gallery', () => {
  const item = (id: string, extra: Partial<CameraMediaItem> = {}): CameraMediaItem => ({
    id,
    kind: 'photo',
    fileName: `${id}.JPG`,
    createdAt: 1_700_000_000_000,
    sizeBytes: 100,
    favorite: false,
    ...extra,
  });
  it('stacks bursts behind their first frame', () => {
    const entries = buildEntries([item('a'), item('b', { groupId: 'g' }), item('c', { groupId: 'g' })], true);
    expect(entries.map((e) => [e.id, e.members.length])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });
  it('counts categories and filters favorites', () => {
    const m = deriveGallery([item('a', { kind: 'video', fps: 60, width: 3840, height: 2160 }), item('b', { favorite: true })], {
      category: 'favorites',
      filters: { resolutions: [], frameRates: [], colors: [] },
      sort: 'newest',
      stackBursts: true,
      groupByDay: true,
    });
    expect(m.counts).toEqual({ all: 2, video: 1, photo: 1, favorites: 1 });
    expect(m.entries.map((e) => e.id)).toEqual(['b']);
  });
});
