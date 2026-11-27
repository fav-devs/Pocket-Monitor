/**
 * A small QR Code encoder (byte mode, error correction M, versions 1–10) for the host's Wi-Fi join
 * code. Follows ISO/IEC 18004 as laid out in Project Nayuki's reference generator (MIT). Pure
 * TypeScript; tested by decoding its output (qr.test.ts).
 *
 * The payload carries credentials: never log it, persist it, or render it outside an explicitly
 * opened sheet (docs/watcher-relay.md "Join and network boundary").
 */

const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

export interface QrMatrix {
  size: number;
  /** Row-major, true = dark. */
  modules: boolean[];
}

function rawModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMultiply(coef, factor)));
  }
  return result;
}

function withEcc(data: number[], ver: number): number[] {
  const numBlocks = BLOCKS_M[ver];
  const eccLen = ECC_PER_BLOCK_M[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]);
    });
  }
  return out;
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly modules: boolean[];
  readonly fixed: boolean[];
  constructor(readonly size: number) {
    this.modules = new Array(size * size).fill(false);
    this.fixed = new Array(size * size).fill(false);
  }
  get(x: number, y: number) {
    return this.modules[y * this.size + x];
  }
  setFunction(x: number, y: number, dark: boolean) {
    this.modules[y * this.size + x] = dark;
    this.fixed[y * this.size + x] = true;
  }
}

function drawFunctionPatterns(g: Grid, ver: number) {
  const size = g.size;
  for (let i = 0; i < size; i++) {
    g.setFunction(6, i, i % 2 === 0);
    g.setFunction(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) g.setFunction(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(ver, size);
  const last = align.length - 1;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) g.setFunction(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(g, 0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.setFunction(a, b, bit);
      g.setFunction(b, a, bit);
    }
  }
}

/** Error correction M (format bits 00) with `mask`. */
function drawFormatBits(g: Grid, mask: number) {
  const data = (0 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  const size = g.size;
  for (let i = 0; i <= 5; i++) g.setFunction(8, i, bit(i));
  g.setFunction(8, 7, bit(6));
  g.setFunction(8, 8, bit(7));
  g.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.setFunction(8, size - 15 + i, bit(i));
  g.setFunction(8, size - 8, true);
}

function drawCodewords(g: Grid, data: number[]) {
  const size = g.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!g.fixed[y * size + x] && i < data.length * 8) {
          g.modules[y * size + x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function applyMask(g: Grid, mask: number) {
  const f = MASKS[mask];
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.fixed[y * g.size + x] && f(x, y)) g.modules[y * g.size + x] = !g.modules[y * g.size + x];
    }
  }
}

/** Runs, 2×2 blocks and balance (the finder-lookalike rule is left out; any mask is valid). */
function penalty(g: Grid): number {
  const n = g.size;
  let score = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const cur = pass === 0 ? g.get(b, a) : g.get(a, b);
        const prev = pass === 0 ? g.get(b - 1, a) : g.get(a, b - 1);
        if (cur === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else run = 1;
      }
    }
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = g.get(x, y);
      if (c === g.get(x + 1, y) && c === g.get(x, y + 1) && c === g.get(x + 1, y + 1)) score += 3;
    }
  }
  const dark = g.modules.filter(Boolean).length;
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encodes `text` (UTF-8) or returns null when it does not fit version 10-M (213 bytes). */
export function encodeQr(text: string): QrMatrix | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const countBits = ver < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) return null;
  const capacity = dataCodewords(ver) * 8;
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  const size = ver * 4 + 17;
  const codewords = withEcc(data, ver);
  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = new Grid(size);
    drawFunctionPatterns(g, ver);
    drawCodewords(g, codewords);
    applyMask(g, mask);
    drawFormatBits(g, mask);
    const score = penalty(g);
    if (score < bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best ? { size, modules: best.modules } : null;
}

/** One SVG path (unit modules) of the dark cells, for `react-native-svg`. */
export function qrPath(matrix: QrMatrix): string {
  let d = '';
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y * matrix.size + x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return d;
}
