import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialCameraState } from '../defaults';
import type { CameraSession, SessionEvent } from '../session';
import type { CameraState, ConnectionPhase } from '../types';
import { MultiviewCoordinator, TILE_COUNT } from './MultiviewCoordinator';
import { StageReducers, cameraFromJournal, fromStored, initialStage, lookFor, toJournal } from './stage';
import { DEFAULT_LOOK, type MultiviewCamera } from './types';

/** A camera session whose link, recording and failures the test drives. */
class FakeSession implements CameraSession {
  readonly kind = 'demo' as const;
  video = { kind: 'none' as const };
  state: CameraState = initialCameraState('osmo-pocket-3');
  listeners = new Set<(s: CameraState) => void>();
  events = new Set<(e: SessionEvent) => void>();
  connects = 0;
  disconnects = 0;
  starts = 0;
  stops = 0;
  /** How the next connect ends. */
  nextConnect: 'live' | 'fail' | 'hang' = 'live';
  /** How the camera answers record commands. */
  recordReply: 'confirm' | 'refuse' | 'silent' = 'confirm';
  restores: string[] = [];

  getState = () => this.state;
  subscribe = (l: (s: CameraState) => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  onEvent = (l: (e: SessionEvent) => void) => {
    this.events.add(l);
    return () => this.events.delete(l);
  };
  set(patch: (s: CameraState) => CameraState) {
    this.state = patch(this.state);
    this.listeners.forEach((l) => l(this.state));
  }
  phase(phase: ConnectionPhase, error?: string) {
    this.set((s) => ({ ...s, connection: { ...s.connection, phase, error } }));
  }
  startScan = () => () => {};
  connect = vi.fn(async () => {
    this.connects += 1;
    this.phase('bluetooth');
    await new Promise((r) => setTimeout(r, 500));
    if (this.nextConnect === 'hang') return new Promise<void>(() => {});
    if (this.nextConnect === 'fail') this.phase('failed', 'Camera did not respond.');
    else this.phase('live');
  });
  disconnect = vi.fn(async () => {
    this.disconnects += 1;
    this.phase('disconnected');
  });
  retry = async () => {};
  control = {
    startRecording: async () => {
      this.starts += 1;
      if (this.recordReply === 'refuse') throw new Error('refused');
      if (this.recordReply === 'confirm') setTimeout(() => this.set((s) => ({ ...s, recording: { ...s.recording, recording: true } })), 300);
    },
    stopRecording: async () => {
      this.stops += 1;
      if (this.recordReply === 'confirm') setTimeout(() => this.set((s) => ({ ...s, recording: { ...s.recording, recording: false } })), 300);
    },
  } as unknown as CameraSession['control'];
  gimbal = {} as CameraSession['gimbal'];
  media = {} as CameraSession['media'];
}

const cam = (n: number, path = false): MultiviewCamera => ({
  id: `cam-${n}`,
  name: `Cam ${n}`,
  model: 'osmo-pocket-3',
  ...(path ? { path: { kind: 'station' as const, ssid: 'Studio' } } : {}),
});

function stage(opts: { restore?: (s: FakeSession) => Promise<'restored' | 'deferred' | 'failed'> } = {}) {
  const sessions: FakeSession[] = [];
  const members: (MultiviewCamera | null)[][] = [];
  const notices: string[] = [];
  const c = new MultiviewCoordinator({
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    restoreAccessPoint: opts.restore ? (s) => opts.restore!(s as FakeSession) : undefined,
    onMembersChanged: (m) => members.push(m),
    restoreRetryMs: 100,
  });
  c.onNotice((n) => notices.push(n.message));
  return { c, sessions, members, notices };
}

async function liveStage(n: number) {
  const s = stage();
  for (let i = 0; i < n; i++) void s.c.add(cam(i + 1));
  await vi.advanceTimersByTimeAsync(600 * n + 100);
  return s;
}

describe('MultiviewCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fills slots in order, one connect at a time, and journals membership', async () => {
    const { c, sessions, members } = stage();
    void c.add(cam(1));
    void c.add(cam(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(sessions.map((s) => s.connects)).toEqual([1, 0]);
    expect(c.getSnapshot().tiles[1]).toMatchObject({ phase: 'connecting', queued: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(sessions.map((s) => s.connects)).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(600);
    const snap = c.getSnapshot();
    expect(snap.members).toBe(2);
    expect(snap.tiles.map((t) => t.phase)).toEqual(['live', 'live', 'empty', 'empty']);
    expect(members[members.length - 1].map((m) => m?.id ?? null)).toEqual(['cam-1', 'cam-2', null, null]);
  });

  it('refuses a duplicate camera and a fifth camera', async () => {
    const { c, notices } = await liveStage(4);
    expect(await c.add(cam(1), 0)).toBe(false);
    expect(await c.add(cam(9))).toBe(false);
    expect(notices).toEqual(['This camera is already in Multiview.', 'Multiview shows up to four cameras.']);
    expect(c.getSnapshot().members).toBe(TILE_COUNT);
  });

  it('removing a tile closes only its link and keeps the others', async () => {
    const { c, sessions } = await liveStage(3);
    expect(c.remove(1)).toBe(true);
    expect(sessions.map((s) => s.disconnects)).toEqual([0, 1, 0]);
    expect(c.getSnapshot().tiles.map((t) => t.phase)).toEqual(['live', 'empty', 'live', 'empty']);
  });

  describe('recovery isolation', () => {
    it('repairs a dropped tile alone, within its budget, then waits for Reconnect', async () => {
      const { c, sessions } = await liveStage(3);
      c.start();
      sessions[0].set((s) => ({ ...s, recording: { ...s.recording, recording: true } }));
      const [a, b, d] = sessions;
      b.nextConnect = 'fail';
      b.phase('failed', 'Camera did not respond.');
      await vi.advanceTimersByTimeAsync(1000);
      expect(c.getSnapshot().tiles[1]).toMatchObject({ phase: 'reconnecting', recovering: true });
      await vi.advanceTimersByTimeAsync(10_000);
      // Two attempts, then an operator action. Peers never reconnected or disconnected.
      expect(b.connects).toBe(3);
      expect(c.getSnapshot().tiles[1]).toMatchObject({ phase: 'failed', recovering: false });
      expect(c.getSnapshot().tiles[1].failure).toMatch(/Reconnect/);
      expect([a.connects, d.connects]).toEqual([1, 1]);
      expect([a.disconnects, d.disconnects]).toEqual([0, 0]);
      expect(c.getSnapshot().tiles[0]).toMatchObject({ phase: 'live', recording: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(b.connects).toBe(3);

      // The operator's Reconnect gets a fresh budget.
      b.nextConnect = 'live';
      void c.reconnect(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(b.connects).toBe(4);
      expect(c.getSnapshot().tiles[1]).toMatchObject({ phase: 'live', failure: undefined });
      c.stop();
    });

    it('does not auto-repair a camera that never came up', async () => {
      const { c, sessions } = stage();
      c.start();
      const p = c.add(cam(1));
      sessions[0].nextConnect = 'fail';
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(sessions[0].connects).toBe(1);
      expect(c.getSnapshot().tiles[0]).toMatchObject({ phase: 'failed', status: 'Could not connect', failure: 'Camera did not respond.' });
      c.stop();
    });

    it('drops a repair that outlives its deadline without touching peers', async () => {
      const s = stage();
      const c = new MultiviewCoordinator({
        createSession: () => {
          const f = new FakeSession();
          s.sessions.push(f);
          return f;
        },
        repairDeadlineMs: 2000,
      });
      void c.add(cam(1));
      void c.add(cam(2));
      await vi.advanceTimersByTimeAsync(1300);
      c.start();
      s.sessions[0].nextConnect = 'hang';
      s.sessions[0].phase('failed');
      await vi.advanceTimersByTimeAsync(1000);
      expect(c.getSnapshot().tiles[0].recovering).toBe(true);
      await vi.advanceTimersByTimeAsync(2600);
      expect(c.getSnapshot().tiles[0].recovering).toBe(false);
      expect(s.sessions[1].connects).toBe(1);
      c.stop();
    });
  });

  describe('group record', () => {
    it('starts every camera and confirms each from its own report', async () => {
      const { c, sessions, notices } = await liveStage(3);
      expect(c.canRecordTogether()).toBe(true);
      const run = c.record();
      await vi.advanceTimersByTimeAsync(10);
      expect(c.getSnapshot().groupBusy).toBe(true);
      expect(c.getSnapshot().tiles[0]).toMatchObject({ recordBusy: true, recordNote: 'Waiting for camera confirmation' });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await run;
      expect(result?.plan.direction).toBe('start');
      expect(result?.outcomes).toEqual({ 0: 'confirmed', 1: 'confirmed', 2: 'confirmed' });
      expect(sessions.map((s) => s.starts)).toEqual([1, 1, 1]);
      expect(notices[notices.length - 1]).toBe('Recording on 3 cameras');
      expect(c.getSnapshot()).toMatchObject({ groupBusy: false, anyRecording: true });

      // Next press stops them all.
      const stop = c.record();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await stop)?.plan.direction).toBe('stop');
      expect(sessions.map((s) => s.stops)).toEqual([1, 1, 1]);
      expect(notices[notices.length - 1]).toBe('Recording stopped');
    });

    it('reports each camera’s own outcome; a partial start is never compensated', async () => {
      const { c, sessions, notices } = await liveStage(3);
      sessions[1].recordReply = 'refuse';
      sessions[2].recordReply = 'silent';
      const run = c.record();
      await vi.advanceTimersByTimeAsync(9000);
      const result = await run;
      expect(result?.outcomes).toEqual({ 0: 'confirmed', 1: 'refused', 2: 'unconfirmed' });
      expect(c.getSnapshot().tiles.map((t) => t.recordNote)).toEqual(['Recording', 'Recording command rejected · check camera', 'No confirmation · check camera', undefined]);
      expect(sessions[0].stops).toBe(0);
      expect(c.getSnapshot().tiles[0].recording).toBe(true);
      expect(notices[notices.length - 1]).toBe('1 of 3 confirmed · check camera tiles');
    });

    it('sends nothing when one camera is not ready (strict)', async () => {
      const { c, sessions, notices } = await liveStage(2);
      sessions[1].phase('recovering');
      expect(c.canRecordTogether()).toBe(false);
      expect(await c.record()).toBeNull();
      expect(sessions.map((s) => s.starts)).toEqual([0, 0]);
      expect(notices[notices.length - 1]).toBe('Cam 2 is not connected');
      // A tile's own press still works for the ready camera.
      const own = c.record(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await own)?.outcomes).toEqual({ 0: 'confirmed' });
      expect(sessions.map((s) => s.starts)).toEqual([1, 0]);
    });

    it('a removed camera’s late result is superseded', async () => {
      const { c, sessions } = await liveStage(2);
      sessions[1].recordReply = 'silent';
      const run = c.record();
      await vi.advanceTimersByTimeAsync(500);
      // Group busy: remove is refused while the press runs.
      expect(c.remove(1)).toBe(false);
      await vi.advanceTimersByTimeAsync(9000);
      expect((await run)?.outcomes).toEqual({ 0: 'confirmed', 1: 'unconfirmed' });
    });
  });

  describe('exit', () => {
    it('returns shared-network cameras to their Wi-Fi, retrying a deferred pairing, then closes every link', async () => {
      const attempts = new Map<FakeSession, number>();
      const s = stage({
        restore: async (f) => {
          const n = (attempts.get(f) ?? 0) + 1;
          attempts.set(f, n);
          return f === s.sessions[1] ? 'failed' : n === 1 ? 'deferred' : 'restored';
        },
      });
      void s.c.add(cam(1, true));
      void s.c.add(cam(2, true));
      void s.c.add({ ...cam(3), demoScene: 'studio' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(s.c.restoresNetworks).toBe(true);
      const closing = s.c.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(s.c.getSnapshot().closing).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      const { pending } = await closing;
      expect(pending.map((p) => p.id)).toEqual(['cam-2']);
      expect([...attempts.values()]).toEqual([2, 1]);
      expect(s.sessions.map((f) => f.disconnects)).toEqual([1, 1, 1]);
      expect(s.c.getSnapshot().members).toBe(0);
    });
  });
});

describe('Multiview stage reducers and journal', () => {
  it('focus selects the tile and shows it large; layout and fill toggle', () => {
    let s = initialStage();
    s = StageReducers.focus(s, 2);
    expect(s).toMatchObject({ selected: 2, layout: 'center' });
    s = StageReducers.toggleLayout(s);
    expect(s.layout).toBe('grid');
    s = StageReducers.select(s, 9);
    expect(s.selected).toBe(3);
    expect(StageReducers.toggleFill(s).fill).toBe(true);
  });

  it('journals members and owes shared-network cameras a Wi-Fi return until Close confirms it', () => {
    let s = StageReducers.setNetwork(initialStage(), { ssid: 'Studio', hotspot: false });
    s = StageReducers.members(s, [cam(1, true), null, { ...cam(3), demoScene: 'skin' }, null]);
    expect(s.cameras.map((c) => [c.slot, c.id])).toEqual([
      [0, 'cam-1'],
      [2, 'cam-3'],
    ]);
    expect(s.pendingReset.map((c) => c.id)).toEqual(['cam-1']);
    s = StageReducers.members(s, [null, null, { ...cam(3), demoScene: 'skin' }, null]);
    // Removed from the stage, still owed its return.
    expect(s.pendingReset.map((c) => c.id)).toEqual(['cam-1']);
    expect(s.selected).toBe(2);
    s = StageReducers.returned(s, ['cam-9']);
    expect(s.pendingReset.map((c) => c.id)).toEqual(['cam-1']);
    s = StageReducers.returned(s, ['cam-1']);
    expect(s.pendingReset).toEqual([]);
  });

  it('keeps a per-camera look', () => {
    let s = StageReducers.setLook(initialStage(), 'cam-1', { peaking: true });
    s = StageReducers.setLook(s, 'cam-1', { lut: false });
    expect(lookFor(s, 'cam-1')).toEqual({ ...DEFAULT_LOOK, peaking: true, lut: false });
    expect(lookFor(s, 'cam-2')).toEqual(DEFAULT_LOOK);
  });

  it('round-trips through the journal and drops invalid stored values', () => {
    let s = StageReducers.setNetwork(initialStage(), { ssid: 'Studio', hotspot: true });
    s = StageReducers.members(StageReducers.focus(s, 1), [cam(1, true), cam(2, true), null, null]);
    expect(toJournal(s)).toMatchObject({ version: 1, ssid: 'Studio', hotspot: true, layout: 'center', focusedIndex: 1 });
    expect(fromStored(JSON.parse(JSON.stringify(s)))).toMatchObject({ layout: 'center', selected: 1, cameras: [{ id: 'cam-1' }, { id: 'cam-2' }] });
    const broken = fromStored({ ...s, cameras: [{ slot: 0, id: 'x', name: 'X' }, { slot: 0, id: 'y', name: 'Y' }], fill: true });
    expect(broken).toMatchObject({ cameras: [], layout: 'center', fill: true, network: null });
    expect(cameraFromJournal(s.cameras[0], { ssid: 'Studio', hotspot: true }).path).toEqual({ kind: 'hotspot', ssid: 'Studio' });
  });
});
