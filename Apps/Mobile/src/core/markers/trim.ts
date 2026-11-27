/**
 * Markers through the clip editor's trim: an exported clip starts at the trim's start, so each
 * marker moves back by it, and markers outside the kept range are dropped. Pure.
 */
import type { ClipMarker } from './model';

/** Markers this close outside the range (seconds) still count as on its edge. */
export const TRIM_EDGE = 0.001;

export function shiftMarkersForTrim(markers: ClipMarker[], trim: { start: number; end: number } | null | undefined): ClipMarker[] {
  if (!trim) return markers.map((m) => ({ ...m }));
  const { start, end } = trim;
  return markers
    .filter((m) => m.time >= start - TRIM_EDGE && m.time <= end + TRIM_EDGE)
    .map((m) => ({ ...m, time: Math.min(Math.max(0, m.time - start), Math.max(0, end - start)) }));
}
