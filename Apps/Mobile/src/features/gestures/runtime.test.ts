import { describe, expect, it } from 'vitest';
import type { HandsAudioEvent, HandsSeenEvent, HandsStatusEvent, PocketHandsNativeModule } from '@modules/pocket-native/src/types';
import type { CameraSession } from '@/camera/session';
import { defaultGestureMap } from '@/core/gestures/gesture';
import { POINTS } from '@/core/gestures/hand';
import { GestureRuntime, handsOf, type GestureConfig } from './runtime';
import { statusLine, type PhoneGestureStatus } from './status';

/** A pinching hand (index tip on the thumb tip) at (x, y), as 42 numbers. */
function pinch(x: number, y: number, right: boolean) {
  const p: [number, number][] = Array.from({ length: POINTS }, () => [x, y + 0.1]);
  p[0] = [x, y + 0.2];
  [5, 9, 13, 17].forEach((base, f) => {
    const bx = x - 0.03 + f * 0.02;
    p[base] = [bx, y + 0.08];
    p[base + 1] = [bx, y + 0.06];
    p[base + 2] = [bx, y + 0.05];
    p[base + 3] = [bx, y + 0.04];
  });
  p[8] = [x, y];
  p[4] = [x + 0.002, y + 0.002];
  return { points: p.flat(), score: 0.9, right };
}

function rig() {
  const calls: string[] = [];
  const listeners: Record<string, ((e: never) => void)[]> = {};
  const hands: PocketHandsNativeModule = {
    isAvailable: () => true,
    start: async (o) => {
      calls.push(`start ${o.source} ${o.sessionId}`);
    },
    stop: () => calls.push('stop'),
    setWantsFaces: (on) => calls.push(`faces ${on}`),
    startMicrophone: async () => {
      calls.push('mic on');
    },
    stopMicrophone: () => calls.push('mic off'),
    addListener: ((event: string, cb: (e: never) => void) => {
      (listeners[event] ??= []).push(cb);
      return { remove: () => (listeners[event] = listeners[event].filter((l) => l !== cb)) };
    }) as PocketHandsNativeModule['addListener'],
  };
  const emit = (event: 'onHands' | 'onStatus' | 'onAudio', payload: HandsSeenEvent | HandsStatusEvent | HandsAudioEvent) =>
    (listeners[event] ?? []).forEach((cb) => (cb as (e: unknown) => void)(payload));
  const state = {
    gimbal: { available: true, yaw: 0, pitch: 0, program: { status: 'idle' } },
    tracking: { status: 'idle', available: true },
    recording: { recording: false },
    capabilities: { tracking: true },
  };
  const session = {
    getState: () => state,
    gimbal: { drive: (x: number, y: number) => calls.push(`drive ${x} ${y}`), recenter: async () => calls.push('recenter'), flip: async () => {} },
    control: { zoomBy: (r: number) => calls.push(`zoom ${r}`), startTracking: async () => {}, stopTracking: async () => {} },
  } as unknown as CameraSession;
  let now = 0;
  let status: Partial<PhoneGestureStatus> = {};
  let ticker: (() => void) | null = null;
  const runtime = new GestureRuntime({
    hands,
    session: () => session,
    now: () => now,
    status: (patch) => (status = { ...status, ...patch }),
    overlay: () => {},
    permit: async () => true,
    every: (_ms, fn) => {
      ticker = fn;
      return () => (ticker = null);
    },
  });
  const config: GestureConfig = {
    active: true,
    source: 'cameraFeed',
    sessionId: 'cam-1',
    map: defaultGestureMap(),
    handControl: true,
    stickIsRight: true,
    autoFaceTrack: false,
    handView: false,
  };
  return {
    runtime,
    calls,
    emit,
    config,
    status: () => status,
    at: (t: number) => (now = t),
    tick: () => ticker?.(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('GestureRuntime', () => {
  it('reads the native hands, drives with a pinch, lets go when it stops', async () => {
    const r = rig();
    r.runtime.configure(r.config);
    await flush();
    expect(r.calls).toContain('start cameraFeed cam-1');
    expect(r.calls).toContain('mic on');
    r.emit('onStatus', { state: 'ready', provider: 'GPU' });
    // Pinch, hold, then drag right and up.
    const seen = (x: number, y: number): HandsSeenEvent => ({ source: 'cameraFeed', hands: [pinch(x, y, true)], faces: null, aspect: 16 / 9, ms: 11 });
    for (const [t, x, y] of [
      [0, 0.5, 0.5],
      [0.066, 0.5, 0.5],
      [0.133, 0.5, 0.5],
      [0.2, 0.6, 0.35],
      [0.266, 0.65, 0.3],
    ] as const) {
      r.at(t);
      r.emit('onHands', seen(x, y));
    }
    const drives = r.calls.filter((c) => c.startsWith('drive'));
    expect(drives.length).toBeGreaterThan(0);
    const [, dx, dy] = drives[drives.length - 1].split(' ').map(Number);
    expect(dx).toBeGreaterThan(0.3);
    expect(dy).toBeGreaterThan(0.3);
    expect(statusLine(r.status() as PhoneGestureStatus, 0)).toBe('Gestures · 11 ms');
    // The readings stop: the stick is let go after the stale time.
    r.at(1.0);
    r.tick();
    expect(r.calls[r.calls.length - 1]).toBe('drive 0 0');
    // Leaving the live view stops the models and the microphone.
    r.runtime.configure({ ...r.config, active: false });
    expect(r.calls.slice(-2)).toEqual(['stop', 'mic off']);
    expect(r.status().state).toBe('off');
  });

  it('waits without a picture, and a double clap recentres', async () => {
    const r = rig();
    r.runtime.configure({ ...r.config, sessionId: null });
    await flush();
    expect(r.calls.some((c) => c.startsWith('start'))).toBe(false);
    expect(r.status().state).toBe('waiting');
    // Two claps a third of a second apart, as 10 ms blocks at 16 kHz.
    const quiet = { peaks: Array(10).fill(0.01), levels: Array(10).fill(0.007) };
    const clap = { peaks: [0.8, 0.5, ...Array(8).fill(0.01)], levels: [0.4, 0.2, ...Array(8).fill(0.007)] };
    const audio = (b: { peaks: number[]; levels: number[] }) => r.emit('onAudio', { sampleRate: 16000, ...b });
    for (let i = 0; i < 10; i++) audio(quiet);
    audio(clap);
    for (let i = 0; i < 3; i++) audio(quiet);
    audio(clap);
    audio(quiet);
    expect(r.calls).toContain('recenter');
    expect(r.status().notice?.text).toBe('CLAP: RECENTRE');
  });

  it('turns native landmarks into hands and drops broken ones', () => {
    const e: HandsSeenEvent = { source: 'cameraFeed', hands: [pinch(0.5, 0.5, true), { points: [1, 2], score: 1, right: false }], aspect: 0, ms: 1 };
    const hands = handsOf(e);
    expect(hands).toHaveLength(1);
    expect(hands[0].points).toHaveLength(POINTS);
    expect(hands[0].aspect).toBeCloseTo(16 / 9);
  });
});
