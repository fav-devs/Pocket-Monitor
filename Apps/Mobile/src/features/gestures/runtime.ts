/**
 * The phone's gesture runtime: native `PocketHands` readings in, camera commands out. The desktop's
 * input thread (`pm-desktop/src/input.rs` `Gestures::look`) for phones:
 *
 * - `PocketHands` reads the camera's live picture (or the front camera) at ≤ 15 Hz natively and
 *   hands over landmarks, faces when asked, and the time it took.
 * - {@link FeedReader} (`src/core/gestures/vision.ts`) turns them into gestures, pinch controls,
 *   the hold's progress and a face; {@link GestureDriver} carries those out on the session.
 * - A 10 Hz tick keeps the stick's heartbeat, lets go when the readings stop, and times out a face
 *   that was asked for and not found.
 * - The microphone's 10 ms blocks feed the {@link ClapDetector}; a double clap recentres.
 *
 * Nothing runs unless {@link GestureRuntime.configure} says it is active (gestures on, the live
 * view on screen, the app in front). Going inactive stops the models, the camera and the
 * microphone and lets go of the gimbal and the zoom.
 */
import type { HandsAudioEvent, HandsSeenEvent, HandsStatusEvent, PocketHandsNativeModule } from '@modules/pocket-native/src/types';
import type { CameraSession } from '@/camera/session';
import type { HandOverlay } from '@/core/gestures/vision';
import { ClapDetector } from '@/core/gestures/clap';
import { GestureDriver, type GestureTarget } from '@/core/gestures/drive';
import { requestMarker } from '@/features/markers/bridge';
import type { GestureMap } from '@/core/gestures/gesture';
import { HandSmoother, POINTS, type Hand } from '@/core/gestures/hand';
import { FeedReader, handOverlay, type Face, type VisionUpdate } from '@/core/gestures/vision';
import type { PhoneGestureStatus } from './status';

export interface GestureConfig {
  /** Gestures on, the live view on screen and the app in front. */
  active: boolean;
  source: 'cameraFeed' | 'frontCamera';
  /** The native video session to read for `cameraFeed`; null while there is none. */
  sessionId: string | null;
  map: GestureMap;
  handControl: boolean;
  stickIsRight: boolean;
  autoFaceTrack: boolean;
  /** The hand view is showing: publish the overlay. */
  handView: boolean;
}

export interface RuntimeDeps {
  hands: PocketHandsNativeModule;
  session: () => CameraSession;
  /** Seconds, monotonic. */
  now: () => number;
  status: (patch: Partial<PhoneGestureStatus>) => void;
  overlay: (overlay: HandOverlay | null) => void;
  /** Asks for the camera (front camera source) or the microphone; false when denied. */
  permit: (what: 'camera' | 'microphone') => Promise<boolean>;
  /** Defaults to `setInterval` / `clearInterval`. */
  every?: (ms: number, fn: () => void) => () => void;
  recordCountdown?: () => boolean;
}

const TICK_MS = 100;

/** The native hands as the reader takes them; a malformed one is dropped. */
export function handsOf(event: HandsSeenEvent): Hand[] {
  const aspect = event.aspect > 0 ? event.aspect : 16 / 9;
  const out: Hand[] = [];
  for (const h of event.hands ?? []) {
    const flat = h.points;
    if (!flat || flat.length < POINTS * 2) continue;
    const points: [number, number][] = [];
    for (let i = 0; i < POINTS; i++) points.push([Number(flat[2 * i]), Number(flat[2 * i + 1])]);
    if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) continue;
    out.push({ points, aspect, score: Number(h.score) || 0, right: !!h.right });
  }
  return out;
}

/** The session calls each gesture makes. */
export function sessionTarget(session: () => CameraSession, notice: (text: string) => void, recordCountdown: () => boolean): GestureTarget {
  const quiet = (p: Promise<unknown> | void) => {
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => {});
  };
  return {
    drive: (x, y) => session().gimbal.drive(x, y),
    zoomBy: (rate) => session().control.zoomBy(rate),
    recenter: () => quiet(session().gimbal.recenter()),
    flip: () => quiet(session().gimbal.flip()),
    stop: () => {
      const s = session();
      const state = s.getState();
      if (state.gimbal.program.status === 'running' || state.gimbal.program.status === 'preparing') s.gimbal.stopProgram();
      if (state.tracking.status !== 'idle') quiet(s.control.stopTracking());
    },
    toggleRecording: () => {
      const s = session();
      if (s.getState().recording.recording) quiet(s.control.stopRecording());
      else quiet(s.control.startRecording({ countdown: recordCountdown() }));
    },
    trackFace: ([x, y, width, height]) => {
      const s = session();
      const state = s.getState();
      if (!state.capabilities.tracking || !state.tracking.available) {
        notice('THIS CAMERA CANNOT TRACK');
        return;
      }
      quiet(s.control.startTracking({ x, y, width, height }));
    },
    stopTracking: () => quiet(session().control.stopTracking()),
    marker: () => requestMarker('gesture'),
    notice,
  };
}

const sameNative = (a: NativeRun | null, b: NativeRun | null) => a?.source === b?.source && a?.sessionId === b?.sessionId;

interface NativeRun {
  source: 'cameraFeed' | 'frontCamera';
  sessionId: string | null;
}

export class GestureRuntime {
  private config: GestureConfig | null = null;
  private reader = new FeedReader();
  private smoother = new HandSmoother();
  private driver: GestureDriver;
  private clap: ClapDetector | null = null;
  private pending: VisionUpdate[] = [];
  private native: NativeRun | null = null;
  /** Bumped on every start and stop, so a late answer from an earlier start is ignored. */
  private generation = 0;
  private wantsFaces = false;
  private microphone: 'off' | 'starting' | 'on' | 'denied' = 'off';
  private stopTick: (() => void) | null = null;
  private subs: { remove(): void }[] = [];
  private overlayShown = false;
  private overlayAt = -Infinity;
  private clapRate = 0;

  constructor(private readonly deps: RuntimeDeps) {
    this.driver = new GestureDriver(
      sessionTarget(deps.session, (text) => deps.status({ notice: { text, at: deps.now() * 1000 } }), deps.recordCountdown ?? (() => false)),
      () => {
        const s = deps.session().getState();
        return { tracking: s.tracking.status !== 'idle', recording: s.recording.recording };
      },
      {} as GestureMap,
    );
  }

  /** What should run now. Cheap to call on every change; only differences act. */
  configure(config: GestureConfig): void {
    this.config = config;
    this.driver.map = config.map;
    if (!config.active) {
      this.shutdown();
      return;
    }
    this.listen();
    this.driver.setFaceFinder(config.source === 'cameraFeed');
    if (!this.stopTick) this.stopTick = (this.deps.every ?? defaultEvery)(TICK_MS, () => this.tick());
    // The front camera does not depend on the camera's picture: a reconnect must not restart it.
    const want: NativeRun | null =
      config.source === 'frontCamera' ? { source: 'frontCamera', sessionId: null } : config.sessionId ? { source: 'cameraFeed', sessionId: config.sessionId } : null;
    if (!sameNative(this.native, want)) {
      this.stopNative();
      if (want) void this.startNative(want);
    }
    if (!want) this.deps.status({ state: 'waiting', source: config.source, provider: null, ms: null, error: null });
    if (!want && config.handView) {
      this.overlayShown = true;
      this.deps.overlay(handOverlay(config.source, 'no picture', null, [], config.stickIsRight));
    }
    if (this.microphone === 'off') void this.startMicrophone();
    if (!config.handView && this.overlayShown) {
      this.overlayShown = false;
      this.deps.overlay(null);
    }
  }

  /** Stops everything for good (the host unmounting). */
  dispose(): void {
    this.shutdown();
  }

  private listen() {
    if (this.subs.length) return;
    const { hands } = this.deps;
    this.subs = [
      hands.addListener('onHands', (e) => this.onHands(e)),
      hands.addListener('onStatus', (e) => this.onStatus(e)),
      hands.addListener('onAudio', (e) => this.onAudio(e)),
    ];
  }

  private shutdown() {
    this.stopNative();
    this.stopMicrophone();
    this.stopTick?.();
    this.stopTick = null;
    for (const sub of this.subs) sub.remove();
    this.subs = [];
    this.driver.release();
    this.driver.setFaceFinder(false);
    if (this.overlayShown) this.deps.overlay(null);
    this.overlayShown = false;
    this.deps.status({ state: 'off', provider: null, ms: null, error: null, hold: null, microphone: 'off' });
  }

  private async startNative(run: NativeRun) {
    const generation = ++this.generation;
    this.native = run;
    this.reader = new FeedReader();
    this.smoother.reset();
    this.pending = [];
    this.wantsFaces = false;
    this.deps.status({ state: 'starting', source: run.source, provider: null, ms: null, error: null });
    if (run.source === 'frontCamera' && !(await this.deps.permit('camera'))) {
      if (generation !== this.generation) return;
      this.deps.status({ state: 'failed', error: 'camera access is off' });
      return;
    }
    if (generation !== this.generation) return;
    try {
      await this.deps.hands.start({ source: run.source, sessionId: run.sessionId, rate: 15, width: 480 });
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.status({ state: 'failed', error: message || 'not running' });
    }
  }

  private stopNative() {
    if (!this.native) return;
    this.generation += 1;
    this.native = null;
    try {
      this.deps.hands.stop();
    } catch {
      // Already stopped.
    }
    // Let go of whatever a pinch held: no more readings are coming.
    this.driver.release();
    this.deps.status({ hold: null });
  }

  private async startMicrophone() {
    this.microphone = 'starting';
    const allowed = await this.deps.permit('microphone');
    if (this.microphone !== 'starting') return;
    if (!allowed) {
      this.microphone = 'denied';
      this.deps.status({ microphone: 'denied' });
      return;
    }
    try {
      await this.deps.hands.startMicrophone();
      if (this.microphone !== 'starting') {
        this.deps.hands.stopMicrophone();
        return;
      }
      this.microphone = 'on';
      this.deps.status({ microphone: 'on' });
    } catch {
      if (this.microphone === 'starting') this.microphone = 'denied';
      this.deps.status({ microphone: 'denied' });
    }
  }

  private stopMicrophone() {
    const was = this.microphone;
    this.microphone = 'off';
    this.clap = null;
    if (was === 'on') {
      try {
        this.deps.hands.stopMicrophone();
      } catch {
        // Already closed.
      }
    }
  }

  private onHands(event: HandsSeenEvent) {
    if (!this.native || !this.config?.active) return;
    const faces: Face[] | null = Array.isArray(event.faces) ? event.faces.map((f) => ({ x: f.x, y: f.y, width: f.width, height: f.height, score: f.score })) : null;
    this.pending.push({ kind: 'seen', hands: this.smoother.smooth(handsOf(event)), faces, ms: Number(event.ms) || 0 });
    this.look();
  }

  private onStatus(event: HandsStatusEvent) {
    if (!this.native) return;
    if (event.state === 'ready') {
      this.pending.push({ kind: 'ready', provider: event.provider ?? 'CPU' });
      this.deps.status({ state: 'running', provider: event.provider ?? null, error: null });
    } else if (event.state === 'failed') {
      this.pending.push({ kind: 'failed', error: event.error ?? 'failed' });
      this.deps.status({ state: 'failed', error: event.error ?? 'not running' });
    }
  }

  private onAudio(event: HandsAudioEvent) {
    if (this.microphone !== 'on' || !this.config?.active) return;
    const rate = Number(event.sampleRate) || 16000;
    if (!this.clap || this.clapRate !== rate) {
      this.clap = new ClapDetector(rate);
      this.clapRate = rate;
    }
    if (this.clap.feedBlocks(event.peaks ?? [], event.levels ?? [])) this.driver.clap();
  }

  private tick() {
    if (!this.config?.active) return;
    this.look();
    this.driver.tick(this.deps.now());
  }

  /** One look at what came in (`Gestures::look`). */
  private look() {
    const config = this.config;
    if (!config) return;
    const now = this.deps.now();
    const updates = this.pending;
    this.pending = [];
    const fresh = updates.some((u) => u.kind === 'seen');
    const state = this.deps.session().getState();
    const cameraFeed = config.source === 'cameraFeed';
    const looked = this.reader.read(updates, state.gimbal.available ? { yaw: state.gimbal.yaw, pitch: state.gimbal.pitch } : null, now, {
      map: config.map,
      stickIsRight: config.stickIsRight,
      handControl: config.handControl,
      faceRequested: this.driver.takeFaceRequest(),
      // A face in the front camera is not in the camera's picture: it cannot be tracked.
      autoFace: config.autoFaceTrack && cameraFeed,
      tracking: state.tracking.status !== 'idle',
    });
    const wants = this.reader.wantsFaces();
    if (wants !== this.wantsFaces && this.native) {
      this.wantsFaces = wants;
      try {
        this.deps.hands.setWantsFaces(wants);
      } catch {
        // The module went away; the next start asks again.
      }
    }
    for (const control of looked.controls) this.driver.handControl(control, now);
    for (const gesture of looked.gestures) this.driver.gesture(gesture);
    if (fresh) {
      this.driver.gestureProgress(looked.progress);
      const last = updates.filter((u) => u.kind === 'seen').pop();
      this.deps.status({ hold: this.driver.hold(), ms: last?.kind === 'seen' ? last.ms : null });
    }
    if (looked.face) this.driver.trackFace(looked.face);
    if (looked.noFace) this.driver.noFace();
    // The hand view follows each reading (≤ 15 Hz), and the status line a few times a second
    // while nothing is read.
    if (config.handView && this.native && (fresh || now - this.overlayAt >= 0.25)) {
      this.overlayShown = true;
      this.overlayAt = now;
      this.deps.overlay(handOverlay(config.source, this.reader.status(), this.reader.scene(), this.reader.faces(now), config.stickIsRight));
    }
  }
}

function defaultEvery(ms: number, fn: () => void): () => void {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}
