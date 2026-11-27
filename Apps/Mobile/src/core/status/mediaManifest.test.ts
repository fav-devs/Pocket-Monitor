import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Commands, mediaListPayload, MEDIA_LIST_TRIGGER } from '../commands/commands';
import { makeFrame } from '../duml/frame';
import { MediaChunkAssembler, MediaFiles, MediaManifest, MEDIA_NEWEST_INTERNAL } from './mediaManifest';

// Ported from OpenCine Tests/OpenCineDJITests/MediaManifestTests.swift (fixture from this repo's
// Tests/OpenPocketViewCoreTests/Fixtures/nano-manifest.bin, identical to upstream's).
const fixture = new Uint8Array(readFileSync(path.resolve(__dirname, '../../../../../Tests/OpenPocketViewCoreTests/Fixtures/nano-manifest.bin')));

describe('MediaManifest', () => {
  it('decodes Nano manifest count and names', () => {
    const files = MediaManifest.decode(fixture);
    expect(files.length).toBe(34);
    expect(MediaManifest.headerCount(fixture)).toBe(34);
    expect(MediaFiles.filename(files[0])).toBe('DJI_20260814125250_0034_D.MP4');
    expect(MediaFiles.filename(files[33])).toBe('DJI_20260404103742_0001_D.MP4');
    expect(files.every((f) => MediaFiles.isVideo(f))).toBe(true);
  });
  it('pairs thumbs, handles and duration', () => {
    const [first, second] = MediaManifest.decode(fixture);
    expect(first.path).toBe('DCIM/DJI_001/DJI_20260814125250_0034_D.MP4');
    expect(first.thumbPath).toBe('MISC/THM/DJI_001/DJI_20260814125250_0034_D.scr');
    expect(first.handle).toBe(0x40100880);
    expect(first.durationSeconds).toBe(209);
    expect(first.fps).toBe(25);
    expect(first.resolution).toBe('3840x2160');
    expect(first.isStarred).toBe(false);
    expect(first.sizeBytes).toBeGreaterThan(0);
    expect(MediaFiles.filename(second)).toBe('DJI_20260814122657_0033_D.MP4');
    expect(second.handle).toBe(0x40100840);
    expect(second.durationSeconds).toBe(1551);
  });
  it('handle fit is Nano geometry', () => {
    const files = MediaManifest.decode(fixture);
    expect(files.filter((f) => f.cmdHandle !== 0).length).toBe(34);
    expect(files[0].cmdHandle).toBe(0x40100880);
    for (let i = 1; i < files.length; i++) expect((files[i - 1].handle - files[i].handle) >>> 0).toBe(0x40);
    expect(MediaFiles.storageGuess(files[0].handle, false)).toBe(1);
    expect(MediaFiles.storageGuess(files[0].handle, true)).toBe(0);
    expect(MediaManifest.recordCount(fixture)).toBe(34);
  });
  it('list payload matches Osmosis', () => {
    const newest = mediaListPayload(1, 1);
    expect(newest[4]).toBe(1);
    expect(newest.slice(10, 14)).toEqual([1, 0, 0, 0]);
    expect(newest[14]).toBe(0x2d);
    expect(mediaListPayload(2, MEDIA_NEWEST_INTERNAL).slice(10, 14)).toEqual([1, 0, 0, 0x40]);
    expect(Array.from(Commands.mediaListTrigger().payload)).toEqual(MEDIA_LIST_TRIGGER);
  });
  it('delete and favourite payloads match capture', () => {
    const del = Commands.deleteMedia(0x40104480, 1);
    expect([del.cmdSet, del.cmdId]).toEqual([0, 0x28]);
    expect(Array.from(del.payload)).toEqual([1, 0x80, 0x44, 0x10, 0x40, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]);
    const fav = Commands.setMediaFavorite(0x40104040, true, 1);
    expect(Array.from(fav.payload)).toEqual([1, 1, 0x40, 0x40, 0x10, 0x40, 1, 0, 0, 0, 0, 1, 0, 0, 0]);
  });
  it('chunk assembler strips subheader; completion is per counter', () => {
    const a = new MediaChunkAssembler();
    expect(a.ingestPayload([0x4a, 4, 0, 0, 2, 0, 0, 0, 0, 0])).toBe(true);
    expect(a.ingest(makeFrame({ sender: 0, receiver: 0, seq: 0, flags: 0, cmdSet: 0, cmdId: 0x27, payload: [0x4a, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0xde, 0xad] }))).toBe(true);
    expect(Array.from(a.assembled(2))).toEqual([0xde, 0xad]);
    a.ingestPayload([0x4a, 3, 0, 0, 2, 0, 0, 0, 0, 0]);
    expect(a.sawEnd && a.didEnd(2) && !a.didEnd(1)).toBe(true);
    expect(a.streamsEnded([2])).toBe(true);
    const ctl = (s: number, c: number) => [0x4a, s, 0, 0, c, 0, 0, 0, 0, 0];
    const b = new MediaChunkAssembler();
    b.ingestPayload(ctl(4, 1));
    b.ingestPayload([...ctl(1, 1), 1]);
    b.ingestPayload(ctl(3, 1));
    expect(b.streamsEnded([1, 2])).toBe(false);
    b.ingestPayload(ctl(4, 2));
    b.ingestPayload([...ctl(1, 2), 2]);
    expect(b.streamsEnded([1, 2])).toBe(false);
    b.ingestPayload(ctl(3, 2));
    expect(b.streamsEnded([1, 2])).toBe(true);
    b.reset();
    b.ingestPayload(ctl(4, 1));
    b.ingestPayload(ctl(4, 2));
    b.ingestPayload([...ctl(1, 2), 2]);
    b.ingestPayload(ctl(3, 2));
    expect(b.streamsEnded([1, 2])).toBe(true);
    expect(b.streamsEnded([1, 2, 3])).toBe(false);
  });
  it('decodeStores stamps the internal store', () => {
    const a = new MediaChunkAssembler();
    for (let i = 0; i < fixture.length; i += 500) a.ingestPayload([0x4a, 1, 0, 0, 2, 0, 0, 0, 0, 0, ...fixture.slice(i, i + 500)]);
    const files = MediaManifest.decodeStores(a);
    expect(files.length).toBe(34);
    expect(files.every((f) => f.storage === 1 && f.storageKnown === true)).toBe(true);
    expect(MediaFiles.pageKey(files[0])).toBe('1:DCIM/DJI_001/DJI_20260814125250_0034_D.MP4');
  });
});
