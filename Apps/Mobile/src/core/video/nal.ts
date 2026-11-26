/**
 * HEVC / AVC Annex-B NAL helpers and live codec detection.
 * Source of truth: OpenCine `OpenCineMedia/Hevc.swift`, `Avc.swift` (fork `Avc.swift` for
 * `LiveVideo`), `OpenCineDJI/Hevc+DJI.swift` (`stripDjiMarker`).
 *
 * NATIVE: decoder configuration must use `detectCodec` on observed VPS/SPS/PPS (0x40/0x42/0x44)
 * or AVC SPS/PPS (0x67/0x68), never the model name; IRAP 16–21 are GOP starts.
 */
import type { ByteInput } from '../bytes';

export const Hevc = {
  nalType: (firstByte: number) => (firstByte >> 1) & 0x3f,
  vps: 32,
  sps: 33,
  pps: 34,
  /** IDR_N_LP */
  idr: 20,
  blaWLP: 16,
  craNut: 21,
  /** DJI's private per-frame marker (`00 00 01 ff …`). */
  djiMarker: 63,
  isVCL: (t: number) => t <= 31,
  isIRAP: (t: number) => t >= 16 && t <= 21,
  isKeyframeNal: (t: number) => t === 32 || t === 33 || t === 34 || (t >= 16 && t <= 21),
};

export const Avc = {
  nalType: (firstByte: number) => firstByte & 0x1f,
  nonIdr: 1,
  idr: 5,
  sei: 6,
  sps: 7,
  pps: 8,
  aud: 9,
  isVCL: (t: number) => t >= 1 && t <= 5,
  isKeyframeNal: (t: number) => t === 7 || t === 8 || t === 5,
};

/** NAL payload ranges [start, end) (start codes stripped, trailing zeros trimmed). */
export function nalRanges(a: ByteInput): Array<[number, number]> {
  const starts: number[] = [];
  const privateMetadata = new Set<number>();
  let i = 0;
  while (i + 3 <= a.length) {
    if (a[i] === 0 && a[i + 1] === 0 && a[i + 2] === 1) {
      starts.push(i + 3);
      // Nano SEI payload 0xF0 is 25 raw DJI bytes without emulation prevention: skip by length.
      if (i + 32 <= a.length && a[i + 3] === 6 && a[i + 4] === 0xf0 && a[i + 5] === 25 && a[i + 31] === 0x80) {
        privateMetadata.add(i + 3);
        i += 32;
      } else i += 3;
    } else i += 1;
  }
  const out: Array<[number, number]> = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    if (privateMetadata.has(s)) continue;
    let e = k + 1 < starts.length ? starts[k + 1] - 3 : a.length;
    while (e > s && a[e - 1] === 0) e -= 1;
    if (e > s) out.push([s, e]);
  }
  return out;
}

export function nalUnits(a: ByteInput): Uint8Array[] {
  return nalRanges(a).map(([s, e]) => Uint8Array.from(Array.prototype.slice.call(a, s, e) as number[]));
}

export function nalHeaders(a: ByteInput): number[] {
  return nalRanges(a).map(([s]) => a[s]);
}

/** Drop DJI's `00 00 01 ff …` marker: return from the first standard NAL start, else the input. */
export function stripDjiMarker(a: ByteInput): Uint8Array {
  let i = 0;
  while (i + 4 <= a.length) {
    if (a[i] === 0 && a[i + 1] === 0 && a[i + 2] === 1) {
      if (Hevc.nalType(a[i + 3]) !== Hevc.djiMarker) return Uint8Array.from(Array.prototype.slice.call(a, i) as number[]);
      i += 3;
    } else i += 1;
  }
  return Uint8Array.from(a as ArrayLike<number>);
}

export type LiveVideoCodec = 'hevc' | 'avc';

/** HEVC param sets 0x40/0x42/0x44; AVC SPS/PPS 0x67/0x68. Never `& 0x1f` (0x28 is HEVC IDR_N_LP). */
export function codecOfNAL(firstByte: number): LiveVideoCodec | null {
  if (firstByte === 0x40 || firstByte === 0x42 || firstByte === 0x44) return 'hevc';
  if (firstByte === 0x67 || firstByte === 0x68) return 'avc';
  return null;
}

export function detectCodec(annexB: ByteInput): LiveVideoCodec | null {
  for (const h of nalHeaders(annexB)) {
    const c = codecOfNAL(h);
    if (c) return c;
  }
  return null;
}

export function accessUnitCarriesKeyframe(annexB: ByteInput, codec: LiveVideoCodec = 'hevc'): boolean {
  return nalHeaders(annexB).some((h) => (codec === 'avc' ? Avc.isKeyframeNal(Avc.nalType(h)) : Hevc.isKeyframeNal(Hevc.nalType(h))));
}

/** True when the AU starts a GOP (HEVC IRAP 16–21 or AVC IDR). */
export function accessUnitIsIrap(annexB: ByteInput, codec: LiveVideoCodec): boolean {
  return nalHeaders(annexB).some((h) => (codec === 'avc' ? Avc.nalType(h) === Avc.idr : Hevc.isIRAP(Hevc.nalType(h))));
}
