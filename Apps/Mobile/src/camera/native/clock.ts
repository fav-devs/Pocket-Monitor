/**
 * The camera session's timers, behind one seam so server mode can keep them running while the
 * app is in the background.
 *
 * Why: on Android, React Native's JS timers stop when the Activity pauses. Verified in
 * react-native 0.88.1 `ReactAndroid/.../modules/core/JavaTimerManager.kt`: `onHostPause()` sets
 * `isPaused` and removes the `TimerFrameCallback` from `ReactChoreographer`; `doFrame` returns
 * early while `isPaused && !isRunningTasks`, so no `setTimeout` / `setInterval` fires until
 * `onHostResume()` (or while a Headless JS task is running). Bridgeless mode is the same path:
 * the C++ `TimerManager` delegates to `JavaTimerRegistry` → the same `JavaTimerManager`
 * (`runtime/ReactInstance.kt`). Timers also ride Choreographer vsync, which stops with the display
 * on many devices, so even a Headless JS task would not keep them reliable with the screen off.
 * Native events still reach JS in the background (they are posted to the JS queue, not to the
 * Choreographer), so the server's foreground service emits a native heartbeat (`PocketBackground`
 * `onTick`, ~10 Hz) and the session's timers run off that while serving in the background.
 *
 * `systemClock` is the global timers. `SwitchableClock` is identical to them (same calls, same
 * delays) until `useTicks(source)` moves every pending timer onto the tick source; `useTicks(null)`
 * moves them back with their remaining time. Tick mode fires a due timer on the first tick at or
 * after its deadline (≤ one tick late) and, like RN's timer manager, reschedules an interval from
 * the tick it fired on (no burst after a gap).
 */

/** Opaque handle; pass back to `clearTimeout` / `clearInterval` of the clock that made it. */
export type ClockTimer = { readonly __clockTimer: true } | ReturnType<typeof setTimeout>;

export interface SessionClock {
  /** Monotonic milliseconds. */
  now(): number;
  setTimeout(fn: () => void, ms: number): ClockTimer;
  clearTimeout(timer: ClockTimer | null | undefined): void;
  setInterval(fn: () => void, ms: number): ClockTimer;
  clearInterval(timer: ClockTimer | null | undefined): void;
}

/** Something that calls `onTick` regularly (the server service's native heartbeat). */
export interface TickSource {
  subscribe(onTick: () => void): () => void;
}

const monotonicNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

type Native = ReturnType<typeof setTimeout>;

export interface BaseTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): Native;
  clearTimeout(t: Native): void;
  setInterval(fn: () => void, ms: number): Native;
  clearInterval(t: Native): void;
}

const globalTimers: BaseTimers = {
  now: monotonicNow,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
};

/** The global JS timers, unchanged. */
export const systemClock: SessionClock = {
  now: monotonicNow,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => {
    if (t != null) clearTimeout(t as Native);
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => {
    if (t != null) clearInterval(t as Native);
  },
};

interface Entry {
  handle: ClockTimer;
  fn: () => void;
  /** Next deadline on `base.now()`. */
  due: number;
  /** Interval period, or null for a one-shot. */
  every: number | null;
  /** Global timer while in timer mode. `oneShot` marks a re-armed interval's first leg. */
  native: { id: Native; kind: 'timeout' | 'interval' } | null;
}

export class SwitchableClock implements SessionClock {
  private entries = new Map<ClockTimer, Entry>();
  private source: TickSource | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly base: BaseTimers = globalTimers,
    private readonly onError: (e: unknown) => void = (e) => console.error('[clock] timer threw', e),
  ) {}

  now(): number {
    return this.base.now();
  }

  /** True while timers run off a tick source. */
  get ticking(): boolean {
    return this.source != null;
  }

  /** Pending timers (tests / diagnostics). */
  get pending(): number {
    return this.entries.size;
  }

  setTimeout(fn: () => void, ms: number): ClockTimer {
    return this.add(fn, ms, null);
  }

  setInterval(fn: () => void, ms: number): ClockTimer {
    return this.add(fn, ms, Math.max(0, ms));
  }

  clearTimeout(timer: ClockTimer | null | undefined): void {
    this.remove(timer);
  }

  clearInterval(timer: ClockTimer | null | undefined): void {
    this.remove(timer);
  }

  /**
   * Run timers off `source` (non-null) or the global timers (null). Pending timers keep their
   * deadlines across the switch.
   */
  useTicks(source: TickSource | null): void {
    if (source === this.source) return;
    if (this.source) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.source = null;
    }
    if (source) {
      for (const e of this.entries.values()) this.disarm(e);
      this.source = source;
      this.unsubscribe = source.subscribe(() => this.tick());
    } else {
      const now = this.base.now();
      for (const e of this.entries.values()) this.armRemaining(e, now);
    }
  }

  /** Fire every timer that is due. Public so a test (or a source) can drive it directly. */
  tick(): void {
    if (!this.source) return;
    const now = this.base.now();
    const due = [...this.entries.values()].filter((e) => e.due <= now).sort((a, b) => a.due - b.due);
    for (const e of due) {
      if (this.entries.get(e.handle) !== e || !this.source) continue;
      if (e.every != null) e.due = now + Math.max(1, e.every);
      else this.entries.delete(e.handle);
      this.run(e);
    }
  }

  private add(fn: () => void, ms: number, every: number | null): ClockTimer {
    const delay = Math.max(0, Number.isFinite(ms) ? ms : 0);
    const handle = { __clockTimer: true } as ClockTimer;
    const entry: Entry = { handle, fn, due: this.base.now() + delay, every, native: null };
    this.entries.set(handle, entry);
    if (!this.source) {
      // Exactly the global call the session made before this seam existed.
      if (every == null) {
        entry.native = { id: this.base.setTimeout(() => this.fireNative(entry), ms), kind: 'timeout' };
      } else {
        entry.native = { id: this.base.setInterval(() => this.fireNative(entry), ms), kind: 'interval' };
      }
    }
    return handle;
  }

  private remove(timer: ClockTimer | null | undefined): void {
    if (timer == null) return;
    const e = this.entries.get(timer);
    if (!e) return;
    this.entries.delete(timer);
    this.disarm(e);
  }

  private disarm(e: Entry): void {
    if (!e.native) return;
    if (e.native.kind === 'interval') this.base.clearInterval(e.native.id);
    else this.base.clearTimeout(e.native.id);
    e.native = null;
  }

  /** Back to global timers: the next deadline is kept, then an interval resumes its period. */
  private armRemaining(e: Entry, now: number): void {
    this.disarm(e);
    const remaining = Math.max(0, e.due - now);
    e.native = { id: this.base.setTimeout(() => this.fireNative(e, true), remaining), kind: 'timeout' };
  }

  private fireNative(e: Entry, rearmInterval = false): void {
    if (this.entries.get(e.handle) !== e) return;
    const now = this.base.now();
    if (e.every == null) {
      this.entries.delete(e.handle);
      e.native = null;
    } else {
      e.due = now + e.every;
      if (rearmInterval) e.native = { id: this.base.setInterval(() => this.fireNative(e), e.every), kind: 'interval' };
    }
    // Global-timer mode: let a throw propagate exactly as it did from a plain setTimeout.
    e.fn();
  }

  private run(e: Entry): void {
    try {
      e.fn();
    } catch (error) {
      this.onError(error);
    }
  }
}

/**
 * The clock every phone `NativeCameraSession` uses (`createNativeSession`). Global timers until
 * server mode moves it onto the service heartbeat (`src/camera/server`).
 */
export const sessionClock = new SwitchableClock();
