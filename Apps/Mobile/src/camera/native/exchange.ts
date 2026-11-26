/**
 * Request/reply matching for DUML frames on one channel (BLE fff4 or the UDP datalink).
 * A waiter is registered *before* its request is written, so a fast reply cannot be lost.
 * Port of the waiter half of OpenCine `DjiAppleControlExchange` (no hold buffer: every
 * request in this session registers first).
 */
import type { DumlFrame } from '@/core/duml/frame';

export class ExchangeTimeout extends Error {
  constructor(readonly label: string) {
    super(`${label} timed out`);
    this.name = 'ExchangeTimeout';
  }
}

export class ExchangeClosed extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ExchangeClosed';
  }
}

interface Waiter {
  match: (f: DumlFrame) => boolean;
  resolve: (f: DumlFrame) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Match by opcode (and seq when given). */
export function opcodeMatcher(pairs: Array<[number, number]>, seq?: number): (f: DumlFrame) => boolean {
  return (f) => pairs.some(([s, c]) => f.cmdSet === s && f.cmdId === c) && (seq === undefined || f.seq === seq);
}

export class FrameExchange {
  private waiters = new Set<Waiter>();
  private closedReason: string | null = null;

  /** Waits for the first frame `match` accepts. `send` runs after the waiter is armed. */
  request(match: (f: DumlFrame) => boolean, timeoutMs: number, label: string, send?: () => void): Promise<DumlFrame> {
    if (this.closedReason) return Promise.reject(new ExchangeClosed(this.closedReason));
    return new Promise<DumlFrame>((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (f) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          reject(e);
        },
        timer: setTimeout(() => waiter.reject(new ExchangeTimeout(label)), timeoutMs),
      };
      this.waiters.add(waiter);
      try {
        send?.();
      } catch (e) {
        waiter.reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Offer an inbound frame. Resolves at most one waiter; returns true when one took it. */
  deliver(frame: DumlFrame): boolean {
    for (const w of this.waiters) {
      if (w.match(frame)) {
        w.resolve(frame);
        return true;
      }
    }
    return false;
  }

  get pending(): number {
    return this.waiters.size;
  }

  /** Rejects every waiter. Further requests reject until `reopen`. */
  close(reason: string): void {
    this.closedReason = reason;
    for (const w of [...this.waiters]) w.reject(new ExchangeClosed(reason));
  }

  reopen(): void {
    this.closedReason = null;
  }
}
