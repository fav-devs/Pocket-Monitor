/** `pm_controller::clap` tests, with the same vectors. */
import { describe, expect, it } from 'vitest';
import { ClapDetector, downmix, sampleI16 } from './clap';

const RATE = 16_000;

function room(seconds: number): number[] {
  // Steady low hum.
  return Array.from({ length: Math.trunc(RATE * seconds) }, (_, i) => 0.01 * Math.sin(i * 0.3));
}

function clap(): number[] {
  // A 20 ms burst, decaying.
  return Array.from({ length: 320 }, (_, i) => 0.8 * Math.exp(-i / 80) * (i % 2 === 0 ? 1 : -0.7));
}

function run(parts: number[][]): number {
  const detector = new ClapDetector(RATE);
  return parts.filter((part) => detector.feed(part)).length;
}

/** The same parts as 10 ms blocks of peak and level, as the native module hands them over. */
function runBlocks(parts: number[][]): number {
  const detector = new ClapDetector(RATE);
  const per = detector.blockLength;
  let carry: number[] = [];
  let heard = 0;
  for (const part of parts) {
    const samples = carry.concat(part);
    const peaks: number[] = [];
    const levels: number[] = [];
    let i = 0;
    for (; i + per <= samples.length; i += per) {
      const block = samples.slice(i, i + per);
      peaks.push(Math.max(...block.map(Math.abs)));
      levels.push(Math.sqrt(block.reduce((s, v) => s + v * v, 0) / per));
    }
    carry = samples.slice(i);
    if (detector.feedBlocks(peaks, levels)) heard += 1;
  }
  return heard;
}

describe('ClapDetector', () => {
  it('stereo is averaged into mono', () => {
    expect(downmix([0.5, -0.5, 1.0, 0.0, 0.25], 2)).toEqual([0, 0.5]);
    expect(downmix([0.1, 0.2], 0)).toEqual([0.1, 0.2]);
    expect(sampleI16(-32768)).toBe(-1);
    expect(sampleI16(16384)).toBe(0.5);
  });

  it('two claps close together fire once', () => {
    const parts = [room(1.0), clap(), room(0.3), clap(), room(1.0)];
    expect(run(parts)).toBe(1);
    expect(runBlocks(parts)).toBe(1);
  });

  it('one clap does nothing', () => {
    expect(run([room(1.0), clap(), room(2.0)])).toBe(0);
    expect(runBlocks([room(1.0), clap(), room(2.0)])).toBe(0);
  });

  it('claps far apart do nothing', () => {
    expect(run([room(1.0), clap(), room(1.5), clap(), room(1.0)])).toBe(0);
  });

  it('a steady loud room is not a clap', () => {
    const loud = Array.from({ length: RATE * 3 }, (_, i) => 0.3 * Math.sin(i * 0.2));
    expect(run([loud])).toBe(0);
  });

  it('it rests after firing', () => {
    const parts = [room(1.0), clap(), room(0.3), clap(), room(0.3), clap(), room(0.3), clap(), room(1.0)];
    expect(run(parts)).toBe(1);
    expect(runBlocks(parts)).toBe(1);
  });
});
