/**
 * Built-in looks: our own, generated procedurally into 3D LUTs (no third-party cubes, no DJI
 * looks). Each look is a small set of grading parameters run through one fixed pipeline:
 *
 *   exposure → white balance → filmic contrast → saturation / vibrance → hue pushes
 *   (teal & amber) → split toning → monochrome → black lift / highlight fade → clamp
 *
 * Inputs and outputs are display-referred code values 0…1 (what the clip's encoding holds), so a
 * look behaves like a creative .cube applied in an editor. The edit's colour stage bakes
 * `custom LUT (strength) → look (strength)` into one cube (`composeEditCube`).
 */
import { cubeFrom, mapCube, type CubeLUT } from '../media/cubeLut';

export type LookCategory = 'pro' | 'cinema' | 'film' | 'retro' | 'mono';

export const LOOK_CATEGORIES: { id: 'original' | LookCategory; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'pro', label: 'Pro' },
  { id: 'cinema', label: 'Cinema' },
  { id: 'film', label: 'Film' },
  { id: 'retro', label: 'Retro' },
  { id: 'mono', label: 'Mono' },
];

export type Rgb = [number, number, number];

export interface LookParams {
  /** Stops. */
  exposure?: number;
  /** −1 cool … +1 warm. */
  temperature?: number;
  /** −1 green … +1 magenta. */
  tint?: number;
  /** 1 = none; > 1 adds an S-curve about `pivot`. */
  contrast?: number;
  pivot?: number;
  /** 1 = none, 0 = grey. */
  saturation?: number;
  /** Saturation that favours muted colours (−1…1). */
  vibrance?: number;
  /** Warm skin / amber highlights, teal shadows and cool hues (0…1). */
  tealAmber?: number;
  /** Colour added to shadows / highlights (signed RGB offsets, scaled by `split`). */
  shadows?: Rgb;
  highlights?: Rgb;
  split?: number;
  /** Black lift (0…0.2) and highlight fade (0…0.2). */
  lift?: number;
  fade?: number;
  /** Monochrome, optionally tinted (multiplier on the grey). */
  mono?: boolean;
  monoTint?: Rgb;
  /** Channel mixer for mono: weights for R, G, B. */
  monoMix?: Rgb;
  /** Per-channel gamma (1 = none), applied last before lift. */
  gamma?: Rgb;
}

export interface Look {
  id: string;
  name: string;
  category: LookCategory;
  params: LookParams;
}

export const LOOKS: Look[] = [
  // Pro: clean, everyday grades.
  { id: 'pro-clear', name: 'Clear', category: 'pro', params: { contrast: 1.12, saturation: 1.06, vibrance: 0.15 } },
  { id: 'pro-vivid', name: 'Vivid', category: 'pro', params: { contrast: 1.18, saturation: 1.22, vibrance: 0.25, exposure: 0.05 } },
  { id: 'pro-daylight', name: 'Daylight', category: 'pro', params: { temperature: 0.18, contrast: 1.08, vibrance: 0.2 } },
  { id: 'pro-shade', name: 'Shade', category: 'pro', params: { temperature: -0.2, tint: 0.04, contrast: 1.06, saturation: 1.04 } },
  { id: 'pro-golden', name: 'Golden Hour', category: 'pro', params: { temperature: 0.42, tint: 0.08, contrast: 1.1, saturation: 1.08, highlights: [0.05, 0.02, -0.04], split: 1 } },
  { id: 'pro-portrait', name: 'Portrait', category: 'pro', params: { temperature: 0.12, tint: 0.06, contrast: 0.96, saturation: 0.94, lift: 0.02, vibrance: 0.1 } },
  // Cinema: stronger, filmic contrast and hue separation.
  { id: 'cine-teal-amber', name: 'Teal & Amber', category: 'cinema', params: { tealAmber: 0.75, contrast: 1.18, saturation: 1.05 } },
  { id: 'cine-night', name: 'Night City', category: 'cinema', params: { temperature: -0.3, contrast: 1.22, saturation: 0.9, shadows: [-0.03, 0.01, 0.05], split: 1, tealAmber: 0.3 } },
  { id: 'cine-desert', name: 'Desert', category: 'cinema', params: { temperature: 0.5, tint: 0.05, contrast: 1.15, saturation: 0.88, highlights: [0.04, 0.02, -0.05], split: 1, lift: 0.02 } },
  { id: 'cine-arctic', name: 'Arctic', category: 'cinema', params: { temperature: -0.55, contrast: 1.08, saturation: 0.78, exposure: 0.1, lift: 0.03 } },
  { id: 'cine-noir-colour', name: 'Low Key', category: 'cinema', params: { exposure: -0.25, contrast: 1.35, saturation: 0.75, pivot: 0.4, shadows: [0, 0.01, 0.03], split: 1 } },
  // Film: print-like toes and shoulders, lifted blacks.
  { id: 'film-matte', name: 'Matte', category: 'film', params: { contrast: 1.05, saturation: 0.92, lift: 0.07, fade: 0.06 } },
  { id: 'film-warm-print', name: 'Warm Print', category: 'film', params: { temperature: 0.25, contrast: 1.14, saturation: 0.95, shadows: [0.02, 0, -0.02], highlights: [0.03, 0.02, -0.03], split: 1, lift: 0.03 } },
  { id: 'film-cool-print', name: 'Cool Print', category: 'film', params: { temperature: -0.15, tint: -0.04, contrast: 1.12, saturation: 0.9, shadows: [-0.02, 0.01, 0.04], split: 1, lift: 0.03 } },
  { id: 'film-pastel', name: 'Pastel', category: 'film', params: { contrast: 0.88, saturation: 0.8, exposure: 0.15, lift: 0.06, fade: 0.04, tint: 0.05 } },
  { id: 'film-green', name: 'Evergreen', category: 'film', params: { tint: -0.12, contrast: 1.1, saturation: 0.88, shadows: [-0.02, 0.03, 0.01], split: 1, lift: 0.04 } },
  // Retro: faded, colour-shifted stock.
  { id: 'retro-seventies', name: 'Seventies', category: 'retro', params: { temperature: 0.35, contrast: 0.95, saturation: 0.85, lift: 0.08, fade: 0.05, gamma: [0.95, 1, 1.12] } },
  { id: 'retro-sunbleach', name: 'Sun Bleach', category: 'retro', params: { exposure: 0.25, contrast: 0.85, saturation: 0.7, lift: 0.06, fade: 0.08, temperature: 0.15 } },
  { id: 'retro-cross', name: 'Cross Process', category: 'retro', params: { contrast: 1.2, saturation: 1.12, gamma: [0.9, 0.95, 1.25], tint: -0.06, lift: 0.03 } },
  { id: 'retro-instant', name: 'Instant', category: 'retro', params: { temperature: 0.1, tint: 0.1, contrast: 0.92, saturation: 0.88, lift: 0.09, fade: 0.07, shadows: [0, 0.02, 0.04], split: 1 } },
  // Mono.
  { id: 'mono-silver', name: 'Silver', category: 'mono', params: { mono: true, contrast: 1.1 } },
  { id: 'mono-high', name: 'High Contrast', category: 'mono', params: { mono: true, contrast: 1.45, monoMix: [0.35, 0.55, 0.1] } },
  { id: 'mono-soft', name: 'Soft Grey', category: 'mono', params: { mono: true, contrast: 0.9, lift: 0.06, fade: 0.05 } },
  { id: 'mono-sepia', name: 'Sepia', category: 'mono', params: { mono: true, contrast: 1.05, monoTint: [1.08, 0.98, 0.82], lift: 0.03 } },
  { id: 'mono-cyan', name: 'Cyanotype', category: 'mono', params: { mono: true, contrast: 1.12, monoTint: [0.82, 0.96, 1.12] } },
];

export const lookById = (id: string | null | undefined): Look | undefined => (id ? LOOKS.find((l) => l.id === id) : undefined);

// ───────────────────────────── The pipeline ─────────────────────────────

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Filmic S-curve about `pivot`: slope `k` at the pivot, soft toe and shoulder, 0→0 and 1→1. */
export function sCurve(x: number, k: number, pivot = 0.45): number {
  const v = clamp01(x);
  if (Math.abs(k - 1) < 1e-6) return v;
  // Power curves on each side of the pivot, matched at the pivot with slope k.
  if (v < pivot) {
    const t = v / pivot;
    return pivot * Math.pow(t, k);
  }
  const t = (1 - v) / (1 - pivot);
  return 1 - (1 - pivot) * Math.pow(t, k);
}

/** Hue in 0…1 (HSV hue). */
function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return h < 0 ? h + 1 : h;
}

/** The look's mapping on one RGB triplet (0…1 in, 0…1 out). */
export function mapLook(p: LookParams, rIn: number, gIn: number, bIn: number): Rgb {
  let r = rIn;
  let g = gIn;
  let b = bIn;
  // Exposure (on code values, as a gain).
  if (p.exposure) {
    const k = Math.pow(2, p.exposure * 0.6);
    r *= k;
    g *= k;
    b *= k;
  }
  // White balance as channel gains, luma kept.
  if (p.temperature || p.tint) {
    const t = p.temperature ?? 0;
    const m = p.tint ?? 0;
    const gr = 1 + 0.12 * t + 0.03 * m;
    const gg = 1 - 0.06 * m;
    const gb = 1 - 0.14 * t + 0.03 * m;
    const y0 = luma(r, g, b);
    r *= gr;
    g *= gg;
    b *= gb;
    const y1 = luma(r, g, b);
    if (y1 > 1e-6) {
      const k = y0 / y1;
      r *= k;
      g *= k;
      b *= k;
    }
  }
  r = clamp01(r);
  g = clamp01(g);
  b = clamp01(b);
  // Contrast on luma, applied as a ratio so hues hold.
  if (p.contrast && Math.abs(p.contrast - 1) > 1e-6) {
    const y = luma(r, g, b);
    if (y > 1e-6) {
      const y2 = sCurve(y, p.contrast, p.pivot ?? 0.45);
      const k = y2 / y;
      r *= k;
      g *= k;
      b *= k;
      // Highlights that overflow desaturate toward white instead of clipping a channel.
      const mx = Math.max(r, g, b);
      if (mx > 1) {
        const t = y2 >= 1 ? 0 : (1 - y2) / Math.max(1e-6, mx - y2);
        r = y2 + (r - y2) * t;
        g = y2 + (g - y2) * t;
        b = y2 + (b - y2) * t;
      }
    } else {
      r = g = b = 0;
    }
  }
  // Saturation and vibrance about luma.
  const sat = p.saturation ?? 1;
  const vib = p.vibrance ?? 0;
  if (Math.abs(sat - 1) > 1e-6 || vib) {
    const y = luma(r, g, b);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const s = sat * (1 + vib * (1 - clamp01(chroma * 2)));
    r = y + (r - y) * s;
    g = y + (g - y) * s;
    b = y + (b - y) * s;
  }
  // Teal & amber: warm the skin-to-yellow hues and highlights, cool the rest and the shadows.
  if (p.tealAmber) {
    const a = p.tealAmber;
    const y = luma(r, g, b);
    const h = hueOf(r, g, b);
    const warmHue = smooth(0.0, 0.05, h) * (1 - smooth(0.13, 0.2, h)); // reds-oranges-yellows
    const amber = a * (0.5 * warmHue + 0.5 * smooth(0.45, 0.9, y));
    const teal = a * (1 - warmHue) * (1 - smooth(0.35, 0.75, y));
    r += 0.13 * amber - 0.09 * teal;
    g += 0.03 * amber + 0.03 * teal;
    b += -0.11 * amber + 0.11 * teal;
  }
  // Split toning.
  if (p.split && (p.shadows || p.highlights)) {
    const y = luma(clamp01(r), clamp01(g), clamp01(b));
    const ws = (1 - smooth(0.0, 0.55, y)) * p.split;
    const wh = smooth(0.45, 1.0, y) * p.split;
    if (p.shadows) {
      r += p.shadows[0] * ws;
      g += p.shadows[1] * ws;
      b += p.shadows[2] * ws;
    }
    if (p.highlights) {
      r += p.highlights[0] * wh;
      g += p.highlights[1] * wh;
      b += p.highlights[2] * wh;
    }
  }
  r = clamp01(r);
  g = clamp01(g);
  b = clamp01(b);
  // Monochrome.
  if (p.mono) {
    const m = p.monoMix ?? [0.2126, 0.7152, 0.0722];
    const total = m[0] + m[1] + m[2] || 1;
    const y = clamp01((r * m[0] + g * m[1] + b * m[2]) / total);
    const t = p.monoTint ?? [1, 1, 1];
    // Tint the mid-tones most so black stays black and white stays white.
    const w = 4 * y * (1 - y);
    r = clamp01(y * (1 + (t[0] - 1) * w));
    g = clamp01(y * (1 + (t[1] - 1) * w));
    b = clamp01(y * (1 + (t[2] - 1) * w));
  }
  // Per-channel gamma.
  if (p.gamma) {
    r = Math.pow(r, p.gamma[0]);
    g = Math.pow(g, p.gamma[1]);
    b = Math.pow(b, p.gamma[2]);
  }
  // Black lift and highlight fade.
  const lift = p.lift ?? 0;
  const fade = p.fade ?? 0;
  if (lift || fade) {
    const span = 1 - lift - fade;
    r = lift + r * span;
    g = lift + g * span;
    b = lift + b * span;
  }
  return [clamp01(r), clamp01(g), clamp01(b)];
}

/** Standard edge length for look and edit cubes. */
export const EDIT_CUBE_SIZE = 33;

export function lookCubeFor(look: Look, size = EDIT_CUBE_SIZE): CubeLUT {
  return cubeFrom(size, (r, g, b) => mapLook(look.params, r, g, b), look.name);
}

/**
 * The edit's colour stage as one cube: `custom` at `customStrength`, then the look at
 * `lookStrength` (each mixed with its input). Null when neither changes anything.
 */
export function composeEditCube(input: {
  look: Look | null | undefined;
  lookStrength: number;
  custom: CubeLUT | null | undefined;
  customStrength: number;
  size?: number;
}): CubeLUT | null {
  const ls = input.look ? clamp01(input.lookStrength) : 0;
  const cs = input.custom ? clamp01(input.customStrength) : 0;
  if (ls <= 0.001 && cs <= 0.001) return null;
  const params = input.look?.params;
  const custom = input.custom;
  return cubeFrom(input.size ?? EDIT_CUBE_SIZE, (r, g, b) => {
    let c: Rgb = [r, g, b];
    if (custom && cs > 0.001) {
      const m = mapCube(custom, r, g, b);
      c = [r + (m[0] - r) * cs, g + (m[1] - g) * cs, b + (m[2] - b) * cs];
    }
    if (params && ls > 0.001) {
      const m = mapLook(params, c[0], c[1], c[2]);
      c = [c[0] + (m[0] - c[0]) * ls, c[1] + (m[1] - c[1]) * ls, c[2] + (m[2] - c[2]) * ls];
    }
    return c;
  });
}

/** A stable key for a composed cube (cache / native registry key). */
export function editCubeKey(input: { look: string | null; lookStrength: number; lut: string | null; lutStrength: number }): string | null {
  const ls = input.look ? Math.round(clamp01(input.lookStrength) * 100) : 0;
  const cs = input.lut ? Math.round(clamp01(input.lutStrength) * 100) : 0;
  if (!ls && !cs) return null;
  return `edit:${ls ? `${input.look}@${ls}` : '-'}|${cs ? `${input.lut}@${cs}` : '-'}`;
}

/** Apply a cube to RGBA8 pixels (thumbnails). Alpha is kept. */
export function applyCubeToRGBA(cube: CubeLUT, src: ArrayLike<number>, out?: Uint8ClampedArray): Uint8ClampedArray {
  const dst = out ?? new Uint8ClampedArray(src.length);
  for (let i = 0; i + 3 < src.length; i += 4) {
    const m = mapCube(cube, src[i] / 255, src[i + 1] / 255, src[i + 2] / 255);
    dst[i] = Math.round(m[0] * 255);
    dst[i + 1] = Math.round(m[1] * 255);
    dst[i + 2] = Math.round(m[2] * 255);
    dst[i + 3] = src[i + 3];
  }
  return dst;
}
