/**
 * Download speed over a sliding window (OpenCine `MediaTransferRateEstimator`). Instants are
 * milliseconds from an injected clock so tests never read the wall clock.
 */
import { transferRateLabel } from './format';

export type TransferRateReading = { kind: 'measuring' } | { kind: 'rate'; bytesPerSecond: number } | { kind: 'stalled' };

export function rateReadingLabel(reading: TransferRateReading | null | undefined): string | null {
  if (!reading) return null;
  switch (reading.kind) {
    case 'measuring':
      return null;
    case 'stalled':
      return 'Stalled';
    case 'rate':
      return transferRateLabel(reading.bytesPerSecond);
  }
}

const WINDOW = 2000;
const SETTLE_TIME = 500;
const SETTLE_BYTES = 256_000;
const EARLY_TIME = 250;
const STALL_AFTER = 3000;

interface Sample {
  at: number;
  total: number;
}

export class TransferRateEstimator {
  private start: number;
  private startBytes: number;
  private samples: Sample[];
  private lastArrival: number;

  constructor(startedAt: number, bytes = 0) {
    this.start = startedAt;
    this.startBytes = bytes;
    this.samples = [{ at: startedAt, total: bytes }];
    this.lastArrival = startedAt;
  }

  record(totalBytes: number, at: number) {
    const latest = this.samples[this.samples.length - 1];
    if (totalBytes < latest.total) {
      this.start = at;
      this.startBytes = totalBytes;
      this.samples = [{ at, total: totalBytes }];
      this.lastArrival = at;
      return;
    }
    if (totalBytes <= latest.total) return;
    this.samples.push({ at, total: totalBytes });
    this.lastArrival = at;
    const windowStart = at - WINDOW;
    while (this.samples.length > 2 && this.samples[1].at <= windowStart) this.samples.shift();
  }

  rate(now: number): TransferRateReading {
    const first = this.samples[0];
    const latest = this.samples[this.samples.length - 1];
    if (now - this.lastArrival >= STALL_AFTER) return { kind: 'stalled' };
    const elapsed = now - this.start;
    const received = latest.total - this.startBytes;
    if (received <= 0) return { kind: 'measuring' };
    const settled = elapsed >= SETTLE_TIME || (elapsed >= EARLY_TIME && received >= SETTLE_BYTES);
    if (!settled) return { kind: 'measuring' };
    const windowStart = now - WINDOW;
    let from: number;
    let base: number;
    if (first.at >= windowStart) {
      from = first.at;
      base = first.total;
    } else {
      const next = this.samples.find((s) => s.at > windowStart) ?? latest;
      from = windowStart;
      if (next.at <= first.at) base = next.total;
      else {
        const part = (windowStart - first.at) / (next.at - first.at);
        base = first.total + (next.total - first.total) * Math.min(1, part);
      }
    }
    const span = (now - from) / 1000;
    if (span <= 0) return { kind: 'measuring' };
    return { kind: 'rate', bytesPerSecond: Math.round(Math.max(0, (latest.total - base) / span)) };
  }
}
