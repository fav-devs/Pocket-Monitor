/**
 * The one way input code asks for a marker (the gesture runtime, the desktop keys): no React
 * Native or storage imports, so the input modules stay testable in Node. `MarkerHost` connects
 * it to `capture.addMarker`.
 */
import type { MarkerSource } from '@/core/markers/model';

let handler: ((source: MarkerSource) => void) | null = null;

export function setMarkerHandler(next: ((source: MarkerSource) => void) | null): void {
  handler = next;
}

/** A marker on the take being recorded, if the app is up to take it. */
export function requestMarker(source: MarkerSource): void {
  handler?.(source);
}
