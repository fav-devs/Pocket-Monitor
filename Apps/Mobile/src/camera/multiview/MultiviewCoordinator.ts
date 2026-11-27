/**
 * Multiview's stage: up to four camera sessions side by side, each with its own link, picture,
 * watchdog and recovery, plus the group pieces that belong to the stage (a serial Bluetooth turn
 * for connects, bounded per-tile recovery, strict group record with per-camera confirmation, and
 * the exit that returns cameras to their own Wi-Fi).
 *
 * Shaped after OpenCine `OpenCineAppKit/MultiviewCoordinator(+Record).swift` and OpenPocketCine
 * `MultiviewSession.swift`, with this app's `CameraSession` as the member link: a native tile is
 * one `NativeCameraSession` on the shared network (its own datalink session id), a demo tile one
 * `DemoCameraSession`. No React here; the screen reads `getSnapshot()` through
 * `useSyncExternalStore`.
 *
 * Isolation rules this file keeps:
 * - A tile's repair touches only that tile's session. Healthy peers are never reconnected,
 *   paused or re-enabled because another tile failed.
 * - Connects (Bluetooth pairing + station join) take turns: one at a time, so two sessions never
 *   fight over the radio's scan. Tiles already live keep streaming while another connects.
 * - Group record is strict: one press never leaves some cameras rolling and others not by
 *   surprise. A partial result is never compensated.
 */
import {
  MultiviewCopy,
  RECORD_CONFIRM_WINDOW_MS,
  RecordCopy,
  RecoveryBudget,
  exclusionText,
  isExecutable,
  planIsCurrent,
  planRecord,
  raceDeadline,
  recordNote,
  recordSummary,
  restoreWithRetry,
  type RecordCandidate,
  type RecordOutcome,
  type RecordPlan,
  type RestoreResult,
} from '@/core/multicam';
import type { CameraSession, ConnectOptions } from '../session';
import type { CameraNotice, DiscoveredCamera, SavedCamera, ShootingMode } from '../types';
import type { MultiviewCamera, StageSnapshot, TilePhase, TileSnapshot } from './types';

export const TILE_COUNT = 4;

const PHOTO_MODES: ShootingMode[] = ['photo', 'panorama', 'night'];

export interface CoordinatorDeps {
  /** One session per tile, for the tile's lifetime (native: on the shared network; demo: a scene). */
  createSession(camera: MultiviewCamera, slot: number): CameraSession;
  /** Whether a camera's connect takes a Bluetooth turn (default: every camera). Demo cameras need none. */
  takesTurn?(camera: MultiviewCamera): boolean;
  /** Connect options for a camera (the shared network password for a station join). */
  connectOptions?(camera: MultiviewCamera): Promise<ConnectOptions | undefined> | ConnectOptions | undefined;
  /** Return a camera moved onto the shared network to its own access point (before disconnect). */
  restoreAccessPoint?(session: CameraSession, camera: MultiviewCamera): Promise<RestoreResult>;
  /** Slot membership changed (add, remove, a learned address): the stage journal. */
  onMembersChanged?(cameras: (MultiviewCamera | null)[]): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Stage monitor cadence (upstream 1 s). */
  tickMs?: number;
  /** Deadline on one automatic repair (upstream `repairDeadline`, 60 s). */
  repairDeadlineMs?: number;
  recordWindowMs?: number;
  /** Pause between AP-return attempts after a deferred pairing (upstream 3 s). */
  restoreRetryMs?: number;
}

interface TileRuntime {
  camera: MultiviewCamera | null;
  session: CameraSession | null;
  unsubs: (() => void)[];
  generation: number;
  queued: boolean;
  connecting: boolean;
  recovering: boolean;
  /** The tile reached live since its last (re)connect: only then does it repair by itself. */
  everLive: boolean;
  failure?: string;
  budget: RecoveryBudget;
  recordBusy: boolean;
  recordNote?: string;
}

const emptyRuntime = (): TileRuntime => ({
  camera: null,
  session: null,
  unsubs: [],
  generation: 0,
  queued: false,
  connecting: false,
  recovering: false,
  everLive: false,
  budget: new RecoveryBudget(2, 30_000),
  recordBusy: false,
});

export interface RecordRun {
  plan: RecordPlan;
  outcomes: Record<number, RecordOutcome>;
  summary: string;
}

type NoticeListener = (notice: CameraNotice) => void;

function sameTile(a: TileSnapshot, b: TileSnapshot): boolean {
  return (
    a.camera === b.camera &&
    a.session === b.session &&
    a.phase === b.phase &&
    a.status === b.status &&
    a.failure === b.failure &&
    a.recovering === b.recovering &&
    a.recording === b.recording &&
    a.recordBusy === b.recordBusy &&
    a.recordNote === b.recordNote &&
    a.queued === b.queued
  );
}

/** The session target a camera connects with: its shared network path, or a demo sighting. */
export function connectTarget(camera: MultiviewCamera): DiscoveredCamera | SavedCamera {
  if (camera.path) return { id: camera.id, name: camera.name, model: camera.model, path: camera.path };
  return { id: camera.id, name: camera.name, model: camera.model, rssi: -50, pairable: true, saved: false };
}

export class MultiviewCoordinator {
  private readonly tiles: TileRuntime[] = Array.from({ length: TILE_COUNT }, emptyRuntime);
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<NoticeListener>();
  private snapshot: StageSnapshot;
  private turn: Promise<void> = Promise.resolve();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private groupBusy = false;
  private closing = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: CoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? (() => {});
    this.snapshot = this.build(null);
  }

  // ───────────────────────────── observation ─────────────────────────────

  getSnapshot = (): StageSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onNotice(listener: NoticeListener): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  session(slot: number): CameraSession | null {
    return this.tiles[slot]?.session ?? null;
  }

  private notice(message: string, tone: CameraNotice['tone'] = 'info'): void {
    const n: CameraNotice = { id: `${this.now()}-${Math.random()}`, message, tone };
    this.noticeListeners.forEach((l) => l(n));
  }

  private tileSnapshot(slot: number): TileSnapshot {
    const rt = this.tiles[slot];
    const base = { slot, camera: rt.camera, session: rt.session, recovering: rt.recovering, recordBusy: rt.recordBusy, recordNote: rt.recordNote, queued: rt.queued };
    if (!rt.camera || !rt.session) return { ...base, phase: 'empty', status: MultiviewCopy.addCamera, recording: false };
    const s = rt.session.getState();
    const c = s.connection;
    const live = c.phase === 'live';
    const recording = live && s.recording.recording;
    let phase: TilePhase;
    let status: string;
    let failure: string | undefined;
    if (rt.queued) {
      phase = 'connecting';
      status = 'Waiting to connect';
    } else if (rt.recovering) {
      phase = 'reconnecting';
      status = MultiviewCopy.restoring;
    } else if (rt.connecting && c.phase !== 'live' && c.phase !== 'live-start') {
      phase = 'connecting';
      status = c.detail ?? MultiviewCopy.connectingPreview;
    } else if (live) {
      phase = 'live';
      status = MultiviewCopy.live;
    } else if (c.phase === 'live-start') {
      phase = 'waiting';
      status = c.detail ?? MultiviewCopy.waitingForVideo;
    } else if (c.phase === 'recovering') {
      phase = 'reconnecting';
      status = MultiviewCopy.reconnecting;
    } else if (c.phase === 'failed' || c.phase === 'disconnected' || c.phase === 'idle') {
      phase = 'failed';
      status = rt.everLive ? MultiviewCopy.connectionFailed : MultiviewCopy.couldNotConnect;
      failure = rt.failure ?? c.error ?? (c.phase === 'failed' ? undefined : 'The camera disconnected.');
    } else {
      phase = 'connecting';
      status = c.detail ?? MultiviewCopy.connectingPreview;
    }
    if (rt.failure && phase !== 'live') failure = rt.failure;
    return { ...base, phase, status, failure, recording };
  }

  private build(previous: StageSnapshot | null): StageSnapshot {
    const tiles = this.tiles.map((_, i) => {
      const next = this.tileSnapshot(i);
      const prev = previous?.tiles[i];
      return prev && sameTile(prev, next) ? prev : next;
    });
    const members = tiles.filter((t) => t.camera).length;
    const anyRecording = tiles.some((t) => t.recording);
    if (
      previous &&
      previous.groupBusy === this.groupBusy &&
      previous.closing === this.closing &&
      previous.members === members &&
      previous.anyRecording === anyRecording &&
      previous.tiles.every((t, i) => t === tiles[i])
    )
      return previous;
    return { tiles, groupBusy: this.groupBusy, closing: this.closing, members, anyRecording };
  }

  private publish = (): void => {
    const next = this.build(this.snapshot);
    if (next === this.snapshot) return;
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  };

  private membersChanged(): void {
    this.deps.onMembersChanged?.(this.tiles.map((t) => t.camera));
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Starts the 1 s stage monitor (recovery budgets and automatic repairs). */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), this.deps.tickMs ?? 1000);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  /** Leaves without returning cameras to their Wi-Fi (screen unmounted). Recording continues. */
  dispose(): void {
    this.stop();
    for (let slot = 0; slot < TILE_COUNT; slot++) this.clearSlot(slot, true);
    this.publish();
  }

  // ───────────────────────────── members ─────────────────────────────

  firstEmptySlot(): number | null {
    const i = this.tiles.findIndex((t) => !t.camera);
    return i < 0 ? null : i;
  }

  /** Adds `camera` to `slot` (default: the first empty one) and connects it in its turn. */
  async add(camera: MultiviewCamera, slot: number | null = null): Promise<boolean> {
    if (this.closing) return false;
    const target = slot ?? this.firstEmptySlot();
    if (target == null || target < 0 || target >= TILE_COUNT) {
      this.notice(MultiviewCopy.full, 'warning');
      return false;
    }
    if (this.tiles.some((t) => t.camera?.id === camera.id)) {
      this.notice(MultiviewCopy.duplicate, 'warning');
      return false;
    }
    if (this.tiles[target].camera) this.clearSlot(target, true);
    const rt = this.tiles[target];
    rt.camera = camera;
    rt.session = this.deps.createSession(camera, target);
    rt.budget.reset();
    rt.failure = undefined;
    rt.recordNote = undefined;
    const session = rt.session;
    rt.unsubs.push(
      session.subscribe(() => this.onSessionState(target, session)),
      session.onEvent((e) => {
        if (e.type === 'notice' && this.tiles[target].session === session) this.notice(`${camera.name} · ${e.notice.message}`, e.notice.tone);
      }),
    );
    this.membersChanged();
    this.log(`multiview: add ${camera.name} to slot ${target + 1}`);
    await this.connectTile(target, 'add');
    return true;
  }

  /** Clears `slot`. Its camera keeps recording; no camera command is sent beyond closing the link. */
  remove(slot: number): boolean {
    const rt = this.tiles[slot];
    if (!rt?.camera || rt.recordBusy || this.groupBusy || this.closing) return false;
    this.clearSlot(slot, true);
    this.membersChanged();
    this.publish();
    return true;
  }

  /** The operator's Reconnect: a fresh recovery budget and a new connect in turn. */
  async reconnect(slot: number): Promise<void> {
    const rt = this.tiles[slot];
    if (!rt?.camera || rt.connecting || rt.queued || rt.recovering || this.closing) return;
    rt.budget.reset();
    rt.failure = undefined;
    rt.recordNote = undefined;
    await this.connectTile(slot, 'reconnect');
  }

  /** A camera answered at a new address on the shared network: keep it for the next connect. */
  setCameraHost(cameraId: string, host: string): void {
    const rt = this.tiles.find((t) => t.camera?.id === cameraId);
    if (!rt?.camera?.path || rt.camera.path.host === host) return;
    rt.camera = { ...rt.camera, path: { ...rt.camera.path, host } };
    this.membersChanged();
    this.publish();
  }

  private clearSlot(slot: number, disconnect: boolean): void {
    const rt = this.tiles[slot];
    rt.generation += 1;
    rt.unsubs.forEach((u) => u());
    const session = rt.session;
    Object.assign(rt, { ...emptyRuntime(), generation: rt.generation, budget: rt.budget });
    rt.budget.reset();
    if (session && disconnect) session.disconnect().catch(() => {});
  }

  private onSessionState(slot: number, session: CameraSession): void {
    const rt = this.tiles[slot];
    if (rt.session !== session) return;
    if (!rt.everLive && session.getState().connection.phase === 'live') rt.everLive = true;
    this.publish();
  }

  /** One connect at a time (the Bluetooth turn); peers keep streaming meanwhile. */
  private inTurn(job: () => Promise<void>): Promise<void> {
    const run = this.turn.then(job, job);
    this.turn = run.catch(() => {});
    return run;
  }

  private connectTile(slot: number, why: 'add' | 'reconnect' | 'repair'): Promise<void> {
    const rt = this.tiles[slot];
    const generation = rt.generation;
    const session = rt.session;
    const camera = rt.camera;
    if (!session || !camera) return Promise.resolve();
    const turn = this.deps.takesTurn?.(camera) ?? true;
    rt.queued = turn;
    this.publish();
    const run = turn ? (job: () => Promise<void>) => this.inTurn(job) : (job: () => Promise<void>) => job();
    return run(async () => {
      if (generation !== rt.generation || this.closing) return;
      rt.queued = false;
      rt.connecting = true;
      rt.everLive = why === 'repair' ? rt.everLive : false;
      this.publish();
      try {
        const options = await this.deps.connectOptions?.(camera);
        if (generation !== rt.generation) return;
        const work = session.connect(connectTarget(camera), options).then(() => 'done' as const);
        // A repair has a deadline; past it the tile stops counting as recovering (late results drop).
        const result = why === 'repair' ? await raceDeadline(work, this.deps.repairDeadlineMs ?? 60_000, 'deadline' as const, 'error' as const) : await work.catch(() => 'error' as const);
        if (result !== 'done') this.log(`multiview: slot ${slot + 1} ${why} ${result}`);
      } finally {
        if (generation === rt.generation) {
          rt.connecting = false;
          this.publish();
        }
      }
    });
  }

  // ───────────────────────────── recovery ─────────────────────────────

  /** The stage monitor: budgets observe health; a tile that dropped after being live repairs alone. */
  tick(): void {
    if (this.closing) return;
    const now = this.now();
    this.tiles.forEach((rt, slot) => {
      const session = rt.session;
      if (!rt.camera || !session || rt.queued || rt.connecting || rt.recovering) return;
      const phase = session.getState().connection.phase;
      rt.budget.observe(phase === 'live', now);
      const dropped = phase === 'failed' || phase === 'disconnected' || phase === 'idle';
      if (!dropped || !rt.everLive || rt.budget.exhausted) return;
      if (!rt.budget.beginAttempt()) {
        rt.failure = MultiviewCopy.couldNotRestore;
        this.publish();
        return;
      }
      void this.repair(slot);
    });
  }

  private async repair(slot: number): Promise<void> {
    const rt = this.tiles[slot];
    const generation = rt.generation;
    rt.recovering = true;
    this.log(`multiview: slot ${slot + 1} repair ${rt.budget.used} of ${rt.budget.limit}`);
    this.publish();
    try {
      await this.connectTile(slot, 'repair');
    } finally {
      if (generation === rt.generation) {
        rt.recovering = false;
        const phase = rt.session?.getState().connection.phase;
        if (phase !== 'live' && phase !== 'live-start' && rt.budget.used >= rt.budget.limit) {
          rt.budget.exhaust();
          rt.failure = MultiviewCopy.couldNotRestore;
        }
        this.publish();
      }
    }
  }

  // ───────────────────────────── record ─────────────────────────────

  candidates(): RecordCandidate[] {
    const out: RecordCandidate[] = [];
    this.tiles.forEach((rt, slot) => {
      if (!rt.camera || !rt.session) return;
      const s = rt.session.getState();
      const live = s.connection.phase === 'live';
      out.push({
        slot,
        name: rt.camera.name,
        live,
        busy: rt.connecting || rt.queued || rt.recovering || rt.recordBusy || s.recording.countdown != null,
        recording: live ? s.recording.recording : null,
        photo: PHOTO_MODES.includes(s.format.shootingMode),
      });
    });
    return out;
  }

  /** The record press as a strict plan: every member (`null`) or one slot. */
  recordPlan(slot: number | null = null): RecordPlan {
    return planRecord(this.candidates(), slot);
  }

  canRecordTogether(): boolean {
    return !this.groupBusy && !this.closing && isExecutable(this.recordPlan(null));
  }

  /** Why the group press would send nothing now ('' when it would send). */
  recordBlocker(slot: number | null = null): string {
    const plan = this.recordPlan(slot);
    if (isExecutable(plan)) return '';
    return exclusionText(plan, (s) => this.tiles[s].camera?.name ?? `Camera ${s + 1}`);
  }

  /**
   * Sends an approved plan: one explicit start or stop per camera, each confirmed by the camera's
   * own report within the window. Nothing is resent; a partial result is never compensated.
   */
  async record(slot: number | null = null): Promise<RecordRun | null> {
    if (this.closing || this.groupBusy) return null;
    const plan = this.recordPlan(slot);
    if (!isExecutable(plan)) {
      const why = this.recordBlocker(slot);
      if (why) this.notice(why, 'warning');
      return null;
    }
    const together = slot == null;
    if (together) this.groupBusy = true;
    this.publish();
    try {
      // Revalidate against fresh state; a changed camera means nothing is sent.
      if (!planIsCurrent(plan, this.candidates(), slot)) {
        this.notice(RecordCopy.changed, 'warning');
        return null;
      }
      for (const s of plan.targets) {
        this.tiles[s].recordBusy = true;
        this.tiles[s].recordNote = RecordCopy.waiting;
      }
      this.publish();
      const results = await Promise.all(plan.targets.map((s) => this.commandRecord(s, plan.direction)));
      const outcomes: Record<number, RecordOutcome> = {};
      plan.targets.forEach((s, i) => {
        outcomes[s] = results[i];
        const rt = this.tiles[s];
        rt.recordBusy = false;
        const note = recordNote(results[i], plan.direction);
        if (note != null) rt.recordNote = note;
      });
      const confirmed = results.filter((o) => o === 'confirmed').length;
      const want = plan.direction === 'start';
      const allMatch = this.candidates().every((c) => c.recording === want);
      const summary = recordSummary(plan.direction, plan.targets.length, confirmed, allMatch);
      if (together) this.notice(summary, confirmed === plan.targets.length ? 'success' : 'warning');
      else if (results[0] !== 'confirmed') this.notice(`${this.tiles[plan.targets[0]].camera?.name ?? 'Camera'} · ${recordNote(results[0], plan.direction) ?? ''}`, 'warning');
      return { plan, outcomes, summary };
    } finally {
      if (together) this.groupBusy = false;
      this.publish();
    }
  }

  private async commandRecord(slot: number, direction: 'start' | 'stop'): Promise<RecordOutcome> {
    const rt = this.tiles[slot];
    const session = rt.session;
    const generation = rt.generation;
    if (!session) return 'failed';
    const want = direction === 'start';
    let refused = false;
    try {
      (want ? session.control.startRecording() : session.control.stopRecording()).catch(() => {
        refused = true;
      });
    } catch {
      return 'failed';
    }
    const deadline = this.now() + (this.deps.recordWindowMs ?? RECORD_CONFIRM_WINDOW_MS);
    while (this.now() < deadline) {
      await this.sleep(100);
      if (generation !== rt.generation || rt.session !== session) return 'superseded';
      if (refused) return 'refused';
      const s = session.getState();
      if (s.connection.phase === 'live' && s.recording.recording === want) return 'confirmed';
    }
    return 'unconfirmed';
  }

  // ───────────────────────────── exit ─────────────────────────────

  /** Whether Close returns cameras to their own Wi-Fi (any member joined a shared network). */
  get restoresNetworks(): boolean {
    return this.tiles.some((t) => !!t.camera?.path);
  }

  /**
   * Closes the stage: each shared-network camera returns to its own access point (in parallel,
   * retried after a deferred pairing), then every link closes. Recording continues on the
   * cameras. Returns the cameras that are still on the shared network.
   */
  async close(): Promise<{ pending: MultiviewCamera[] }> {
    if (this.closing) return { pending: [] };
    this.closing = true;
    this.stop();
    this.publish();
    const members = this.tiles.map((rt) => ({ rt, camera: rt.camera, session: rt.session })).filter((m) => m.camera && m.session);
    members.forEach((m) => (m.rt.generation += 1));
    const restore = this.deps.restoreAccessPoint;
    const returns = await Promise.all(
      members.map(async ({ camera, session }) => {
        if (!camera!.path || !restore) return true;
        return restoreWithRetry(
          () => restore(session!, camera!),
          () => this.sleep(this.deps.restoreRetryMs ?? 3000),
        );
      }),
    );
    const pending = members.filter((_, i) => !returns[i]).map((m) => m.camera!);
    await Promise.all(members.map(({ session }) => session!.disconnect().catch(() => {})));
    // The journal keeps the closed stage's cameras (for a later restore); only the links go.
    for (let slot = 0; slot < TILE_COUNT; slot++) this.clearSlot(slot, false);
    this.closing = false;
    this.publish();
    this.log(`multiview: closed, ${pending.length} camera(s) still on the shared network`);
    return { pending };
  }
}
