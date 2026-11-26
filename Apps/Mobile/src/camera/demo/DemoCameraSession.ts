import { initialCameraState, modelDisplayName } from '../defaults';
import type {
  CameraController,
  CameraMediaItem,
  CameraMediaService,
  CameraSession,
  ConnectOptions,
  GimbalController,
  SessionEvent,
  Unsubscribe,
  VideoSource,
} from '../session';
import type {
  CameraModelId,
  CameraState,
  ConnectionPhase,
  DiscoveredCamera,
  MotionWaypoint,
  SavedCamera,
} from '../types';
import { demoMediaItems } from './demoMedia';

type Listener<T> = (value: T) => void;

const CONNECT_STEPS: { phase: ConnectionPhase; detail: string; ms: number }[] = [
  { phase: 'bluetooth', detail: 'Finding the camera over Bluetooth', ms: 500 },
  { phase: 'authorizing', detail: 'Waiting for the camera to allow this phone', ms: 500 },
  { phase: 'wifi-handoff', detail: 'Camera is sharing its Wi-Fi', ms: 400 },
  { phase: 'joining-wifi', detail: 'Joining camera Wi-Fi', ms: 600 },
  { phase: 'datalink', detail: 'Opening the camera link', ms: 400 },
  { phase: 'live-start', detail: 'Starting live view', ms: 400 },
];

const DEMO_CAMERAS: DiscoveredCamera[] = [
  { id: 'demo-pocket-4-pro', name: 'Pocket 4 Pro', model: 'osmo-pocket-4-pro', rssi: -48, pairable: true, saved: false },
  { id: 'demo-pocket-3', name: 'Pocket 3', model: 'osmo-pocket-3', rssi: -61, pairable: true, saved: false },
  { id: 'demo-nano', name: 'Nano', model: 'osmo-nano', rssi: -72, pairable: false, saved: false },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const nearest = (options: number[], value: number) =>
  options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) ? o : best), options[0]);

/**
 * A believable offline camera. Every control mutates state the way the real camera reports
 * back, with small delays, so the whole UI can be exercised on web without hardware.
 */
export class DemoCameraSession implements CameraSession {
  readonly kind = 'demo' as const;
  video: VideoSource = { kind: 'none' };
  private state: CameraState;
  private listeners = new Set<Listener<CameraState>>();
  private eventListeners = new Set<Listener<SessionEvent>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private driveVector = { x: 0, y: 0 };
  private zoomRate = 0;
  private media: CameraMediaItem[] = demoMediaItems();
  private lastTarget: DiscoveredCamera | SavedCamera | null = null;
  private t = 0;

  constructor(model: CameraModelId = 'osmo-pocket-4-pro') {
    this.state = initialCameraState(model);
  }

  getState() {
    return this.state;
  }

  subscribe(listener: Listener<CameraState>): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(listener: Listener<SessionEvent>): Unsubscribe {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private set(mutator: (draft: CameraState) => CameraState) {
    this.state = mutator(this.state);
    this.listeners.forEach((l) => l(this.state));
  }

  private emit(event: SessionEvent) {
    this.eventListeners.forEach((l) => l(event));
  }

  private notice(message: string, tone: 'info' | 'warning' | 'error' | 'success' = 'info') {
    this.emit({ type: 'notice', notice: { id: `${Date.now()}-${Math.random()}`, message, tone } });
  }

  startScan(onFound: (cameras: DiscoveredCamera[]) => void): Unsubscribe {
    const found: DiscoveredCamera[] = [];
    const timers = DEMO_CAMERAS.map((cam, i) =>
      setTimeout(() => {
        found.push(cam);
        onFound([...found]);
      }, 400 + i * 700),
    );
    return () => timers.forEach(clearTimeout);
  }

  async connect(target: DiscoveredCamera | SavedCamera, _options?: ConnectOptions): Promise<void> {
    this.lastTarget = target;
    const fresh = initialCameraState(target.model);
    this.set(() => ({
      ...fresh,
      identity: { id: target.id, name: target.name, model: target.model, firmware: '01.04.02.30', serial: 'DEMO0000001', ssid: `OsmoPocket-${target.id.slice(-4).toUpperCase()}` },
      connection: { ...fresh.connection, phase: 'scanning', detail: 'Looking for the camera', transport: 'demo' },
    }));
    for (const step of CONNECT_STEPS) {
      await new Promise((r) => setTimeout(r, step.ms));
      this.set((s) => ({ ...s, connection: { ...s.connection, phase: step.phase, detail: step.detail } }));
    }
    this.video = { kind: 'demo', scene: 'studio' };
    this.set((s) => ({
      ...s,
      connection: {
        ...s.connection,
        phase: 'live',
        detail: undefined,
        signalBars: 4,
        videoFps: 30,
        videoKbps: 9800,
        streamWidth: 1280,
        streamHeight: 720,
        streamCodec: 'hevc',
      },
      exposure: { ...s.exposure, iso: 200, shutterDenom: 60, meteredEv: 0.2 },
      whiteBalance: { ...s.whiteBalance, kelvin: 5600 },
      recording: { ...s.recording, remainingSec: 3 * 3600 + 12 * 60 },
      power: { ...s.power, batteryPercent: 78, storageFreeMb: 61_200, storageTotalMb: 122_000, sdPresent: true },
    }));
    this.startSimulation();
  }

  async disconnect(): Promise<void> {
    this.stopSimulation();
    this.video = { kind: 'none' };
    this.set((s) => ({ ...s, connection: { ...s.connection, phase: 'disconnected', signalBars: 0, videoFps: 0 } }));
  }

  async retry(): Promise<void> {
    if (this.lastTarget) await this.connect(this.lastTarget);
  }

  private startSimulation() {
    this.stopSimulation();
    const tickMs = 50;
    this.timers.push(
      setInterval(() => {
        this.t += tickMs / 1000;
        const t = this.t;
        const speedScale = { slow: 30, normal: 60, fast: 120 }[this.state.gimbal.speed];
        this.set((s) => {
          const g = s.gimbal;
          const locked = g.lockedAllAxes;
          const yaw = locked ? g.yaw : clamp(g.yaw + this.driveVector.x * speedScale * (tickMs / 1000), -230, 230);
          const pitch = locked ? g.pitch : clamp(g.pitch + this.driveVector.y * speedScale * (tickMs / 1000), -90, 60);
          const zoomFactor = clamp(s.zoom.factor * Math.pow(1.8, this.zoomRate * (tickMs / 1000)), s.zoom.min, s.zoom.max);
          const talk = 0.5 + 0.5 * Math.sin(t * 2.1) * Math.sin(t * 0.7);
          const l = -38 + talk * 26 + Math.random() * 4;
          const r = l - 1.5 + Math.random() * 3;
          return {
            ...s,
            gimbal: { ...g, yaw, pitch, roll: Math.sin(t * 0.4) * 0.6 },
            zoom: { ...s.zoom, factor: zoomFactor },
            level: { roll: Math.sin(t * 0.3) * 1.4, pitch: pitch * 0.02 + Math.sin(t * 0.25) },
            audio: {
              ...s.audio,
              left: { rmsDb: l, peakDb: Math.min(0, l + 6) },
              right: { rmsDb: r, peakDb: Math.min(0, r + 6) },
            },
            connection: {
              ...s.connection,
              videoFps: 29 + Math.round(Math.random()),
              videoKbps: 9400 + Math.round(Math.random() * 900),
              lastFrameAgeMs: 20 + Math.random() * 15,
            },
          };
        });
      }, tickMs),
    );
    this.timers.push(
      setInterval(() => {
        this.set((s) => {
          if (!s.recording.recording) return s;
          const elapsed = s.recording.elapsedSec + 1;
          return {
            ...s,
            recording: { ...s.recording, elapsedSec: elapsed, remainingSec: Math.max(0, s.recording.remainingSec - 1), timecode: tc(elapsed) },
            power: { ...s.power, storageFreeMb: Math.max(0, s.power.storageFreeMb - 12) },
          };
        });
      }, 1000),
    );
  }

  private stopSimulation() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  private delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));

  readonly control: CameraController = {
    startRecording: async (options) => {
      if (options?.countdown) {
        for (let n = 3; n > 0; n--) {
          this.set((s) => ({ ...s, recording: { ...s.recording, countdown: n } }));
          await this.delay(1000);
        }
      }
      await this.delay();
      this.set((s) => ({ ...s, recording: { ...s.recording, countdown: null, recording: true, elapsedSec: 0, timecode: tc(0) } }));
      this.emit({ type: 'recording-started' });
    },
    stopRecording: async () => {
      await this.delay();
      const elapsed = this.state.recording.elapsedSec;
      this.set((s) => ({ ...s, recording: { ...s.recording, recording: false } }));
      this.media.unshift({
        id: `demo-clip-${Date.now()}`,
        kind: 'video',
        fileName: `DJI_${String(this.media.length + 1).padStart(4, '0')}.MP4`,
        createdAt: Date.now(),
        durationSec: elapsed,
        sizeBytes: elapsed * 1_250_000,
        width: 3840,
        height: 2160,
        fps: this.state.format.fps,
        colorMode: this.state.format.colorMode,
        favorite: false,
      });
      this.emit({ type: 'recording-stopped' });
    },
    capturePhoto: async () => {
      this.set((s) => ({ ...s, recording: { ...s.recording, capturingStill: true } }));
      await this.delay(300);
      this.set((s) => ({ ...s, recording: { ...s.recording, capturingStill: false } }));
      this.emit({ type: 'photo-captured' });
    },
    setShootingMode: async (mode) => {
      await this.delay();
      this.set((s) => ({ ...s, format: { ...s.format, shootingMode: mode } }));
    },
    setExposureMode: async (mode) => {
      await this.delay();
      this.set((s) => ({
        ...s,
        exposure: { ...s.exposure, mode, isoAuto: mode === 'auto', shutterAuto: mode === 'auto' },
      }));
    },
    setIso: async (iso) => {
      await this.delay();
      this.set((s) => ({
        ...s,
        exposure:
          iso === 'auto'
            ? { ...s.exposure, isoAuto: true }
            : { ...s.exposure, isoAuto: false, mode: 'manual', iso: nearest(s.exposure.isoOptions, iso) },
      }));
    },
    setIsoLimit: async (iso) => {
      await this.delay();
      this.set((s) => ({ ...s, exposure: { ...s.exposure, isoLimit: iso } }));
    },
    setShutter: async (denom) => {
      await this.delay();
      this.set((s) => ({
        ...s,
        exposure:
          denom === 'auto'
            ? { ...s.exposure, shutterAuto: true }
            : { ...s.exposure, shutterAuto: false, mode: 'manual', shutterDenom: denom },
      }));
    },
    setEv: async (ev) => {
      await this.delay();
      this.set((s) => ({ ...s, exposure: { ...s.exposure, ev: nearest(s.exposure.evOptions, ev) } }));
    },
    setAperture: async (fNumber) => {
      await this.delay();
      this.set((s) => ({ ...s, exposure: { ...s.exposure, aperture: fNumber } }));
    },
    setWhiteBalance: async (change) => {
      await this.delay();
      this.set((s) => {
        const wb = { ...s.whiteBalance, ...change };
        if (change.kelvin !== undefined) wb.preset = 'custom';
        const presetKelvin: Record<string, number> = { daylight: 5600, cloudy: 6500, incandescent: 3200, fluorescent: 4000 };
        if (change.preset && presetKelvin[change.preset]) wb.kelvin = presetKelvin[change.preset];
        return { ...s, whiteBalance: wb };
      });
    },
    setFormat: async (change) => {
      await this.delay(250);
      this.set((s) => ({ ...s, format: { ...s.format, ...change } }));
      this.notice('Format changed');
    },
    setFocusMode: async (mode) => {
      await this.delay();
      this.set((s) => ({ ...s, focus: { ...s.focus, mode } }));
    },
    focusAt: async (point) => {
      await this.delay();
      this.set((s) => ({ ...s, focus: { ...s.focus, ...point, hasPoint: true } }));
    },
    setManualFocus: async (position) => {
      this.set((s) => ({ ...s, focus: { ...s.focus, mode: 'mf', manualPosition: clamp(position, 0, 1) } }));
    },
    setZoom: async (factor) => {
      this.set((s) => ({ ...s, zoom: { ...s.zoom, factor: clamp(factor, s.zoom.min, s.zoom.max) } }));
    },
    zoomBy: (rate) => {
      this.zoomRate = clamp(rate, -1, 1);
    },
    startTracking: async (target) => {
      const box = 'width' in target ? target : { x: target.x - 0.08, y: target.y - 0.12, width: 0.16, height: 0.24 };
      this.set((s) => ({ ...s, tracking: { ...s.tracking, status: 'searching', box } }));
      await this.delay(500);
      this.set((s) => ({ ...s, tracking: { ...s.tracking, status: 'tracking', label: 'Person' } }));
    },
    stopTracking: async () => {
      this.set((s) => ({ ...s, tracking: { ...s.tracking, status: 'idle', box: undefined, label: undefined } }));
    },
    setAudio: async (change) => {
      await this.delay();
      this.set((s) => ({ ...s, audio: { ...s.audio, ...change } }));
    },
  };

  readonly gimbal: GimbalController = {
    drive: (x, y) => {
      this.driveVector = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    },
    recenter: async () => {
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, recentering: true } }));
      await this.delay(600);
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, recentering: false, yaw: 0, pitch: 0 } }));
    },
    flip: async (face) => {
      await this.delay(400);
      this.set((s) => ({
        ...s,
        gimbal: { ...s.gimbal, face: face ?? (s.gimbal.face === 'front' ? 'selfie' : 'front'), yaw: 0 },
      }));
    },
    setMode: async (mode) => {
      await this.delay();
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, mode } }));
      this.notice(`Gimbal ${mode.replace('-', ' ')}`);
    },
    setSpeed: async (speed) => {
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, speed } }));
    },
    setLockedAllAxes: (locked) => {
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, lockedAllAxes: locked } }));
    },
    captureWaypoint: async (slot) => {
      const wp: MotionWaypoint = { yaw: this.state.gimbal.yaw, pitch: this.state.gimbal.pitch, zoom: this.state.zoom.factor };
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, program: { ...s.gimbal.program, [slot]: wp } } }));
      return wp;
    },
    clearWaypoint: (slot) => {
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, program: { ...s.gimbal.program, [slot]: undefined } } }));
    },
    configureProgram: (options) => {
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, program: { ...s.gimbal.program, ...options } } }));
    },
    runProgram: async () => {
      const p = this.state.gimbal.program;
      if (!p.a || !p.b) {
        this.notice('Set A and B first', 'warning');
        return;
      }
      const legs = [p.a, p.b, ...(p.c ? [p.c] : [])];
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, program: { ...s.gimbal.program, status: 'preparing', progress: 0 } } }));
      await this.delay(500);
      const total = p.legSeconds[0] + (p.c ? p.legSeconds[1] : 0);
      const start = Date.now();
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, program: { ...s.gimbal.program, status: 'running' } } }));
      await new Promise<void>((resolve) => {
        const id = setInterval(() => {
          if (this.state.gimbal.program.status !== 'running') {
            clearInterval(id);
            resolve();
            return;
          }
          const elapsed = (Date.now() - start) / 1000;
          const progress = clamp(elapsed / total, 0, 1);
          const legIndex = !p.c || elapsed < p.legSeconds[0] ? 0 : 1;
          const legT = legIndex === 0 ? clamp(elapsed / p.legSeconds[0], 0, 1) : clamp((elapsed - p.legSeconds[0]) / p.legSeconds[1], 0, 1);
          const from = legs[legIndex];
          const to = legs[legIndex + 1];
          this.set((s) => ({
            ...s,
            gimbal: {
              ...s.gimbal,
              yaw: from.yaw + (to.yaw - from.yaw) * legT,
              pitch: from.pitch + (to.pitch - from.pitch) * legT,
              program: { ...s.gimbal.program, progress },
            },
          }));
          if (progress >= 1) {
            clearInterval(id);
            this.set((s) => ({ ...s, gimbal: { ...s.gimbal, program: { ...s.gimbal.program, status: 'done', progress: 1 } } }));
            resolve();
          }
        }, 50);
      });
    },
    stopProgram: () => {
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, program: { ...s.gimbal.program, status: 'idle', progress: 0 } } }));
    },
    level: async () => {
      await this.delay(300);
      this.set((s) => ({ ...s, gimbal: { ...s.gimbal, pitch: 0, roll: 0 } }));
    },
  };

  readonly media: CameraMediaService = {
    list: async () => {
      await this.delay(400);
      return [...this.media];
    },
    setFavorite: async (id, favorite) => {
      this.media = this.media.map((m) => (m.id === id ? { ...m, favorite } : m));
    },
    delete: async (ids) => {
      await this.delay(300);
      this.media = this.media.filter((m) => !ids.includes(m.id));
    },
    download: async (id, onProgress) => {
      const item = this.media.find((m) => m.id === id);
      const total = item?.sizeBytes ?? 1;
      for (let i = 1; i <= 10; i++) {
        await this.delay(120);
        onProgress?.({ itemId: id, bytesDone: (total * i) / 10, bytesTotal: total, rate: total / 1.2 });
      }
      return item?.previewUrl ?? '';
    },
    resumeLive: async () => {},
  };
}

function tc(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s, 0].map((n) => String(n).padStart(2, '0')).join(':');
}

export { modelDisplayName };
