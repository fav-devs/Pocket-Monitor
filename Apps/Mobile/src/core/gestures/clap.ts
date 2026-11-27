/**
 * Hearing a double clap in the microphone: a port of `pm_controller::clap`
 * (`Apps/Desktop/crates/pm-controller/src/clap.rs`). Pure signal handling.
 *
 * A clap is a burst that is much louder than the room and rises within a few milliseconds. Two of
 * them, a fraction of a second apart, are the signal: one clap is too easy to make by accident
 * (a door, a desk, a cough).
 *
 * The detector reasons in 10 ms blocks of their peak and RMS level. On phones the native module
 * does the per-sample work (it hands over each block's peak and level, ten blocks a call), so
 * the JS thread never sees raw audio: {@link ClapDetector.feedBlocks}. {@link ClapDetector.feed}
 * takes samples, as the desktop's does, and is what the tests drive.
 */

/** Block length the detector reasons in, in seconds. */
export const CLAP_BLOCK_SECONDS = 0.01;
/** The burst must beat the room's usual level by this much, and this absolute floor. */
const RATIO = 6.0;
const FLOOR = 0.12;
/** A second clap comes no sooner and no later than this after the first. */
const GAP_MIN = 0.15;
const GAP_MAX = 0.8;
/** After a double clap, ignore the microphone this long. */
const COOLDOWN = 2.5;
/** Echoes and the tail of one clap are not a second one. */
const REFRACTORY = 0.1;

export class ClapDetector {
  private readonly rate: number;
  private block: number[] = [];
  /** Slow average of the room's level. */
  private room = 0.01;
  private lastLevel = 0;
  private clock = 0;
  private first: number | null = null;
  private lastClap = -Number.MAX_VALUE;
  private quietUntil = 0;

  constructor(sampleRate: number) {
    this.rate = Math.max(sampleRate, 8000);
  }

  /** Samples in one block at this rate (`rate × 10 ms`). */
  get blockLength(): number {
    return Math.trunc(this.rate * CLAP_BLOCK_SECONDS);
  }

  /** Mono samples in −1…1. True once, when a double clap has just completed. */
  feed(samples: ArrayLike<number>): boolean {
    const perBlock = this.blockLength;
    let heard = false;
    for (let i = 0; i < samples.length; i++) {
      this.block.push(samples[i]);
      if (this.block.length >= perBlock) {
        let peak = 0;
        let sum = 0;
        for (const s of this.block) {
          peak = Math.max(peak, Math.abs(s));
          sum += s * s;
        }
        heard = this.blockDone(peak, Math.sqrt(sum / this.block.length)) || heard;
        this.block = [];
      }
    }
    return heard;
  }

  /** Whole 10 ms blocks, each its peak and RMS level. True once, when a double clap has just completed. */
  feedBlocks(peaks: ArrayLike<number>, levels: ArrayLike<number>): boolean {
    let heard = false;
    const n = Math.min(peaks.length, levels.length);
    for (let i = 0; i < n; i++) heard = this.blockDone(peaks[i], levels[i]) || heard;
    return heard;
  }

  private blockDone(peak: number, level: number): boolean {
    this.clock += CLAP_BLOCK_SECONDS;
    const rising = level > 3 * this.lastLevel + 0.02;
    const loud = peak > FLOOR && peak > RATIO * this.room;
    this.lastLevel = level;
    // The room follows quiet blocks only, so a clap does not raise its own bar.
    if (!loud) this.room += (level - this.room) * 0.02;
    if (this.clock < this.quietUntil || !(loud && rising)) return false;
    if (this.clock - this.lastClap < REFRACTORY) return false;
    this.lastClap = this.clock;
    if (this.first != null && this.clock - this.first >= GAP_MIN && this.clock - this.first <= GAP_MAX) {
      this.first = null;
      this.quietUntil = this.clock + COOLDOWN;
      return true;
    }
    this.first = this.clock;
    return false;
  }
}

/**
 * A device's interleaved samples (`channels` per frame) as mono, the average of each frame's
 * channels. A partial frame at the end is dropped (`clap::downmix`).
 */
export function downmix(interleaved: Iterable<number>, channels: number): number[] {
  const n = Math.max(channels, 1);
  const out: number[] = [];
  let sum = 0;
  let count = 0;
  for (const sample of interleaved) {
    sum += sample;
    count += 1;
    if (count === n) {
      out.push(sum / n);
      sum = 0;
      count = 0;
    }
  }
  return out;
}

/** A 16-bit sample in −1…1. */
export function sampleI16(sample: number): number {
  return sample / 32768;
}
