/**
 * False colour: band tables, the per-code paint table the GPU samples, and the reference key.
 * Port of OpenCine `FalseColor.swift`, `MonitorFalseColorReferencePlan.swift` and
 * OpenPocketViewCore `FalseColorCube.swift` (as a 256-entry luma table instead of a 64³ cube:
 * every scale keys encoded luma only, so the 1D table is exact).
 */
import { CLIP_SHELF_CODES, monitorPercent } from './scope';
import { lumaWeights, stopsFromEncoded, type MonitorTransfer } from './transfer';

/** Scale names. `sceneStops` is CineStop (scene stops); `stops` is Video (published IRE zones). */
export type FalseColorScale = 'sceneStops' | 'stops' | 'ire' | 'limits';

/** PictureEffects / store spelling → scale. */
export type FalseColorMode = 'cinestop' | 'video' | 'ire' | 'limits';

export function scaleForMode(mode: FalseColorMode): FalseColorScale {
  switch (mode) {
    case 'cinestop':
      return 'sceneStops';
    case 'video':
      return 'stops';
    default:
      return mode;
  }
}

export const FALSE_COLOR_MODE_LABEL: Record<FalseColorMode, string> = {
  cinestop: 'CineStop',
  video: 'Video',
  ire: 'IRE',
  limits: 'Limits',
};

export const usesSceneStops = (s: FalseColorScale) => s === 'sceneStops';
export const edgeSoftness = (s: FalseColorScale) => (usesSceneStops(s) ? 0.05 : 0.5);

export interface FalseColorBand {
  lower: number;
  upper: number;
  r: number;
  g: number;
  b: number;
  label: string;
}

const ire = (lower: number, upper: number, r: number, g: number, b: number, label: string): FalseColorBand => ({
  lower,
  upper,
  r,
  g,
  b,
  label,
});
const band = (lower: number, upper: number, r: number, g: number, b: number, label: string): FalseColorBand => ({
  lower,
  upper,
  r: r / 255,
  g: g / 255,
  b: b / 255,
  label,
});

/** Video: published Video Mode IRE on the WAVE axis. Gaps are greyscale. */
const VIDEO_BANDS: FalseColorBand[] = [
  ire(0, 5, 0.44, 0.22, 0.76, '0–4'),
  ire(5, 6, 0.28, 0.37, 0.85, '5'),
  ire(10, 13, 0.18, 0.58, 0.64, '10–12'),
  ire(41, 49, 0.38, 0.63, 0.35, '41–48'),
  ire(61, 71, 0.83, 0.53, 0.71, '61–70'),
  ire(92, 94, 0.83, 0.77, 0.45, '92–93'),
  ire(94, 96, 0.89, 0.72, 0.29, '94–95'),
  ire(96, 99, 0.85, 0.55, 0.22, '96–98'),
  ire(99, Infinity, 0.78, 0.28, 0.18, '99–100'),
];

/** IRE: six video-level zones (BDL / NBDL / 18%MG / MG+1 / 80%WC / 95%WC). */
const IRE_BANDS: FalseColorBand[] = [
  band(0, 2.5, 115, 33, 120, 'BDL'),
  band(2.5, 10, 29, 2, 221, 'NBDL'),
  band(38, 42, 123, 207, 87, '18%MG'),
  band(52, 56, 241, 190, 198, 'MG+1'),
  band(80, 95, 255, 255, 88, '80%WC'),
  band(95, Infinity, 220, 51, 33, '95%WC'),
];

const LIMIT_BANDS: FalseColorBand[] = [
  ire(0, 5, 0.44, 0.22, 0.76, '0–4'),
  ire(5, 10, 0.28, 0.37, 0.85, '5–9'),
  ire(94, 99, 0.89, 0.72, 0.29, '94–98'),
  ire(99, Infinity, 0.78, 0.28, 0.18, '99–100'),
];

/** Scene stops where clip starts when the ceiling is unknown. */
export const SCENE_STOP_DEFAULT_CLIP = 10.5;

function sceneStopBands(clipStops: number | null): FalseColorBand[] {
  const clip = clipStops != null && Number.isFinite(clipStops) ? clipStops : SCENE_STOP_DEFAULT_CLIP;
  const zones = [
    band(-2.5, -1.5, 39, 76, 0, '−2'),
    band(-1.5, -0.5, 155, 196, 56, '−1'),
    band(-0.5, 0.5, 127, 127, 127, '18%'),
    band(0.5, 1.5, 221, 174, 180, '+1'),
    band(1.5, 2.5, 252, 232, 96, '+2'),
  ];
  const bands = [band(-Infinity, -6.5, 75, 8, 165, 'crush'), band(-6.5, -2.5, 102, 102, 102, 'shadows')];
  for (const z of zones) if (z.lower < clip) bands.push({ ...z, upper: Math.min(z.upper, clip) });
  if (clip > 2.5) bands.push(band(2.5, clip, 179, 178, 178, 'highlights'));
  bands.push(band(clip, Infinity, 245, 39, 0, 'clip'));
  return bands;
}

/** Encoded clip shelf under a ceiling, snapped down to a lattice point when given. */
export function clipShelf(ceiling: number, latticeSize?: number): number {
  const shelf = Math.max(0, ceiling - CLIP_SHELF_CODES / 255);
  if (!latticeSize || latticeSize <= 1) return shelf;
  return Math.floor(shelf * (latticeSize - 1)) / (latticeSize - 1);
}

export function falseColorBands(
  scale: FalseColorScale,
  transfer: MonitorTransfer,
  clipEncoded?: number,
  latticeSize?: number,
): FalseColorBand[] {
  const shelf = clipEncoded != null ? clipShelf(clipEncoded, latticeSize) : null;
  const soften = latticeSize == null ? 0 : edgeSoftness(scale);
  switch (scale) {
    case 'stops':
      return VIDEO_BANDS;
    case 'ire':
      return IRE_BANDS;
    case 'limits': {
      const clipByte = clipEncoded != null ? Math.round(clipEncoded * 255) : 255;
      const edge = shelf != null ? monitorPercent(shelf, transfer, clipByte) - soften : null;
      if (edge == null || !(edge < 99) || !(edge > LIMIT_BANDS[2].lower)) return LIMIT_BANDS;
      const bands = LIMIT_BANDS.map((b) => ({ ...b }));
      bands[2].upper = edge;
      bands[3].lower = edge;
      return bands;
    }
    case 'sceneStops':
      return sceneStopBands(shelf != null ? stopsFromEncoded(shelf, transfer) - soften : null);
  }
}

export function falseColorBand(
  value: number,
  scale: FalseColorScale,
  transfer: MonitorTransfer,
  clipEncoded?: number,
): FalseColorBand | null {
  const v = usesSceneStops(scale) ? value : Math.min(100, Math.max(0, value));
  return falseColorBands(scale, transfer, clipEncoded).find((b) => v >= b.lower && v < b.upper) ?? null;
}

function smoothStep(e0: number, e1: number, v: number) {
  const span = e1 - e0;
  if (span === 0) return v >= e1 ? 1 : 0;
  const p = Math.min(1, Math.max(0, (v - e0) / span));
  return p * p * (3 - 2 * p);
}

function bandWeight(value: number, b: FalseColorBand, width: number) {
  const rising = Number.isFinite(b.lower) && b.lower !== 0 ? smoothStep(b.lower - width, b.lower + width, value) : 1;
  const falling = Number.isFinite(b.upper) ? 1 - smoothStep(b.upper - width, b.upper + width, value) : 1;
  return rising * falling;
}

/**
 * 256 × RGBA8 paint table indexed by encoded luma code. Alpha is the weight: 255 for the
 * full-repaint scales (CineStop / Video / IRE: gaps are greyscale at the WAVE level), the
 * band mask for Limits (composited over the picture).
 */
export function falseColorTable(scale: FalseColorScale, transfer: MonitorTransfer, clipByte: number): Uint8Array {
  const bands = falseColorBands(scale, transfer, clipByte / 255, 256);
  const width = edgeSoftness(scale);
  const out = new Uint8Array(256 * 4);
  for (let code = 0; code < 256; code++) {
    const enc = code / 255;
    const level = monitorPercent(enc, transfer, clipByte);
    const value = usesSceneStops(scale) ? stopsFromEncoded(enc, transfer) : level;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 1;
    if (scale === 'limits') {
      let total = 0;
      for (const bd of bands) {
        const w = bandWeight(value, bd, width);
        r += bd.r * w;
        g += bd.g * w;
        b += bd.b * w;
        total += w;
      }
      if (total > 0) {
        r /= total;
        g /= total;
        b /= total;
      }
      a = Math.min(1, total);
    } else {
      const gray = Math.min(1, Math.max(0, level / 100));
      let total = 0;
      let pr = 0;
      let pg = 0;
      let pb = 0;
      for (const bd of bands) {
        const w = Number.isFinite(value) || value === -Infinity ? bandWeight(value, bd, width) : 0;
        pr += bd.r * w;
        pg += bd.g * w;
        pb += bd.b * w;
        total += w;
      }
      const norm = Math.max(1, total);
      const baseW = Math.max(0, 1 - total);
      r = (gray * baseW + pr) / norm;
      g = (gray * baseW + pg) / norm;
      b = (gray * baseW + pb) / norm;
    }
    out[code * 4] = Math.round(r * 255);
    out[code * 4 + 1] = Math.round(g * 255);
    out[code * 4 + 2] = Math.round(b * 255);
    out[code * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/** Encoded luma the table is indexed by (same weights as the scope sampler). */
export function falseColorLuma(r: number, g: number, b: number, transfer: MonitorTransfer) {
  const [wr, wg, wb] = lumaWeights(transfer);
  return wr * r + wg * g + wb * b;
}

// ───────────────────────────── Reference key ─────────────────────────────

export interface FalseColorReference {
  subtitle: string;
  segments: { lower: number; upper: number; r: number; g: number; b: number; label: string }[];
  markers: { label: string; fraction: number }[];
  axisLabels: string[];
}

export const FALSE_COLOR_LEGEND_LABELS: Record<FalseColorScale, string[]> = {
  sceneStops: [],
  stops: ['0–4', '5', '10–12', '41–48', '61–70', '92–93', '94–95', '96–98', '99–100'],
  ire: ['BDL', 'NBDL', '18%MG', 'MG+1', '80%WC', '95%WC'],
  limits: ['0–4', '5–9', '94–98', '99–100'],
};

/** Ruler values for the same bands the monitor paints (`MonitorFalseColorReferencePlan`). */
export function falseColorReference(mode: FalseColorMode, transfer: MonitorTransfer, clipByte: number, transferName: string): FalseColorReference {
  const scale = scaleForMode(mode);
  const ceiling = clipByte / 255;
  const measured = stopsFromEncoded(clipShelf(ceiling), transfer);
  const clipStops = Number.isFinite(measured) ? measured : SCENE_STOP_DEFAULT_CLIP;
  const lower = -8.5;
  const upper = Math.max(2.5, clipStops) + 1;
  const fraction = (v: number, fallback: number) => {
    if (!Number.isFinite(v)) return fallback;
    const c = usesSceneStops(scale) ? (v - lower) / (upper - lower) : v / 100;
    return Math.min(1, Math.max(0, c));
  };
  const segments = falseColorBands(scale, transfer, ceiling).map((b) => ({
    lower: fraction(b.lower, 0),
    upper: fraction(b.upper, 1),
    r: b.r,
    g: b.g,
    b: b.b,
    label: b.label,
  }));
  const markers: { label: string; fraction: number }[] = [];
  if (usesSceneStops(scale)) {
    for (let stop = -6; stop < clipStops - 1.5; stop += 2) {
      markers.push({ label: stop === 0 ? '18%' : stop < 0 ? `−${-stop}` : `+${stop}`, fraction: fraction(stop, 0) });
    }
    markers.push({ label: 'clip', fraction: fraction(clipStops, 1) });
  }
  return {
    subtitle: `${FALSE_COLOR_MODE_LABEL[mode]} · ${transferName}`,
    segments,
    markers,
    axisLabels: usesSceneStops(scale) ? [] : ['0', '25', '50', '75', '100'],
  };
}
