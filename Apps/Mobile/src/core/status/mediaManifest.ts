/**
 * On-camera media list wire: `0x00/0x27` chunk reassembly per store counter and the CompositePack
 * TLV manifest decode (paths, thumbs, handles, size, duration, fps, resolution, star).
 *
 * Source of truth: OpenCine `OpenCineDJI/MediaManifest+DJIWire.swift` (`MediaChunkAssembler`,
 * `MediaManifest`) and `OpenCineCameraVocabulary/MediaManifest.swift` (`MediaFile`,
 * `MediaListCommand.store`). Pagination helpers (`seedPagination` / `stepPagination`) and the HTTP
 * path builders are not ported yet. List/delete/favourite frames live in commands/commands.ts.
 */
import { type ByteInput, u32le } from '../bytes';
import type { DumlFrame } from '../duml/frame';

export const MEDIA_INTERNAL_BIT = 0x40000000;
export const MEDIA_SD_COUNTER = 1;
export const MEDIA_INTERNAL_COUNTER = 2;
export const MEDIA_PAGE_SIZE = 45;
export const MEDIA_COUNT_MAX = 512;
export const MEDIA_NEWEST_SD = 0x00000001;
export const MEDIA_NEWEST_INTERNAL = 0x40000001;

export interface MediaFile {
  path: string;
  thumbPath: string;
  handle: number;
  cmdHandle: number;
  sizeBytes: number;
  durationSeconds: number;
  isStarred: boolean;
  resolution: string | null;
  fps: number | null;
  proxyPath: string | null;
  /** 0 SD, 1 internal */
  storage: number;
  storageKnown: boolean | null;
  group: number;
  handleShared: boolean;
  handleCandidate: number;
}

export const MediaFiles = {
  filename: (f: MediaFile) => f.path.slice(f.path.lastIndexOf('/') + 1),
  extension(f: MediaFile): string {
    const n = MediaFiles.filename(f);
    const i = n.lastIndexOf('.');
    return i > 0 ? n.slice(i + 1).toUpperCase() : '';
  },
  sequenceNumber(f: MediaFile): number {
    const m = /_(\d{4})_D/.exec(MediaFiles.filename(f));
    return m ? parseInt(m[1], 10) : 0;
  },
  isVideo: (f: MediaFile) => MediaManifest.videoExtensions.has(MediaFiles.extension(f)),
  /** Store selected by the query that returned `file`, else the handle bit. */
  store(f: MediaFile): number {
    if (f.storageKnown === true) return f.storage;
    const h = f.handle !== 0 ? f.handle : f.cmdHandle;
    if (h !== 0) return (h & MEDIA_INTERNAL_BIT) === 0 ? 0 : 1;
    return f.group === 1 ? 1 : 0;
  },
  pageKey: (f: MediaFile) => `${MediaFiles.store(f)}:${f.path}`,
  storageGuess: (handle: number, singleSdStorage: boolean) => (singleSdStorage ? 0 : (handle & MEDIA_INTERNAL_BIT) !== 0 ? 1 : 0),
};

/** Strip `0x00/0x27` 10-byte sub-headers and concat data chunks per counter in arrival order. */
export class MediaChunkAssembler {
  private chunks = new Map<number, number[]>();
  private chunkCounts = new Map<number, number>();
  private started = new Set<number>();
  private data = new Set<number>();
  private ended = new Set<number>();
  chunkCount = 0;

  get sawEnd(): boolean {
    return this.ended.size > 0;
  }
  reset(counter?: number): void {
    if (counter === undefined) {
      this.chunks.clear();
      this.chunkCounts.clear();
      this.started.clear();
      this.data.clear();
      this.ended.clear();
      this.chunkCount = 0;
      return;
    }
    this.chunks.delete(counter);
    this.chunkCount = Math.max(0, this.chunkCount - (this.chunkCounts.get(counter) ?? 0));
    this.chunkCounts.delete(counter);
    this.started.delete(counter);
    this.data.delete(counter);
    this.ended.delete(counter);
  }
  ingest(frame: DumlFrame): boolean {
    if (frame.cmdSet !== 0x00 || frame.cmdId !== 0x27) return false;
    return this.ingestPayload(frame.payload);
  }
  ingestPayload(p: ByteInput): boolean {
    if (p.length < 10 || p[0] !== 0x4a) return false;
    const subtype = p[1];
    const counter = p[4];
    if (subtype === 0x04) {
      this.started.add(counter);
      return true;
    }
    if (subtype === 0x03) {
      this.ended.add(counter);
      return true;
    }
    if (subtype !== 0x01 || p.length <= 10) return false;
    this.data.add(counter);
    const buf = this.chunks.get(counter) ?? [];
    for (let i = 10; i < p.length; i++) buf.push(p[i]);
    this.chunks.set(counter, buf);
    this.chunkCounts.set(counter, (this.chunkCounts.get(counter) ?? 0) + 1);
    this.chunkCount += 1;
    return true;
  }
  assembled(counter: number): Uint8Array {
    return Uint8Array.from(this.chunks.get(counter) ?? []);
  }
  chunkCountFor(counter: number): number {
    return this.chunkCounts.get(counter) ?? 0;
  }
  didEnd(counter: number): boolean {
    return this.ended.has(counter);
  }
  /** Start-without-data is the camera's empty-store closure; data streams need an explicit end. */
  isClosed(counter: number): boolean {
    return this.ended.has(counter) || (this.started.has(counter) && !this.data.has(counter));
  }
  streamsEnded(requiredCounters: number[]): boolean {
    if (this.data.size === 0) return false;
    const observed = new Set([...this.started, ...this.data, ...this.ended]);
    return requiredCounters.every((c) => this.isClosed(c)) && [...observed].every((c) => this.isClosed(c));
  }
  assembledMerged(): Uint8Array {
    const out: number[] = [];
    for (const k of [...this.chunks.keys()].sort((a, b) => a - b)) out.push(...(this.chunks.get(k) ?? []));
    return Uint8Array.from(out);
  }
  get isEmpty(): boolean {
    return this.chunkCount === 0;
  }
  get hasResponse(): boolean {
    return this.started.size > 0 || this.data.size > 0 || this.ended.size > 0;
  }
}

const DIMENSIONS: Record<number, [number, number]> = {
  0x0a: [1920, 1080],
  0x0c: [1920, 1440],
  0x10: [3840, 2160],
  0x2d: [2688, 1512],
  0x42: [1080, 1920],
  0x43: [1512, 2688],
  0x5f: [2688, 2016],
  0x67: [3840, 2880],
  0x69: [1080, 1080],
  0x6a: [2160, 2160],
  0x6b: [3072, 3072],
  0x6c: [1728, 3072],
  0x7d: [3840, 3840],
};

const latin1 = (b: ByteInput, s: number, e: number) => {
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
  return out;
};

function readPath(b: ByteInput, i: number, sub: number, prefix: string): { value: string; end: number } | null {
  if (i + 6 > b.length || b[i] !== 0x1a || b[i + 2] !== 0 || b[i + 3] !== 0 || b[i + 4] !== 0 || b[i + 5] !== sub) return null;
  const slen = b[i + 1] - 6;
  if (slen < prefix.length || i + 6 + slen > b.length) return null;
  for (let k = i + 6; k < i + 6 + slen; k++) if (b[k] < 0x20 || b[k] > 0x7e) return null;
  const value = latin1(b, i + 6, i + 6 + slen);
  if (!value.startsWith(prefix)) return null;
  return { value, end: i + 6 + slen };
}

function emptyFile(path: string, thumbPath: string): MediaFile {
  return {
    path,
    thumbPath,
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
  };
}

const STAR_SIG = [0x1b, 0x0a, 0x00, 0x00, 0x00, 0x02, 0x02, 0x01, 0x14, 0x02, 0x15, 0x03];

function starBySignature(b: ByteInput, lo: number, hi: number): boolean | null {
  const end = Math.min(hi, b.length - STAR_SIG.length - 1);
  for (let q = Math.max(0, lo); q <= end; q++) {
    let k = 0;
    while (k < STAR_SIG.length && b[q + k] === STAR_SIG[k]) k++;
    if (k === STAR_SIG.length) return b[q + STAR_SIG.length] === 1;
  }
  return null;
}

function starByMarker(b: ByteInput, lo: number, hi: number): boolean {
  for (let q = lo; q < hi - 9; q++) {
    if ((b[q] === 0xff || b[q] === 0xfe) && b[q + 1] === 0x19 && b[q + 2] === 0x06) return b[q + 9] === 1;
  }
  return false;
}

function fpsInRange(b: ByteInput, start: number, end: number): number | null {
  let fps: number | null = null;
  const stop = Math.min(end, b.length) - 8;
  for (let i = Math.max(0, start); i <= stop; i++) {
    const den = u32le(b, i + 4);
    if (den === 1000 || den === 1001) {
      const num = u32le(b, i);
      if (num >= 20000 && num <= 250000) fps = Math.round(num / den);
    }
  }
  return fps;
}

function resolveRecord(b: ByteInput, mediaDir: string, selfPos: number, lo: number, hi: number): MediaFile {
  const base = mediaDir.slice(mediaDir.lastIndexOf('/') + 1);
  let thumb: string | null = null;
  for (let t = lo; t < hi; t++) {
    const f = readPath(b, t, 2, 'MISC/');
    if (f && f.value.endsWith(base)) {
      thumb = f.value;
      break;
    }
  }
  let ext = '';
  let proxyExt: string | null = null;
  for (let n = lo; n < hi - 2; n++) {
    if (b[n] !== 0x0d) continue;
    const len = b[n + 1];
    if (len > base.length && n + 2 + len <= b.length) {
      const value = latin1(b, n + 2, n + 2 + len);
      if (value.length > base.length + 1 && value.startsWith(base) && value[base.length] === '.') {
        const e = value.slice(base.length + 1).toUpperCase();
        if (MediaManifest.videoExtensions.has(e) || MediaManifest.photoExtensions.has(e)) ext = e;
        else if (e === 'LRF' || e === 'LRV' || e === 'XRF') proxyExt = e;
      }
    }
  }
  let head = -1;
  for (let m = lo; m < hi - 4; m++) {
    const kind = b[m];
    const star = b[m + 1];
    if ((kind === 0x03 || kind === 0x00) && (star === 0xff || star === 0xfe) && b[m + 2] === 0x19 && b[m + 3] === 0x06 && m >= 8) {
      head = m - 8;
      break;
    }
  }
  const hasMarker = head >= 0;
  const isVideo = MediaManifest.videoExtensions.has(ext);
  const handleCandidate = selfPos >= 17 && selfPos <= b.length && b[selfPos - 7] === 0x19 && b[selfPos - 6] === 0x06 ? u32le(b, selfPos - 17) : 0;
  let photoSize = 0;
  let photoRes: string | null = null;
  if (!isVideo) {
    for (let q = lo; q < hi - 3; q++) {
      if ((b[q] === 0xff || b[q] === 0xfe) && b[q + 1] === 0x19 && b[q + 2] === 0x06) {
        const mk = q + 1;
        if (mk >= 14) photoSize = u32le(b, mk - 14);
        if (base.startsWith('DJI_') && mk + 66 <= b.length) {
          const w = u32le(b, mk + 58);
          const h = u32le(b, mk + 62);
          if (w >= 1 && w <= 60000 && h >= 1 && h <= 60000) photoRes = `${w}x${h}`;
        }
        break;
      }
    }
  }
  const path = ext ? `${mediaDir}.${ext}` : mediaDir;
  const thumbPath = (thumb ?? (mediaDir.startsWith('DCIM/') ? 'MISC/THM/' + mediaDir.slice(5) : mediaDir)) + '.scr';
  const f = emptyFile(path, thumbPath);
  f.handle = hasMarker ? u32le(b, head) : 0;
  f.sizeBytes = isVideo && hasMarker && head >= 4 ? u32le(b, head - 4) : photoSize;
  f.fps = isVideo && hasMarker ? fpsInRange(b, head, hi) : null;
  f.durationSeconds = isVideo && hasMarker && head + 6 <= b.length ? b[head + 4] | (b[head + 5] << 8) : 0;
  if (isVideo && hasMarker && head + 7 < b.length) {
    const d = DIMENSIONS[b[head + 7]];
    f.resolution = d ? `${d[0]}x${d[1]}` : null;
  } else f.resolution = photoRes;
  f.isStarred = starBySignature(b, selfPos >= 0 ? selfPos : lo, hi) ?? starByMarker(b, lo, hi);
  f.proxyPath = proxyExt ? `${mediaDir}.${proxyExt}` : null;
  f.handleCandidate = handleCandidate;
  return f;
}

function withCmdHandles(files: MediaFile[]): MediaFile[] {
  const fits = new Map<number, { base: number; step: number }>();
  const groups = new Map<number, MediaFile[]>();
  for (const f of files) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  const maxKey = (m: Map<number, number>) => {
    let best: number | null = null;
    let n = -1;
    for (const [k, v] of m) if (v > n) [best, n] = [k, v];
    return best;
  };
  for (const [group, list] of groups) {
    const uniq = new Map<number, number>();
    for (const f of list) {
      const seq = MediaFiles.sequenceNumber(f);
      if (f.handle !== 0 && seq > 0 && !uniq.has(seq)) uniq.set(seq, f.handle);
    }
    const pts = [...uniq.entries()].sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) continue;
    const stepCounts = new Map<number, number>();
    for (let i = 1; i < pts.length; i++) {
      const dSeq = pts[i][0] - pts[i - 1][0];
      if (dSeq <= 0) continue;
      const dHandle = (pts[i][1] - pts[i - 1][1]) >>> 0;
      if (dHandle > 0) {
        const step = Math.floor(dHandle / dSeq);
        if (step > 0) stepCounts.set(step, (stepCounts.get(step) ?? 0) + 1);
      }
    }
    const step = maxKey(stepCounts);
    if (step == null) continue;
    const baseCounts = new Map<number, number>();
    for (const [seq, h] of pts) {
      const base = (h - Math.imul(seq, step)) >>> 0;
      baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
    }
    const base = maxKey(baseCounts);
    if (base == null) continue;
    fits.set(group, { base, step });
  }
  if (!fits.size) return files;
  return files.map((f) => {
    const fit = fits.get(f.group);
    const seq = MediaFiles.sequenceNumber(f);
    if (!fit || seq <= 0) return f;
    const fitted = (fit.base + Math.imul(seq, fit.step)) >>> 0;
    const next = { ...f, cmdHandle: fitted };
    if (f.handle === 0 && f.handleCandidate !== 0 && f.handleCandidate === fitted) next.handle = f.handleCandidate;
    else if (f.handle !== 0 && f.handle !== fitted) next.handle = 0; // contradicted: never delete the wrong file
    return next;
  });
}

function flagHandleCollisions(files: MediaFile[]): MediaFile[] {
  const counts = new Map<number, number>();
  for (const f of files) if (f.handle !== 0) counts.set(f.handle, (counts.get(f.handle) ?? 0) + 1);
  const shared = new Set([...counts].filter(([, n]) => n > 1).map(([h]) => h));
  if (!shared.size) return files;
  return files.map((f) => (shared.has(f.handle) ? { ...f, handleShared: true } : f));
}

export const MediaManifest = {
  videoExtensions: new Set(['MP4', 'MOV', 'OSV', 'INSV', 'LRF', 'LRV', 'XRF']),
  photoExtensions: new Set(['JPG', 'JPEG', 'DNG', 'HEIC', 'TIF', 'TIFF', 'PANO']),

  decode(bytes: ByteInput): MediaFile[] {
    const medias: Array<{ pos: number; end: number; path: string }> = [];
    for (let i = 0; i < bytes.length; ) {
      const f = readPath(bytes, i, 1, 'DCIM/');
      if (f) {
        medias.push({ pos: i, end: f.end, path: f.value });
        i = f.end;
      } else i += 1;
    }
    if (!medias.length) return [];
    const declared = bytes.length >= 4 ? u32le(bytes, 0) : -1;
    const boundary = declared >= 1 && declared < medias.length ? declared : -1;
    const byPath = new Map<string, MediaFile>();
    medias.forEach((m, k) => {
      if (byPath.has(m.path)) return;
      const lo = k > 0 ? medias[k - 1].end : 0;
      const hi = k + 1 < medias.length ? medias[k + 1].pos : bytes.length;
      const file = resolveRecord(bytes, m.path, m.pos, lo, hi);
      file.group = boundary > 0 && k >= boundary ? 1 : 0;
      byPath.set(m.path, file);
    });
    return flagHandleCollisions(withCmdHandles([...byPath.values()]));
  },

  /** Split the collected blob into SD (ctr 1) and internal (ctr 2) when the camera echoed counters. */
  decodeStores(a: MediaChunkAssembler): MediaFile[] {
    const sdBytes = a.assembled(MEDIA_SD_COUNTER);
    const inBytes = a.assembled(MEDIA_INTERNAL_COUNTER);
    const sd = sdBytes.length ? MediaManifest.decode(sdBytes) : [];
    const intern = inBytes.length ? MediaManifest.decode(inBytes) : [];
    const guess = (files: MediaFile[]) =>
      files.map((f) => ({ ...f, storage: MediaFiles.storageGuess(f.handle !== 0 ? f.handle : f.cmdHandle, false), storageKnown: false }));
    const samePaths = sd.length === intern.length && sd.every((f) => intern.some((g) => g.path === f.path));
    if (sd.length && intern.length && samePaths) return guess(MediaManifest.decode(a.assembledMerged()));
    if (!sd.length && !intern.length) {
      const merged = a.assembledMerged();
      return merged.length ? guess(MediaManifest.decode(merged)) : [];
    }
    return [...sd.map((f) => ({ ...f, storage: 0, storageKnown: true, group: 0 })), ...intern.map((f) => ({ ...f, storage: 1, storageKnown: true, group: 1 }))];
  },

  headerCount: (b: ByteInput) => (b.length >= 4 ? u32le(b, 0) : 0),
  recordCount(b: ByteInput): number {
    const paths = new Set<string>();
    for (let i = 0; i < b.length; ) {
      const f = readPath(b, i, 1, 'DCIM/');
      if (f) {
        paths.add(f.value);
        i = f.end;
      } else i += 1;
    }
    return paths.size;
  },
  /** `0c 01` immediately before the final record's `0d` name field. */
  hasEndMarker(b: ByteInput): boolean {
    for (let i = 0; i + 2 < b.length; i++) if (b[i] === 0x0c && b[i + 1] === 0x01 && b[i + 2] === 0x0d) return true;
    return false;
  },
};
