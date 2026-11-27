import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ClipMarker,
  type ClipMeta,
  type ExportClip,
  type PendingTake,
  PHONE_START_OFFSET_SEC,
  RecordingClock,
  SIDECAR_FORMAT,
  buildSidecar,
  cleanFolderPath,
  colorForTag,
  exportFileName,
  frameAt,
  frameDuration,
  knownIdsOf,
  matchTakes,
  metaForMatch,
  parseSidecar,
  shiftMarkersForTrim,
  sidecarFileName,
  sidecarJson,
  sidecarPathBeside,
  timecodeAt,
  toFcpxml,
  toPremiereCsv,
  toResolveCsv,
  toResolveEdl,
  toastTags,
  toggleTag,
} from './index';

const T0 = Date.UTC(2026, 10, 27, 10, 0, 0);

const marker = (id: string, time: number, extra: Partial<ClipMarker> = {}): ClipMarker => ({
  id,
  time,
  label: '',
  tag: null,
  color: 'blue',
  createdAt: T0 + time * 1000,
  ...extra,
});

describe('RecordingClock: markers by the camera’s own recording time', () => {
  it('settles on the earliest elapsed report and carries the fraction on the phone clock', () => {
    const c = new RecordingClock();
    // REC seen 0.3 s after the camera started, reporting 0.
    c.update(true, 0, T0 + 300);
    // Elapsed 1 arrives 80 ms late, elapsed 2 arrives 20 ms late.
    c.update(true, 1, T0 + 1080);
    c.update(true, 2, T0 + 2020);
    c.update(true, 2, T0 + 2500);
    expect(c.startedAt(T0 + 2500)).toBe(T0 + 20);
    const p = c.position(T0 + 2520)!;
    expect(p.source).toBe('camera');
    expect(p.seconds).toBeCloseTo(2.5, 3);
  });

  it('a step replaces the first report of 0, whose time is only a guess', () => {
    const c = new RecordingClock();
    c.update(true, 0, T0 + 100);
    // Before any step: the phone clock with the known offset.
    expect(c.position(T0 + 600)!.seconds).toBeCloseTo(0.5 + PHONE_START_OFFSET_SEC, 3);
    c.update(true, 1, T0 + 1050);
    expect(c.startedAt(T0 + 1100)).toBe(T0 + 50);
    // A new take under REC (the elapsed time goes back) starts over.
    c.update(true, 5, T0 + 5050);
    c.update(true, 1, T0 + 9030);
    expect(c.startedAt(T0 + 9100)).toBe(T0 + 8030);
  });

  it('never leaves the second the camera last reported', () => {
    const c = new RecordingClock();
    c.update(true, 0, T0);
    c.update(true, 5, T0 + 5000);
    // The phone stalls: 7 s later still says 5.x.
    expect(c.position(T0 + 12_000)!.seconds).toBeLessThan(6);
    expect(c.position(T0 + 12_000)!.seconds).toBeGreaterThanOrEqual(5);
  });

  it('joins a take already running from its elapsed time', () => {
    const c = new RecordingClock();
    c.update(true, 41, T0 + 41_200);
    c.update(true, 42, T0 + 42_050);
    expect(c.position(T0 + 42_500)!.seconds).toBeCloseTo(42.45, 2);
  });

  it('falls back to the phone clock with the known offset when no elapsed time comes', () => {
    const c = new RecordingClock();
    c.update(true, 0, T0);
    c.update(true, 0, T0 + 4000);
    const p = c.position(T0 + 4000)!;
    expect(p.source).toBe('phone');
    expect(p.seconds).toBeCloseTo(4 + PHONE_START_OFFSET_SEC, 3);
    c.update(false, 0, T0 + 5000);
    expect(c.position(T0 + 5000)).toBeNull();
  });

  it('frames are the nearest at the clip rate', () => {
    expect(frameAt(41.02, 30)).toBe(1231);
    expect(frameAt(1.5, 59.94)).toBe(90);
    expect(frameAt(-1, 30)).toBe(0);
  });
});

const take = (over: Partial<PendingTake> = {}): PendingTake => ({
  id: 't1',
  number: 1,
  startedAt: T0,
  stoppedAt: T0 + 41_000,
  durationSec: 41,
  timeSource: 'camera',
  cameraId: 'cam',
  fps: 30,
  shootId: null,
  knownIds: [],
  markers: [marker('m1', 12.4)],
  ...over,
});

const file = (id: string, createdAt: number, durationSec?: number, kind: 'video' | 'photo' = 'video') => ({ id, kind, fileName: `${id}.MP4`, createdAt, durationSec });

describe('matching a take with the file it made', () => {
  it('pairs by start time and duration, best fit first, one to one', () => {
    const files = [file('old', T0 - 600_000, 41), file('new', T0 + 1000, 41.2), file('photo', T0, undefined, 'photo')];
    expect(matchTakes([take()], files, new Set())).toEqual([{ takeId: 't1', itemId: 'new' }]);
    // Already claimed by another take: left alone.
    expect(matchTakes([take()], files, new Set(['new']))).toEqual([]);
  });

  it('keeps a take pending while its file is not listed, and while it is still recording', () => {
    expect(matchTakes([take()], [file('a', T0 - 3_600_000, 41)], new Set())).toEqual([]);
    expect(matchTakes([take({ stoppedAt: undefined })], [file('a', T0, 41)], new Set())).toEqual([]);
  });

  it('a file stamped at the close also matches', () => {
    expect(matchTakes([take()], [file('a', T0 + 41_500, 41)], new Set())).toEqual([{ takeId: 't1', itemId: 'a' }]);
  });

  it('a wrong duration never matches', () => {
    expect(matchTakes([take()], [file('a', T0 + 500, 12)], new Set())).toEqual([]);
  });

  it('a camera clock hours off still matches a new file of the right length', () => {
    const before = [file('x1', T0 - 9e6, 10), file('x2', T0 - 8e6, 20)];
    const known = knownIdsOf(before);
    const t = take({ ...known });
    const listed = [...before, file('fresh', T0 - 7e6, 41.4), file('older', T0 - 9.5e6, 41)];
    expect(matchTakes([t], listed, new Set())).toEqual([{ takeId: 't1', itemId: 'fresh' }]);
  });

  it('two takes and two files pair up by fit', () => {
    const a = take({ id: 'a', startedAt: T0, stoppedAt: T0 + 10_000, durationSec: 10 });
    const b = take({ id: 'b', startedAt: T0 + 20_000, stoppedAt: T0 + 50_000, durationSec: 30 });
    const out = matchTakes([a, b], [file('f2', T0 + 20_000, 30), file('f1', T0, 10)], new Set());
    expect(out).toContainEqual({ takeId: 'a', itemId: 'f1' });
    expect(out).toContainEqual({ takeId: 'b', itemId: 'f2' });
  });

  it('a take from another camera waits for that camera', () => {
    expect(matchTakes([take({ cameraId: 'other' })], [file('a', T0, 41)], new Set(), 'cam')).toEqual([]);
  });

  it('pending → matched: markers, shoot and take land on the clip', () => {
    const meta = metaForMatch(undefined, take({ shootId: 's1', number: 3 }), { fileName: 'DJI_0001.MP4', createdAt: T0, durationSec: 41.2, sizeBytes: 9 });
    expect(meta.markers.map((m) => m.id)).toEqual(['m1']);
    expect(meta.shootId).toBe('s1');
    expect(meta.take).toMatchObject({ id: 't1', number: 3, startedAt: T0, timeSource: 'camera' });
    expect(meta.identity.fps).toBe(30);
    // A clip already in a shoot keeps it; markers merge by id.
    const again = metaForMatch({ ...meta, shootId: 'kept' }, take({ markers: [marker('m1', 12.4), marker('m2', 20)] }), meta.identity);
    expect(again.shootId).toBe('kept');
    expect(again.markers.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('trim', () => {
  it('moves markers back by the trim start and drops those outside it', () => {
    const ms = [marker('a', 1), marker('b', 5), marker('c', 9.5), marker('d', 10), marker('e', 12)];
    const out = shiftMarkersForTrim(ms, { start: 4, end: 10 });
    expect(out.map((m) => [m.id, m.time])).toEqual([
      ['b', 1],
      ['c', 5.5],
      ['d', 6],
    ]);
    // The input is untouched; no trim keeps every marker.
    expect(ms[1].time).toBe(5);
    expect(shiftMarkersForTrim(ms, null)).toHaveLength(5);
  });
});

const meta = (over: Partial<ClipMeta> = {}): ClipMeta => ({
  identity: { fileName: 'DJI_20261127100000_0001_D.MP4', createdAt: T0, durationSec: 41.2, sizeBytes: 51_500_000, fps: 30, width: 3840, height: 2160, colorMode: 'dlog-m', codec: 'h265', cameraModel: 'osmo-pocket-3', cameraName: 'Pocket 3', cameraSerial: 'SN1' },
  markers: [marker('m1', 12.4, { tag: 'Hook', color: 'yellow', label: 'Laugh', source: 'button' }), marker('m2', 3, { tag: 'Good', color: 'green' })],
  tags: ['B-roll'],
  notes: 'Wide of the market',
  shootId: 's1',
  take: { id: 't1', number: 3, startedAt: T0, timeSource: 'camera' },
  updatedAt: T0,
  ...over,
});

const shoot = { id: 's1', name: 'Tokyo', folderPath: 'Vlog/Tokyo/Day 2', createdAt: T0 };
const app = { version: '0.1.0', platform: 'ios' };

describe('sidecar v1', () => {
  it('names the file after the clip', () => {
    expect(sidecarFileName('DJI_0001.MP4')).toBe('DJI_0001.pocketmeta.json');
    expect(sidecarFileName('noext')).toBe('noext.pocketmeta.json');
    expect(sidecarPathBeside('file:///a/b/DJI_0001.MP4')).toBe('file:///a/b/DJI_0001.pocketmeta.json');
    expect(sidecarPathBeside('C:\\Videos\\DJI_0001.MP4')).toBe('C:\\Videos\\DJI_0001.pocketmeta.json');
  });

  it('writes the format, markers by time with frames, tags, rating, shoot and take', () => {
    const s = buildSidecar({ meta: meta(), rating: 4, favorite: true, shoot, app, now: T0 + 60_000 });
    expect(s.format).toBe(SIDECAR_FORMAT);
    expect(s.version).toBe(1);
    expect(s.clip).toMatchObject({ fileName: 'DJI_20261127100000_0001_D.MP4', fps: 30, width: 3840, colorMode: 'dlog-m', codec: 'h265', camera: { model: 'osmo-pocket-3', serial: 'SN1' } });
    expect(s.markers.map((m) => [m.id, m.time, m.frame, m.tag])).toEqual([
      ['m2', 3, 90, 'Good'],
      ['m1', 12.4, 372, 'Hook'],
    ]);
    expect(s.shoot).toEqual({ id: 's1', name: 'Tokyo', folderPath: 'Vlog/Tokyo/Day 2' });
    expect(s.take).toEqual({ id: 't1', number: 3, startedAt: new Date(T0).toISOString(), timeSource: 'camera' });
    expect(s.rating).toBe(4);
    expect(s.favorite).toBe(true);
  });

  it('round-trips, keeping fields it does not know at every level', () => {
    const s = buildSidecar({ meta: meta(), rating: 2, favorite: false, shoot, app, now: T0 });
    const future = JSON.parse(sidecarJson(s));
    future.version = 2;
    future.aiCut = { projectId: 'p1' };
    future.clip.lens = 'wide';
    future.markers[0].confidence = 0.9;
    future.shoot.location = 'Shibuya';
    future.take.slate = 'A';
    future.app.build = '77';
    const read = parseSidecar(JSON.stringify(future), T0);
    expect(read.version).toBe(2);
    expect(read.meta.markers.find((m) => m.id === 'm2')!.extra).toEqual({ confidence: 0.9 });
    const again = JSON.parse(sidecarJson(buildSidecar({ meta: read.meta, rating: read.rating, favorite: read.favorite, shoot, app, now: T0 })));
    expect(again.aiCut).toEqual({ projectId: 'p1' });
    expect(again.clip.lens).toBe('wide');
    expect(again.markers[0].confidence).toBe(0.9);
    expect(again.shoot.location).toBe('Shibuya');
    expect(again.take.slate).toBe('A');
    expect(again.app.build).toBe('77');
    // Everything this app knows comes back as written.
    const { writtenAt: _w, ...first } = JSON.parse(sidecarJson(s));
    const { writtenAt: _w2, aiCut: _a, ...second } = again;
    second.version = 1;
    delete second.clip.lens;
    delete second.markers[0].confidence;
    delete second.shoot.location;
    delete second.take.slate;
    delete second.app.build;
    expect(second).toEqual(first);
  });

  it('refuses what is not a sidecar and reads a marker from its frame alone', () => {
    expect(() => parseSidecar('nope')).toThrow();
    expect(() => parseSidecar({ format: 'x', version: 1 })).toThrow();
    expect(() => parseSidecar({ format: SIDECAR_FORMAT, version: 1, clip: {} })).toThrow();
    const read = parseSidecar({ format: SIDECAR_FORMAT, version: 1, clip: { fileName: 'A.MP4', fps: 25 }, markers: [{ id: 'x', frame: 50, tag: ' Good ' }, { time: -1 }, 'junk'] });
    expect(read.meta.markers).toHaveLength(1);
    expect(read.meta.markers[0]).toMatchObject({ time: 2, tag: 'Good', color: 'green' });
  });

  it('every field the writer puts out is in the JSON schema', () => {
    const schema = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../docs/clip-metadata.schema.json'), 'utf8'));
    const s = buildSidecar({ meta: meta(), rating: 1, favorite: true, shoot, app, now: T0, derivedFrom: { fileName: 'A.MP4', trimStart: 1, trimEnd: 2 } });
    for (const k of schema.required) expect(s).toHaveProperty(k);
    for (const k of Object.keys(s)) expect(schema.properties).toHaveProperty(k);
    for (const k of Object.keys(s.clip)) expect(schema.properties.clip.properties).toHaveProperty(k);
    for (const k of Object.keys(s.markers[0])) expect(schema.$defs.marker.properties).toHaveProperty(k);
    expect(schema.properties.format.const).toBe(SIDECAR_FORMAT);
    expect(schema.additionalProperties).not.toBe(false);
  });
});

describe('tags and shoots', () => {
  it('offers the built-ins then the operator’s own, once each', () => {
    expect(toastTags(['Sunset', 'good'])).toEqual(['Good', 'Bad', 'Hook', 'B-roll', 'Retake', 'Sunset']);
    expect(toggleTag(['Good'], 'good')).toEqual([]);
    expect(toggleTag([], '  Hook  ')).toEqual(['Hook']);
    expect(colorForTag('Bad')).toBe('red');
    expect(colorForTag('Sunset')).toBe('pink');
    expect(colorForTag(null)).toBe('blue');
  });

  it('cleans a folder path', () => {
    expect(cleanFolderPath(' Vlog / Tokyo//Day 2/ ')).toBe('Vlog/Tokyo/Day 2');
    expect(cleanFolderPath('..\\a:b\\c')).toBe('ab/c');
  });
});

const exportClip = (over: Partial<ExportClip> = {}): ExportClip => {
  const m = meta();
  return { identity: m.identity, markers: m.markers, tags: m.tags, rating: 4, favorite: true, notes: m.notes, shootName: 'Tokyo', ...over };
};

describe('marker exports', () => {
  it('timecodes and frame durations', () => {
    expect(timecodeAt(3661.5, 30)).toBe('01:01:01:15');
    expect(frameDuration(29.97)).toEqual({ num: 1001, den: 30000 });
    expect(frameDuration(25)).toEqual({ num: 1, den: 25 });
  });

  it('FCPXML', () => {
    expect(toFcpxml([exportClip()])).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE fcpxml>
      <fcpxml version="1.10">
        <resources>
          <format id="r1" frameDuration="1/30s" width="3840" height="2160"/>
          <asset id="r2" name="DJI_20261127100000_0001_D" start="0s" duration="1236/30s" hasVideo="1" hasAudio="1" format="r1">
            <media-rep kind="original-media" src="./DJI_20261127100000_0001_D.MP4"/>
          </asset>
        </resources>
        <library>
          <event name="Tokyo">
            <asset-clip ref="r2" name="DJI_20261127100000_0001_D" duration="1236/30s" format="r1" tcFormat="NDF">
              <note>Wide of the market</note>
              <marker start="90/30s" duration="1/30s" value="Good" note="Good"/>
              <marker start="372/30s" duration="1/30s" value="Laugh" note="Hook"/>
              <keyword start="0s" duration="1236/30s" value="B-roll"/>
              <rating start="0s" duration="1236/30s" value="favorite"/>
            </asset-clip>
          </event>
        </library>
      </fcpxml>
      "
    `);
  });

  it('Resolve EDL lays clips end to end from 01:00:00:00', () => {
    const second = exportClip({ identity: { ...meta().identity, fileName: 'DJI_0002.MP4', durationSec: 10 }, markers: [marker('z', 2, { color: 'red', label: 'Redo' })] });
    expect(toResolveEdl([exportClip(), second])).toMatchInlineSnapshot(`
      "TITLE: Pocket Monitor markers
      FCM: NON-DROP FRAME

      001  001      V     C        01:00:03:00 01:00:03:01 01:00:03:00 01:00:03:01
       |C:ResolveColorGreen |M:Good |D:1

      002  001      V     C        01:00:12:12 01:00:12:13 01:00:12:12 01:00:12:13
       |C:ResolveColorYellow |M:Laugh |D:1

      003  001      V     C        01:00:43:06 01:00:43:07 01:00:43:06 01:00:43:07
       |C:ResolveColorRed |M:Redo |D:1
      "
    `);
  });

  it('Resolve and Premiere CSV', () => {
    const clip = exportClip({ markers: [marker('q', 1, { label: 'Say "hi", wave', tag: 'Hook', color: 'yellow' })] });
    expect(toResolveCsv([clip])).toMatchInlineSnapshot(`
      "File Name,Marker Name,Notes,Color,Source In,Duration,Frame,Seconds,Keywords,Clip Tags,Rating
      DJI_20261127100000_0001_D.MP4,"Say ""hi"", wave","Say ""hi"", wave",Yellow,00:00:01:00,1,30,1.000,Hook,B-roll,4
      "
    `);
    expect(toPremiereCsv([clip])).toMatchInlineSnapshot(`
      "Marker Name,Description,In,Out,Duration,Marker Type,File Name
      "Say ""hi"", wave","Hook · Say ""hi"", wave",00:00:01:00,00:00:01:00,00:00:00:00,Comment,DJI_20261127100000_0001_D.MP4
      "
    `);
  });

  it('names the export after the clip, or the day for several', () => {
    expect(exportFileName('fcpxml', [exportClip()])).toBe('DJI_20261127100000_0001_D markers.fcpxml');
    expect(exportFileName('premiere-csv', [exportClip(), exportClip()], T0)).toMatch(/^Pocket Monitor markers 2026-11-2\d Premiere\.csv$/);
  });
});
