/**
 * Focus peaking: the two-scale Roberts ratio detector (OpenCine `FocusAssist.swift` `Peaking`).
 * Sharpness = fine / coarse operator (amplitude cancels), so one threshold holds from dim
 * texture to a blown highlight; the noise gate (on the coarse operator) rejects grain.
 * `overlay` is the executable definition that every GPU shell transcribes.
 */
import { PEAKING_NOISE_GATE, PEAKING_RATIO_THRESHOLD, type PeakingSense } from './assistOptions';
import type { MonitorTransfer } from './transfer';

export const PEAKING = {
  reblurWeights: [0.006044, 0.060662, 0.241798, 0.382992, 0.241798, 0.060662, 0.006044],
  ratioCeiling: 4,
  antialiasWidth: 0.12,
  underRampOffset: 0.5,
  underColor: [0.04, 0.04, 0.05] as [number, number, number],
  gateRampFloor: 0.7,
  edgeInset: 6,
  displayReferredGradientScale: 1.57,
};

/** Gate multiplier: display-referred feeds read larger gradients than log (squared domain). */
export function peakingGateScale(transfer: MonitorTransfer): number {
  if (transfer === 'rec709' || transfer === 'hdr') return PEAKING.displayReferredGradientScale ** 2;
  return 1;
}

const clamped = (v: number) => Math.min(Math.max(v, 0), 1);

export function robertsSquared(x: number, y: number, sample: (x: number, y: number) => number): number {
  const a = sample(x, y);
  const b = sample(x + 1, y);
  const c = sample(x, y + 1);
  const d = sample(x + 1, y + 1);
  const d1 = d - a;
  const d2 = c - b;
  return d1 * d1 + d2 * d2;
}

export const sharpness = (fine: number, coarse: number) => Math.min(fine / Math.max(coarse, 1e-9), PEAKING.ratioCeiling);
export const gateOpacity = (coarse: number, gate: number) =>
  clamped((coarse - gate * PEAKING.gateRampFloor) / Math.max(gate * (1 - PEAKING.gateRampFloor), 1e-12));
export const strokeOpacity = (s: number, threshold: number) => clamped((s - threshold) / PEAKING.antialiasWidth);
export const underOpacity = (s: number, threshold: number) =>
  strokeOpacity(s, threshold - PEAKING.antialiasWidth * PEAKING.underRampOffset);

/** Whole-frame reference detector on a normalized grey plane (row-major, top-down). */
export function peakingOverlay(
  grey: Float32Array | number[],
  width: number,
  height: number,
  sense: PeakingSense,
  gateScale = 1,
  closing = true,
): { stroke: Float32Array; under: Float32Array } {
  const gate = PEAKING_NOISE_GATE[sense] * gateScale;
  const threshold = PEAKING_RATIO_THRESHOLD[sense];
  const inset = PEAKING.edgeInset;
  const at = (p: ArrayLike<number>, x: number, y: number) =>
    p[Math.min(Math.max(y, 0), height - 1) * width + Math.min(Math.max(x, 0), width - 1)];
  const w = PEAKING.reblurWeights;
  const taps = (w.length - 1) / 2;
  const rows = new Float32Array(width * height);
  const blurred = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let t = 0;
      for (let i = 0; i < w.length; i++) t += w[i] * at(grey, x + i - taps, y);
      rows[y * width + x] = t;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let t = 0;
      for (let i = 0; i < w.length; i++) t += w[i] * at(rows, x, y + i - taps);
      blurred[y * width + x] = t;
    }
  let stroke = new Float32Array(width * height);
  const under = new Float32Array(width * height);
  for (let y = inset; y < Math.max(inset, height - inset); y++)
    for (let x = inset; x < Math.max(inset, width - inset); x++) {
      const fine = robertsSquared(x, y, (a, b) => at(grey, a, b));
      const coarse = robertsSquared(x, y, (a, b) => at(blurred, a, b));
      const ratio = sharpness(fine, coarse);
      const g = gateOpacity(coarse, gate);
      stroke[y * width + x] = strokeOpacity(ratio, threshold) * g;
      under[y * width + x] = underOpacity(ratio, threshold) * g;
    }
  if (!closing) return { stroke, under };
  const offsets = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const morph = (plane: Float32Array, pick: (a: number, b: number) => number) => {
    const out = new Float32Array(plane.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let v = plane[y * width + x];
        for (const [dx, dy] of offsets) v = pick(v, at(plane, x + dx, y + dy));
        out[y * width + x] = v;
      }
    return out;
  };
  stroke = morph(morph(stroke, Math.max), Math.min);
  return { stroke, under };
}
