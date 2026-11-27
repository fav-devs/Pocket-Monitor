/**
 * Geometry stage: rotate (clockwise, 90° steps) → crop (aspect, zoom, pan) → flip.
 *
 * Everything is in normalized coordinates with a top-left origin. The crop rect lives in the
 * rotated frame (before the flip). Preview (React Native transforms), the iOS Core Image
 * compositor and the Android Media3 effects all derive from these functions, so what the
 * operator frames is what the export renders.
 */
import { ASPECTS, MAX_ZOOM, type CropState, type Rotation } from './model';

export interface Size {
  width: number;
  height: number;
}

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const quarterTurn = (r: Rotation) => r === 90 || r === 270;

export function rotatedSize(src: Size, rotation: Rotation): Size {
  return quarterTurn(rotation) ? { width: src.height, height: src.width } : { width: src.width, height: src.height };
}

/** The crop's aspect (w/h) for a rotated frame of `rotated` size. */
export function cropAspect(rotated: Size, crop: CropState): number {
  const ratio = ASPECTS.find((a) => a.id === crop.aspect)?.ratio ?? null;
  if (ratio) return ratio;
  return rotated.height > 0 ? rotated.width / rotated.height : 16 / 9;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The crop rect (normalized, in the rotated frame). */
export function cropRect(src: Size, rotation: Rotation, crop: CropState): NormRect {
  const rs = rotatedSize(src, rotation);
  if (rs.width <= 0 || rs.height <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  const a = cropAspect(rs, crop);
  const frameAspect = rs.width / rs.height;
  // Largest rect of aspect `a` inside the frame, as fractions of the frame.
  let w = 1;
  let h = 1;
  if (frameAspect > a) w = a / frameAspect;
  else h = frameAspect / a;
  const z = clamp(crop.zoom || 1, 1, MAX_ZOOM);
  w /= z;
  h /= z;
  const cx = 0.5 + clamp(crop.panX, -1, 1) * (1 - w) * 0.5;
  const cy = 0.5 + clamp(crop.panY, -1, 1) * (1 - h) * 0.5;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));

/**
 * Output pixel size: the crop at source resolution, capped so the long side is at most
 * `maxLong` (when given), rounded to even numbers for the encoders.
 */
export function outputSize(src: Size, rotation: Rotation, crop: CropState, maxLong?: number): Size {
  const rs = rotatedSize(src, rotation);
  const r = cropRect(src, rotation, crop);
  let w = r.w * rs.width;
  let h = r.h * rs.height;
  const long = Math.max(w, h);
  if (maxLong && long > maxLong) {
    w = (w * maxLong) / long;
    h = (h * maxLong) / long;
  }
  return { width: even(w), height: even(h) };
}

/** Output aspect (w/h) without rounding. */
export function outputAspect(src: Size, rotation: Rotation, crop: CropState): number {
  const rs = rotatedSize(src, rotation);
  const r = cropRect(src, rotation, crop);
  const h = r.h * rs.height;
  return h > 0 ? (r.w * rs.width) / h : 16 / 9;
}

/**
 * React Native layout for the preview inside an output frame of `frame` size (the frame has
 * `overflow: hidden`):
 *   frame → flip wrapper (fills the frame, `scaleX/scaleY` ±1)
 *         → `box`: the whole rotated picture, offset so the crop fills the frame
 *         → `inner`: the source-shaped picture view, centred in `box` and rotated.
 */
export function previewLayout(
  src: Size,
  rotation: Rotation,
  crop: CropState,
  flip: { h: boolean; v: boolean },
  frame: Size,
): {
  box: { left: number; top: number; width: number; height: number };
  inner: { left: number; top: number; width: number; height: number; rotate: number };
  scaleX: number;
  scaleY: number;
} {
  const r = cropRect(src, rotation, crop);
  const bw = r.w > 0 ? frame.width / r.w : frame.width;
  const bh = r.h > 0 ? frame.height / r.h : frame.height;
  const turned = quarterTurn(rotation);
  const iw = turned ? bh : bw;
  const ih = turned ? bw : bh;
  return {
    box: { left: -r.x * bw, top: -r.y * bh, width: bw, height: bh },
    inner: { left: (bw - iw) / 2, top: (bh - ih) / 2, width: iw, height: ih, rotate: rotation },
    scaleX: flip.h ? -1 : 1,
    scaleY: flip.v ? -1 : 1,
  };
}

/** The crop's centre from a rect (inverse of the pan → rect mapping). */
function panFor(center: number, size: number): number {
  const room = (1 - size) / 2;
  return room > 1e-6 ? clamp((center - 0.5) / room, -1, 1) : 0;
}

/**
 * Drag the picture inside the frame by (`dx`, `dy`) fractions of the frame: the content follows
 * the finger, so the crop moves the other way (the same way when that axis is flipped).
 */
export function panBy(src: Size, rotation: Rotation, crop: CropState, flip: { h: boolean; v: boolean }, dx: number, dy: number): CropState {
  const r = cropRect(src, rotation, crop);
  const cx = r.x + r.w / 2 + (flip.h ? dx : -dx) * r.w;
  const cy = r.y + r.h / 2 + (flip.v ? dy : -dy) * r.h;
  return { ...crop, panX: panFor(cx, r.w), panY: panFor(cy, r.h) };
}

/** Zoom about the crop's centre, keeping it inside the frame. */
export function zoomTo(src: Size, rotation: Rotation, crop: CropState, zoom: number): CropState {
  const before = cropRect(src, rotation, crop);
  const z = clamp(zoom, 1, MAX_ZOOM);
  const sized = cropRect(src, rotation, { ...crop, zoom: z, panX: 0, panY: 0 });
  const cx = before.x + before.w / 2;
  const cy = before.y + before.h / 2;
  return { ...crop, zoom: z, panX: panFor(cx, sized.w), panY: panFor(cy, sized.h) };
}

/**
 * Before/after compare: the frame's vertical centre line expressed in the source frame (the
 * colour stage runs on the source, before geometry). Original shows on the screen's left.
 * `originalLow`: the original is where the source coordinate is below `at`.
 */
export interface CompareSplit {
  axis: 'x' | 'y';
  at: number;
  originalLow: boolean;
}

export function compareSplit(src: Size, rotation: Rotation, crop: CropState, flip: { h: boolean; v: boolean }): CompareSplit {
  const r = cropRect(src, rotation, crop);
  // The centre line in the rotated frame; the screen's left is the low side unless flipped.
  const c = r.x + r.w / 2;
  const lowInRotated = !flip.h;
  switch (rotation) {
    case 0:
      return { axis: 'x', at: c, originalLow: lowInRotated };
    case 90:
      // u' = 1 − v
      return { axis: 'y', at: 1 - c, originalLow: !lowInRotated };
    case 180:
      // u' = 1 − u
      return { axis: 'x', at: 1 - c, originalLow: !lowInRotated };
    case 270:
      // u' = v
      return { axis: 'y', at: c, originalLow: lowInRotated };
  }
}

/** Map a normalized source point into the output frame (for tests and overlays). */
export function sourceToOutput(src: Size, rotation: Rotation, crop: CropState, flip: { h: boolean; v: boolean }, u: number, v: number): { x: number; y: number } {
  let ru = u;
  let rv = v;
  if (rotation === 90) [ru, rv] = [1 - v, u];
  else if (rotation === 180) [ru, rv] = [1 - u, 1 - v];
  else if (rotation === 270) [ru, rv] = [v, 1 - u];
  const r = cropRect(src, rotation, crop);
  let x = (ru - r.x) / r.w;
  let y = (rv - r.y) / r.h;
  if (flip.h) x = 1 - x;
  if (flip.v) y = 1 - y;
  return { x, y };
}
