/**
 * `cam_audio_status_v2` meter decode → stereo dBFS levels.
 * Source of truth: OpenCine `OpenCineDJI/CamAudioStatus.swift` and
 * `OpenCineMedia/MonitorAudioMeterBallistics.swift` (floor −60 dB).
 */
import type { ByteInput } from '../bytes';

export const AUDIO_FLOOR_DB = -60;
export const MAX_SEGMENT = 14;

export interface AudioMeterChannel {
  levelDB: number;
  peakDB: number;
}
export interface AudioMeterLevels {
  left: AudioMeterChannel;
  right: AudioMeterChannel;
}
export const SILENT_LEVELS: AudioMeterLevels = {
  left: { levelDB: AUDIO_FLOOR_DB, peakDB: AUDIO_FLOOR_DB },
  right: { levelDB: AUDIO_FLOOR_DB, peakDB: AUDIO_FLOOR_DB },
};
export const isSilent = (l: AudioMeterLevels) =>
  l.left.levelDB === AUDIO_FLOOR_DB && l.left.peakDB === AUDIO_FLOOR_DB && l.right.levelDB === AUDIO_FLOOR_DB && l.right.peakDB === AUDIO_FLOOR_DB;

export function decibelsFromLinear(a: number): number {
  if (!(a > 0)) return AUDIO_FLOOR_DB;
  return Math.max(AUDIO_FLOOR_DB, Math.min(0, 20 * Math.log10(a)));
}

const segDb = (s: number) => AUDIO_FLOOR_DB * (1 - Math.min(Math.max(s, 0), MAX_SEGMENT) / MAX_SEGMENT);
const pctDb = (p: number) => AUDIO_FLOOR_DB * (1 - Math.min(Math.max(p, 0), 100) / 100);

export function levelsFromSegments(cl: number, cr: number, pl: number, pr: number): AudioMeterLevels {
  return { left: { levelDB: segDb(cl), peakDB: segDb(pl) }, right: { levelDB: segDb(cr), peakDB: segDb(pr) } };
}

const u16be = (v: ByteInput, o: number) => (v[o] << 8) | v[o + 1];

export const CamAudioStatus = {
  subscribeKey: 'cam_audio_status_v2',
  capturedSize: 114,
  parse(value: ByteInput): AudioMeterLevels | null {
    if (!value.length) return null;
    const pocket = CamAudioStatus.parsePocketV2(value);
    if (pocket) return pocket;
    if (value.length >= 4) {
      const w = CamAudioStatus.bestU8Window(value);
      if (w && w.some((b) => b > 0)) return CamAudioStatus.fromU8Window(w);
    }
    const pairs = CamAudioStatus.parseInt16Pairs(value);
    if (pairs && !isSilent(pairs)) return pairs;
    if (value.length >= 4) return SILENT_LEVELS;
    if (value.length >= 2 && value[0] <= 100 && value[1] <= 100) {
      const s = (b: number) => (b <= MAX_SEGMENT ? b : Math.trunc((b / 100) * MAX_SEGMENT + 0.5));
      return levelsFromSegments(s(value[0]), s(value[1]), s(value[0]), s(value[1]));
    }
    return null;
  },
  parsePocketV2(value: ByteInput): AudioMeterLevels | null {
    if (value.length < 14) return null;
    if (u16be(value, 10) !== 100 || u16be(value, 12) !== 100) return null;
    const left = u16be(value, 2);
    const leftPeak = u16be(value, 6);
    const right = u16be(value, 8);
    const peakLeft = Math.max(left, leftPeak);
    if (Math.max(left, peakLeft, right) <= MAX_SEGMENT) return levelsFromSegments(left, right, peakLeft, right);
    return { left: { levelDB: pctDb(left), peakDB: pctDb(peakLeft) }, right: { levelDB: pctDb(right), peakDB: pctDb(right) } };
  },
  bestU8Window(value: ByteInput): number[] | null {
    if (value.length < 4) return null;
    let best: { score: number; bytes: number[] } | null = null;
    for (let i = 0; i <= value.length - 4; i++) {
      const w = [value[i], value[i + 1], value[i + 2], value[i + 3]];
      if (!w.every((b) => b <= 100)) continue;
      const score = w[0] + w[1] + w[2] + w[3];
      if (score > (best?.score ?? -1)) best = { score, bytes: w };
    }
    return best?.bytes ?? null;
  },
  fromU8Window(b: number[]): AudioMeterLevels {
    const [a, bb, c, d] = b;
    const currentFirst = (c >= a && d >= bb) || !(a >= c && bb >= d);
    const cl = currentFirst ? a : c;
    const cr = currentFirst ? bb : d;
    const pl = currentFirst ? c : a;
    const pr = currentFirst ? d : bb;
    if (Math.max(a, bb, c, d) <= MAX_SEGMENT) return levelsFromSegments(cl, cr, pl, pr);
    return { left: { levelDB: pctDb(cl), peakDB: pctDb(pl) }, right: { levelDB: pctDb(cr), peakDB: pctDb(pr) } };
  },
  parseInt16Pairs(value: ByteInput): AudioMeterLevels | null {
    if (value.length < 4) return null;
    const i16 = (o: number) => {
      const v = value[o] | (value[o + 1] << 8);
      return v >= 0x8000 ? v - 0x10000 : v;
    };
    const count = Math.floor(value.length / 2);
    const samples: number[] = [];
    for (let i = 0; i < Math.min(count, 4); i++) samples.push(i16(i * 2));
    const [cl, cr] = samples;
    const pl = samples.length > 2 ? samples[2] : cl;
    const pr = samples.length > 3 ? samples[3] : cr;
    const all = [cl, cr, pl, pr];
    if (all.every((v) => v === 0)) return SILENT_LEVELS;
    if (all.every((v) => v >= -600 && v <= 50)) {
      const scale = all.every((v) => (v >= -60 && v <= 0) || v === 0) ? 1 : 10;
      const db = (raw: number) => Math.max(AUDIO_FLOOR_DB, Math.min(0, raw / scale));
      return { left: { levelDB: db(cl), peakDB: db(pl) }, right: { levelDB: db(cr), peakDB: db(pr) } };
    }
    if (all.every((v) => v >= 0 && v <= 32767)) {
      const lin = (raw: number) => decibelsFromLinear(raw / 32767);
      return { left: { levelDB: lin(cl), peakDB: lin(pl) }, right: { levelDB: lin(cr), peakDB: lin(pr) } };
    }
    return null;
  },
};
