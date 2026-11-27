import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialCameraState } from '../defaults';
import { SwitchableClock } from '../native/clock';
import type { CameraSession, VideoSource } from '../session';
import type { CameraState, ConnectionPhase, SavedCamera } from '../types';
import { notificationChanged, serverNotification } from './notification';
import { createRelayHost } from './relayHostPort';
import { ServerController, ServerCopy, type ServerDeps } from './ServerController';
import { availableSetups, defaultSetup, sessionFitsSetup, setupReadiness } from './setups';
import { serverWifi } from './serverWifi';
import { createSimulatedBackground, createSimulatedRelay } from './simulated';

const CAMERA: SavedCamera = { id: 'cam-1', name: 'Pocket 3', model: 'osmo-pocket-3', path: { kind: 'station', ssid: 'Studio' } };

class FakeSession {
  readonly kind = 'native' as const;
  video: VideoSource = { kind: 'none' };
  state: CameraState = initialCameraState('osmo-pocket-3');
  listeners = new Set<(s: CameraState) => void>();
  connect = vi.fn(async (target: SavedCamera) => {
    this.patch('scanning', { identity: { id: target.id, name: target.name, model: target.model } });
  });
  disconnect = vi.fn(async () => {
    this.video = { kind: 'none' };
    this.patch('disconnected');
  });
  retry = vi.fn(async () => this.patch('scanning'));
  control = { startRecording: vi.fn(async () => {}), stopRecording: vi.fn(async () => {}) };
  getState = () => this.state;
  subscribe = (l: (s: CameraState) => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  onEvent = () => () => {};
  patch(phase: ConnectionPhase, extra: Partial<CameraState> = {}, transport?: CameraState['connection']['transport']) {
    this.state = { ...this.state, ...extra, connection: { ...this.state.connection, phase, ...(transport ? { transport } : {}) } };
    this.listeners.forEach((l) => l(this.state));
  }
  goLive(sessionId: string) {
    this.video = { kind: 'native', sessionId };
    this.patch('live');
  }
}

function harness(opts: { current?: FakeSession | null; startFails?: boolean } = {}) {
  const background = createSimulatedBackground();
  if (opts.startFails) background.startServer = async () => Promise.reject(new Error('ForegroundServiceStartNotAllowedException'));
  const clock = new SwitchableClock();
  let appState = 'active';
  const appListeners = new Set<(s: string) => void>();
  const relay = createSimulatedRelay();
  const startRelay = vi.spyOn(relay, 'start');
  const created: FakeSession[] = [];
  let current: CameraSession | null = (opts.current as unknown as CameraSession) ?? null;
  const released: CameraSession[] = [];
  const deps: ServerDeps = {
    background,
    clock,
    appState: {
      current: () => appState,
      subscribe: (cb) => {
        appListeners.add(cb);
        return () => appListeners.delete(cb);
      },
    },
    relay,
    currentSession: () => current,
    createSession: () => {
      const s = new FakeSession();
      created.push(s);
      return s as unknown as CameraSession;
    },
    installSession: (s) => {
      current = s;
    },
    releaseSession: (s) => {
      released.push(s);
      current = null;
    },
    readPassword: async () => 'hunter22-not-real',
    openUrl: 'pocketmonitor://server',
    wallNow: () => 1_000,
  };
  const controller = new ServerController(deps);
  return {
    controller,
    background,
    clock,
    relay,
    startRelay,
    created,
    released,
    setAppState: (s: string) => {
      appState = s;
      appListeners.forEach((l) => l(s));
    },
  };
}

describe('ServerController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts the service, connects a server session and shares its video once live', async () => {
    const h = harness();
    await h.controller.start('station', CAMERA);
    expect(h.background.isServing()).toBe(true);
    expect(h.controller.getState()).toMatchObject({ status: 'serving', setup: 'station', cameraId: 'cam-1', startedAt: 1_000 });
    const session = h.created[0];
    expect(session.connect).toHaveBeenCalledWith(CAMERA, { wifiPassword: 'hunter22-not-real' });
    expect(h.background.notification).toMatchObject({ title: 'Pocket 3', text: 'Connecting · No watchers', live: false });

    session.goLive('pm-abc-1');
    expect(h.startRelay).toHaveBeenCalledWith('pm-abc-1', expect.objectContaining({ cameraName: 'Pocket 3' }));
    expect(h.background.notification?.text).toBe('Live · No watchers');
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.controller.getState().relay.watchers).toBe(1);
    expect(h.background.notification?.text).toBe('Live · 1 watcher');

    // A reconnect makes a new video session: the relay follows it.
    session.video = { kind: 'native', sessionId: 'pm-def-2' };
    session.patch('live');
    expect(h.startRelay).toHaveBeenLastCalledWith('pm-def-2', expect.anything());
  });

  it('runs the session clock on the service heartbeat only while backgrounded', async () => {
    const h = harness();
    await h.controller.start('dual', { ...CAMERA, path: { kind: 'softap', ssid: 'OsmoPocket3-X' } });
    expect(h.clock.ticking).toBe(false);
    h.setAppState('background');
    expect(h.clock.ticking).toBe(true);
    expect(h.controller.getState().backgrounded).toBe(true);
    let fired = 0;
    h.clock.setTimeout(() => fired++, 250);
    await vi.advanceTimersByTimeAsync(400); // simulated service ticks at 10 Hz
    expect(fired).toBe(1);
    h.setAppState('active');
    expect(h.clock.ticking).toBe(false);
    await h.controller.stop();
    expect(h.clock.ticking).toBe(false);
  });

  it('notification actions record, stop and disconnect', async () => {
    const h = harness();
    await h.controller.start('station', CAMERA);
    const session = h.created[0];
    session.goLive('pm-1');
    (h.background as unknown as { press(a: string): void }).press('record');
    expect(session.control.startRecording).toHaveBeenCalled();
    session.patch('live', { recording: { ...session.state.recording, recording: true, elapsedSec: 12 } });
    expect(h.background.notification).toMatchObject({ recording: true, recordingElapsedSec: 12 });
    (h.background as unknown as { press(a: string): void }).press('stop');
    expect(session.control.stopRecording).toHaveBeenCalled();

    (h.background as unknown as { press(a: string): void }).press('disconnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.disconnect).toHaveBeenCalled();
    expect(h.released).toHaveLength(1);
    expect(h.background.isServing()).toBe(false);
    expect(h.controller.getState()).toMatchObject({ status: 'idle', error: null });
    expect(h.relay.status().state).toBe('off');
  });

  it('retries a failed camera link on the session clock', async () => {
    const h = harness();
    await h.controller.start('station', CAMERA);
    const session = h.created[0];
    session.patch('failed');
    await vi.advanceTimersByTimeAsync(14_000);
    expect(session.retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(session.retry).toHaveBeenCalledTimes(1);
    session.patch('failed');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(session.retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.retry).toHaveBeenCalledTimes(2);
  });

  it('keeps a live session that already uses the setup, and leaves it connected on stop', async () => {
    const live = new FakeSession();
    live.patch('live', { identity: { id: 'cam-1', name: 'Pocket 3', model: 'osmo-pocket-3' } }, 'station');
    live.video = { kind: 'native', sessionId: 'pm-live' };
    const h = harness({ current: live });
    await h.controller.start('station', CAMERA);
    expect(h.created).toHaveLength(0);
    expect(live.connect).not.toHaveBeenCalled();
    expect(h.startRelay).toHaveBeenCalledWith('pm-live', expect.anything());
    await h.controller.stop();
    expect(live.disconnect).not.toHaveBeenCalled();
    expect(h.released).toHaveLength(0);
  });

  it('reports a refused start and a service the system stopped', async () => {
    const refused = harness({ startFails: true });
    await refused.controller.start('station', CAMERA);
    expect(refused.controller.getState()).toMatchObject({ status: 'failed', error: ServerCopy.startRefused });
    expect(refused.created).toHaveLength(0);

    const h = harness();
    await h.controller.start('station', CAMERA);
    await h.background.stopServer();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toMatchObject({ status: 'failed', error: ServerCopy.stoppedBySystem });
    expect(h.created[0].disconnect).toHaveBeenCalled();
  });

  it('stops when the camera is disconnected elsewhere', async () => {
    const h = harness();
    await h.controller.start('station', CAMERA);
    await h.created[0].disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toMatchObject({ status: 'failed', error: ServerCopy.cameraDisconnected });
    expect(h.background.isServing()).toBe(false);
  });
});

describe('server setups', () => {
  it('offers phone-on-both-networks only with STA/STA local-only concurrency', () => {
    expect(availableSetups({ staConcurrencyLocalOnly: false })).toEqual(['station', 'hotspot']);
    expect(availableSetups({ staConcurrencyLocalOnly: true })).toEqual(['station', 'dual', 'hotspot']);
    expect(availableSetups(null)).toEqual(['station', 'hotspot']);
  });

  it('picks the setup the camera is prepared for', () => {
    expect(defaultSetup(CAMERA, ['station', 'dual', 'hotspot'])).toBe('station');
    expect(defaultSetup({ ...CAMERA, path: { kind: 'softap', ssid: 'x' } }, ['station', 'dual', 'hotspot'])).toBe('dual');
    expect(defaultSetup({ ...CAMERA, path: { kind: 'softap', ssid: 'x' } }, ['station', 'hotspot'])).toBe('station');
    expect(defaultSetup(null, ['station', 'hotspot'])).toBe('station');
  });

  it('says what each setup still needs', () => {
    expect(setupReadiness('station', null, null)).toEqual({ ready: false, need: 'camera' });
    expect(setupReadiness('station', CAMERA, 'Studio')).toEqual({ ready: true });
    expect(setupReadiness('station', CAMERA, null)).toEqual({ ready: true });
    expect(setupReadiness('station', CAMERA, 'Home')).toEqual({ ready: false, need: 'join-wifi', ssid: 'Studio' });
    expect(setupReadiness('hotspot', CAMERA, 'Studio')).toEqual({ ready: false, need: 'add-setup', pathKind: 'hotspot' });
    expect(setupReadiness('dual', CAMERA, 'Studio')).toEqual({ ready: false, need: 'add-setup', pathKind: 'softap' });
  });

  it('keeps live sessions only on a matching shared network', () => {
    expect(sessionFitsSetup('station', 'station', 'live')).toBe(true);
    expect(sessionFitsSetup('hotspot', 'hotspot', 'live-start')).toBe(true);
    expect(sessionFitsSetup('dual', 'softap', 'live')).toBe(false);
    expect(sessionFitsSetup('station', 'station', 'failed')).toBe(false);
  });
});

describe('server notification', () => {
  it('shows link, watchers and REC; elapsed alone is not a change', () => {
    const a = serverNotification({ cameraName: 'Pocket 3', phase: 'live', recording: true, elapsedSec: 5, watchers: 2, openUrl: null });
    expect(a).toEqual({ title: 'Pocket 3', text: 'Live · 2 watchers', live: true, recording: true, recordingElapsedSec: 5, openUrl: null });
    const b = serverNotification({ cameraName: 'Pocket 3', phase: 'live', recording: true, elapsedSec: 6, watchers: 2, openUrl: null });
    expect(notificationChanged(a, b)).toBe(false);
    const c = serverNotification({ cameraName: 'Pocket 3', phase: 'recovering', recording: false, elapsedSec: 0, watchers: 1, openUrl: null });
    expect(c.text).toBe('Reconnecting · 1 watcher');
    expect(notificationChanged(b, c)).toBe(true);
    const d = serverNotification({ cameraName: '', phase: 'datalink', recording: true, elapsedSec: 3, watchers: 0, openUrl: null });
    expect(d).toMatchObject({ title: 'Camera', live: false, recording: false, recordingElapsedSec: null });
  });
});

describe('server Wi-Fi path', () => {
  const base = { join: vi.fn(), leave: vi.fn(), currentSsid: vi.fn(async () => 'Studio'), localAddress: vi.fn(async () => null) };
  const bg = {
    joinLocalOnly: vi.fn(async () => ({ joined: true, outcome: 'joined' as const })),
    leaveLocalOnly: vi.fn(async () => {}),
    localOnlyAddress: vi.fn(async () => '192.168.2.20'),
    primaryWifi: vi.fn(async () => ({ ssid: 'Studio', address: '192.168.1.24', prefixLength: 24, internet: true })),
  };

  it('station never requests the home network, it checks the phone is on it', async () => {
    const wifi = serverWifi('station', base, bg);
    expect(await wifi.join('Studio', 'pw', { joinOnce: false, timeoutMs: 1000 })).toEqual({ joined: true, outcome: 'already-associated' });
    expect((await wifi.join('Other', 'pw', { joinOnce: false, timeoutMs: 1000 })).joined).toBe(false);
    await wifi.leave('Studio');
    expect(base.join).not.toHaveBeenCalled();
    expect(base.leave).not.toHaveBeenCalled();
    expect(await wifi.localAddress()).toBe('192.168.1.24');
  });

  it('dual joins the camera as a local-only link', async () => {
    const wifi = serverWifi('dual', base, bg);
    await wifi.join('OsmoPocket3-X', 'pw', { joinOnce: false, timeoutMs: 30_000 });
    expect(bg.joinLocalOnly).toHaveBeenCalledWith('OsmoPocket3-X', 'pw', { timeoutMs: 30_000 });
    expect(await wifi.localAddress()).toBe('192.168.2.20');
    await wifi.leave('OsmoPocket3-X');
    expect(bg.leaveLocalOnly).toHaveBeenCalled();
    expect(serverWifi('hotspot', base, bg)).toBe(base);
  });
});

describe('relay host port', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts the native host for the camera session and publishes state on the clock', async () => {
    let statusCb: ((e: unknown) => void) | null = null;
    const relay = {
      startHost: vi.fn(async () => {}),
      stopHost: vi.fn(),
      publishHostState: vi.fn(),
      addListener: vi.fn((_event: string, cb: (e: unknown) => void) => {
        statusCb = cb;
        return { remove: () => (statusCb = null) };
      }),
    };
    const clock = new SwitchableClock();
    const port = createRelayHost(relay as never, clock);
    const session = new FakeSession();
    await port.start('pm-1', { cameraName: 'Pocket 3', session: session as unknown as CameraSession });
    expect(relay.startHost).toHaveBeenCalledWith(expect.objectContaining({ cameraSessionId: 'pm-1', cameraName: 'Pocket 3', allowsControl: false }));
    expect(relay.publishHostState).toHaveBeenCalledTimes(1);
    statusCb!({ state: 'advertising', watchers: 2, pending: null, holder: 'iPad', joinable: true, watcherNames: ['iPad', 'Desk'] });
    expect(port.status()).toMatchObject({ state: 'advertising', watchers: 2, names: ['iPad', 'Desk'], sessionId: 'pm-1' });
    session.patch('live', { recording: { ...session.state.recording, recording: true } });
    await vi.advanceTimersByTimeAsync(600);
    expect(relay.publishHostState).toHaveBeenCalledTimes(2);
    await port.start('pm-1', { cameraName: 'Pocket 3' });
    expect(relay.startHost).toHaveBeenCalledTimes(1);
    port.stop();
    expect(relay.stopHost).toHaveBeenCalled();
    expect(port.status().state).toBe('off');
    expect(clock.pending).toBe(0);
  });

  it('is unavailable without the native relay', async () => {
    const port = createRelayHost(null);
    await port.start('pm-1', { cameraName: 'x' });
    expect(port.status().state).toBe('unavailable');
  });
});

