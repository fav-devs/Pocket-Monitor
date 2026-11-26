/**
 * Broadcast-style dBFS meter ballistics: instant attack, timed decay, peak hold.
 * Port of OpenCine `MonitorAudioMeterBallistics.swift` and `MonitorAudioReadout`.
 */

export interface AudioMeterChannel {
  levelDB: number;
  peakDB: number;
  peakAge: number;
}

export const AUDIO_FLOOR_DB = -60;
export const AUDIO_LEVEL_DECAY_PER_SECOND = 26;
export const AUDIO_PEAK_HOLD_SECONDS = 1.8;
export const AUDIO_PEAK_DECAY_PER_SECOND = 12;
export const AUDIO_YELLOW_FROM_DB = -18;
export const AUDIO_RED_FROM_DB = -6;
export const AUDIO_GUIDE_MARKS = [0, -6, -18, -36];

export const silentChannel = (): AudioMeterChannel => ({ levelDB: AUDIO_FLOOR_DB, peakDB: AUDIO_FLOOR_DB, peakAge: 0 });

export function decibelsFromLinear(amplitude: number): number {
  if (!(amplitude > 0)) return AUDIO_FLOOR_DB;
  return Math.max(AUDIO_FLOOR_DB, Math.min(0, 20 * Math.log10(amplitude)));
}

export const linearFromDecibels = (db: number) => (db <= AUDIO_FLOOR_DB ? 0 : Math.pow(10, db / 20));

/** Advance one channel by `dt` seconds given the loudest linear sample since the last step. */
export function stepChannel(ch: AudioMeterChannel, peakLinear: number, dt: number): AudioMeterChannel {
  const d = Math.max(0, dt);
  const incoming = decibelsFromLinear(peakLinear);
  const decayed = Math.max(AUDIO_FLOOR_DB, ch.levelDB - AUDIO_LEVEL_DECAY_PER_SECOND * d);
  const next: AudioMeterChannel = { ...ch, levelDB: Math.max(incoming, decayed) };
  if (incoming >= ch.peakDB) {
    next.peakDB = incoming;
    next.peakAge = 0;
  } else {
    next.peakAge = ch.peakAge + d;
    if (next.peakAge > AUDIO_PEAK_HOLD_SECONDS) next.peakDB = Math.max(AUDIO_FLOOR_DB, ch.peakDB - AUDIO_PEAK_DECAY_PER_SECOND * d);
  }
  next.peakDB = Math.max(next.peakDB, next.levelDB);
  return next;
}

/** Bar fraction 0…1 of a dBFS value on the −60…0 meter. */
export function audioFraction(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - AUDIO_FLOOR_DB) / -AUDIO_FLOOR_DB));
}

export function audioLabel(db: number): string {
  if (!Number.isFinite(db) || db <= AUDIO_FLOOR_DB + 0.5) return '−∞';
  return Math.round(Math.min(0, db)).toFixed(0).replace('-', '−');
}

export function audioZone(db: number): 'green' | 'yellow' | 'red' {
  if (db >= AUDIO_RED_FROM_DB) return 'red';
  if (db >= AUDIO_YELLOW_FROM_DB) return 'yellow';
  return 'green';
}
