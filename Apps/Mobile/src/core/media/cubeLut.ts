/**
 * Adobe/IRIDAS `.cube` 3D LUTs: parse, validated import, trilinear map, resample, pack and
 * serialize, plus the generated grading looks. Port of OpenCine `CubeLUT.swift`,
 * `CubeLUT+Import.swift`, `CubeLUTPacking.swift` and `LUTExposureCompensation` (cube part).
 *
 * `rgb` holds `size³` triplets red-fastest: `index = (r + g·size + b·size²) · 3`.
 */
import { compensateEncoded, snapLutExposure } from './exposure';
import type { MonitorTransfer } from './transfer';

export interface CubeLUT {
  size: number;
  rgb: Float32Array;
  title?: string;
}

export const CUBE_SIZE_RANGE: [number, number] = [2, 65];
export const CUBE_MAX_IMPORT_BYTES = 16 * 1024 * 1024;
export const CUBE_IMPORT_SAMPLE_RANGE: [number, number] = [-0.05, 1.05];

export class CubeParseError extends Error {
  constructor(
    readonly kind: 'missingSize' | 'unsupportedSize' | 'unsupportedDomain' | 'sampleCountMismatch' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

const startsData = (c: string) => (c >= '0' && c <= '9') || c === '+' || c === '-' || c === '.';
const fieldsOf = (line: string) => line.split(/[ \t]+/).filter(Boolean);

/** Parses a 3D `.cube`. CRLF tolerant. Throws `CubeParseError`. */
export function parseCube(text: string): CubeLUT {
  let size: number | null = null;
  let title: string | undefined;
  const values: number[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) {
      const m = line.match(/^TITLE\s+"?(.*?)"?$/);
      if (m) title = m[1];
      continue;
    }
    if (line.startsWith('LUT_3D_SIZE')) {
      const f = fieldsOf(line);
      const parsed = f.length >= 2 ? parseInt(f[1], 10) : NaN;
      if (Number.isFinite(parsed)) {
        if (parsed < CUBE_SIZE_RANGE[0] || parsed > CUBE_SIZE_RANGE[1]) {
          throw new CubeParseError(
            'unsupportedSize',
            `The .cube file declares an unsupported LUT size of ${parsed}. Supported sizes are 2–65.`,
          );
        }
        size = parsed;
      }
      continue;
    }
    if (line.startsWith('DOMAIN_MIN') || line.startsWith('DOMAIN_MAX')) {
      const expected = line.startsWith('DOMAIN_MIN') ? 0 : 1;
      const comps = fieldsOf(line).slice(1).map(Number).filter((n) => Number.isFinite(n));
      if (comps.length < 3 || !comps.slice(0, 3).every((c) => c === expected)) {
        throw new CubeParseError(
          'unsupportedDomain',
          'The .cube file declares a non-default input domain (DOMAIN_MIN/MAX); only the standard 0–1 domain is supported.',
        );
      }
      continue;
    }
    if (!startsData(line[0])) continue;
    const f = fieldsOf(line);
    if (f.length < 3) continue;
    const r = Number(f[0]);
    const g = Number(f[1]);
    const b = Number(f[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
    values.push(r, g, b);
  }
  if (size == null) throw new CubeParseError('missingSize', 'The .cube file is missing its LUT_3D_SIZE declaration.');
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new CubeParseError(
      'sampleCountMismatch',
      `The .cube file declares ${expected / 3} table entries but contains ${values.length / 3}.`,
    );
  }
  return { size, rgb: Float32Array.from(values), title };
}

/**
 * A `.cube` at an import trust boundary: bounded size, a single `LUT_3D_SIZE`, finite samples
 * inside the importable range, then the shared parser. Throws with operator copy on failure.
 */
export function validatedImport(text: string): CubeLUT {
  if (text.length > CUBE_MAX_IMPORT_BYTES) throw new CubeParseError('invalid', 'That .cube file is larger than 16 MB.');
  let foundSize = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('LUT_3D_SIZE')) {
      if (foundSize) throw new CubeParseError('invalid', 'The .cube file declares LUT_3D_SIZE more than once.');
      foundSize = true;
      continue;
    }
    if (!startsData(line[0])) continue;
    const f = fieldsOf(line);
    if (f.length < 3) continue;
    const v = [Number(f[0]), Number(f[1]), Number(f[2])];
    if (v.some((n) => Number.isNaN(n))) continue;
    if (!v.every((n) => Number.isFinite(n) && n >= CUBE_IMPORT_SAMPLE_RANGE[0] && n <= CUBE_IMPORT_SAMPLE_RANGE[1])) {
      throw new CubeParseError('invalid', 'The .cube file has samples outside 0–1.');
    }
  }
  return parseCube(text);
}

/** Trilinear lookup. Inputs clamp to 0…1. */
export function mapCube(lut: CubeLUT, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size;
  const t = lut.rgb;
  if (n < 2 || t.length !== n * n * n * 3) return [r, g, b];
  const s = n - 1;
  const fr = Math.min(Math.max(r, 0), 1) * s;
  const fg = Math.min(Math.max(g, 0), 1) * s;
  const fb = Math.min(Math.max(b, 0), 1) * s;
  const r0 = Math.floor(fr);
  const g0 = Math.floor(fg);
  const b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, s);
  const g1 = Math.min(g0 + 1, s);
  const b1 = Math.min(b0 + 1, s);
  const tr = fr - r0;
  const tg = fg - g0;
  const tb = fb - b0;
  const at = (ri: number, gi: number, bi: number, c: number) => t[(ri + gi * n + bi * n * n) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - tr) + at(r1, g0, b0, c) * tr;
    const c10 = at(r0, g1, b0, c) * (1 - tr) + at(r1, g1, b0, c) * tr;
    const c01 = at(r0, g0, b1, c) * (1 - tr) + at(r1, g0, b1, c) * tr;
    const c11 = at(r0, g1, b1, c) * (1 - tr) + at(r1, g1, b1, c) * tr;
    const c0 = c00 * (1 - tg) + c10 * tg;
    const c1 = c01 * (1 - tg) + c11 * tg;
    out[c] = c0 * (1 - tb) + c1 * tb;
  }
  return out;
}

/** Build a cube from a mapping function on an `n³` lattice. */
export function cubeFrom(size: number, fn: (r: number, g: number, b: number) => [number, number, number], title?: string): CubeLUT {
  const n = Math.max(2, size);
  const d = n - 1;
  const rgb = new Float32Array(n * n * n * 3);
  let i = 0;
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const m = fn(r / d, g / d, b / d);
        rgb[i++] = m[0];
        rgb[i++] = m[1];
        rgb[i++] = m[2];
      }
  return { size: n, rgb, title };
}

export function resampleCube(lut: CubeLUT, target: number): CubeLUT {
  if (target === lut.size) return lut;
  return cubeFrom(target, (r, g, b) => mapCube(lut, r, g, b), lut.title);
}

/** RGBA8 grid for a 2D texture: pixel `(x = b·size + r, y = g)`, alpha 255. */
export function packCubeRGBA(lut: CubeLUT): Uint8Array {
  const n = lut.size;
  const out = new Uint8Array(n * n * n * 4).fill(255);
  for (let g = 0; g < n; g++)
    for (let b = 0; b < n; b++)
      for (let r = 0; r < n; r++) {
        const src = (r + g * n + b * n * n) * 3;
        const dst = (g * n * n + b * n + r) * 4;
        out[dst] = quantize(lut.rgb[src]);
        out[dst + 1] = quantize(lut.rgb[src + 1]);
        out[dst + 2] = quantize(lut.rgb[src + 2]);
      }
  return out;
}

/** RGBA8 red-fastest volume for a 3D texture (`texImage3D` with width = height = depth = size). */
export function cubeVolumeRGBA(lut: CubeLUT): Uint8Array {
  const total = lut.size * lut.size * lut.size;
  const out = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    out[i * 4] = quantize(lut.rgb[i * 3]);
    out[i * 4 + 1] = quantize(lut.rgb[i * 3 + 1]);
    out[i * 4 + 2] = quantize(lut.rgb[i * 3 + 2]);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export const quantize = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255);

/** Serialize to `.cube` text (for `PocketVideo.loadLut`, which takes text). */
export function formatCube(lut: CubeLUT): string {
  const lines: string[] = [];
  if (lut.title) lines.push(`TITLE "${lut.title.replace(/"/g, "'")}"`);
  lines.push(`LUT_3D_SIZE ${lut.size}`);
  const t = lut.rgb;
  for (let i = 0; i < t.length; i += 3) lines.push(`${t[i].toFixed(6)} ${t[i + 1].toFixed(6)} ${t[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** Remap cube inputs so a pulled log code hits the slot the cube expected at nominal exposure. */
export function compensatingExposure(lut: CubeLUT, stops: number, transfer: MonitorTransfer): CubeLUT {
  const v = snapLutExposure(stops);
  if (v === 0) return lut;
  return cubeFrom(lut.size, (r, g, b) =>
    mapCube(lut, compensateEncoded(r, v, transfer), compensateEncoded(g, v, transfer), compensateEncoded(b, v, transfer)),
  lut.title);
}

// ───────────────────────────── Built-in looks ─────────────────────────────

export type BuiltInLook = 'Mono' | 'Contrast' | 'Warm' | 'Cool';
export const BUILT_IN_LOOKS: BuiltInLook[] = ['Mono', 'Contrast', 'Warm', 'Cool'];

export function mapLook(look: BuiltInLook, r: number, g: number, b: number): [number, number, number] {
  switch (look) {
    case 'Mono': {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return [y, y, y];
    }
    case 'Contrast': {
      const s = (x: number) => Math.min(Math.max(0.5 + 1.35 * (Math.min(Math.max(x, 0), 1) - 0.5), 0), 1);
      return [s(r), s(g), s(b)];
    }
    case 'Warm':
      return [Math.min(r * 1.08 + 0.04, 1), g, Math.max(b * 0.88 - 0.02, 0)];
    case 'Cool':
      return [Math.max(r * 0.9 - 0.02, 0), g, Math.min(b * 1.1 + 0.03, 1)];
  }
}

export function lookCube(look: BuiltInLook, size = 17): CubeLUT {
  return cubeFrom(size, (r, g, b) => mapLook(look, r, g, b), look);
}
