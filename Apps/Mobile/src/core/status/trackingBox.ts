/**
 * Tracking box geometry and its DJI wire (`0x02/0x89` live push, `0x02/0xA5` poll reply).
 * Source of truth: OpenCine `OpenCineCameraVocabulary/TrackingBox.swift` (struct only) and
 * `OpenCineDJI/TrackingBox+DJIWire.swift`. Face/AF policies (Vision-side) are not ported.
 */
import { type ByteInput, f32le } from '../bytes';

export interface TrackingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TRACKING_MIN_NORMALIZED = 0.05;
export const TRACKING_MIMO_MIN_SIDE = 0.09;

export const TrackingBoxes = {
  center(b: TrackingBox): { x: number; y: number } {
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  },
  isTooSmall: (b: TrackingBox) => b.width < TRACKING_MIMO_MIN_SIDE || b.height < TRACKING_MIMO_MIN_SIDE,
  intersectionOverUnion(a: TrackingBox, b: TrackingBox): number {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width);
    const y1 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    const union = a.width * a.height + b.width * b.height - inter;
    return union > 0 ? inter / union : 0;
  },
  flipped(b: TrackingBox, horizontal: boolean, vertical: boolean): TrackingBox {
    return { x: horizontal ? 1 - b.x - b.width : b.x, y: vertical ? 1 - b.y - b.height : b.y, width: b.width, height: b.height };
  },
  normalized(fromX: number, fromY: number, toX: number, toY: number): TrackingBox {
    const c = (v: number) => Math.min(Math.max(v, 0), 1);
    const x0 = c(Math.min(fromX, toX));
    const y0 = c(Math.min(fromY, toY));
    const x1 = c(Math.max(fromX, toX));
    const y1 = c(Math.max(fromY, toY));
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  },
  fromCenter(x: number, y: number, width: number, height: number): TrackingBox {
    const w = Math.min(Math.max(width, 0.02), 1);
    const h = Math.min(Math.max(height, 0.02), 1);
    return { x: x - w / 2, y: y - h / 2, width: w, height: h };
  },
  subject(search: TrackingBox): TrackingBox {
    const w = Math.min(Math.max(search.width * 0.45, TRACKING_MIN_NORMALIZED), search.width);
    const h = Math.min(Math.max(search.height * 0.45, TRACKING_MIN_NORMALIZED), search.height);
    return { x: search.x + (search.width - w) / 2, y: search.y + (search.height - h) / 2, width: w, height: h };
  },

  // ---- DJI wire ----
  parseNormalized(bytes: ByteInput, minimum = TRACKING_MIN_NORMALIZED, requireOriginFits = true): TrackingBox | null {
    if (bytes.length < 16) return null;
    const f = (o: number) => {
      const v = f32le(bytes, o);
      return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
    };
    const x = f(0);
    const y = f(4);
    const width = f(8);
    const height = f(12);
    if (x == null || y == null || width == null || height == null || width < minimum || height < minimum) return null;
    if (requireOriginFits && (x + width > 1.02 || y + height > 1.02)) return null;
    return { x, y, width, height };
  },
  /** `0x02/0x89` notify, 23 B: 5×`00` + 2-byte tag + centre/size 4×f32 LE @7. */
  parseLivePush(p: ByteInput): TrackingBox | null {
    if (p.length < 23 || p[0] || p[1] || p[2] || p[3] || p[4]) return null;
    const raw = TrackingBoxes.parseNormalized(Array.prototype.slice.call(p, 7) as number[], 0.02, false);
    return raw ? TrackingBoxes.fromCenter(raw.x, raw.y, raw.width, raw.height) : null;
  },
};

export type TrackingPoll = { kind: 'locked'; box: TrackingBox | null } | { kind: 'idle' };

/** `0x02/0xA5` GET reply. Locked `00 01 00 00`, idle `00 00 00 00`, optional 4×f32 subject. */
export function parseTrackingPoll(p: ByteInput): TrackingPoll | null {
  if (p.length < 4 || p[0] !== 0 || p[2] !== 0 || p[3] !== 0) return null;
  if (p[1] === 0) return { kind: 'idle' };
  if (p[1] !== 1) return null;
  const extra = p.length >= 20 ? (Array.prototype.slice.call(p, 4) as number[]) : [];
  const raw = TrackingBoxes.parseNormalized(extra, TRACKING_MIN_NORMALIZED, false);
  return { kind: 'locked', box: raw ? TrackingBoxes.fromCenter(raw.x, raw.y, raw.width, raw.height) : null };
}
