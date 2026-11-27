/**
 * Transfer curves and log → display transforms. Port of OpenCine `TransferCurves.swift`,
 * `MonitorSceneToneMap.swift`, `MonitorLogDisplayTransform.swift` and the D-Gamut matrices in
 * OpenPocketViewCore `LiveColorScience.swift`. Math only: no DJI `.cube` data lives here.
 *
 * Everything speaks **curve fractions** (`byte / 255` on the tap axis).
 */

export type MonitorTransfer = 'rec709' | 'hdr' | 'dlog' | 'dlog2' | 'dlogm';

export const MONITOR_TRANSFERS: MonitorTransfer[] = ['rec709', 'hdr', 'dlog', 'dlog2', 'dlogm'];

export function transferLabel(t: MonitorTransfer): string {
  switch (t) {
    case 'rec709':
      return 'Rec.709';
    case 'hdr':
      return 'HLG';
    case 'dlog':
      return 'D-Log';
    case 'dlog2':
      return 'D-Log2';
    case 'dlogm':
      return 'D-Log M';
  }
}

/** Camera colour mode (camera contract strings) → monitor transfer. `10bit` reads as Rec.709. */
export function transferForColorMode(mode: string | null | undefined): MonitorTransfer {
  switch (mode) {
    case 'hlg':
      return 'hdr';
    case 'dlog-m':
      return 'dlogm';
    case 'dlog':
      return 'dlog';
    case 'dlog2':
      return 'dlog2';
    default:
      return 'rec709';
  }
}

/** PictureEffects `sourceColor` spelling of a transfer. */
export type SourceColor = 'rec709' | 'hlg' | 'dlog-m' | 'dlog' | 'dlog2';

export function sourceColorForTransfer(t: MonitorTransfer): SourceColor {
  switch (t) {
    case 'hdr':
      return 'hlg';
    case 'dlogm':
      return 'dlog-m';
    case 'dlog':
      return 'dlog';
    case 'dlog2':
      return 'dlog2';
    default:
      return 'rec709';
  }
}

export function transferForSourceColor(s: SourceColor): MonitorTransfer {
  return transferForColorMode(s);
}

export const isLogTransfer = (t: MonitorTransfer) => t === 'dlog' || t === 'dlog2' || t === 'dlogm';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x: number) => clamp(x, 0, 1);

// ───────────────────────────── Curves ─────────────────────────────

/** ITU-R BT.709-6 inverse OETF / OETF. */
const Rec709 = {
  decode(e: number) {
    return e < 0.081 ? e / 4.5 : Math.pow((e + 0.099) / 1.099, 1 / 0.45);
  },
  encode(linear: number) {
    const l = Math.min(1, linear);
    return l < 0.018 ? 4.5 * l : 1.099 * Math.pow(l, 0.45) - 0.099;
  },
};

/** ITU-R BT.2100 HLG, scene reflectance with 1.0 = diffuse white (BT.2408 75% signal). */
const HLG = (() => {
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  const oetf = (scene: number) => (scene <= 1 / 12 ? Math.sqrt(3 * scene) : a * Math.log(12 * scene - b) + c);
  const inverseOETF = (e: number) => (e <= 0.5 ? (e * e) / 3 : (Math.exp((e - c) / a) + b) / 12);
  const diffuseWhite = inverseOETF(0.75);
  return {
    decode: (e: number) => inverseOETF(clamp01(e)) / diffuseWhite,
    encode: (linear: number) => oetf(clamp01(linear * diffuseWhite)),
  };
})();

/** DJI D-Log (2017 white paper). 0% → 0.0929, 18% → 408/1023, peak 4200%. */
const DLog = {
  peakLinear: 42,
  decode(e: number) {
    if (e <= 0.14) return (e - 0.0929) / 6.025;
    return (Math.pow(10, 3.89616 * e - 2.27752) - 0.0108) / 0.9892;
  },
  encode(linear: number) {
    if (linear <= 0.0078) return 6.025 * linear + 0.0929;
    return Math.log10(linear * 0.9892 + 0.0108) * 0.256663 + 0.584555;
  },
};

/**
 * D-Log M: empirical Pocket 3 neutral-channel fit (OpenPocketCine docs/pocket3-dlogm-curve.md).
 * An estimate for scene-stop tools, not a DJI specification.
 */
const DLogM = {
  decode(e: number) {
    const t = Math.pow(2, e * 5.612990379333496 + 0.9327186346054077) - 2.428226947784424;
    const value = t < 0.6034245491027832 ? t * 1.0151796340942383 + 0.5178895592689514 : t * 1.8734303712844849;
    return value * (0.18 / 12.4054);
  },
  encode(linear: number) {
    const value = linear / (0.18 / 12.4054);
    const t =
      value < 0.6034245491027832 * 1.8734303712844849
        ? (value - 0.5178895592689514) / 1.0151796340942383
        : value / 1.8734303712844849;
    return (Math.log2(t + 2.428226947784424) - 0.9327186346054077) / 5.612990379333496;
  },
};

/** D-Log2 (Gamut white paper Rev 1.0). 0 → 0.062561; 18% → 0.304985; 475 → 1.0. */
const DLog2 = (() => {
  const peakLinear = 475;
  const a = 16.285770761945304;
  const k1 = 0.059439938321493;
  const b1 = 0.304985337243402;
  const k2 = 2.96093524549225;
  const b2 = 0.148314799066323;
  const inLimit1 = 0.18;
  const inLimit2 = 0.028961695254132;
  return {
    peakLinear,
    decode(e: number) {
      if (e >= b1) return (peakLinear / (Math.pow(2, a) - 1)) * (Math.pow(2, a * e) - 1);
      if (e >= b2) return Math.pow(2, (e - b1) / k1 + Math.log2(inLimit1));
      return (e - b2) / k2 + inLimit2;
    },
    encode(linear: number) {
      if (linear >= inLimit1) return (1 / a) * Math.log2((linear * (Math.pow(2, a) - 1)) / peakLinear + 1);
      if (linear >= inLimit2) return k1 * (Math.log2(Math.max(linear, 1e-15)) - Math.log2(inLimit1)) + b1;
      return k2 * (linear - inLimit2) + b2;
    },
  };
})();

/** Raw curve decode (no clamping of the result). Used by display transforms. */
export function decodeRaw(encoded: number, t: MonitorTransfer): number {
  switch (t) {
    case 'rec709':
      return Rec709.decode(encoded);
    case 'hdr':
      return HLG.decode(encoded);
    case 'dlog':
      return DLog.decode(encoded);
    case 'dlog2':
      return DLog2.decode(encoded);
    case 'dlogm':
      return DLogM.decode(encoded);
  }
}

function encodeRaw(linear: number, t: MonitorTransfer): number {
  switch (t) {
    case 'rec709':
      return Rec709.encode(linear);
    case 'hdr':
      return HLG.encode(linear);
    case 'dlog':
      return DLog.encode(linear);
    case 'dlog2':
      return DLog2.encode(linear);
    case 'dlogm':
      return DLogM.encode(linear);
  }
}

/** Scene-linear reflectance from a normalized encoded channel. Below a log toe clamps to 0. */
export function linearize(encoded: number, t: MonitorTransfer): number {
  const linear = decodeRaw(clamp01(encoded), t);
  if (!Number.isFinite(linear)) return 0;
  return Math.max(0, linear);
}

/** Normalized encoded code from scene-linear reflectance, clamped to 0…1. */
export function encode(linear: number, t: MonitorTransfer): number {
  const e = encodeRaw(Math.max(0, linear), t);
  if (!Number.isFinite(e)) return 0;
  return clamp01(e);
}

export function peakLinear(t: MonitorTransfer): number {
  switch (t) {
    case 'rec709':
      return 1;
    case 'dlog':
      return DLog.peakLinear;
    case 'dlog2':
      return DLog2.peakLinear;
    default:
      return decodeRaw(1, t);
  }
}

/** Encoded-domain luma weights (BT.709 for Rec.709 / D-Log / D-Log M; BT.2020 for HLG / D-Log2). */
export function lumaWeights(t: MonitorTransfer): [number, number, number] {
  switch (t) {
    case 'hdr':
    case 'dlog2':
      return [0.2627, 0.678, 0.0593];
    default:
      return [0.2126, 0.7152, 0.0722];
  }
}

/** Published paper IRE: encoded × 100. */
export const paperIRE = (encoded: number) => encoded * 100;

export function middleGrayEncoded(t: MonitorTransfer): number {
  return encode(0.18, t);
}

export function middleGrayPaperIRE(t: MonitorTransfer): number {
  return paperIRE(middleGrayEncoded(t));
}

/** Stops relative to 18% grey. Zero light is −∞, never NaN. */
export function stopsFromLinear(linear: number): number {
  const y = Math.max(0, linear);
  if (!(y > 0) || !Number.isFinite(y)) return -Infinity;
  return Math.log2(y / 0.18);
}

export function stopsFromEncoded(encoded: number, t: MonitorTransfer): number {
  return stopsFromLinear(linearize(encoded, t));
}

// ───────────────────────────── Gamut ─────────────────────────────

/** Row-major 3×3. */
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

export function applyMatrix(m: Matrix3, r: number, g: number, b: number): [number, number, number] {
  return [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
}

export const IDENTITY3: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** DJI 2017 white paper. */
export const DGamut = {
  rgbToRec709: [1.6746, -0.5797, -0.0949, -0.0981, 1.334, -0.2359, -0.041, -0.243, 1.284] as Matrix3,
  rec709ToRGB: [0.6163, 0.2857, 0.098, 0.0505, 0.799, 0.1505, 0.0292, 0.1604, 0.8104] as Matrix3,
};

/** Gamut D-Log2 paper Rev 1.0. */
export const DGamut2 = {
  rgbToRec709: [1.8577, -0.7712, -0.0869, -0.2018, 1.4176, -0.2158, -0.0125, -0.1621, 1.1746] as Matrix3,
  rec709ToRGB: [0.5742, 0.324, 0.102, 0.0844, 0.7682, 0.1474, 0.0177, 0.1094, 0.8728] as Matrix3,
};

/** ITU-R BT.2087 linear BT.2020 → BT.709. */
export const BT2020_TO_709: Matrix3 = [
  1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187,
];

/**
 * Source gamut → Rec.709 for a transfer's display transform. D-Log M on Pocket bodies is
 * close to Rec.709 primaries, so it rides identity (same as `LogColorTransform` .dlogm).
 */
export function gamutToRec709(t: MonitorTransfer): Matrix3 {
  switch (t) {
    case 'dlog':
      return DGamut.rgbToRec709;
    case 'dlog2':
      return DGamut2.rgbToRec709;
    case 'hdr':
      return BT2020_TO_709;
    default:
      return IDENTITY3;
  }
}

// ───────────────────────────── Tone map ─────────────────────────────

/** Scene-linear → display code with an explicit scene white (`MonitorSceneToneMap`). */
export class SceneToneMap {
  static readonly middleGrayDisplayLinear = Math.pow(0.42, 2.4);
  static readonly defaultContrast = 1.1;
  readonly contrast: number;
  readonly whitePoint: number;
  readonly gain: number;
  readonly whiteReinhard: number;

  constructor(sceneWhite: number, contrast = SceneToneMap.defaultContrast) {
    this.contrast = contrast;
    this.whitePoint = Math.max(sceneWhite / 0.18, 0.000001);
    const contrastedWhite = Math.pow(this.whitePoint, contrast);
    const whiteContribution = 1 / (contrastedWhite * contrastedWhite);
    const numerator = SceneToneMap.middleGrayDisplayLinear - whiteContribution;
    this.gain = Math.max(0.000001, numerator / (1 - SceneToneMap.middleGrayDisplayLinear));
    this.whiteReinhard = this.gain * contrastedWhite;
  }

  displayLinear(sceneLinear: number): number {
    const x = Math.max(0, sceneLinear) / 0.18;
    const contrasted = this.gain * Math.pow(x, this.contrast);
    const w = this.whiteReinhard;
    const mapped = (contrasted * (1 + contrasted / (w * w))) / (1 + contrasted);
    return clamp01(mapped);
  }

  displayCode(sceneLinear: number): number {
    return Math.pow(this.displayLinear(sceneLinear), 1 / 2.4);
  }
}

/**
 * A generated display look for a log / HLG source: raw decode, source gamut → Rec.709,
 * then the shared scene tone map (`MonitorLogDisplayTransform`). Rec.709 is identity.
 */
export class LogDisplayTransform {
  readonly transfer: MonitorTransfer;
  readonly matrix: Matrix3;
  readonly tone: SceneToneMap;

  constructor(transfer: MonitorTransfer) {
    this.transfer = transfer;
    this.matrix = gamutToRec709(transfer);
    this.tone = new SceneToneMap(decodeRaw(1, transfer));
  }

  get isIdentity() {
    return this.transfer === 'rec709';
  }

  map(r: number, g: number, b: number): [number, number, number] {
    if (this.isIdentity) return [r, g, b];
    const t = this.transfer;
    const [lr, lg, lb] = applyMatrix(this.matrix, decodeRaw(r, t), decodeRaw(g, t), decodeRaw(b, t));
    return [
      this.tone.displayCode(Math.max(0, lr)),
      this.tone.displayCode(Math.max(0, lg)),
      this.tone.displayCode(Math.max(0, lb)),
    ];
  }

  /** Red-fastest RGB lattice (`size³ × 3`). */
  lattice(size = 33): Float32Array {
    const out = new Float32Array(size * size * size * 3);
    const d = size - 1;
    let i = 0;
    for (let b = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++) {
          const m = this.map(r / d, g / d, b / d);
          out[i++] = m[0];
          out[i++] = m[1];
          out[i++] = m[2];
        }
    return out;
  }
}

/** Technical D-Log ↔ D-Log2 conversion (`LogColorTransform`). Not a look. */
export function convertLog(
  r: number,
  g: number,
  b: number,
  source: 'dlog' | 'dlog2',
  destination: 'dlog' | 'dlog2',
): [number, number, number] {
  const lin: [number, number, number] = [linearize(r, source), linearize(g, source), linearize(b, source)];
  const toRec = source === 'dlog' ? DGamut.rgbToRec709 : DGamut2.rgbToRec709;
  const fromRec = destination === 'dlog' ? DGamut.rec709ToRGB : DGamut2.rec709ToRGB;
  const rec = applyMatrix(toRec, ...lin);
  const dst = applyMatrix(fromRec, ...rec);
  return [encode(dst[0], destination), encode(dst[1], destination), encode(dst[2], destination)];
}
