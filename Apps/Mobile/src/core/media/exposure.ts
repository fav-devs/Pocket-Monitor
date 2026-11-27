/**
 * Exposure readouts: EV label, LUT input exposure, ND suggestion and the picture EV meter.
 * Port of OpenCine `ExposureCompensation`, `LUTExposureCompensation`,
 * `MonitorNDFilterRecommendation`.
 */
import { pictureStops } from './scope';
import { encode, linearize, type MonitorTransfer } from './transfer';
import type { NDNotation } from './assistOptions';

export const MINUS = '−';

/** `0.0`, `+0.3`, `−0.7` (U+2212), one decimal like C `%.1f`. */
export function evLabel(stops: number): string {
  const magnitude = Math.abs(stops).toFixed(1);
  if (magnitude === '0.0') return magnitude;
  return (stops < 0 ? MINUS : '+') + magnitude;
}

// ───────────────────────────── LUT input exposure ─────────────────────────────

export const LUT_EXPOSURE = { min: -3, max: 3, step: 0.5 };

export function snapLutExposure(stops: number): number {
  if (!Number.isFinite(stops)) return 0;
  const c = Math.min(Math.max(stops, LUT_EXPOSURE.min), LUT_EXPOSURE.max);
  const s = Math.round(c / LUT_EXPOSURE.step) * LUT_EXPOSURE.step;
  return Math.abs(s) < 0.0001 ? 0 : s;
}

/** Encoded code after an exposure gain in the transfer's linear light. */
export function compensateEncoded(encoded: number, stops: number, transfer: MonitorTransfer): number {
  const v = snapLutExposure(stops);
  if (v === 0) return Math.min(Math.max(encoded, 0), 1);
  return encode(linearize(encoded, transfer) * Math.pow(2, v), transfer);
}

// ───────────────────────────── ND ─────────────────────────────

export const ND_OPTICAL_FACTORS = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1000];
export const ND_DENSITY_PER_STOP = 0.3;

export interface NDSuggestion {
  pictureStops: number;
  ndStops: number;
  opticalFactor: number;
  ndLabel: string;
  stopsLabel: string;
  needsGlass: boolean;
}

export function opticalFactor(stops: number) {
  if (stops < 1) return 1;
  return ND_OPTICAL_FACTORS[Math.min(Math.max(stops, 1), 10) - 1];
}

export function ndDensityLabel(stops: number, none = '—') {
  if (!Number.isFinite(stops)) return none;
  const d = stops * ND_DENSITY_PER_STOP;
  if (Math.abs(d) < 0.05) return 'ND 0.0';
  return `ND ${d > 0 ? '' : MINUS}${Math.abs(d).toFixed(1)}`;
}

/** Map measured picture stops onto glass. Under half a stop is no ND. */
export function ndSuggestion(picture: number, none = '—'): NDSuggestion | null {
  if (!Number.isFinite(picture)) return null;
  const ndStops = picture >= 0.5 ? Math.min(Math.max(Math.floor(Math.min(10, picture + 0.5)), 1), 10) : 0;
  return {
    pictureStops: picture,
    ndStops,
    opticalFactor: opticalFactor(ndStops),
    ndLabel: ndStops >= 1 ? `ND${opticalFactor(ndStops)}` : none,
    stopsLabel: evLabel(picture),
    needsGlass: ndStops >= 1,
  };
}

export function ndReading(lumaHistogram: ArrayLike<number>, transfer: MonitorTransfer, none = '—'): NDSuggestion | null {
  const p = pictureStops(lumaHistogram, transfer);
  return p == null ? null : ndSuggestion(p, none);
}

export function ndChipLabel(s: NDSuggestion | null, notation: NDNotation, none = '—'): string {
  if (!s) return none;
  switch (notation) {
    case 'stops':
      return s.stopsLabel;
    case 'factor':
      return s.ndLabel;
    case 'density':
      return ndDensityLabel(s.pictureStops, none);
  }
}

// ───────────────────────────── EV meter ─────────────────────────────

/** EV meter span: the strip reads −3 … +3 around middle grey. */
export const EV_METER_SPAN = 3;

/** Position (0 top … 1 bottom) of an EV value on the meter strip. */
export function evMeterFraction(ev: number): number {
  const c = Math.min(EV_METER_SPAN, Math.max(-EV_METER_SPAN, ev));
  return 0.5 - c / (2 * EV_METER_SPAN);
}

/**
 * The value the EV meter shows: the camera's metered offset when it reports one, else the
 * picture's median luma in stops vs 18% grey.
 */
export function evMeterValue(cameraMeteredEv: number | null | undefined, lumaHistogram: ArrayLike<number> | null, transfer: MonitorTransfer): number | null {
  if (cameraMeteredEv != null && Number.isFinite(cameraMeteredEv)) return cameraMeteredEv;
  if (!lumaHistogram) return null;
  return pictureStops(lumaHistogram, transfer);
}
