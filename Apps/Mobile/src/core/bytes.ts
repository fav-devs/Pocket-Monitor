/**
 * Byte helpers shared by the protocol core. Pure, no platform imports.
 * Wire bytes are `Uint8Array`; inputs accept any `ArrayLike<number>` so tests can pass arrays.
 */

export type Bytes = Uint8Array;
export type ByteInput = ArrayLike<number>;

export function bytes(input: ByteInput | Iterable<number>): Uint8Array {
  if (input instanceof Uint8Array) return input;
  return Uint8Array.from(input as ArrayLike<number>);
}

export function concat(...parts: ByteInput[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) out[o + i] = p[i] & 0xff;
    o += p.length;
  }
  return out;
}

export function u16le(data: ByteInput, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8)) & 0xffff;
}

export function i16le(data: ByteInput, offset: number): number {
  const v = u16le(data, offset);
  return v >= 0x8000 ? v - 0x10000 : v;
}

export function u32le(data: ByteInput, offset: number): number {
  return (
    (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)) + data[offset + 3] * 0x1000000
  );
}

export function i32le(data: ByteInput, offset: number): number {
  return u32le(data, offset) | 0;
}

export function putU16le(v: number): [number, number] {
  return [v & 0xff, (v >>> 8) & 0xff];
}

export function putU32le(v: number): [number, number, number, number] {
  const u = v >>> 0;
  return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff];
}

/** Float32 little-endian helpers (DJI packs gimbal/zoom floats LE). */
export function f32le(data: ByteInput, offset: number): number {
  const dv = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < 4; i++) dv.setUint8(i, data[offset + i]);
  return dv.getFloat32(0, true);
}

export function putF32le(v: number): number[] {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, v, true);
  return [dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)];
}

export function wrap16(v: number): number {
  return ((v % 0x10000) + 0x10000) % 0x10000;
}

export function equalBytes(a: ByteInput, b: ByteInput): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if ((a[i] & 0xff) !== (b[i] & 0xff)) return false;
  return true;
}

/** UTF-8 encode without relying on TextEncoder (Hermes-safe). */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 decode with U+FFFD replacement (matches Swift `String(decoding:as:)` on bad input). */
export function utf8Decode(data: ByteInput, start = 0, end = data.length): string {
  let s = '';
  let i = start;
  while (i < end) {
    const b0 = data[i];
    let cp = 0xfffd;
    let need = 0;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      need = 1;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      need = 2;
      cp = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 < 0xf5) {
      need = 3;
      cp = b0 & 0x07;
    } else {
      s += '�';
      i += 1;
      continue;
    }
    let ok = i + need < end;
    for (let k = 1; ok && k <= need; k++) {
      const b = data[i + k];
      if ((b & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (b & 0x3f);
    }
    if (!ok) {
      s += '�';
      i += 1;
      continue;
    }
    s += String.fromCodePoint(cp);
    i += need + 1;
  }
  return s;
}

export function hex(data: ByteInput, limit = 24): string {
  if (data.length === 0) return '-';
  const parts: string[] = [];
  const n = Math.min(limit, data.length);
  for (let i = 0; i < n; i++) parts.push((data[i] & 0xff).toString(16).toUpperCase().padStart(2, '0'));
  const head = parts.join(' ');
  return data.length > limit ? head + '…' : head;
}

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
