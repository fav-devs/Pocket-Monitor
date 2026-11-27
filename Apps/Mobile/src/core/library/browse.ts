/**
 * Listing the library: enter playback, query each page (SD list, trigger, internal list), collect
 * `0x00/0x27` chunks until each store goes quiet, decode, and walk older pages while playback holds.
 *
 * Source of truth: OpenCine `OpenCineDJIApple/DjiAppleMediaService.swift` (`enterPlayback`,
 * `query`, `collect`, `DjiAppleMediaCursor.next`). Numbers: enter ×3 with a 0.9 s answer window
 * and 120 ms between attempts; per page a 12 s budget; SD collect floor 0.8 s / idle 1 s, trigger
 * 0.4 s / 0.2 s, internal 0.8 s / 1 s; on the first page while playback holds, an empty SD answer
 * is asked once more (the card mounts a beat after the playback bit sets).
 *
 * The desktop (`Apps/Desktop/crates/opc-media/src/browse.rs`) runs an older sequence (internal
 * store first, a fixed 1.7 s settle, a Pocket 3 `0x01/0x01` special entry); upstream wins, and
 * this module keeps upstream's order. I/O is injected, so the whole sequence runs under a fake
 * clock in tests.
 */
import {
  MEDIA_INTERNAL_COUNTER,
  MEDIA_NEWEST_INTERNAL,
  MEDIA_NEWEST_SD,
  MEDIA_SD_COUNTER,
  MediaChunkAssembler,
  type MediaFile,
  MediaFiles,
  MediaManifest,
} from '../status/mediaManifest';
import { type MediaPageSliceInfo, pageSlices, seedPagination, stepPagination } from './pagination';
import { afterEnterPlayback, type MediaBrowsePolicy } from './resume';

export const MEDIA_ENTER_ATTEMPTS = 3;
export const MEDIA_ENTER_ANSWER_MS = 900;
export const MEDIA_ENTER_RETRY_PAUSE_MS = 120;
export const MEDIA_PAGE_BUDGET_MS = 12000;
export const MEDIA_COLLECT_POLL_MS = 50;
/** Safety cap: 40 pages × 45 records per store. */
export const MEDIA_MAX_PAGES = 40;

export interface CollectWindow {
  /** Seconds the store gets before quiet or its end counts. */
  floorS: number;
  /** Seconds without a new chunk that end the collect. */
  idleS: number;
}

export const SD_COLLECT: CollectWindow = { floorS: 0.8, idleS: 1 };
export const TRIGGER_COLLECT: CollectWindow = { floorS: 0.4, idleS: 0.2 };
export const INTERNAL_COLLECT: CollectWindow = { floorS: 0.8, idleS: 1 };
/** The trigger after a retried SD list waits on the SD counter. */
export const RETRY_TRIGGER_COLLECT: CollectWindow = { floorS: 0.4, idleS: 1 };

export type MediaQueryStep =
  | { kind: 'list'; counter: number; cursor: number; collect: CollectWindow }
  | { kind: 'trigger'; collectCounter: number | null; collect: CollectWindow };

/** The three frames of one page query and how long to collect after each. */
export function mediaQueryPlan(sdCursor: number, internalCursor: number): MediaQueryStep[] {
  return [
    { kind: 'list', counter: MEDIA_SD_COUNTER, cursor: sdCursor, collect: SD_COLLECT },
    { kind: 'trigger', collectCounter: null, collect: TRIGGER_COLLECT },
    { kind: 'list', counter: MEDIA_INTERNAL_COUNTER, cursor: internalCursor, collect: INTERNAL_COLLECT },
  ];
}

/** Asked once more when the first page's SD answer was empty while playback holds. */
export function retryEmptySdPlan(sdCursor: number): MediaQueryStep[] {
  return [
    { kind: 'list', counter: MEDIA_SD_COUNTER, cursor: sdCursor, collect: SD_COLLECT },
    { kind: 'trigger', collectCounter: MEDIA_SD_COUNTER, collect: RETRY_TRIGGER_COLLECT },
  ];
}

export interface CollectState {
  /** ms */
  start: number;
  lastChange: number;
  now: number;
  deadline: number;
  /** The awaited counter closed (`4a 03`). Always false for the trigger collect. */
  ended: boolean;
}

/** `collect`'s exit test, checked before each 50 ms poll (`end`) and after it (`quiet`). */
export function collectFinished(s: CollectState, w: CollectWindow, phase: 'before' | 'after'): boolean {
  if (s.now >= s.deadline) return true;
  if (phase === 'before') return s.ended && s.now - s.start >= w.floorS * 1000;
  return s.now - s.start >= w.floorS * 1000 && s.now - s.lastChange >= w.idleS * 1000;
}

export class MediaListingRetired extends Error {
  constructor() {
    super('The media listing was retired.');
    this.name = 'MediaListingRetired';
  }
}

export class MediaListingUnavailable extends Error {
  constructor(message = 'The camera did not send its media list. Try again.') {
    super(message);
    this.name = 'MediaListingUnavailable';
  }
}

export interface MediaListingIO {
  /** Milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** False once the browse is gone (left the library, link lost). */
  isCurrent(): boolean;
  /** Write one frame of the query. */
  sendList(counter: number, cursor: number): void;
  sendTrigger(): void;
  /** Route `0x00/0x27` frames into `assembler` until `null` is passed. */
  attach(assembler: MediaChunkAssembler | null): void;
}

export interface MediaPage {
  files: MediaFile[];
  slices: Record<number, MediaPageSliceInfo>;
  sawResponse: boolean;
}

async function collect(io: MediaListingIO, a: MediaChunkAssembler, counter: number | null, w: CollectWindow, deadline: number): Promise<void> {
  const count = () => (counter != null ? a.chunkCountFor(counter) : a.chunkCount);
  const start = io.now();
  let lastChange = start;
  let lastCount = count();
  for (;;) {
    if (!io.isCurrent()) throw new MediaListingRetired();
    const ended = counter != null && a.didEnd(counter);
    if (collectFinished({ start, lastChange, now: io.now(), deadline, ended }, w, 'before')) return;
    await io.sleep(MEDIA_COLLECT_POLL_MS);
    if (!io.isCurrent()) throw new MediaListingRetired();
    const c = count();
    if (c !== lastCount) {
      lastCount = c;
      lastChange = io.now();
    }
    if (collectFinished({ start, lastChange, now: io.now(), deadline, ended: false }, w, 'after')) return;
  }
}

async function runSteps(io: MediaListingIO, a: MediaChunkAssembler, steps: MediaQueryStep[], deadline: number): Promise<void> {
  for (const step of steps) {
    if (!io.isCurrent()) throw new MediaListingRetired();
    if (step.kind === 'list') {
      io.sendList(step.counter, step.cursor);
      await collect(io, a, step.counter, step.collect, deadline);
    } else {
      io.sendTrigger();
      await collect(io, a, step.collectCounter, step.collect, deadline);
    }
  }
}

/** One page query (`DjiAppleMediaService.query`). */
export async function queryMediaPage(io: MediaListingIO, sdCursor: number, internalCursor: number, retryEmptySd: boolean): Promise<MediaPage> {
  const a = new MediaChunkAssembler();
  io.attach(a);
  try {
    const deadline = io.now() + MEDIA_PAGE_BUDGET_MS;
    await runSteps(io, a, mediaQueryPlan(sdCursor, internalCursor), deadline);
    if (retryEmptySd && a.assembled(MEDIA_SD_COUNTER).length === 0 && io.now() < deadline) {
      a.reset(MEDIA_SD_COUNTER);
      await runSteps(io, a, retryEmptySdPlan(sdCursor), deadline);
    }
    if (!io.isCurrent()) throw new MediaListingRetired();
    return { files: MediaManifest.decodeStores(a), slices: pageSlices(a), sawResponse: a.hasResponse };
  } finally {
    io.attach(null);
  }
}

/** `0x02/0x0c` enter-playback, up to three times (`DjiAppleMediaService.enterPlayback`). */
export async function enterMediaPlayback(io: {
  isCurrent(): boolean;
  sleep(ms: number): Promise<void>;
  /** One attempt; true on a success reply. */
  attempt(): Promise<boolean>;
  inPlayback(): boolean;
}): Promise<boolean> {
  for (let i = 1; i <= MEDIA_ENTER_ATTEMPTS; i++) {
    if (!io.isCurrent()) throw new MediaListingRetired();
    let ok = false;
    try {
      ok = await io.attempt();
    } catch {
      ok = false;
    }
    if (ok || io.inPlayback()) return true;
    await io.sleep(MEDIA_ENTER_RETRY_PAUSE_MS);
  }
  return io.inPlayback();
}

/** Every record listed so far, in listing order, deduplicated by store and path. */
export class MediaCatalog {
  private byKey = new Map<string, MediaFile>();

  get files(): MediaFile[] {
    return [...this.byKey.values()];
  }
  get size(): number {
    return this.byKey.size;
  }
  clear(): void {
    this.byKey.clear();
  }
  /** A fresh page replaces a record with the same key, so a delete uses the fresh handle. */
  merge(files: MediaFile[]): void {
    for (const f of files) this.byKey.set(MediaFiles.pageKey(f), f);
  }
  remove(key: string): void {
    this.byKey.delete(key);
  }
  get(key: string): MediaFile | undefined {
    return this.byKey.get(key);
  }
  set(key: string, f: MediaFile): void {
    this.byKey.set(key, f);
  }
}

export interface MediaListingResult {
  files: MediaFile[];
  pages: number;
  /** Every page the camera would give was listed (false: newest page only, or capped). */
  complete: boolean;
  policy: MediaBrowsePolicy;
}

/**
 * The whole listing (`DjiAppleMediaCursor`): the newest page always; older pages only while the
 * camera holds playback and the cursors say more exist. `onPage` sees the catalogue after each
 * page so the grid can fill in as pages arrive.
 */
export async function listMediaCatalog(
  io: MediaListingIO,
  options: { playbackHeld: boolean; maxPages?: number; onPage?: (files: MediaFile[], page: number) => void },
): Promise<MediaListingResult> {
  const policy = afterEnterPlayback(options.playbackHeld);
  const maxPages = options.maxPages ?? MEDIA_MAX_PAGES;
  const catalog = new MediaCatalog();
  const seen = new Set<string>();
  let sd = MEDIA_NEWEST_SD;
  let internal = MEDIA_NEWEST_INTERNAL;
  let pages = 0;
  for (;;) {
    const first = pages === 0;
    const page = await queryMediaPage(io, sd, internal, first && options.playbackHeld);
    if (first && !page.sawResponse) throw new MediaListingUnavailable();
    pages += 1;
    const step = first ? seedPagination(page.files, seen, page.slices) : stepPagination(sd, internal, page.files, seen, page.slices);
    sd = step.sdCursor;
    internal = step.internalCursor;
    catalog.merge(step.fresh);
    options.onPage?.(catalog.files, pages);
    const more = policy.listOlderPages && step.moreAvailable && page.sawResponse;
    if (!more) return { files: catalog.files, pages, complete: !step.moreAvailable, policy };
    if (pages >= maxPages) return { files: catalog.files, pages, complete: false, policy };
  }
}
