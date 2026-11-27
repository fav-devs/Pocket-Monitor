/**
 * Capability tables pushed as `camcap_*` subscription values: legal shutter / ISO / colour /
 * video-format wheels, plus the wheel helpers the UI mapping uses.
 * Source of truth: OpenCine `OpenCineDJI/CamCap+DJIWire.swift`, `OpenCineCameraVocabulary/CamCap.swift`.
 */
import type { ByteInput } from '../bytes';
import { type ColorMode, ColorModes, type IsoIndex, IsoIndexes, type IsoLimit, isIsoLimit, type VideoFormat, VideoFormats } from '../commands/vocabulary';
import type { CameraModel } from './cameraModel';

const slice = (v: ByteInput, a: number, b: number) => Array.prototype.slice.call(v, a, b) as number[];

type ShutterItem = { kind: 'fraction'; denom: number } | { kind: 'seconds'; s: number };

function decodeTriplets(b: number[]): ShutterItem[] {
  const items: ShutterItem[] = [];
  for (let i = 0; i + 2 < b.length; i += 3) {
    const raw = b[i] | (b[i + 1] << 8);
    if (raw & 0x8000) {
      const d = raw & 0x7fff;
      if (d >= 1 && d <= 16000) items.push({ kind: 'fraction', denom: d });
    } else if (raw >= 1 && raw <= 60) items.push({ kind: 'seconds', s: raw });
  }
  return items;
}
const fractionCount = (items: ShutterItem[]) => items.filter((i) => i.kind === 'fraction').length;

export const CamCapShutter = {
  subscribeKey: 'camcap_shutter',
  emptyCapVideoDenoms: [8000, 6400, 4000, 3200, 2000, 1600, 1000, 800, 500, 400, 250, 200, 125, 120, 100, 60, 50, 48, 40, 30, 25, 24],
  parseItems(value: ByteInput): ShutterItem[] | null {
    if (value.length < 13 || value[0] !== 0x01) return null;
    const inner = value[1] | (value[2] << 8);
    if (inner < 10 || 3 + inner > value.length) return null;
    const body = slice(value, 3, 3 + inner);
    const count = body[9];
    const payload = body.slice(10);
    if (count > 0 && payload.length === count * 3) {
      const items = decodeTriplets(payload);
      if (items.length) return items;
    }
    let best: ShutterItem[] = [];
    const maxOff = Math.min(16, Math.max(0, body.length - 6));
    for (let off = 0; off <= maxOff; off++) {
      const s = body.slice(off);
      const n = Math.floor(s.length / 3);
      if (n < 2) continue;
      const items = decodeTriplets(s.slice(0, n * 3));
      if (fractionCount(items) > fractionCount(best)) best = items;
    }
    return fractionCount(best) >= 2 ? best : null;
  },
  parseDenoms(value: ByteInput): number[] {
    const items = CamCapShutter.parseItems(value);
    if (!items) return [];
    const seen = new Set<number>();
    const out: number[] = [];
    for (const it of items) {
      if (it.kind !== 'fraction' || seen.has(it.denom)) continue;
      seen.add(it.denom);
      out.push(it.denom);
    }
    return out;
  },
  wheelDenoms(available: number[], current: number): number[] {
    if (available.length) return available;
    const ladder = CamCapShutter.emptyCapVideoDenoms;
    if (current < 1 || current > 16000 || ladder.includes(current)) return ladder;
    const out = ladder.slice();
    const idx = out.findIndex((d) => d < current);
    if (idx >= 0) out.splice(idx, 0, current);
    else out.push(current);
    return out;
  },
  nearestDenom(current: number, denoms: number[]): number | null {
    if (!denoms.length) return null;
    let best = denoms[0];
    for (const d of denoms) if (Math.abs(d - current) < Math.abs(best - current)) best = d;
    return best;
  },
  steppedDenom(current: number, steps: number, available: number[]): number | null {
    const list = CamCapShutter.wheelDenoms(available, current);
    let idx = list.indexOf(current);
    if (idx < 0) {
      const n = CamCapShutter.nearestDenom(current, list);
      idx = n == null ? -1 : list.indexOf(n);
    }
    if (idx < 0) return null;
    const next = idx + steps;
    if (next < 0 || next >= list.length || next === idx) return null;
    return list[next];
  },
};

export const CamCapIso = {
  subscribeKey: 'camcap_iso',
  parseIndices(value: ByteInput): IsoIndex[] {
    if (value.length < 5 || value[0] !== 1) return [];
    const inner = value[1] | (value[2] << 8);
    if (inner < 2 || 3 + inner > value.length) return [];
    const body = slice(value, 3, 3 + inner);
    const count = body[1];
    if (body[0] !== 0 || count < 1 || body.length < 2 + count) return [];
    return body
      .slice(2, 2 + count)
      .map((b) => IsoIndexes.fromDjiWire(b))
      .filter((x): x is IsoIndex => x !== null);
  },
  baseISO(colorMode: ColorMode | null): number | null {
    return colorMode === 0x17 ? 400 : colorMode === 0x41 ? 1600 : null;
  },
};

export const CamCapColorMode = {
  subscribeKey: 'camcap_color_mode',
  parse(value: ByteInput, model?: CameraModel | null): ColorMode[] {
    if (value.length < 5 || value[0] !== 1) return [];
    const inner = value[1] | (value[2] << 8);
    if (inner < 2 || 3 + inner > value.length) return [];
    const body = slice(value, 3, 3 + inner);
    const count = body[0];
    if (count < 1 || body.length < 1 + count) return [];
    return body
      .slice(1, 1 + count)
      .map((b) => ColorModes.fromWire(b, model))
      .filter((x): x is ColorMode => x !== null);
  },
  /** Available modes ranked by the body's catalogue order. */
  wheel(available: ColorMode[], order: ColorMode[]): ColorMode[] {
    if (!order.length) return available;
    if (!available.length) return order;
    const have = new Set(available);
    const ranked = order.filter((m) => have.has(m));
    return ranked.length ? ranked : order;
  },
};

export const CamCapVideoFormat = {
  subscribeKey: 'camcap_video_format',
  parse(value: ByteInput): VideoFormat[] {
    if (value.length < 5 || value[0] !== 1) return [];
    const inner = value[1] | (value[2] << 8);
    if (inner < 2 || 3 + inner > value.length) return [];
    const body = slice(value, 3, 3 + inner);
    const count = body[0];
    if (count < 1 || body.length < 1 + count * 3) return [];
    const out: VideoFormat[] = [];
    const seen = new Set<number>();
    let i = 1;
    for (let k = 0; k < count; k++) {
      if (i + 2 >= body.length) break;
      const f = VideoFormats.parseVideoParamV2(body.slice(i, i + 2))!;
      const key = (f.resolution << 8) | f.frameRate;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(f);
      }
      i += 3;
    }
    return out;
  },
  /** Reported formats, else the body's documented fallback for this shooting mode. */
  pickerFormats(available: VideoFormat[], model: CameraModel | null, shootingMode: number): VideoFormat[] {
    if (available.length) return available;
    const mode = shootingMode === 0x05 ? 0x17 : shootingMode;
    const pairs = model?.captureProfile?.videoFormatFallbacks[mode] ?? [];
    return pairs.map(([resolution, frameRate]) => ({ resolution, frameRate }));
  },
};

export const CamCapIsoAutoMax = {
  subscribeKey: 'camcap_iso_auto_max',
  parse(value: ByteInput): { base: number; limits: IsoLimit[] } | null {
    if (!value.length) return null;
    if (value[0] === 1) return { base: 0, limits: [] };
    if (value.length < 6 || value[0] !== 2) return null;
    const inner = value[1] | (value[2] << 8);
    if (inner < 3 || 3 + inner > value.length) return null;
    const body = slice(value, 3, 3 + inner);
    const count = body[0];
    if (count < 1 || body.length < 1 + count + 2) return null;
    const raw = body.slice(1, 1 + count);
    if (!raw.every(isIsoLimit)) return null;
    const at = 1 + count;
    return { base: body[at] | (body[at + 1] << 8), limits: raw as IsoLimit[] };
  },
};
