import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialCameraState } from '../defaults';
import type { SessionEvent } from '../session';
import type { CameraState } from '../types';
import { DemoRelayTransport } from './demo';
import {
  colorModeOf,
  formatOf,
  hostActionFor,
  modelOf,
  planIso,
  planWhiteBalance,
  relayStateFromCamera,
  stateFromRelay,
  zoomFactorOf,
} from './mapping';
import { decodeCommand, decodeHello, encodeControlToken, encodeHello, encodeJoinDenied, encodeState, type RelayState } from './protocol';
import type {
  RelayHostsEvent,
  RelayWatcherMessageEvent,
  RelayWatcherStatsEvent,
  RelayWatcherStatusEvent,
  RelayWatcherTransport,
} from './transport';
import { WatcherCameraSession } from './WatcherCameraSession';

const state = (over: Partial<RelayState> = {}): RelayState => ({
  isRecording: false,
  format: '4K/30',
  color: 'D-Log M 10-bit',
  zoom: '2x',
  liveFPS: '25',
  batteryPercent: 64,
  cameraName: 'Pocket 3',
  iso: '800',
  shutter: '1/50',
  allowsControlRequests: true,
  controlOptions: { isoIndices: [0x00, 0x05, 0x06, 0x07], shutterDenominators: [50, 100, 200], zoomHundredths: [100, 200, 400] },
  cameraModel: 'Osmo Pocket 3',
  isNano: false,
  ...over,
});

describe('relay state → camera state', () => {
  it('reads labels the way hosts write them', () => {
    expect(zoomFactorOf('2.5×')).toBe(2.5);
    expect(zoomFactorOf('Wide')).toBeNull();
    expect(formatOf('4K/60')).toEqual({ resolution: '4K', fps: 60 });
    expect(formatOf('1080p')).toEqual({ resolution: '1080p', fps: null });
    expect(colorModeOf('D-Log M 10-bit')).toBe('dlog-m');
    expect(colorModeOf('D-Log2')).toBe('dlog2');
    expect(colorModeOf('HDR')).toBe('hlg');
    expect(colorModeOf('Normal')).toBe('normal');
    expect(modelOf('Osmo Pocket 4 Pro', false)).toBe('osmo-pocket-4-pro');
    expect(modelOf(null, true)).toBe('osmo-nano');
  });

  it('folds a state message into the camera model', () => {
    const next = stateFromRelay(initialCameraState(), state(), { hostName: 'Studio', cameraName: 'Pocket 3' });
    expect(next.identity).toMatchObject({ name: 'Pocket 3', model: 'osmo-pocket-3' });
    expect(next.exposure).toMatchObject({ iso: 800, isoAuto: false, shutterDenom: 50, isoOptions: [400, 800, 1600], shutterOptions: [50, 100, 200] });
    expect(next.format).toMatchObject({ resolution: '4K', fps: 30, colorMode: 'dlog-m' });
    expect(next.zoom).toMatchObject({ factor: 2, stops: [1, 2, 4] });
    expect(next.power.batteryPercent).toBe(64);
    expect(next.capabilities).toMatchObject({ gimbal: false, tracking: false, media: false });
    expect(next.gimbal.available).toBe(false);
  });

  it('keeps what the wire does not carry', () => {
    const first = stateFromRelay(initialCameraState(), state(), { hostName: 'Studio' });
    const next = stateFromRelay(first, state({ iso: 'Auto', shutter: '', zoom: '' }), { hostName: 'Studio' });
    expect(next.exposure.isoAuto).toBe(true);
    expect(next.exposure.shutterDenom).toBe(50);
    expect(next.zoom.factor).toBe(2);
  });
});

describe('camera state → relay state (host)', () => {
  it('writes upstream labels and the host-advertised choices', () => {
    const s: CameraState = initialCameraState('osmo-pocket-3');
    s.identity = { id: 'cam', name: 'Pocket 3', model: 'osmo-pocket-3' };
    s.exposure = { ...s.exposure, iso: 400, isoAuto: false, isoOptions: [100, 200, 400, 800], shutterDenom: 100, shutterOptions: [50, 100] };
    s.zoom = { ...s.zoom, factor: 1.5 };
    s.connection = { ...s.connection, videoFps: 29.7 };
    const r = relayStateFromCamera(s, false);
    expect(r).toMatchObject({ iso: '400', shutter: '1/100', zoom: '1.5x', liveFPS: '30', cameraName: 'Pocket 3', allowsControlRequests: false, cameraModel: 'Osmo Pocket 3', isNano: false });
    expect(r.controlOptions?.isoIndices).toEqual([0x00, 0x03, 0x04, 0x05, 0x06]);
    expect(r.controlOptions?.zoomHundredths).toEqual([100, 200, 400]);
    // Round trip: the watcher reads back what the host wrote.
    const back = stateFromRelay(initialCameraState(), r, { hostName: 'Host' });
    expect(back.exposure.iso).toBe(400);
    expect(back.exposure.isoOptions).toEqual([100, 200, 400, 800]);
  });

  it('maps admitted commands onto host actions', () => {
    const s = initialCameraState('osmo-pocket-3');
    expect(hostActionFor({ kind: 'toggleRecording' }, s)).toEqual({ kind: 'record', start: true });
    expect(hostActionFor({ kind: 'setISO', index: 0x06 }, s)).toEqual({ kind: 'iso', value: 800 });
    expect(hostActionFor({ kind: 'setISO', index: 0x00 }, s)).toEqual({ kind: 'iso', value: 'auto' });
    expect(hostActionFor({ kind: 'tapFocus', cameraX: 250, cameraY: 500, coordinateWidth: 1000, coordinateHeight: 1000 }, s)).toEqual({ kind: 'focus', x: 0.25, y: 0.5 });
    expect(hostActionFor({ kind: 'setColor', mode: 0x00 }, s)).toEqual({ kind: 'color', mode: 'dlog-m' });
    expect(hostActionFor({ kind: 'setZoom', hundredths: 200 }, s)).toEqual({ kind: 'zoom', factor: 2 });
    expect(hostActionFor({ kind: 'setWhiteBalance', mode: 1, kelvin: 5600, tint: 2 }, s)).toEqual({ kind: 'white-balance', preset: 'custom', kelvin: 5600, tint: 2 });
  });

  it('only host-advertised ISO choices are sent', () => {
    expect(planIso(800, state())).toEqual({ send: { kind: 'setISO', index: 0x06 } });
    expect(planIso(6400, state())).toEqual({ refuse: 'Not offered by the host' });
    expect(planIso('auto', state())).toEqual({ send: { kind: 'setISO', index: 0x00 } });
    expect('refuse' in planWhiteBalance({ preset: 'daylight' }, { kelvin: null, tint: 0 })).toBe(true);
  });
});

/** A scripted transport: records calls, lets the test deliver host messages. */
function fakeTransport() {
  const calls: { op: string; args: unknown[] }[] = [];
  const status = new Set<(e: RelayWatcherStatusEvent) => void>();
  const message = new Set<(e: RelayWatcherMessageEvent) => void>();
  const stats = new Set<(e: RelayWatcherStatsEvent) => void>();
  const transport: RelayWatcherTransport = {
    simulated: false,
    deviceName: () => 'Pixel',
    browse: (cb: (e: RelayHostsEvent) => void) => {
      cb({ hosts: [], browsing: true });
      return () => {};
    },
    join: async (...args) => {
      calls.push({ op: 'join', args });
    },
    leave: (...args) => calls.push({ op: 'leave', args }),
    requestControl: (...args) => calls.push({ op: 'request', args }),
    releaseControl: (...args) => calls.push({ op: 'release', args }),
    sendCommand: (...args) => calls.push({ op: 'command', args }),
    onStatus: (cb) => (status.add(cb), () => status.delete(cb)),
    onMessage: (cb) => (message.add(cb), () => message.delete(cb)),
    onStats: (cb) => (stats.add(cb), () => stats.delete(cb)),
  };
  return {
    transport,
    calls,
    joins: () => calls.filter((c) => c.op === 'join'),
    host(sessionId: string, kind: RelayWatcherMessageEvent['kind'], json: string) {
      message.forEach((l) => l({ sessionId, kind, json }));
    },
    closed(sessionId: string, error?: string) {
      status.forEach((l) => l({ sessionId, state: 'closed', error }));
    },
    stats(sessionId: string, frames: number) {
      stats.forEach((l) => l({ sessionId, framesPerSec: 25, kbps: 5000, frames, lastFrameAgeMs: 20, codec: 'hevc', catchingUp: false }));
    },
  };
}

describe('WatcherCameraSession', () => {
  let clock = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
  });
  afterEach(() => vi.useRealTimers());

  const advance = (seconds: number) => {
    for (let i = 0; i < seconds * 4; i++) {
      clock += 0.25;
      vi.advanceTimersByTime(250);
    }
  };

  function joined() {
    const fake = fakeTransport();
    const session = new WatcherCameraSession({ transport: fake.transport, watcherId: 'w-1', now: () => clock });
    const id = (session.video as { sessionId: string }).sessionId;
    const notices: string[] = [];
    session.onEvent((e: SessionEvent) => e.type === 'notice' && notices.push(e.notice.message));
    session.watch({ hostId: '_pocket-mon._tcp/Studio', name: 'Studio' });
    return { fake, session, id, notices };
  }

  it('is a watcher with a relay picture, and says hello with its id', () => {
    const { fake, session } = joined();
    expect(session.kind).toBe('watcher');
    expect(session.video.kind).toBe('relay');
    const hello = decodeHello(fake.joins()[0].args[2] as string)!;
    expect(hello).toMatchObject({ version: 1, hostName: 'Pixel', watcherID: 'w-1', passcode: null });
    expect(session.getState().connection).toMatchObject({ phase: 'datalink', transport: 'watcher' });
  });

  it('goes live on the host hello and mirrors its state', () => {
    const { fake, session, id } = joined();
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio', cameraName: 'Pocket 3' }));
    fake.host(id, 'state', encodeState(state({ isRecording: true })));
    expect(session.getWatcherInfo()).toMatchObject({ phase: 'live', title: 'Studio · Pocket 3', control: 'available' });
    expect(session.getState().connection.phase).toBe('live');
    expect(session.getState().recording.recording).toBe(true);
  });

  it('a passcode refusal stops and asks; the answer joins again with it', () => {
    const { fake, session, id } = joined();
    fake.host(id, 'denied', encodeJoinDenied({ reason: 'Wrong passcode.', passcodeRequired: true }));
    expect(session.getWatcherInfo()).toMatchObject({ phase: 'needs-passcode', error: null });
    advance(30);
    expect(fake.joins()).toHaveLength(1);
    session.answerPasscode(' 1234 ');
    expect(decodeHello(fake.joins()[1].args[2] as string)?.passcode).toBe('1234');
    fake.host(id, 'denied', encodeJoinDenied({ reason: 'Wrong passcode.', passcodeRequired: true }));
    expect(session.getWatcherInfo().error).toBe('Wrong passcode.');
  });

  it('an explicit host stop fails with its reason, no retry', () => {
    const { fake, session, id } = joined();
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio' }));
    fake.host(id, 'denied', encodeJoinDenied({ reason: 'The host ended this shared feed.', passcodeRequired: false }));
    expect(session.getWatcherInfo()).toMatchObject({ phase: 'failed', error: 'The host ended this shared feed.' });
    advance(10);
    expect(fake.joins()).toHaveLength(1);
  });

  it('an unexplained drop retries with backoff and holds the session', () => {
    const { fake, session, id } = joined();
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio' }));
    fake.closed(id, 'reset by peer');
    expect(session.getWatcherInfo()).toMatchObject({ phase: 'reconnecting', attempt: 1 });
    expect(session.getState().connection.phase).toBe('recovering');
    advance(1);
    expect(fake.joins()).toHaveLength(2);
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio' }));
    expect(session.getWatcherInfo().phase).toBe('live');
  });

  it('a silent picture drops the socket and reconnects; three failures end it', () => {
    const { fake, session, id } = joined();
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio' }));
    for (let t = 0; t < 10; t++) {
      fake.host(id, 'state', encodeState(state()));
      advance(1);
    }
    expect(session.getWatcherInfo().phase).toBe('reconnecting');
    expect(fake.calls.some((c) => c.op === 'leave')).toBe(true);
    for (let i = 0; i < 3; i++) {
      advance(5);
      fake.closed(id, 'refused');
    }
    expect(session.getWatcherInfo().phase).toBe('failed');
  });

  it('pictures keep a join alive', () => {
    const { fake, session, id } = joined();
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio' }));
    for (let t = 1; t <= 20; t++) {
      fake.stats(id, t * 25);
      advance(1);
    }
    expect(session.getWatcherInfo()).toMatchObject({ phase: 'live', receivedFps: 25 });
  });

  it('commands wait for the token; the first one asks for it', async () => {
    const { fake, session, id, notices } = joined();
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio' }));
    fake.host(id, 'state', encodeState(state()));
    await session.control.setIso(800);
    expect(fake.calls.filter((c) => c.op === 'command')).toHaveLength(0);
    expect(fake.calls.filter((c) => c.op === 'request')).toHaveLength(1);
    expect(notices).toContain('Control requested');
    expect(session.getWatcherInfo().control).toBe('requested');

    fake.host(id, 'token', encodeControlToken({ holderName: 'Pixel', holderIsRecipient: true }));
    expect(session.canControl).toBe(true);
    await session.control.setIso(800);
    await session.control.startRecording();
    const sent = fake.calls.filter((c) => c.op === 'command').map((c) => decodeCommand(c.args[1] as string));
    expect(sent).toEqual([{ kind: 'setISO', index: 0x06 }, { kind: 'toggleRecording' }]);
  });

  it('refuses what the wire does not carry, with a notice', async () => {
    const { fake, session, id, notices } = joined();
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio' }));
    fake.host(id, 'token', encodeControlToken({ holderName: 'Pixel', holderIsRecipient: true }));
    await session.gimbal.recenter();
    await session.control.setFormat({ resolution: '1080p' });
    await session.control.capturePhoto();
    expect(fake.calls.filter((c) => c.op === 'command')).toHaveLength(0);
    expect(notices).toEqual(expect.arrayContaining(['Gimbal needs a direct camera link', 'Format needs a direct camera link', 'Photo needs a direct camera link']));
  });

  it('losing the connection clears the grant', () => {
    const { fake, session, id } = joined();
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio' }));
    fake.host(id, 'token', encodeControlToken({ holderName: 'Pixel', holderIsRecipient: true }));
    fake.closed(id);
    expect(session.canControl).toBe(false);
  });

  it('leave cancels pending retries', () => {
    const { fake, session, id } = joined();
    fake.host(id, 'hello', encodeHello({ version: 1, hostName: 'Studio' }));
    fake.closed(id);
    session.leave();
    advance(10);
    expect(fake.joins()).toHaveLength(1);
    expect(session.getWatcherInfo().phase).toBe('idle');
  });
});

describe('simulated hosts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('join, mirror the demo camera, grant control and apply a command', async () => {
    const transport = new DemoRelayTransport(undefined, 100);
    let clock = 0;
    const session = new WatcherCameraSession({ transport, watcherId: 'w', now: () => clock });
    session.watch({ hostId: '_pocket-mon._tcp/Studio iPhone', name: 'Studio iPhone' });
    for (let i = 0; i < 40; i++) {
      clock += 0.25;
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(session.getWatcherInfo().phase).toBe('live');
    expect(session.getState().identity?.model).toBe('osmo-pocket-4-pro');
    session.requestControl();
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.canControl).toBe(true);
    await session.control.startRecording();
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(250);
    expect(session.getState().recording.recording).toBe(true);
    session.leave();
  });

  it('B-cam asks for its passcode', async () => {
    const transport = new DemoRelayTransport(undefined, 100);
    const session = new WatcherCameraSession({ transport, watcherId: 'w', now: () => 0 });
    session.watch({ hostId: '_opc-mon._tcp/B-cam', name: 'B-cam' });
    await vi.advanceTimersByTimeAsync(300);
    expect(session.getWatcherInfo().phase).toBe('needs-passcode');
    session.answerPasscode('1234');
    await vi.advanceTimersByTimeAsync(300);
    expect(session.getWatcherInfo().phase).toBe('live');
    session.leave();
  });
});
