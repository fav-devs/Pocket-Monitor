import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => disk.get(k) ?? null,
    setItem: async (k: string, v: string) => void disk.set(k, v),
    removeItem: async (k: string) => void disk.delete(k),
  },
}));

const { useClipMeta, sanitize, metaOf, identityOf, currentTake } = await import('./clipMeta');
const { matchTakes } = await import('@/core/markers');

const T0 = Date.UTC(2026, 10, 27, 10, 0, 0);
const item = (id: string, createdAt: number, durationSec: number) => ({
  id,
  kind: 'video' as const,
  fileName: `${id.toUpperCase()}.MP4`,
  createdAt,
  durationSec,
  sizeBytes: 1000 + durationSec,
  fps: 30,
  favorite: false,
});

beforeEach(() => {
  disk.clear();
  useClipMeta.setState({ clips: {}, takes: [], shoots: [], activeShootId: null, userTags: [], takeCounters: {} });
});

function recordTake(id: string, startedAt: number, durationSec: number, markerAt: number[]) {
  const s = useClipMeta.getState();
  const take = s.beginTake({ id, startedAt, timeSource: 'camera', cameraId: 'cam', fps: 30, shootId: s.activeShootId, knownIds: [], markers: [] });
  for (const [i, t] of markerAt.entries()) {
    useClipMeta.getState().addMarker({ kind: 'take', takeId: id }, { id: `${id}-m${i}`, time: t, label: '', tag: null, color: 'blue', createdAt: startedAt + t * 1000 });
  }
  useClipMeta.getState().finishTake(id, startedAt + durationSec * 1000, durationSec);
  return take;
}

function listAndMatch(items: ReturnType<typeof item>[]) {
  const s = useClipMeta.getState();
  const claimed = new Set(Object.entries(s.clips).filter(([, m]) => m.take).map(([id]) => id));
  const matches = matchTakes(s.takes.filter((t) => t.stoppedAt != null), items, claimed, 'cam');
  s.applyMatches(matches, new Map(items.map((i) => [i.id, identityOf(i)])));
  return matches;
}

describe('takes and their clips', () => {
  it('pending markers wait for the file, survive a restart, then land on the clip', () => {
    const shoot = useClipMeta.getState().startShoot('Tokyo', 'Vlog/Tokyo/Day 2');
    recordTake('t1', T0, 41, [3, 12.4]);
    expect(currentTake(useClipMeta.getState().takes)).toBeUndefined();
    // Not listed yet.
    expect(listAndMatch([item('old', T0 - 3_600_000, 41)])).toEqual([]);
    expect(useClipMeta.getState().takes).toHaveLength(1);

    // App restart: what was persisted is all that is left.
    const persisted = JSON.parse(JSON.stringify(useClipMeta.getState()));
    useClipMeta.setState({ ...sanitize(persisted) });
    expect(useClipMeta.getState().takes[0].markers.map((m) => m.time)).toEqual([3, 12.4]);

    // The file shows up.
    const clip = item('dji_0042', T0 + 400, 41.1);
    expect(listAndMatch([item('old', T0 - 3_600_000, 41), clip])).toEqual([{ takeId: 't1', itemId: 'dji_0042' }]);
    const meta = useClipMeta.getState().clips.dji_0042;
    expect(meta.markers.map((m) => m.time)).toEqual([3, 12.4]);
    expect(meta.shootId).toBe(shoot.id);
    expect(meta.take).toMatchObject({ id: 't1', number: 1 });
    expect(useClipMeta.getState().takes).toEqual([]);
    // Listing again matches nothing twice.
    expect(listAndMatch([clip])).toEqual([]);
  });

  it('clips recorded while a shoot is active join it; take numbers count per shoot', () => {
    recordTake('a', T0, 10, []);
    const shoot = useClipMeta.getState().startShoot('', '');
    expect(shoot.name).toBe('Shoot 1');
    recordTake('b', T0 + 60_000, 20, []);
    recordTake('c', T0 + 120_000, 30, []);
    useClipMeta.getState().endShoot(shoot.id);
    expect(useClipMeta.getState().activeShootId).toBeNull();
    recordTake('d', T0 + 180_000, 40, []);
    listAndMatch([item('a', T0, 10), item('b', T0 + 60_000, 20), item('c', T0 + 120_000, 30), item('d', T0 + 180_000, 40)]);
    const clips = useClipMeta.getState().clips;
    // A take without markers still records its shoot and number.
    expect(clips.a?.shootId ?? null).toBeNull();
    expect([clips.b.shootId, clips.c.shootId]).toEqual([shoot.id, shoot.id]);
    expect(clips.d.shootId).toBeNull();
    expect([clips.b.take!.number, clips.c.take!.number]).toEqual([1, 2]);
  });

  it('moves clips between shoots, renames and finds a clip under another id', () => {
    const one = useClipMeta.getState().startShoot('One', '');
    const two = useClipMeta.getState().startShoot('Two', 'A/B');
    const clip = item('x', T0, 5);
    useClipMeta.getState().setShoot([clip], one.id);
    useClipMeta.getState().setShoot([clip], two.id);
    useClipMeta.getState().editShoot(two.id, { name: '  Day   2 ', folderPath: 'Vlog//Tokyo/' });
    const s = useClipMeta.getState();
    expect(s.clips.x.shootId).toBe(two.id);
    expect(s.shoots.find((x) => x.id === two.id)).toMatchObject({ name: 'Day 2', folderPath: 'Vlog/Tokyo' });
    // The desktop lists the same file under its path.
    expect(metaOf(s.clips, { id: '/DCIM/100MEDIA/X.MP4', fileName: 'x.mp4', sizeBytes: clip.sizeBytes })?.shootId).toBe(two.id);
    // Out of every shoot and nothing else: the entry goes.
    useClipMeta.getState().setShoot([clip], null);
    expect(useClipMeta.getState().clips.x).toBeUndefined();
  });

  it('edits markers on a clip and keeps tags and notes', () => {
    const clip = item('y', T0, 30);
    const ref = { kind: 'clip' as const, itemId: 'y' };
    useClipMeta.getState().addMarker(ref, { id: 'm', time: 4, label: '', tag: null, color: 'blue', createdAt: T0 }, clip);
    useClipMeta.getState().updateMarker(ref, 'm', { label: 'Jump', tag: 'Good', color: 'green' });
    useClipMeta.getState().toggleClipTag(clip, 'Hook');
    useClipMeta.getState().setNotes(clip, 'Keep');
    let m = useClipMeta.getState().clips.y;
    expect(m.markers[0]).toMatchObject({ label: 'Jump', tag: 'Good', color: 'green' });
    expect(m.tags).toEqual(['Hook']);
    useClipMeta.getState().removeMarker(ref, 'm');
    m = useClipMeta.getState().clips.y;
    expect(m.markers).toEqual([]);
    expect(m.notes).toBe('Keep');
  });

  it('reads a damaged copy as far as it goes', () => {
    const read = sanitize({ clips: { a: { identity: { fileName: 'A.MP4' }, markers: [{ id: 'm', time: 1 }, { bad: true }] }, b: 'junk' }, takes: [{ id: 't' }], activeShootId: 'gone', userTags: ['x', 3] });
    expect(Object.keys(read.clips)).toEqual(['a']);
    expect(read.clips.a.markers).toHaveLength(1);
    expect(read.takes).toEqual([]);
    expect(read.activeShootId).toBeNull();
    expect(read.userTags).toEqual(['x']);
  });
});
