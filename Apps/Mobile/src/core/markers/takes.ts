/**
 * Takes waiting for their file. A take is what this app saw being recorded (start, stop, the
 * format, the active shoot, the markers made during it); the camera file it produced shows up
 * in the media listing later, maybe after an app restart. {@link matchTakes} pairs them by what
 * a camera file says about itself:
 *
 * - its time: DJI names a file after the moment it started (`DJI_20260814125250_…`), so
 *   `createdAt` should be near the take's start (or, on bodies that stamp the close, its stop);
 * - its duration, against the camera's own elapsed time at stop;
 * - novelty: a file that was not listed when the take began. This carries a match when the
 *   camera's clock is off, as long as the duration agrees.
 *
 * Pure.
 */
import type { ClipMarker } from './model';

export interface PendingTake {
  id: string;
  /** 1-based within its shoot (or its day). */
  number: number;
  /** Estimated first frame by this phone's clock (ms epoch). */
  startedAt: number;
  stoppedAt?: number;
  /** The camera's elapsed time at stop (seconds). */
  durationSec?: number;
  timeSource: 'camera' | 'phone';
  cameraId?: string;
  cameraName?: string;
  cameraModel?: string;
  cameraSerial?: string;
  fps?: number;
  resolution?: string;
  width?: number;
  height?: number;
  colorMode?: string;
  codec?: string;
  shootId: string | null;
  /** Video ids listed before the take began (newest first, a bounded window). */
  knownIds: string[];
  /** The newest of those files' own time (the camera's clock), when known. */
  knownNewestAt?: number;
  markers: ClipMarker[];
}

/** What matching needs to know about a listed file. */
export interface MatchCandidate {
  id: string;
  kind: 'video' | 'photo';
  fileName: string;
  createdAt: number;
  durationSec?: number;
}

/** A file this far (either way) from the take's start or stop still counts as "at that time". */
export const MATCH_TIME_WINDOW_MS = 120_000;
/** How far a file's duration may be from the take's (seconds): the larger of this and 3 %. */
export const MATCH_DURATION_SLACK = 1.5;
/** Ids kept per take for novelty. */
export const KNOWN_IDS_KEPT = 60;

function durationDiff(take: PendingTake, c: MatchCandidate): number | null {
  if (take.durationSec == null || c.durationSec == null || !Number.isFinite(c.durationSec)) return null;
  return Math.abs(c.durationSec - take.durationSec);
}

function durationOk(take: PendingTake, d: number | null): boolean {
  if (d == null) return true;
  return d <= Math.max(MATCH_DURATION_SLACK, 0.03 * (take.durationSec ?? 0));
}

/** How well a file fits a take (lower is better), or null when it cannot be that take. */
export function matchScore(take: PendingTake, c: MatchCandidate): number | null {
  if (c.kind !== 'video' || take.stoppedAt == null) return null;
  const d = durationDiff(take, c);
  if (!durationOk(take, d)) return null;
  const tDiff = c.createdAt > 0 ? Math.min(Math.abs(c.createdAt - take.startedAt), Math.abs(c.createdAt - take.stoppedAt)) : Infinity;
  const timeOk = tDiff <= MATCH_TIME_WINDOW_MS;
  // The camera's clock runs forward even when it disagrees with the phone's: a file made by this
  // take is newer than every file listed before it.
  const novel = take.knownIds.length > 0 && !take.knownIds.includes(c.id) && (take.knownNewestAt == null || c.createdAt >= take.knownNewestAt);
  // Novelty alone needs a duration that agrees; time alone is enough.
  if (!timeOk && !(novel && d != null)) return null;
  return (timeOk ? tDiff / 1000 : 600) + (d ?? 5) * 10 + (novel ? 0 : 30);
}

export interface TakeMatch {
  takeId: string;
  itemId: string;
}

/**
 * Pairs stopped takes with listed files, best fits first; each file and take at most once.
 * `claimed` are ids that already belong to a take. `cameraId` is the listing's camera: takes
 * recorded on another camera are left alone.
 */
export function matchTakes(takes: PendingTake[], items: MatchCandidate[], claimed: ReadonlySet<string>, cameraId?: string | null): TakeMatch[] {
  const pairs: { take: PendingTake; item: MatchCandidate; score: number }[] = [];
  for (const take of takes) {
    if (take.stoppedAt == null) continue;
    if (cameraId && take.cameraId && take.cameraId !== cameraId) continue;
    for (const item of items) {
      if (claimed.has(item.id)) continue;
      const score = matchScore(take, item);
      if (score != null) pairs.push({ take, item, score });
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  const usedTakes = new Set<string>();
  const usedItems = new Set<string>();
  const out: TakeMatch[] = [];
  for (const p of pairs) {
    if (usedTakes.has(p.take.id) || usedItems.has(p.item.id)) continue;
    usedTakes.add(p.take.id);
    usedItems.add(p.item.id);
    out.push({ takeId: p.take.id, itemId: p.item.id });
  }
  return out;
}

/** Video ids to remember at a take's start for novelty (newest first), and the newest file's time. */
export function knownIdsOf(items: MatchCandidate[]): { knownIds: string[]; knownNewestAt?: number } {
  const videos = items.filter((i) => i.kind === 'video').sort((a, b) => b.createdAt - a.createdAt);
  return { knownIds: videos.slice(0, KNOWN_IDS_KEPT).map((i) => i.id), knownNewestAt: videos[0]?.createdAt || undefined };
}
