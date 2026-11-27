/**
 * Persisted option vocabularies shared by the assists (OpenCine `MonitorAssistOptions.swift`,
 * `MonitorScopeValues.swift`, `ZebraAssist`, `FocusAssist`). Raw values are stored: never rename.
 */
import { CLIP_LEVEL, CRUSH_LEVEL, signalNative, zebraHighlightNative } from './scope';
import type { MonitorTransfer } from './transfer';

export type Rgb = [number, number, number];

// ───────────────────────────── Peaking ─────────────────────────────

export type PeakingColor = 'White' | 'Blue' | 'Red' | 'Green';
export const PEAKING_COLORS: PeakingColor[] = ['White', 'Blue', 'Red', 'Green'];
export const PEAKING_RGB: Record<PeakingColor, Rgb> = {
  White: [246 / 255, 241 / 255, 226 / 255],
  Blue: [64 / 255, 142 / 255, 1],
  Red: [1, 72 / 255, 64 / 255],
  Green: [74 / 255, 220 / 255, 132 / 255],
};

export type PeakingSense = 'Low' | 'Med' | 'High';
export const PEAKING_SENSES: PeakingSense[] = ['Low', 'Med', 'High'];
export const PEAKING_RATIO_THRESHOLD: Record<PeakingSense, number> = { Low: 2.3, Med: 2.1, High: 1.9 };
export const PEAKING_NOISE_GATE: Record<PeakingSense, number> = { Low: 0.00522, Med: 0.00174, High: 0.00058 };

// ───────────────────────────── Zebra ─────────────────────────────

export type ZebraPaint = 'White' | 'Amber' | 'Red' | 'Cyan' | 'Green';
export const ZEBRA_RGB: Record<ZebraPaint, Rgb> = {
  White: [1, 1, 1],
  Amber: [1, 0.72, 0.2],
  Red: [1, 0.15, 0.15],
  Cyan: [0, 0.85, 0.9],
  Green: [0.2, 0.9, 0.35],
};
export const ZEBRA_HIGHLIGHT_PALETTE: ZebraPaint[] = ['White', 'Amber', 'Red'];
export const ZEBRA_MIDTONE_PALETTE: ZebraPaint[] = ['Amber', 'Cyan', 'Green'];
export type ZebraUnit = 'Native' | 'IRE';
/** Highlight 99: one IRE under the live ceiling so the D-Log2 243–247 shelf paints. */
export const ZEBRA_HIGHLIGHT_IRE = 99;
export const ZEBRA_MIDTONE_IRE = 55;
export const ZEBRA_MIDTONE_HALF_WIDTH_IRE = 5;
/** `CIStripesGenerator` width 5 at 45°. */
export const ZEBRA_STRIPE_WIDTH = 5;

/** Operator-facing threshold in the chosen unit. */
export function zebraDisplayValue(ire: number, unit: ZebraUnit, transfer: MonitorTransfer, clipByte: number): number {
  if (unit === 'IRE') return Math.round(ire);
  return Math.round(signalNative(ire, transfer, clipByte) * 255);
}

/** Inverse of `zebraDisplayValue`: a 0-255 code back onto the monitor IRE axis. */
export function zebraIreFromDisplay(value: number, unit: ZebraUnit, transfer: MonitorTransfer, clipByte: number): number {
  if (unit === 'IRE') return Math.min(100, Math.max(0, value));
  // Bisection on the monotone signalNative.
  const target = Math.min(255, Math.max(0, value)) / 255;
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (signalNative(mid, transfer, clipByte) < target) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 10) / 10;
}

export interface ZebraCodeThresholds {
  /** Highlight starts at this encoded code (maxRGB ≥). Null = zone off. */
  highlight: number | null;
  midtoneLower: number | null;
  midtoneUpper: number | null;
}

export function zebraCodeThresholds(
  o: { highlight: boolean; highlightIRE: number; midtone: boolean; midtoneIRE: number },
  transfer: MonitorTransfer,
  clipByte: number,
): ZebraCodeThresholds {
  const half = ZEBRA_MIDTONE_HALF_WIDTH_IRE;
  return {
    highlight: o.highlight ? zebraHighlightNative(o.highlightIRE, transfer, clipByte) : null,
    midtoneLower: o.midtone ? signalNative(o.midtoneIRE - half, transfer, clipByte) : null,
    midtoneUpper: o.midtone ? signalNative(o.midtoneIRE + half, transfer, clipByte) : null,
  };
}

/** `(x+y) mod 14 < 7` style 45° stripe test at a screen pixel, phase-stable at frame edges. */
export function zebraStripeOn(x: number, y: number, width = ZEBRA_STRIPE_WIDTH): boolean {
  const period = width * 2;
  const v = (((x + y) % period) + period) % period;
  return v < width;
}

// ───────────────────────────── Traffic lights compensation ─────────────────────────────

export type CrushClipCompensation = 0 | 2 | 5 | 7 | 10;
export const CRUSH_CLIP_OPTIONS: { value: CrushClipCompensation; label: string; glyph: string; stops: number }[] = [
  { value: 0, label: '0', glyph: '0', stops: 0 },
  { value: 2, label: '0.25', glyph: '¼', stops: 0.25 },
  { value: 5, label: '0.5', glyph: '½', stops: 0.5 },
  { value: 7, label: '0.75', glyph: '¾', stops: 0.75 },
  { value: 10, label: '1.0', glyph: '1', stops: 1 },
];
export const crushClipThreshold = (c: CrushClipCompensation) =>
  (CRUSH_CLIP_OPTIONS.find((o) => o.value === c)?.stops ?? 0) / 10;

// ───────────────────────────── Scopes ─────────────────────────────

export type WaveformMode = 'Luma' | 'RGB';
export type ParadeMode = 'RGB' | 'YRGB';
export type VectorscopeZoom = '1x' | '2x' | '4x';
export const VECTOR_GAIN: Record<VectorscopeZoom, number> = { '1x': 1, '2x': 2, '4x': 4 };
export interface ScopeGuides {
  clip: boolean;
  crush: boolean;
  middle: boolean;
}
export const SCOPE_SCALE_RANGE: [number, number] = [0.6, 1.6];
export const clampScopeScale = (v: number) => Math.min(SCOPE_SCALE_RANGE[1], Math.max(SCOPE_SCALE_RANGE[0], v));
/** Initial scale before the operator resizes (`MonitorScopeSizing`). */
export const defaultScopeScale = (portrait: boolean, tablet: boolean) => (tablet ? (portrait ? 0.8 : 1) : portrait ? 0.6 : 0.8);

export const SCOPE_BASE_SIZE = {
  waveform: { width: 250, height: 153 },
  parade: { width: 250, height: 153 },
  histogram: { width: 250, height: 77 },
  vectorscope: { width: 190, height: 190 },
  trafficLights: { width: 74, height: 168 },
  ndMeter: { width: 84, height: 30 },
  audio: { width: 28, height: 168 },
} as const;

/** Level of a 0…100 scale value on the legacy 5/95 axis. */
export const scaleLevel = (ire: number) => CRUSH_LEVEL + (ire / 100) * (CLIP_LEVEL - CRUSH_LEVEL);

// ───────────────────────────── Desqueeze / mirror ─────────────────────────────

export const DESQUEEZE_PRESETS = [1.1, 1.2, 1.33, 1.5, 1.6, 1.8, 2];
export const snapDesqueeze = (v: number) => {
  const f = Number.isFinite(v) ? v : 1.33;
  return Math.round(Math.min(2, Math.max(1, f)) * 100 + 1e-7) / 100;
};
export const desqueezeLabel = (v: number) => `${snapDesqueeze(v).toFixed(2)}×`;
export type DesqueezeDirection = 'horizontal' | 'vertical';
/** Display aspect after desqueeze. */
export function desqueezedAspect(sourceAspect: number, factor: number, direction: DesqueezeDirection) {
  const c = snapDesqueeze(factor);
  return direction === 'horizontal' ? sourceAspect * c : sourceAspect / c;
}

// ───────────────────────────── ND ─────────────────────────────

export type NDNotation = 'stops' | 'factor' | 'density';
export const ND_NOTATION_LABEL: Record<NDNotation, string> = { stops: 'Stops', factor: 'ND32', density: 'ND 0.3' };

// ───────────────────────────── Audio ─────────────────────────────

export type AudioOrientation = 'Vertical' | 'Horizontal';
