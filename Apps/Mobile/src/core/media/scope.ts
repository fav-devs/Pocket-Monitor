/**
 * Scope math: clip ceiling, anchored WAVE axis, traffic lights, sampling, histogram display and
 * the vectorscope raster. Port of OpenCine `ScopeMath`, `ScopeExposureCeiling`,
 * `DJIScopeExposureCeiling`, `WaveformIre`, `ScopeSampling` and `VectorscopeRaster`.
 */
import { encode, linearize, lumaWeights, middleGrayPaperIRE, paperIRE, type MonitorTransfer } from './transfer';

// ───────────────────────────── Clip ceiling ─────────────────────────────

export interface ScopeClipCalibration {
  referenceISO: number;
  referenceByte: number;
  refinementMaximumByte: number;
  noiseAllowance: number;
  refinementAtOrAboveReference: boolean;
}

/** DJI live-tap calibrations (SoftAP 1280×720 tap). D-Log2 247 @ 1600, D-Log 223 @ 400 and up. */
export const DJI_CLIP_CALIBRATIONS: Partial<Record<MonitorTransfer, ScopeClipCalibration>> = {
  dlog2: { referenceISO: 1600, referenceByte: 247, refinementMaximumByte: 248, noiseAllowance: 2, refinementAtOrAboveReference: false },
  dlog: { referenceISO: 400, referenceByte: 223, refinementMaximumByte: 224, noiseAllowance: 2, refinementAtOrAboveReference: true },
};

/** Table clip byte for a calibrated transfer at an ISO (below reference the code cannot saturate). */
export function calibratedClipByte(
  transfer: MonitorTransfer,
  iso: number | null | undefined,
  calibrations = DJI_CLIP_CALIBRATIONS,
  refinedByte?: number,
): number {
  const c = calibrations[transfer];
  if (!c) return 255;
  const ei = iso && iso > 0 ? iso : c.referenceISO;
  const reference = refinedByte ?? c.referenceByte;
  const refLinear = linearize(reference / 255, transfer);
  const linear = ei >= c.referenceISO ? refLinear : (refLinear * ei) / c.referenceISO;
  return Math.min(254, Math.max(1, Math.round(encode(linear, transfer) * 255)));
}

/**
 * Per-source ceiling state: ISO plus tap-max ratchet. One instance per picture source.
 * `observeTapMax` refines the reference at the reference ISO and lets the ceiling climb a couple
 * of codes of preview noise above the table, never to 255 (a full-range leak).
 */
export class ScopeExposureCeiling {
  private iso: number | null;
  private refined = new Map<MonitorTransfer, number>();
  private observed = new Map<string, number>();
  constructor(
    private calibrations = DJI_CLIP_CALIBRATIONS,
    defaultISO: number | null = 1600,
  ) {
    this.iso = defaultISO;
  }
  setISO(iso: number | null | undefined) {
    if (iso != null && iso >= 50 && iso <= 102400) this.iso = iso;
  }
  clipByte(transfer: MonitorTransfer, iso?: number | null): number {
    const ei = iso && iso > 0 ? iso : this.iso;
    const table = calibratedClipByte(transfer, ei, this.calibrations, this.refined.get(transfer));
    return Math.max(table, this.observed.get(`${transfer}:${ei}`) ?? 0);
  }
  observeTapMax(byte: number, transfer: MonitorTransfer): number {
    const c = this.calibrations[transfer];
    if (!c || byte <= 0 || byte >= 255) return this.clipByte(transfer);
    const ei = this.iso ?? c.referenceISO;
    const atReference = c.refinementAtOrAboveReference ? ei >= c.referenceISO : ei === c.referenceISO;
    const refined = this.refined.get(transfer) ?? c.referenceByte;
    if (atReference && byte > refined && byte <= c.refinementMaximumByte) this.refined.set(transfer, byte);
    const table = calibratedClipByte(transfer, ei, this.calibrations, this.refined.get(transfer));
    const key = `${transfer}:${this.iso}`;
    const prev = this.observed.get(key) ?? 0;
    const raised = Math.min(Math.max(prev, byte), Math.min(254, table + c.noiseAllowance));
    if (raised > table) this.observed.set(key, raised);
    return Math.max(table, this.observed.get(key) ?? 0);
  }
}

// ───────────────────────────── Anchors ─────────────────────────────

export const CLIP_SHELF_CODES = 7;
export const CRUSH_LEVEL = 0.05;
export const CLIP_LEVEL = 0.95;

export interface ScopeAnchors {
  black: number;
  mid: number;
  clip: number;
  midLevel: number;
  clipEdgeByte: number;
  clipFloorByte: number;
  crushFloorByte: number;
  crushEdgeByte: number;
}

const anchorCache = new Map<string, ScopeAnchors>();

export function scopeAnchors(transfer: MonitorTransfer, clipByte: number): ScopeAnchors {
  const key = `${transfer}:${clipByte}`;
  const hit = anchorCache.get(key);
  if (hit) return hit;
  const black = transfer === 'dlogm' ? 0 : encode(0, transfer);
  const mid = encode(0.18, transfer);
  const clip = clipByte / 255;
  const midLevel = CRUSH_LEVEL + (paperIRE(mid) / 100) * (CLIP_LEVEL - CRUSH_LEVEL);
  const span = Math.max(0, clip - black) * 255;
  const a: ScopeAnchors = {
    black,
    mid,
    clip,
    midLevel,
    clipEdgeByte: clipByte,
    clipFloorByte: Math.max(0, clipByte - CLIP_SHELF_CODES),
    crushFloorByte: Math.floor(black * 255),
    crushEdgeByte: Math.ceil(black * 255 + 0.02 * span),
  };
  anchorCache.set(key, a);
  return a;
}

/** First byte of the clip shelf (never below 1; D-Log2 247 → 240). */
export const clipShelfByte = (clipByte: number) => Math.max(1, clipByte - CLIP_SHELF_CODES);

// ───────────────────────────── Display scale ─────────────────────────────

function overshoot(v: number, clip: number) {
  const headroom = 1 - clip;
  if (headroom <= 0) return CLIP_LEVEL;
  return CLIP_LEVEL + ((v - clip) / headroom) * (1 - CLIP_LEVEL);
}

/** Plot level (0…1 of plot height) of a normalized tap code on the anchored axis. */
export function waveformLevel(c: number, a: ScopeAnchors): number {
  const v = Math.min(1, Math.max(0, c));
  if (v < a.black) return a.black <= 0 ? CRUSH_LEVEL : (v / a.black) * CRUSH_LEVEL;
  if (a.clip <= a.mid || a.mid <= a.black) {
    if (v <= a.clip) return CRUSH_LEVEL + ((v - a.black) / Math.max(a.clip - a.black, 1e-9)) * (CLIP_LEVEL - CRUSH_LEVEL);
    return overshoot(v, a.clip);
  }
  if (v <= a.mid) return CRUSH_LEVEL + ((v - a.black) / (a.mid - a.black)) * (a.midLevel - CRUSH_LEVEL);
  if (v <= a.clip) return a.midLevel + ((v - a.mid) / (a.clip - a.mid)) * (CLIP_LEVEL - a.midLevel);
  return overshoot(v, a.clip);
}

/** WAVE IRE 0…100 of a code: 0 paper black, grey at paper IRE, 100 the live ceiling. */
export function monitorPercent(c: number, transfer: MonitorTransfer, clipByte: number): number {
  const level = waveformLevel(c, scopeAnchors(transfer, clipByte));
  return Math.min(100, Math.max(0, ((level - CRUSH_LEVEL) / (CLIP_LEVEL - CRUSH_LEVEL)) * 100));
}

/** Code whose `monitorPercent` equals `percent`. */
export function signalNative(percent: number, transfer: MonitorTransfer, clipByte: number): number {
  const a = scopeAnchors(transfer, clipByte);
  const p = Math.min(100, Math.max(0, percent));
  if (p <= 0) return a.black;
  if (p >= 100) return a.clip;
  const target = CRUSH_LEVEL + (p / 100) * (CLIP_LEVEL - CRUSH_LEVEL);
  if (a.clip <= a.mid || a.mid <= a.black) return a.black + (p / 100) * (a.clip - a.black);
  if (target <= a.midLevel) {
    const t = (target - CRUSH_LEVEL) / Math.max(a.midLevel - CRUSH_LEVEL, 1e-9);
    return a.black + t * (a.mid - a.black);
  }
  const t = (target - a.midLevel) / Math.max(CLIP_LEVEL - a.midLevel, 1e-9);
  return a.mid + t * (a.clip - a.mid);
}

export const ZEBRA_HIGHLIGHT_CEILING_PERCENT = 100 + (100 * (1 - CLIP_LEVEL)) / (CLIP_LEVEL - CRUSH_LEVEL);

export function zebraHighlightSignal(percent: number, transfer: MonitorTransfer, clipByte: number): number {
  const a = scopeAnchors(transfer, clipByte);
  if (!(percent > 100) || a.clip >= 1) return signalNative(percent, transfer, clipByte);
  const p = Math.min(percent, ZEBRA_HIGHLIGHT_CEILING_PERCENT);
  const level = CRUSH_LEVEL + (p / 100) * (CLIP_LEVEL - CRUSH_LEVEL);
  return Math.min(1, a.clip + ((level - CLIP_LEVEL) / (1 - CLIP_LEVEL)) * (1 - a.clip));
}

/** Zebra highlight threshold code: never above the clip shelf at 100%, headroom above it. */
export function zebraHighlightNative(percent: number, transfer: MonitorTransfer, clipByte: number): number {
  if (percent > 100 && clipByte < 255) return zebraHighlightSignal(percent, transfer, clipByte);
  return Math.min(signalNative(percent, transfer, clipByte), clipShelfByte(clipByte) / 255);
}

/** Calibrated WAVE IRE (`WaveformIre.ire`). Byte-rounded paper black sits on 0. */
export function waveformIre(encoded: number, transfer: MonitorTransfer, clipByte: number): number {
  const a = scopeAnchors(transfer, clipByte);
  const blackByte = Math.round(a.black * 255);
  if (!Number.isFinite(encoded) || encoded * 255 <= blackByte) return 0;
  if (encoded >= a.clip) return 100;
  const midIRE = paperIRE(a.mid);
  if (a.mid <= a.black || a.clip <= a.mid) return ((encoded - a.black) / Math.max(a.clip - a.black, 1e-9)) * 100;
  if (encoded <= a.mid) return ((encoded - a.black) / (a.mid - a.black)) * midIRE;
  return midIRE + ((encoded - a.mid) / (a.clip - a.mid)) * (100 - midIRE);
}

/** One WAVE IRE value (0…100) per tap code, and the grey guide position. */
export interface ScopeLevelAxis {
  table: Float32Array;
  middleGrayIRE: number;
  supportsCalibratedReferences: boolean;
}

const axisCache = new Map<string, ScopeLevelAxis>();

export function scopeLevelAxis(transfer: MonitorTransfer, clipByte: number): ScopeLevelAxis {
  const key = `${transfer}:${clipByte}`;
  const hit = axisCache.get(key);
  if (hit) return hit;
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) table[i] = waveformIre(i / 255, transfer, clipByte);
  const axis = { table, middleGrayIRE: middleGrayPaperIRE(transfer), supportsCalibratedReferences: true };
  axisCache.set(key, axis);
  return axis;
}

/** Native-code histogram counts onto the WAVE axis buckets. Conserves total count. */
export function remapHistogram(bins: ArrayLike<number>, axis: ScopeLevelAxis): Float32Array {
  const out = new Float32Array(256);
  for (let code = 0; code < Math.min(bins.length, 256); code++) {
    const n = bins[code];
    if (!n) continue;
    const bucket = Math.round((axis.table[code] / 100) * 255);
    out[Math.min(255, Math.max(0, bucket))] += n;
  }
  return out;
}

// ───────────────────────────── Traffic lights ─────────────────────────────

export interface ScopeChannelLight {
  clip: boolean;
  crush: boolean;
  /** Histogram median on the anchored axis, re-centred so 18% grey reads 0.5. */
  level: number;
}

export interface TrafficLightsReading {
  red: ScopeChannelLight;
  green: ScopeChannelLight;
  blue: ScopeChannelLight;
}

const neutralLight: ScopeChannelLight = { clip: false, crush: false, level: 0.5 };
export const TRAFFIC_NONE: TrafficLightsReading = { red: neutralLight, green: neutralLight, blue: neutralLight };
export const TRAFFIC_HOLD_RATIO = 0.5;
export const TRAFFIC_DEAD_ZONE = 0.03;

export function edgeEnergy(bins: ArrayLike<number>, from: number, to: number): number {
  if (bins.length < 256 || from > to || from < 0 || to > 255) return 0;
  let total = 0;
  let band = 0;
  for (let c = 0; c < 256; c++) {
    total += bins[c];
    if (c >= from && c <= to) band += bins[c];
  }
  return total > 0 ? band / total : 0;
}

export function latched(now: boolean, was: boolean, energy: number, threshold: number) {
  if (now) return true;
  if (!was) return false;
  return energy > threshold * TRAFFIC_HOLD_RATIO;
}

export function balance(level: number, midLevel: number) {
  if (level <= midLevel) return midLevel > 0 ? (0.5 * level) / midLevel : 0.5;
  const span = 1 - midLevel;
  return span > 0 ? 0.5 + (0.5 * (level - midLevel)) / span : 0.5;
}

export function trafficLights(
  hist: { red: ArrayLike<number>; green: ArrayLike<number>; blue: ArrayLike<number>; luma?: ArrayLike<number> },
  transfer: MonitorTransfer,
  clipByte: number,
  threshold = 0,
  previous?: TrafficLightsReading,
): TrafficLightsReading {
  const a = scopeAnchors(transfer, clipByte);
  const rc = edgeEnergy(hist.red, a.clipFloorByte, 255);
  const gc = edgeEnergy(hist.green, a.clipFloorByte, 255);
  const bc = edgeEnergy(hist.blue, a.clipFloorByte, 255);
  const lc = hist.luma ? edgeEnergy(hist.luma, a.clipFloorByte, 255) : 0;
  const pictureClip = lc > threshold || rc > threshold || gc > threshold || bc > threshold;
  const pictureEnergy = Math.max(lc, rc, gc, bc);
  const channel = (bins: ArrayLike<number>, own: number, prev?: ScopeChannelLight): ScopeChannelLight => {
    if (bins.length < 256) return neutralLight;
    let total = 0;
    for (let i = 0; i < 256; i++) total += bins[i];
    if (total <= 0) return neutralLight;
    let crushed = 0;
    for (let c = a.crushFloorByte; c <= a.crushEdgeByte; c++) crushed += bins[c];
    const crushEnergy = crushed / total;
    let seen = 0;
    let median = 0;
    const half = Math.floor((total + 1) / 2);
    for (let c = 0; c < 256; c++) {
      seen += bins[c];
      if (seen >= half) {
        median = c;
        break;
      }
    }
    const clip = latched(own > threshold || pictureClip, prev?.clip ?? false, Math.max(own, pictureEnergy), threshold);
    const crush = latched(crushEnergy > threshold, prev?.crush ?? false, crushEnergy, threshold);
    return { clip, crush, level: balance(waveformLevel(median / 255, a), a.midLevel) };
  };
  return {
    red: channel(hist.red, rc, previous?.red),
    green: channel(hist.green, gc, previous?.green),
    blue: channel(hist.blue, bc, previous?.blue),
  };
}

/** Goal-post bar side and fill for one channel. */
export function trafficChannelDisplay(level: number, center = 0.5, deadZone = TRAFFIC_DEAD_ZONE) {
  const d = level - center;
  if (Math.abs(d) <= deadZone) return { side: 'neutral' as const, fill: 0 };
  if (d > 0) return { side: 'over' as const, fill: Math.min(1, d / Math.max(1 - center, 1e-9)) };
  return { side: 'under' as const, fill: Math.min(1, Math.abs(d) / Math.max(center, 1e-9)) };
}

// ───────────────────────────── Sampling ─────────────────────────────

export interface ScopeSamples {
  histLuma: Uint32Array;
  histRed: Uint32Array;
  histGreen: Uint32Array;
  histBlue: Uint32Array;
  /** Interleaved per point: x ratio (0..1), r, g, b, luma. */
  count: number;
  xRatio: Float32Array;
  yRatio: Float32Array;
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  luma: Uint8Array;
  /** Largest luma code in the tap (for the ceiling ratchet). */
  maxByte: number;
}

/** One RGBA buffer walk: 256-bin native-code histograms plus a strided point cloud. */
export function sampleRGBA(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  transfer: MonitorTransfer,
  stride = 2,
): ScopeSamples {
  const cols = Math.ceil(width / stride);
  const rows = Math.ceil(height / stride);
  const n = Math.max(0, cols * rows);
  const s: ScopeSamples = {
    histLuma: new Uint32Array(256),
    histRed: new Uint32Array(256),
    histGreen: new Uint32Array(256),
    histBlue: new Uint32Array(256),
    count: 0,
    xRatio: new Float32Array(n),
    yRatio: new Float32Array(n),
    r: new Uint8Array(n),
    g: new Uint8Array(n),
    b: new Uint8Array(n),
    luma: new Uint8Array(n),
    maxByte: 0,
  };
  const [wr, wg, wb] = lumaWeights(transfer);
  let k = 0;
  for (let y = 0; y < height; y += stride) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += stride) {
      const i = row + x * 4;
      if (i + 2 >= rgba.length) break;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const l = Math.min(255, Math.max(0, Math.round(wr * r + wg * g + wb * b)));
      s.histLuma[l]++;
      s.histRed[r]++;
      s.histGreen[g]++;
      s.histBlue[b]++;
      if (l > s.maxByte) s.maxByte = l;
      s.xRatio[k] = x / Math.max(width, 1);
      s.yRatio[k] = y / Math.max(height, 1);
      s.r[k] = r;
      s.g[k] = g;
      s.b[k] = b;
      s.luma[k] = l;
      k++;
    }
  }
  s.count = k;
  return s;
}

export interface HistogramDisplay {
  luma: Float32Array;
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
}

export function boxBlur(values: Float32Array, radius: number): Float32Array {
  if (radius <= 0 || values.length <= 1) return values;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length - 1, i + radius);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

/** Remap onto the WAVE axis, blend 0.65 / 0.35 with the previous tick, box blur r = 2. */
export function histogramDisplayChannel(native: ArrayLike<number>, previous: Float32Array | null, axis: ScopeLevelAxis) {
  const remapped = remapHistogram(native, axis);
  if (previous && previous.length === 256) for (let i = 0; i < 256; i++) remapped[i] = 0.65 * remapped[i] + 0.35 * previous[i];
  return boxBlur(remapped, 2);
}

export function histogramDisplay(s: ScopeSamples, previous: HistogramDisplay | null, axis: ScopeLevelAxis): HistogramDisplay {
  return {
    luma: histogramDisplayChannel(s.histLuma, previous?.luma ?? null, axis),
    red: histogramDisplayChannel(s.histRed, previous?.red ?? null, axis),
    green: histogramDisplayChannel(s.histGreen, previous?.green ?? null, axis),
    blue: histogramDisplayChannel(s.histBlue, previous?.blue ?? null, axis),
  };
}

/** Median luma in stops vs 18% grey (ND / EV meters). Null when empty. */
export function pictureStops(lumaHistogram: ArrayLike<number>, transfer: MonitorTransfer): number | null {
  let total = 0;
  for (let i = 0; i < lumaHistogram.length; i++) total += lumaHistogram[i];
  if (total <= 0) return null;
  const half = Math.floor((total + 1) / 2);
  let seen = 0;
  for (let c = 0; c < Math.min(256, lumaHistogram.length); c++) {
    seen += lumaHistogram[c];
    if (seen >= half) {
      const lin = linearize(c / 255, transfer);
      const s = lin > 0 ? Math.log2(lin / 0.18) : -Infinity;
      return Number.isFinite(s) ? s : null;
    }
  }
  return null;
}

// ───────────────────────────── Vectorscope ─────────────────────────────

export function chroma709(r: number, g: number, b: number): [number, number] {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [(b - y) / 1.8556, (r - y) / 1.5748];
}

/** Neutrals become white; saturated bins keep hue at full ramp brightness. */
export function traceTint(r: number, g: number, b: number): [number, number, number] {
  const low = Math.min(r, g, b);
  const high = Math.max(r, g, b);
  const span = high - low;
  if (high <= 0.000001 || span <= 0.000001) return [1, 1, 1];
  const sat = Math.min(1, Math.max(0, span / high));
  const tint = (c: number) => 1 - sat + ((c - low) / span) * sat;
  return [tint(r), tint(g), tint(b)];
}

export const VECTOR_BINS = 128;

export function vectorBin(r: number, g: number, b: number, gain = 1): [number, number] | null {
  const [cb, cr] = chroma709(r / 255, g / 255, b / 255);
  const x = cb * gain + 0.5;
  const y = cr * gain + 0.5;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  const s = VECTOR_BINS - 1;
  return [Math.round(x * s), Math.round(y * s)];
}

/**
 * Premultiplied RGBA8 (128²), logarithmic density alpha `(0.4 + 0.6·density) × intensity`,
 * `traceTint` colour, +Cr up. Null when nothing lands.
 */
export function vectorscopeRaster(
  pts: { count: number; r: ArrayLike<number>; g: ArrayLike<number>; b: ArrayLike<number> },
  gain: number,
  intensity: number,
): Uint8ClampedArray | null {
  const n = VECTOR_BINS;
  const counts = new Uint32Array(n * n);
  const sr = new Uint32Array(n * n);
  const sg = new Uint32Array(n * n);
  const sb = new Uint32Array(n * n);
  for (let i = 0; i < pts.count; i++) {
    const bin = vectorBin(pts.r[i], pts.g[i], pts.b[i], gain);
    if (!bin) continue;
    const idx = bin[1] * n + bin[0];
    counts[idx]++;
    sr[idx] += pts.r[i];
    sg[idx] += pts.g[i];
    sb[idx] += pts.b[i];
  }
  let peak = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i] > peak) peak = counts[i];
  if (peak === 0) return null;
  const logPeak = Math.log(1 + peak);
  const px = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const c = counts[i];
    if (!c) continue;
    const density = Math.log(1 + c) / logPeak;
    const alpha = Math.min(1, Math.max(0, (0.4 + 0.6 * density) * intensity));
    const t = traceTint(sr[i] / (c * 255), sg[i] / (c * 255), sb[i] / (c * 255));
    const row = n - 1 - Math.floor(i / n);
    const col = i % n;
    const o = (row * n + col) * 4;
    px[o] = 255 * t[0] * alpha;
    px[o + 1] = 255 * t[1] * alpha;
    px[o + 2] = 255 * t[2] * alpha;
    px[o + 3] = 255 * alpha;
  }
  return px;
}

/** Graticule targets (75% bars) and the skin-tone line. */
export const VECTOR_TARGETS: { label: string; r: number; g: number; b: number }[] = [
  { label: 'R', r: 191, g: 0, b: 0 },
  { label: 'Mg', r: 191, g: 0, b: 191 },
  { label: 'B', r: 0, g: 0, b: 191 },
  { label: 'Cy', r: 0, g: 191, b: 191 },
  { label: 'G', r: 0, g: 191, b: 0 },
  { label: 'Yl', r: 191, g: 191, b: 0 },
];
export const VECTOR_SKIN_ANGLE_DEG = 123;
export const VECTOR_SKIN_LENGTH = 0.92;

/** Target centre as a fraction of the square (0..1, y down). */
export function vectorTargetPoint(r: number, g: number, b: number): [number, number] {
  const [cb, cr] = chroma709(r / 255, g / 255, b / 255);
  return [0.5 + cb, 0.5 - cr];
}

// ───────────────────────────── Scope options ─────────────────────────────

export const scopeIntensity = {
  /** WAVE / PARADE: 100% brightness = former 25%. */
  trace: (brightness: number) => Math.min(Math.max(brightness, 0), 200) / 400,
  vector: (brightness: number) => Math.min(Math.max(brightness, 0), 200) / 100,
};

/** Solid 0 / 100, dotted 5 / 95 safe borders, grey at paper IRE. */
export function waveformGuideStrokes(clip: boolean, crush: boolean, middle: boolean, middleGrayIRE: number) {
  const strokes: { ire: number; dashed: boolean; crushClipColor: boolean }[] = [
    { ire: 0, dashed: false, crushClipColor: false },
    { ire: 100, dashed: false, crushClipColor: false },
  ];
  if (crush) strokes.push({ ire: 5, dashed: true, crushClipColor: true });
  if (clip) strokes.push({ ire: 95, dashed: true, crushClipColor: true });
  if (middle) strokes.push({ ire: middleGrayIRE, dashed: false, crushClipColor: false });
  return strokes;
}
