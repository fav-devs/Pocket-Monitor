/**
 * Paging the camera's catalogue: the SD and internal stores each keep their own cursor, which
 * walks down that store's handles page by page (45 records per page).
 *
 * Source of truth: OpenCine `OpenCineDJI/MediaManifest+DJIWire.swift` (`MediaListCommand`
 * `seedPagination` / `stepPagination` / `storeHasOlderPage`, `MediaPageSliceInfo`,
 * `MediaManifest.sliceInfo`). The desktop's `opc-media/chunks.rs` has the older single-cursor
 * form; upstream wins.
 */
import {
  MEDIA_COUNT_MAX,
  MEDIA_INTERNAL_BIT,
  MEDIA_INTERNAL_COUNTER,
  MEDIA_NEWEST_INTERNAL,
  MEDIA_NEWEST_SD,
  MEDIA_PAGE_SIZE,
  MEDIA_SD_COUNTER,
  type MediaChunkAssembler,
  type MediaFile,
  MediaFiles,
  MediaManifest,
} from '../status/mediaManifest';

export const SD_STORE = 0;
export const INTERNAL_STORE = 1;

/** Wire evidence for one store's answer to a `0x00/0x26` page query. */
export interface MediaPageSliceInfo {
  declared: number;
  records: number;
  endMarker: boolean;
  ended: boolean;
}

/** A plausible header promised more records than reached the decoder. */
export const sliceIncomplete = (s: MediaPageSliceInfo) => s.declared >= 1 && s.declared <= MEDIA_COUNT_MAX && s.records < s.declared;

export function sliceInfo(a: MediaChunkAssembler, counter: number): MediaPageSliceInfo {
  const bytes = a.assembled(counter);
  return {
    declared: bytes.length >= 4 ? MediaManifest.headerCount(bytes) : -1,
    records: MediaManifest.recordCount(bytes),
    endMarker: MediaManifest.hasEndMarker(bytes),
    ended: a.didEnd(counter),
  };
}

/** Both stores' slice facts for one page, keyed by store (0 SD, 1 internal). */
export function pageSlices(a: MediaChunkAssembler): Record<number, MediaPageSliceInfo> {
  return { [SD_STORE]: sliceInfo(a, MEDIA_SD_COUNTER), [INTERNAL_STORE]: sliceInfo(a, MEDIA_INTERNAL_COUNTER) };
}

/** Result of advancing the independent SD and internal-storage page cursors. */
export interface MediaPageStep {
  /** Records not seen on an earlier page (by `pageKey`). */
  fresh: MediaFile[];
  sdCursor: number;
  internalCursor: number;
  moreAvailable: boolean;
}

export const storeSlice = (page: MediaFile[], store: number) => page.filter((f) => MediaFiles.store(f) === store);

/** Oldest usable handle in one store, optionally strictly below its current cursor. */
export function oldestHandle(page: MediaFile[], store: number, below?: number | null): number | null {
  let min: number | null = null;
  for (const f of storeSlice(page, store)) {
    const h = f.handle >>> 0;
    if (h === 0) continue;
    if (below != null && !(h < below >>> 0)) continue;
    if (min == null || h < min) min = h;
  }
  return min;
}

/** A complete short page is final; a full page probably has an older page. */
export function hasOlderPage(recordCount: number, cursor: number | null | undefined): boolean {
  if (cursor == null || cursor <= 0) return false;
  return recordCount >= MEDIA_PAGE_SIZE;
}

/**
 * Per-store end rule. Truncation outranks the final-page marker because missing chunks can sit
 * before the record that carries that marker.
 */
export function storeHasOlderPage(sliceSize: number, cursorMoved: boolean, info?: MediaPageSliceInfo | null): boolean {
  if (!cursorMoved) return false;
  if (!info) return sliceSize >= MEDIA_PAGE_SIZE;
  if (sliceIncomplete(info)) return true;
  if (info.endMarker) return false;
  return sliceSize >= MEDIA_PAGE_SIZE;
}

function pageStep(
  sdCursor: number,
  internalCursor: number,
  page: MediaFile[],
  seen: Set<string>,
  slices: Record<number, MediaPageSliceInfo>,
  initial: boolean,
): MediaPageStep {
  const fresh: MediaFile[] = [];
  for (const f of page) {
    const key = MediaFiles.pageKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(f);
  }
  const sdOldest = oldestHandle(page, SD_STORE, initial ? null : sdCursor);
  const internalOldest = oldestHandle(page, INTERNAL_STORE, initial ? null : internalCursor);
  const more =
    fresh.length > 0 &&
    (storeHasOlderPage(storeSlice(page, SD_STORE).length, sdOldest != null, slices[SD_STORE]) ||
      storeHasOlderPage(storeSlice(page, INTERNAL_STORE).length, internalOldest != null, slices[INTERNAL_STORE]));
  return { fresh, sdCursor: sdOldest ?? sdCursor, internalCursor: internalOldest ?? internalCursor, moreAvailable: more };
}

/** First page: replace each newest-page selector with that store's oldest returned handle. */
export function seedPagination(page: MediaFile[], seen: Set<string>, slices: Record<number, MediaPageSliceInfo> = {}): MediaPageStep {
  return pageStep(MEDIA_NEWEST_SD, MEDIA_NEWEST_INTERNAL, page, seen, slices, true);
}

/** Older page: advance each store only from handles in its own returned slice. */
export function stepPagination(
  sdCursor: number,
  internalCursor: number,
  page: MediaFile[],
  seen: Set<string>,
  slices: Record<number, MediaPageSliceInfo> = {},
): MediaPageStep {
  return pageStep(sdCursor, internalCursor, page, seen, slices, false);
}

/** Is this handle on the internal store (two-store bodies)? */
export const isInternalHandle = (handle: number) => ((handle >>> 0) & MEDIA_INTERNAL_BIT) !== 0;
