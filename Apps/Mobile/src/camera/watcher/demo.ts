/**
 * Simulated sharing hosts for the web preview (and tests): a host list, and a host that runs a
 * demo camera and answers the relay messages like a phone would. The picture is the demo scene.
 *
 * Hosts are found after a short delay; "B-cam" asks for passcode `1234`; a control request is
 * granted after a moment (standing in for the host operator's Grant); granted commands go to the
 * host's demo camera through the same `hostActionFor` a real host uses.
 */
import { DemoCameraSession } from '../demo/DemoCameraSession';
import type { CameraSession, Unsubscribe } from '../session';
import { applyHostAction } from './host';
import { hostActionFor, relayStateFromCamera } from './mapping';
import {
  RELAY_LEGACY_SERVICE_TYPE,
  RELAY_SERVICE_TYPE,
  decodeCommand,
  decodeHello,
  encodeControlToken,
  encodeHello,
  encodeJoinDenied,
  encodeState,
  hostAccepts,
} from './protocol';
import type {
  RelayHostAdvert,
  RelayHostsEvent,
  RelayWatcherMessageEvent,
  RelayWatcherStatsEvent,
  RelayWatcherStatusEvent,
  RelayWatcherTransport,
} from './transport';

export interface DemoHost extends RelayHostAdvert {
  passcode: string;
  /** Simulated round trip, ms (shown in the list). */
  latencyMs: number;
  model: 'osmo-pocket-3' | 'osmo-pocket-4-pro';
}

export const DEMO_HOSTS: DemoHost[] = [
  {
    id: `${RELAY_SERVICE_TYPE}/Studio iPhone`,
    name: 'Studio iPhone',
    camera: 'Pocket 4 Pro',
    serviceType: RELAY_SERVICE_TYPE,
    watchable: true,
    passcode: '',
    latencyMs: 18,
    model: 'osmo-pocket-4-pro',
  },
  {
    id: `${RELAY_LEGACY_SERVICE_TYPE}/B-cam`,
    name: 'B-cam',
    camera: 'Pocket 3',
    serviceType: RELAY_LEGACY_SERVICE_TYPE,
    watchable: true,
    passcode: '1234',
    latencyMs: 41,
    model: 'osmo-pocket-3',
  },
];

type Listener<T> = (e: T) => void;

interface Running {
  host: DemoHost;
  camera: CameraSession;
  timers: ReturnType<typeof setInterval>[];
  holder: boolean;
  frames: number;
}

export class DemoRelayTransport implements RelayWatcherTransport {
  readonly simulated = true;
  private status = new Set<Listener<RelayWatcherStatusEvent>>();
  private messages = new Set<Listener<RelayWatcherMessageEvent>>();
  private stats = new Set<Listener<RelayWatcherStatsEvent>>();
  private running = new Map<string, Running>();

  constructor(
    private readonly hosts: DemoHost[] = DEMO_HOSTS,
    private readonly delayMs = 450,
  ) {}

  deviceName() {
    return 'Browser';
  }

  browse(onHosts: (event: RelayHostsEvent) => void): Unsubscribe {
    onHosts({ hosts: [], browsing: true });
    const t = setTimeout(() => onHosts({ hosts: this.hosts.map(({ passcode: _p, latencyMs: _l, model: _m, ...h }) => h), browsing: true }), this.delayMs * 2);
    return () => clearTimeout(t);
  }

  hostInfo(id: string): DemoHost | undefined {
    return this.hosts.find((h) => h.id === id);
  }

  async join(sessionId: string, hostId: string, helloJson: string): Promise<void> {
    this.leave(sessionId);
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) throw new Error('That feed is no longer on this Wi-Fi.');
    const hello = decodeHello(helloJson);
    const camera = new DemoCameraSession(host.model);
    const run: Running = { host, camera, timers: [], holder: false, frames: 0 };
    this.running.set(sessionId, run);
    this.emitStatus({ sessionId, state: 'connecting' });
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(() => this.running.get(sessionId) === run && fn(), ms);
      run.timers.push(t as unknown as ReturnType<typeof setInterval>);
    };
    later(this.delayMs / 2, () => this.emitStatus({ sessionId, state: 'open' }));
    later(this.delayMs, () => {
      const refusal = hello ? hostAccepts(hello, host.passcode) : { reason: 'The host could not read this join.', passcodeRequired: false };
      if (refusal) {
        this.emitMessage({ sessionId, kind: 'denied', json: encodeJoinDenied(refusal) });
        this.stop(sessionId);
        return;
      }
      void camera.connect({ id: `demo-${host.model}`, name: host.camera, model: host.model, rssi: -50, pairable: true, saved: false });
      this.emitMessage({ sessionId, kind: 'hello', json: encodeHello({ version: 1, hostName: host.name, cameraName: host.camera }) });
      this.emitMessage({ sessionId, kind: 'token', json: encodeControlToken({ holderName: 'Host', holderIsRecipient: false }) });
      const state = setInterval(() => {
        const s = camera.getState();
        if (s.connection.phase !== 'live') return;
        this.emitMessage({ sessionId, kind: 'state', json: encodeState(relayStateFromCamera(s, true)) });
      }, 200);
      const stats = setInterval(() => {
        run.frames += 25;
        this.emitStats({ sessionId, framesPerSec: 25, kbps: 6200, frames: run.frames, lastFrameAgeMs: 30, codec: 'hevc', catchingUp: false });
      }, 1000);
      run.timers.push(state, stats);
    });
  }

  leave(sessionId: string): void {
    this.stop(sessionId);
  }

  requestControl(sessionId: string): void {
    const run = this.running.get(sessionId);
    if (!run || run.holder) return;
    const t = setTimeout(() => {
      if (this.running.get(sessionId) !== run) return;
      run.holder = true;
      this.emitMessage({ sessionId, kind: 'token', json: encodeControlToken({ holderName: this.deviceName(), holderIsRecipient: true }) });
    }, 1200);
    run.timers.push(t as unknown as ReturnType<typeof setInterval>);
  }

  releaseControl(sessionId: string): void {
    const run = this.running.get(sessionId);
    if (!run || !run.holder) return;
    run.holder = false;
    this.emitMessage({ sessionId, kind: 'token', json: encodeControlToken({ holderName: 'Host', holderIsRecipient: false }) });
  }

  sendCommand(sessionId: string, json: string): void {
    const run = this.running.get(sessionId);
    const command = decodeCommand(json);
    if (!run || !run.holder || !command) return;
    const action = hostActionFor(command, run.camera.getState());
    if (action) void applyHostAction(run.camera, action).catch(() => {});
  }

  onStatus(cb: Listener<RelayWatcherStatusEvent>): Unsubscribe {
    this.status.add(cb);
    return () => this.status.delete(cb);
  }

  onMessage(cb: Listener<RelayWatcherMessageEvent>): Unsubscribe {
    this.messages.add(cb);
    return () => this.messages.delete(cb);
  }

  onStats(cb: Listener<RelayWatcherStatsEvent>): Unsubscribe {
    this.stats.add(cb);
    return () => this.stats.delete(cb);
  }

  private stop(sessionId: string) {
    const run = this.running.get(sessionId);
    if (!run) return;
    this.running.delete(sessionId);
    run.timers.forEach((t) => {
      clearInterval(t);
      clearTimeout(t as unknown as ReturnType<typeof setTimeout>);
    });
    void run.camera.disconnect().catch(() => {});
  }

  private emitStatus(e: RelayWatcherStatusEvent) {
    this.status.forEach((l) => l(e));
  }

  private emitMessage(e: RelayWatcherMessageEvent) {
    this.messages.forEach((l) => l(e));
  }

  private emitStats(e: RelayWatcherStatsEvent) {
    this.stats.forEach((l) => l(e));
  }
}
