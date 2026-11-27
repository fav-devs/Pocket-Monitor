import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type MediaChunkAssembler, type MediaFile, MediaManifest, MEDIA_NEWEST_INTERNAL, MEDIA_NEWEST_SD } from '../status/mediaManifest';
import {
  cameraCacheFolder,
  collectFinished,
  deliveryPath,
  derivedProxyPath,
  enterMediaPlayback,
  httpStatusOf,
  isCompleteOriginal,
  isProxyPath,
  listMediaCatalog,
  MediaListingRetired,
  type MediaListingIO,
  MediaListingUnavailable,
  MediaLiveResume,
  mediaPathURL,
  mediaQueryPlan,
  mediaSourcePolicy,
  MediaStorageMemo,
  playbackCacheFileName,
  playbackCandidates,
  playbackMimeType,
  previewPaths,
  proxyPaths,
  resolvedStorage,
  afterEnterPlayback,
  runMediaLiveReturn,
  SD_COLLECT,
  seedPagination,
  sliceIncomplete,
  stepPagination,
  storageGuess,
  storeHasOlderPage,
  thumbnailCacheFileName,
  TRIGGER_COLLECT,
} from '.';

// Vectors from OpenCine Tests/OpenCineDJITests/{MediaManifestTests,DJIMediaHTTPSourceTests,
// MediaLiveResumeTests}.swift and Apps/Desktop/crates/opc-media/src/{model,http,resume}.rs.
const fixture = new Uint8Array(readFileSync(path.resolve(__dirname, '../../../../../Tests/OpenPocketViewCoreTests/Fixtures/nano-manifest.bin')));

function file(p: Partial<MediaFile> & { path: string }): MediaFile {
  return {
    thumbPath: 'T',
    handle: 0,
    cmdHandle: 0,
    sizeBytes: 0,
    durationSeconds: 0,
    isStarred: false,
    resolution: null,
    fps: null,
    proxyPath: null,
    storage: 0,
    storageKnown: null,
    group: 0,
    handleShared: false,
    handleCandidate: 0,
    ...p,
  };
}

describe('MediaHTTP', () => {
  it('builds /v2 paths with storage and the .scr thumbnail (httpPathsUseStorageAndScr)', () => {
    const f = MediaManifest.decode(fixture)[0];
    const storage = storageGuess(f.handle, false);
    expect(storage).toBe(1);
    expect(mediaPathURL(storage, f.thumbPath)).toBe('http://192.168.2.1/v2?storage=1&path=MISC/THM/DJI_001/DJI_20260814125250_0034_D.scr');
    expect(mediaPathURL(storage, f.path)).toContain('DCIM/DJI_001/DJI_20260814125250_0034_D.MP4');
    expect(previewPaths(f).some((p) => p.endsWith('.LRF'))).toBe(true);
    const play = playbackCandidates(f, 1);
    expect(play.map((c) => c.storage)).toEqual([1, 0, 1, 0]);
    expect(play[0].path.endsWith('.LRF')).toBe(true);
    expect(play[play.length - 1].path.endsWith('.MP4')).toBe(true);
    expect(isProxyPath(play[0].path)).toBe(true);
    expect(isProxyPath(f.path)).toBe(false);
    expect(deliveryPath(f)).toBe(f.path);
    expect(previewPaths(f)[0]).not.toBe(deliveryPath(f));
    expect(proxyPaths(f).every(isProxyPath)).toBe(true);
    expect(proxyPaths(f)).not.toContain(f.path);
    expect(playbackMimeType(play[0].path)).toBe('video/mp4');
    expect(playbackCacheFileName(play[0].path).endsWith('.mp4')).toBe(true);
    expect(playbackCacheFileName(f.path).endsWith('.MP4')).toBe(true);
  });

  it('keeps the slashes the camera wants', () => {
    expect(mediaPathURL(0, 'DCIM/DJI_001/DJI_20260814125250_0034_D.MP4')).toBe(
      'http://192.168.2.1/v2?storage=0&path=DCIM/DJI_001/DJI_20260814125250_0034_D.MP4',
    );
    expect(mediaPathURL(0, 'DCIM/a b.MP4', { host: '10.0.0.7', addressing: 'storageQuery' })).toBe('http://10.0.0.7/v2?storage=0&path=DCIM/a%20b.MP4');
    expect(mediaPathURL(0, 'DCIM/a.MP4', { host: '10.0.0.7', addressing: 'directPath' })).toBe('http://10.0.0.7/DCIM/a.MP4');
  });

  it('a Pocket 3 is always storage zero (pocket3SingleSdIgnoresStampedInternalStore)', () => {
    const handle = 0x40100880;
    expect(resolvedStorage(1, handle, null, true)).toBe(0);
    expect(resolvedStorage(1, handle, 1, true)).toBe(0);
    expect(resolvedStorage(1, handle, null, false)).toBe(1);
    expect(resolvedStorage(1, handle, 0, false)).toBe(0);
    expect(resolvedStorage(7, 0x00040010, null, false)).toBe(0);
    expect(storageGuess(0x40104480, false)).toBe(1);
    expect(storageGuess(0x40104480, true)).toBe(0);
    const f = MediaManifest.decode(fixture)[0];
    const play = playbackCandidates(f, resolvedStorage(1, f.handle, null, true));
    expect(play[0]).toEqual({ storage: 0, path: 'DCIM/DJI_001/DJI_20260814125250_0034_D.LRF' });
  });

  it('the proxy chain is listed, then derived, then original', () => {
    const clip = file({ path: 'DCIM/DJI_001/DJI_20260814125250_0034_D.MP4' });
    expect(previewPaths(clip)).toEqual(['DCIM/DJI_001/DJI_20260814125250_0034_D.LRF', 'DCIM/DJI_001/DJI_20260814125250_0034_D.MP4']);
    expect(proxyPaths({ ...clip, proxyPath: 'DCIM/DJI_001/DJI_20260814125250_0034_D.LRF' })).toHaveLength(1);
    expect(proxyPaths(file({ path: 'DCIM/CAM_001/CAM_20260814125250_0034_D.MP4' }))).toEqual(['DCIM/CAM_001/CAM_20260814125250_0034_D.XRF']);
    expect(derivedProxyPath(file({ path: 'DCIM/100/VID_0001.mp4' }))).toBe('DCIM/100/VID_0001.lrv');
    expect(derivedProxyPath(file({ path: 'DCIM/100/IMG_0001.JPG' }))).toBeNull();
    // The derivation reads the prefix, not the kind; a still goes through the photo path.
    expect(proxyPaths(file({ path: 'DCIM/DJI_001/DJI_20260814125250_0035_D.JPG' }))).toEqual(['DCIM/DJI_001/DJI_20260814125250_0035_D.LRF']);
  });

  it('names cache files like the phones', () => {
    expect(playbackCacheFileName('DCIM/DJI_001/DJI_1_D.LRF')).toBe('DCIM_DJI_001_DJI_1_D.mp4');
    expect(playbackCacheFileName('DCIM/DJI_001/DJI_1_D.MP4')).toBe('DCIM_DJI_001_DJI_1_D.MP4');
    expect(playbackMimeType('a.JPG')).toBe('image/jpeg');
    expect(playbackMimeType('a.DNG')).toBe('image/x-adobe-dng');
    expect(thumbnailCacheFileName({ path: 'DCIM/DJI_001/a.MP4' })).toBe('DCIM_DJI_001_a.MP4.jpg');
    expect(cameraCacheFolder('Osmo Pocket 3/EE59')).toBe('Osmo_Pocket_3_EE59');
    expect(cameraCacheFolder('')).toBe('camera');
  });

  it('a short write is not the original', () => {
    expect(isCompleteOriginal(0, 100)).toBe(false);
    expect(isCompleteOriginal(89, 100)).toBe(false);
    expect(isCompleteOriginal(90, 100)).toBe(true);
    expect(isCompleteOriginal(5, 0)).toBe(true);
    expect(httpStatusOf('UnableToDownload: status 404')).toBe(404);
    expect(httpStatusOf('timed out')).toBeNull();
  });
});

describe('MediaStorageMemo (DJIMediaHTTPSource)', () => {
  const clip = file({ path: 'DCIM/DJI_001/a.MP4', storage: 0, sizeBytes: 17 });

  it('routes the winning store first and keeps URL identities', () => {
    const memo = new MediaStorageMemo();
    expect(memo.resources(clip.path, 0).map((r) => r.storage)).toEqual([0, 1]);
    expect(memo.resources(clip.path, 1).map((r) => r.storage)).toEqual([1, 0]);
    expect(memo.resources(clip.path, 0).map((r) => r.url)).toEqual([mediaPathURL(0, clip.path), mediaPathURL(1, clip.path)]);
    memo.remember(1, clip.path);
    expect(memo.resolvedStorage(clip, true)).toBe(0);
    expect(memo.resolvedStorage(clip, false)).toBe(1);
    memo.reset();
    expect(memo.resolvedStorage(clip, false)).toBe(0);
  });

  it('orders by winner then stamp (desktop the_memo_orders_stores_by_winner_then_stamp)', () => {
    const memo = new MediaStorageMemo();
    const c = (storage: number) => file({ path: 'DCIM/DJI_001/DJI_20260814125250_0034_D.MP4', handle: 0x40104480, storage });
    expect(memo.resourcesFor(c(1), 'a', false).map((r) => r.storage)).toEqual([1, 0]);
    memo.remember(0, c(1).path);
    expect(memo.resourcesFor(c(1), 'a', false).map((r) => r.storage)).toEqual([0, 1]);
  });

  it('a proxy never inherits the original size', () => {
    expect(MediaStorageMemo.expectedBytes(clip, clip.path)).toBe(17);
    expect(MediaStorageMemo.expectedBytes(clip, 'a.LRF')).toBeNull();
  });

  it('cancellation and retirement never retry; 4xx always; 5xx only for a proxy', () => {
    expect(MediaStorageMemo.shouldRetry({ kind: 'status', status: 404 }, clip.path)).toBe(true);
    expect(MediaStorageMemo.shouldRetry({ kind: 'status', status: 403 }, clip.path)).toBe(true);
    expect(MediaStorageMemo.shouldRetry({ kind: 'status', status: 500 }, clip.path)).toBe(false);
    expect(MediaStorageMemo.shouldRetry({ kind: 'status', status: 500 }, 'a.LRF')).toBe(true);
    expect(MediaStorageMemo.shouldRetry({ kind: 'cancelled' }, 'a.LRF')).toBe(false);
    expect(MediaStorageMemo.shouldRetry({ kind: 'retired' }, 'a.LRF')).toBe(false);
  });
});

describe('MediaSourcePolicy', () => {
  it('Pocket 3 is single SD; others read the internal block outside playback', () => {
    expect(mediaSourcePolicy({ name: 'Osmo Pocket 3', family: 'pocket' }, true, 100).singleSdStorage).toBe(true);
    expect(mediaSourcePolicy({ name: 'Osmo Nano', family: 'nano' }, false, 0)).toEqual({ sourceOwnsFavorites: true, singleSdStorage: true });
    expect(mediaSourcePolicy({ name: 'Osmo Nano', family: 'nano' }, false, 64000).singleSdStorage).toBe(false);
    expect(mediaSourcePolicy({ name: 'Osmo Nano', family: 'nano' }, true, 0).singleSdStorage).toBeNull();
    expect(mediaSourcePolicy(null, false, -1)).toEqual({ sourceOwnsFavorites: null, singleSdStorage: null });
  });
});

describe('pagination (MediaListCommand)', () => {
  const at = (index: number, store: number, p?: string) =>
    file({
      path: p ?? `DCIM/DJI_001/F${store}_${index}.MP4`,
      handle: ((store === 0 ? 0x00100000 : 0x40100000) + index * 0x40) >>> 0,
      storage: store,
      storageKnown: true,
      group: store,
    });

  it('advances both stores and keeps duplicate paths (paginationAdvancesBothStoresAndKeepsDuplicatePaths)', () => {
    let page: MediaFile[] = [];
    for (let i = 1; i <= 45; i++) page.push(at(i, 0));
    for (let i = 1; i <= 45; i++) page.push(at(i, 1));
    page = [...page, at(46, 0, 'DCIM/DJI_001/SAME.MP4'), at(46, 1, 'DCIM/DJI_001/SAME.MP4')];
    const seen = new Set<string>();
    const seeded = seedPagination(page, seen);
    expect(seeded.fresh).toHaveLength(92);
    expect(seeded.sdCursor).toBe(0x00100040);
    expect(seeded.internalCursor).toBe(0x40100040);
    expect(seeded.moreAvailable).toBe(true);
    const older = [at(0, 0), file({ path: 'DCIM/DJI_001/I0.MP4', handle: 0x400fffc0, storage: 1, storageKnown: true, group: 1 })];
    const stepped = stepPagination(seeded.sdCursor, seeded.internalCursor, older, seen);
    expect(stepped.sdCursor).toBe(0x00100000);
    expect(stepped.internalCursor).toBe(0x400fffc0);
  });

  it('continues with either store alone (paginationContinuesWithEitherStoreAlone)', () => {
    const page = (store: number) =>
      Array.from({ length: 45 }, (_, k) =>
        file({ path: `DCIM/DJI_001/S${store}_${k + 1}.MP4`, handle: ((store === 0 ? 0x00040000 : 0x40040000) + (k + 1) * 0x10) >>> 0, storage: store, storageKnown: true, group: store }),
      );
    const sd = seedPagination(page(0), new Set());
    expect(sd.sdCursor).toBe(0x00040010);
    expect(sd.internalCursor).toBe(MEDIA_NEWEST_INTERNAL);
    expect(sd.moreAvailable).toBe(true);
    const internal = seedPagination(page(1), new Set());
    expect(internal.sdCursor).toBe(MEDIA_NEWEST_SD);
    expect(internal.internalCursor).toBe(0x40040010);
    expect(internal.moreAvailable).toBe(true);
  });

  it('page wire facts control the end (pageWireFactsControlEndOfPagination)', () => {
    const pathBytes = Array.from('DCIM/DJI_001/ONE', (c) => c.charCodeAt(0));
    const field = [0x1a, pathBytes.length + 6, 0, 0, 0, 1, ...pathBytes];
    const truncated = new Uint8Array([2, 0, 0, 0, ...field, 0x0c, 0x01, 0x0d]);
    expect(MediaManifest.recordCount(truncated)).toBe(1);
    expect(MediaManifest.hasEndMarker(truncated)).toBe(true);
    const info = { declared: MediaManifest.headerCount(truncated), records: 1, endMarker: true, ended: false };
    expect(sliceIncomplete(info)).toBe(true);
    expect(storeHasOlderPage(1, true, info)).toBe(true);
    expect(storeHasOlderPage(1, true, { declared: 1, records: 1, endMarker: false, ended: true })).toBe(false);
    expect(storeHasOlderPage(45, true, { declared: 45, records: 45, endMarker: true, ended: true })).toBe(false);
    expect(storeHasOlderPage(45, false, null)).toBe(false);
    expect(storeHasOlderPage(45, true, null)).toBe(true);
  });
});

describe('MediaLiveResume', () => {
  it('exits until playback clears, enables after, done on a live picture', () => {
    const a = (attempt: number, inPlayback: boolean, exitAcknowledged: boolean, pictureFresh: boolean) => MediaLiveResume.action({ attempt, inPlayback, exitAcknowledged, pictureFresh });
    expect(a(1, true, false, false)).toBe('exitPlayback');
    expect(a(2, true, true, false)).toBe('exitPlayback');
    expect(a(2, false, true, false)).toBe('enableLiveView');
    expect(a(3, false, true, true)).toBe('done');
    expect(a(MediaLiveResume.maxExitAttempts + 1, true, false, false)).toBe('exhausted');
  });

  it('a successful enable is not repeated while the first picture is pending', () => {
    let enableSent = false;
    let enables = 0;
    for (let i = 0; i < 100; i++) {
      const action = MediaLiveResume.action({ attempt: 2, inPlayback: false, exitAcknowledged: true, pictureFresh: false, enableSent });
      if (action === 'enableLiveView') {
        enables += 1;
        enableSent = true;
      } else expect(action).toBe('waitForPicture');
    }
    expect(enables).toBe(1);
    const base = { attempt: 2, inPlayback: false, exitAcknowledged: true, pictureFresh: false, enableSent: true };
    expect(MediaLiveResume.action({ ...base, deadlineExpired: true })).toBe('exhausted');
    expect(MediaLiveResume.action({ ...base, keyframeResendDue: true })).toBe('enableLiveView');
    expect(MediaLiveResume.action({ ...base, deadlineExpired: true, keyframeResendDue: true })).toBe('exhausted');
  });

  it('owners, stray playback, and the newest page without playback', () => {
    expect(MediaLiveResume.isCurrentPictureOwner(2, 2, false)).toBe(true);
    expect(MediaLiveResume.isCurrentPictureOwner(2, 3, true)).toBe(false);
    expect(MediaLiveResume.isCurrentPictureOwner(2, 4, false)).toBe(false);
    expect(MediaLiveResume.strayPlaybackAction(false, true)).toBe('exitPlayback');
    expect(MediaLiveResume.strayPlaybackAction(true, true)).toBeNull();
    expect(MediaLiveResume.strayPlaybackAction(false, false)).toBeNull();
    expect(afterEnterPlayback(false)).toEqual({ listNewestPage: true, listOlderPages: false, keepBrowsing: true });
    expect(afterEnterPlayback(true).listOlderPages).toBe(true);
    expect(MediaLiveResume.isPictureFresh(5, 4)).toBe(true);
    expect(MediaLiveResume.isPictureFresh(3, 4)).toBe(false);
    expect(MediaLiveResume.isPictureFresh(null, 4)).toBe(false);
  });

  it('the loop exits until the bit clears, enables once, and resends only after a keyframe interval', async () => {
    let t = 0;
    let inPlayback = true;
    let exits = 0;
    const enables: number[] = [];
    let pictureAt: number | null = null;
    const result = await runMediaLiveReturn({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      isCurrent: () => true,
      inPlayback: () => inPlayback,
      pictureFresh: () => pictureAt != null && t >= pictureAt,
      exitPlayback: async () => {
        exits += 1;
        if (exits === 2) inPlayback = false;
        return exits >= 2;
      },
      enableLiveView: () => {
        enables.push(t);
        // The first enable's keyframe is lost; the resend at +2 s brings the picture.
        if (enables.length === 2) pictureAt = t + 300;
        return true;
      },
    });
    expect(result).toBe('restored');
    expect(exits).toBe(2);
    expect(enables).toHaveLength(2);
    expect(enables[1] - enables[0]).toBeGreaterThanOrEqual(2000);
  });

  it('the loop gives up after the exit budget and never enables in playback', async () => {
    let t = 0;
    let enables = 0;
    const result = await runMediaLiveReturn({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      isCurrent: () => true,
      inPlayback: () => true,
      pictureFresh: () => false,
      exitPlayback: async () => false,
      enableLiveView: () => {
        enables += 1;
        return true;
      },
    });
    expect(result).toBe('exhausted');
    expect(enables).toBe(0);
  });

  it('a retired return stops at once', async () => {
    let current = true;
    const result = await runMediaLiveReturn({
      now: () => 0,
      sleep: async () => {},
      isCurrent: () => current,
      inPlayback: () => true,
      pictureFresh: () => false,
      exitPlayback: async () => {
        current = false;
        return true;
      },
      enableLiveView: () => true,
    });
    expect(result).toBe('superseded');
  });
});

/** A fake camera answering `0x00/0x26` with canned blobs per (counter, cursor). */
function fakeCamera(answers: Record<string, Uint8Array>, options: { emptySdFirst?: boolean } = {}) {
  let t = 0;
  let attached: MediaChunkAssembler | null = null;
  const sent: string[] = [];
  const timers: { at: number; run: () => void }[] = [];
  let sdAsks = 0;
  const chunk = (counter: number, body: Uint8Array) => {
    const payload = new Uint8Array(10 + body.length);
    payload.set([0x4a, 0x01, 0, 0, counter, 0, 0, 0, 0, 0]);
    payload.set(body, 10);
    return payload;
  };
  const io: MediaListingIO = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      for (const timer of timers.filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
    isCurrent: () => true,
    sendList: (counter, cursor) => {
      sent.push(`list ${counter} ${cursor.toString(16)}`);
      if (counter === 1) sdAsks += 1;
      const body = answers[`${counter}:${cursor.toString(16)}`];
      const target = attached;
      if (counter === 1 && options.emptySdFirst && sdAsks === 1) return;
      if (!body || !target) {
        timers.push({ at: t + 100, run: () => target?.ingestPayload([0x4a, 0x04, 0, 0, counter, 0, 0, 0, 0, 0]) });
        return;
      }
      timers.push({ at: t + 100, run: () => target.ingestPayload(chunk(counter, body)) });
      timers.push({ at: t + 150, run: () => target.ingestPayload([0x4a, 0x03, 0, 0, counter, 0, 0, 0, 0, 0]) });
    },
    sendTrigger: () => sent.push('trigger'),
    attach: (a) => {
      attached = a;
    },
  };
  return { io, sent, clock: () => t };
}

describe('listing sequence (DjiAppleMediaService.query)', () => {
  it('collect ends on the store end after the floor, or on quiet', () => {
    expect(collectFinished({ start: 0, lastChange: 0, now: 500, deadline: 12000, ended: true }, SD_COLLECT, 'before')).toBe(false);
    expect(collectFinished({ start: 0, lastChange: 0, now: 800, deadline: 12000, ended: true }, SD_COLLECT, 'before')).toBe(true);
    expect(collectFinished({ start: 0, lastChange: 0, now: 900, deadline: 12000, ended: false }, SD_COLLECT, 'after')).toBe(false);
    expect(collectFinished({ start: 0, lastChange: 0, now: 1000, deadline: 12000, ended: false }, SD_COLLECT, 'after')).toBe(true);
    expect(collectFinished({ start: 0, lastChange: 0, now: 400, deadline: 12000, ended: false }, TRIGGER_COLLECT, 'after')).toBe(true);
    expect(collectFinished({ start: 0, lastChange: 0, now: 12000, deadline: 12000, ended: false }, SD_COLLECT, 'before')).toBe(true);
  });

  it('sends SD list, trigger, internal list in that order', () => {
    expect(mediaQueryPlan(MEDIA_NEWEST_SD, MEDIA_NEWEST_INTERNAL).map((s) => (s.kind === 'list' ? `list ${s.counter} ${s.cursor.toString(16)}` : 'trigger'))).toEqual([
      'list 1 1',
      'trigger',
      'list 2 40000001',
    ]);
  });

  it('lists the newest page of the Nano fixture from the internal store', async () => {
    const cam = fakeCamera({ '2:40000001': fixture });
    const result = await listMediaCatalog(cam.io, { playbackHeld: false });
    expect(cam.sent).toEqual(['list 1 1', 'trigger', 'list 2 40000001']);
    expect(result.files).toHaveLength(34);
    expect(result.files.every((f) => f.storage === 1)).toBe(true);
    expect(result.pages).toBe(1);
    // 34 < 45 records: nothing older.
    expect(result.complete).toBe(true);
  });

  it('retries an empty SD answer once on the first page while playback holds', async () => {
    const cam = fakeCamera({ '2:40000001': fixture }, { emptySdFirst: true });
    await listMediaCatalog(cam.io, { playbackHeld: true });
    expect(cam.sent).toEqual(['list 1 1', 'trigger', 'list 2 40000001', 'list 1 1', 'trigger']);
  });

  it('a camera that never answers is unavailable', async () => {
    const cam = fakeCamera({});
    const silent: MediaListingIO = { ...cam.io, sendList: () => {} };
    await expect(listMediaCatalog(silent, { playbackHeld: false })).rejects.toBeInstanceOf(MediaListingUnavailable);
  });

  it('a retired browse stops the listing', async () => {
    const cam = fakeCamera({ '2:40000001': fixture });
    let n = 0;
    const io: MediaListingIO = { ...cam.io, isCurrent: () => ++n < 5 };
    await expect(listMediaCatalog(io, { playbackHeld: false })).rejects.toBeInstanceOf(MediaListingRetired);
  });

  it('enters playback up to three times', async () => {
    let attempts = 0;
    let t = 0;
    const entered = await enterMediaPlayback({
      isCurrent: () => true,
      sleep: async (ms) => {
        t += ms;
      },
      attempt: async () => {
        attempts += 1;
        return false;
      },
      inPlayback: () => false,
    });
    expect(entered).toBe(false);
    expect(attempts).toBe(3);
    expect(t).toBe(360);
    let bit = false;
    const viaBit = await enterMediaPlayback({
      isCurrent: () => true,
      sleep: async () => {},
      attempt: async () => {
        bit = true;
        throw new Error('timeout');
      },
      inPlayback: () => bit,
    });
    expect(viaBit).toBe(true);
  });
});
