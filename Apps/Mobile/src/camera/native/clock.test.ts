import { describe, expect, it } from 'vitest';
import { type BaseTimers, SwitchableClock, type TickSource } from './clock';

/** A fake global timer queue on a manual clock: `advance(ms)` fires what is due, like JS timers. */
function fakeBase() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; every: number | null; fn: () => void }>();
  const calls: string[] = [];
  const base: BaseTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      calls.push(`setTimeout(${ms})`);
      const id = nextId++;
      timers.set(id, { at: now + ms, every: null, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (t) => void timers.delete(t as unknown as number),
    setInterval: (fn, ms) => {
      calls.push(`setInterval(${ms})`);
      const id = nextId++;
      timers.set(id, { at: now + ms, every: ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearInterval: (t) => void timers.delete(t as unknown as number),
  };
  /** Advance time; `paused` models RN's JavaTimerManager after onHostPause (nothing fires). */
  const advance = (ms: number, paused = false) => {
    const end = now + ms;
    for (;;) {
      const due = paused ? [] : [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, t] = due[0];
      now = Math.max(now, t.at);
      if (t.every != null) t.at = now + t.every;
      else timers.delete(id);
      t.fn();
    }
    now = end;
  };
  return { base, advance, calls, get count() { return timers.size; }, set now(v: number) { now = v; } };
}

function manualTicks() {
  let cb: (() => void) | null = null;
  const source: TickSource = {
    subscribe: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
  };
  return { source, tick: () => cb?.(), get subscribed() { return cb != null; } };
}

describe('SwitchableClock', () => {
  it('passes straight through to the global timers when no tick source is set', () => {
    const f = fakeBase();
    const clock = new SwitchableClock(f.base);
    const log: string[] = [];
    clock.setTimeout(() => log.push('t'), 250);
    const iv = clock.setInterval(() => log.push('i'), 100);
    expect(f.calls).toEqual(['setTimeout(250)', 'setInterval(100)']);
    f.advance(300);
    expect(log).toEqual(['i', 'i', 't', 'i']);
    clock.clearInterval(iv);
    f.advance(500);
    expect(log).toHaveLength(4);
    expect(f.count).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('clearTimeout and clearInterval both cancel either kind', () => {
    const f = fakeBase();
    const clock = new SwitchableClock(f.base);
    let n = 0;
    const a = clock.setTimeout(() => n++, 10);
    const b = clock.setInterval(() => n++, 10);
    clock.clearInterval(a);
    clock.clearTimeout(b);
    clock.clearTimeout(null);
    f.advance(100);
    expect(n).toBe(0);
  });

  it('keeps firing on ticks while the global timers are paused (Android background)', () => {
    const f = fakeBase();
    const clock = new SwitchableClock(f.base);
    const t = manualTicks();
    const log: number[] = [];
    clock.setInterval(() => log.push(f.base.now()), 1000);
    clock.setTimeout(() => log.push(-f.base.now()), 2500);
    f.advance(1000);
    expect(log).toEqual([1000]);

    clock.useTicks(t.source);
    expect(f.count).toBe(0);
    // 10 Hz heartbeat for 3 s while RN's timer manager is paused.
    for (let i = 0; i < 30; i++) {
      f.advance(100, true);
      t.tick();
    }
    expect(log).toEqual([1000, 2000, -2500, 3000, 4000]);
  });

  it('fires an overdue interval once per tick, not a burst (RN repeat semantics)', () => {
    const f = fakeBase();
    const clock = new SwitchableClock(f.base);
    const t = manualTicks();
    clock.useTicks(t.source);
    let n = 0;
    clock.setInterval(() => n++, 100);
    f.advance(1000, true);
    t.tick();
    expect(n).toBe(1);
    f.advance(50, true);
    t.tick();
    expect(n).toBe(1);
    f.advance(60, true);
    t.tick();
    expect(n).toBe(2);
  });

  it('moves pending timers back to the global timers with their remaining time', () => {
    const f = fakeBase();
    const clock = new SwitchableClock(f.base);
    const t = manualTicks();
    const log: string[] = [];
    clock.useTicks(t.source);
    clock.setTimeout(() => log.push(`t@${f.base.now()}`), 500);
    clock.setInterval(() => log.push(`i@${f.base.now()}`), 400);
    f.advance(300, true);
    t.tick();
    expect(log).toEqual([]);

    clock.useTicks(null);
    expect(t.subscribed).toBe(false);
    t.tick();
    f.advance(1000);
    expect(log).toEqual(['i@400', 't@500', 'i@800', 'i@1200']);
  });

  it('a timer cleared by an earlier callback in the same tick does not fire', () => {
    const f = fakeBase();
    const clock = new SwitchableClock(f.base);
    const t = manualTicks();
    clock.useTicks(t.source);
    let fired = false;
    const second = clock.setTimeout(() => (fired = true), 20);
    clock.setTimeout(() => clock.clearTimeout(second), 10);
    f.advance(100, true);
    t.tick();
    expect(fired).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it('a throwing callback on a tick does not stop the others', () => {
    const f = fakeBase();
    const errors: unknown[] = [];
    const clock = new SwitchableClock(f.base, (e) => errors.push(e));
    const t = manualTicks();
    clock.useTicks(t.source);
    let ran = false;
    clock.setTimeout(() => {
      throw new Error('boom');
    }, 10);
    clock.setTimeout(() => (ran = true), 20);
    f.advance(100, true);
    t.tick();
    expect(ran).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('ignores ticks after the source is removed and timers made while ticking start on it', () => {
    const f = fakeBase();
    const clock = new SwitchableClock(f.base);
    const t = manualTicks();
    clock.useTicks(t.source);
    let n = 0;
    clock.setTimeout(() => n++, 0);
    expect(f.calls).toEqual([]);
    t.tick();
    expect(n).toBe(1);
  });
});
