import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Commands } from '@/core/commands/commands';
import { FeedWatchdog } from '@/core/connection/feedWatchdog';
import { makeFrame, type DumlFrame } from '@/core/duml/frame';
import { gimbalProgram, waypoint } from '@/core/gimbal/program';
import { SubscribePush } from '@/core/status/cameraStatus';
import { MODELS_BY_ID } from '@/core/status/cameraModel';
import { MediaManifest } from '@/core/status/mediaManifest';
import { initialCameraState } from '../defaults';
import {
  CONNECT_STAGE_ORDER,
  type ConnectFailure,
  connectFailureCopy,
  datalinkFailure,
  joinRejectsCredentials,
  stageDetail,
  stagePhase,
  wifiJoinFailure,
} from './connectCopy';
import { ExchangeClosed, ExchangeTimeout, FrameExchange, opcodeMatcher } from './exchange';
import { FeedTracker } from './feedTracker';
import { filenameTimestamp, mediaItemsOf } from './mediaMap';
import { codecHint, coreModelFor } from './models';
import { approachMoves, exactLegMoves, moveFrame, planProgram, splitTenths } from './motionPlan';
import { mergeSighting, type Sighting, sightingOf, sortedCameras } from './scanList';
import { LiveSetDriver } from './setDriver';
import { CameraStatusReducer } from './statusReducer';

const reply = (f: DumlFrame, payload: number[], seq = f.seq): DumlFrame =>
  makeFrame({ sender: f.receiver, receiver: f.sender, seq, flags: 0xc0, cmdSet: f.cmdSet, cmdId: f.cmdId, payload });

describe('connect copy', () => {
  it('maps every stage onto the UI checklist in spine order', () => {
    const phases = CONNECT_STAGE_ORDER.map(stagePhase);
    const order = ['scanning', 'bluetooth', 'authorizing', 'wifi-handoff', 'joining-wifi', 'datalink', 'live-start'];
    const indices = phases.map((p) => order.indexOf(p));
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    for (const s of CONNECT_STAGE_ORDER) expect(stageDetail(s).length).toBeGreaterThan(5);
    expect(stageDetail('joining-wifi', { ssid: 'OsmoPocket4-1234' })).toContain('OsmoPocket4-1234');
  });

  it('treats joined and already-associated as success, others as failures with copy', () => {
    expect(wifiJoinFailure({ joined: true, outcome: 'joined' }, 'X')).toBeNull();
    expect(wifiJoinFailure({ joined: false, outcome: 'already-associated' }, 'X')).toBeNull();
    const f = wifiJoinFailure({ joined: false, outcome: 'user-denied' }, 'Osmo-1');
    expect(f).toEqual({ kind: 'wifi-join', outcome: 'user-denied', ssid: 'Osmo-1', message: undefined });
    expect(connectFailureCopy(f!)).toMatch(/Osmo-1/);
    expect(joinRejectsCredentials('wrong-password')).toBe(true);
    expect(joinRejectsCredentials('user-denied')).toBe(false);
  });

  it('recognises Local Network denial and has copy for every failure', () => {
    expect(datalinkFailure('Local Network access denied').kind).toBe('local-network-denied');
    expect(datalinkFailure('socket').kind).toBe('datalink-open');
    const all: ConnectFailure[] = [
      { kind: 'no-native-io' },
      { kind: 'bluetooth-power', state: 'off' },
      { kind: 'bluetooth-permission' },
      { kind: 'camera-not-found' },
      { kind: 'ble-connect' },
      { kind: 'ble-dropped', during: 'pairing' },
      { kind: 'pairing-timeout' },
      { kind: 'pairing-deferred' },
      { kind: 'credentials-refused', which: 'ssid' },
      { kind: 'credentials-timeout', which: 'password' },
      { kind: 'ssid-conflict', ssid: 'OsmoNano-1' },
      { kind: 'saved-password-missing', ssid: 'Home' },
      { kind: 'station', failure: 'joinRejected' },
      { kind: 'station-no-host', ssid: 'Home' },
      { kind: 'datalink-open' },
      { kind: 'datalink-handshake' },
      { kind: 'local-network-denied' },
      { kind: 'unknown', message: '' },
    ];
    for (const f of all) expect(connectFailureCopy(f).length).toBeGreaterThan(10);
  });
});

describe('FrameExchange', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('arms the waiter before sending, resolves on match, times out otherwise', async () => {
    const ex = new FrameExchange();
    const pin = Commands.setPairingPin('osmo');
    const p = ex.request(opcodeMatcher([[0x07, 0x45]]), 1000, 'pin', () => ex.deliver(reply(pin, [0, 1])));
    await expect(p).resolves.toMatchObject({ cmdSet: 0x07, cmdId: 0x45 });
    const t = ex.request(opcodeMatcher([[0x07, 0x07]]), 500, 'ssid');
    const assertion = expect(t).rejects.toBeInstanceOf(ExchangeTimeout);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(ex.pending).toBe(0);
  });

  it('rejects waiters on close', async () => {
    const ex = new FrameExchange();
    const p = ex.request(() => true, 5000, 'x');
    ex.close('ble disconnected');
    await expect(p).rejects.toBeInstanceOf(ExchangeClosed);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('LiveSetDriver (core CameraSetMailbox)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness() {
    const sent: DumlFrame[] = [];
    let seq = 0xa000;
    const driver = new LiveSetDriver((f) => {
      const s = seq++;
      sent.push({ ...f, seq: s });
      return s;
    }, () => Date.now());
    return { driver, sent };
  }

  it('settles a SET on its ACK and reports refusals', async () => {
    const { driver, sent } = harness();
    const p = driver.submit(Commands.recordStart(), true);
    expect(sent).toHaveLength(1);
    expect(driver.reply(reply(sent[0], [0x00]))).toBe(true);
    await expect(p).resolves.toEqual({ kind: 'ok' });
    const q = driver.submit(Commands.recordStop(), true);
    driver.reply(reply(sent[1], [0xd9]));
    await expect(q).resolves.toMatchObject({ kind: 'refused', message: 'camera rejected that in this mode' });
  });

  it('coalesces slider SETs: one on the wire, latest wins, older ones superseded', async () => {
    const { driver, sent } = harness();
    const first = driver.submit(Commands.setEv(1), false);
    const second = driver.submit(Commands.setEv(2), false);
    const third = driver.submit(Commands.setEv(3), false);
    expect(sent).toHaveLength(1);
    await expect(second).resolves.toEqual({ kind: 'superseded' });
    driver.reply(reply(sent[0], [0]));
    await expect(first).resolves.toEqual({ kind: 'ok' });
    await vi.advanceTimersByTimeAsync(150);
    expect(sent).toHaveLength(2);
    expect(Array.from(sent[1].payload)).toEqual(Array.from(Commands.setEv(3).payload));
    driver.reply(reply(sent[1], [0]));
    await expect(third).resolves.toEqual({ kind: 'ok' });
  });

  it('ignores a reply with another seq and times out', async () => {
    const { driver, sent } = harness();
    const p = driver.submit(Commands.setIsoIndex(0), true);
    expect(driver.reply(reply(sent[0], [0], sent[0].seq + 5))).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(p).resolves.toEqual({ kind: 'timeout' });
  });

  it('reports offline when the datalink is not open', async () => {
    const driver = new LiveSetDriver(() => null, () => Date.now());
    await expect(driver.submit(Commands.recordStart(), true)).resolves.toEqual({ kind: 'offline' });
  });
});

describe('CameraStatusReducer', () => {
  const push = (name: string, value: number[]) =>
    makeFrame({ sender: 0x28, receiver: 0x02, seq: 1, flags: 0, cmdSet: 0x00, cmdId: 0x99, payload: SubscribePush.pack(name, value) });

  it('folds pushes into UI state through core decode + mapping', () => {
    const r = new CameraStatusReducer(MODELS_BY_ID[0x0021]);
    // cam_video_param_v2: 4K (0x10) at 25 fps (index 2).
    expect(r.apply(push('cam_video_param_v2', [0x10, 0x02, 0, 0]), 0)).toBe(true);
    // 0x02/0x80 status push: recording bit 0x80.
    const status = new Array(60).fill(0);
    status[0] = 0x80;
    r.apply(makeFrame({ sender: 0x01, receiver: 0x02, seq: 2, flags: 0, cmdSet: 0x02, cmdId: 0x80, payload: status }), 10);
    const state = r.reduce(initialCameraState('osmo-pocket-4'));
    expect(state.format.fps).toBe(25);
    expect(state.format.resolution).toBe('4K');
    expect(state.recording.recording).toBe(true);
    expect(r.lastStatusPushAt).toBe(10);
  });

  it('reads gimbal attitude from 0x04/0x05', () => {
    const r = new CameraStatusReducer(MODELS_BY_ID[0x0021]);
    const p = new Array(50).fill(0);
    p[4] = 0x2c; // yaw 300 tenths = 30°
    p[5] = 0x01;
    p[20] = 0x9c; // raw −100 → display pitch +10°
    p[21] = 0xff;
    p[6] = 2 << 6; // follow family
    r.apply(makeFrame({ sender: 0x04, receiver: 0x02, seq: 3, flags: 0, cmdSet: 0x04, cmdId: 0x05, payload: p }), 5);
    const state = r.reduce(initialCameraState('osmo-pocket-4'));
    expect(state.gimbal.yaw).toBe(30);
    expect(state.gimbal.pitch).toBe(10);
    expect(r.attitude).toMatchObject({ yawTenthDeg: 300, wire: 'wrapped', at: 5 });
  });
});

describe('FeedTracker → FeedWatchdog', () => {
  const stats = (video: number) => ({ sessionId: 's', rxPackets: 10, txPackets: 10, rxBytesPerSec: 250_000, videoPacketsPerSec: video, ackHz: 40, lastRxAgeMs: 20 });

  it('holds while video flows, resends enable once on an encoder pause', () => {
    const feed = new FeedTracker();
    const wd = new FeedWatchdog();
    feed.flowHealthy = true;
    feed.noteEnable(0);
    let enables = 0;
    for (let t = 1000; t <= 60_000; t += 1000) {
      if (t <= 30_000) feed.noteStats(stats(300), t);
      else feed.noteStats(stats(0), t);
      feed.noteStatus(t);
      const action = wd.tick(feed.snapshot(t, true));
      if (action === 'resendLiveViewEnable') {
        enables += 1;
        feed.noteEnable(t);
      }
      if (t <= 30_000) expect(action).toBe('none');
    }
    expect(enables).toBeGreaterThanOrEqual(1);
    expect(enables).toBeLessThanOrEqual(2);
  });

  it('reports link chip values', () => {
    const feed = new FeedTracker();
    feed.noteStats(stats(300), 1000);
    const chip = feed.linkChip(1200, { kind: 'live' }, false);
    expect(chip.videoKbps).toBe(2000);
    expect(chip.videoFps).toBe(0);
    expect(chip.signalBars).toBeGreaterThan(0);
    feed.notePicture({ presentedFps: 24.6, lastFrameAgeMs: 30 }, 1300);
    expect(feed.linkChip(1400, { kind: 'live' }, false).videoFps).toBe(25);
  });
});

describe('Motion Control planning', () => {
  it('approaches A in ≤120° steps of at least 0.5 s', () => {
    const moves = approachMoves(waypoint(-40, 0, 1, 0), waypoint(200, 0, 1, 0));
    expect(moves.length).toBe(2);
    expect(moves.every((m) => m.durationS >= 0.5)).toBe(true);
    expect(moves[1].at).toBeCloseTo(moves[0].durationS);
    expect(moves[1].yawDeg).toBeCloseTo(200);
  });

  it('splits legs ≥180° or > 25.5 s into native sub-moves on the tenth grid', () => {
    expect(splitTenths(25, 2)).toEqual([13, 12]);
    const wide = exactLegMoves(waypoint(-40, 0, 1, 0), waypoint(200, 0, 1, 0), 6, 10);
    expect(wide.length).toBe(2);
    expect(wide.reduce((s, m) => s + m.durationS, 0)).toBeCloseTo(6);
    expect(wide[0].at).toBe(10);
    const slow = exactLegMoves(waypoint(0, 0, 1, 0), waypoint(10, 0, 1, 0), 60, 0);
    expect(slow.length).toBe(3);
    expect(slow.every((m) => m.durationS <= 25.5)).toBe(true);
  });

  it('plans exact and smoothed takes, and needs native pitch', () => {
    const a = waypoint(0, 0, 1, 0);
    const b = waypoint(30, 10, 1, 10);
    const c = waypoint(60, 0, 1, 0);
    const exact = planProgram(gimbalProgram({ a, b, c, durationAB: 4, durationBC: 4 }), waypoint(0, 0, 1, 0));
    expect(typeof exact).toBe('object');
    if (typeof exact === 'object') {
      expect(exact.take).toHaveLength(2);
      expect(exact.end - exact.takeStart).toBe(8);
      expect(exact.smooth).toBeNull();
    }
    const smooth = planProgram(gimbalProgram({ a, b, c, durationAB: 4, durationBC: 4, smoothness: 0.5 }), waypoint(0, 0, 1, 0));
    expect(typeof smooth === 'object' && smooth.smooth != null).toBe(true);
    expect(planProgram(gimbalProgram({ a }), waypoint(0, 0))).toBe('incomplete');
    expect(planProgram(gimbalProgram({ a: waypoint(0, 0), b }), waypoint(0, 0, 1, 0))).toBe('noNativePitch');
  });

  it('refuses a dispatch ≥180° from the live pose', () => {
    expect(moveFrame({ yawDeg: 200, nativePitchDeg: 0, durationS: 2 }, 'wrapped', { yawDeg: 0, nativePitchDeg: 0 })).toBeNull();
    const f = moveFrame({ yawDeg: 90, nativePitchDeg: 0, durationS: 2 }, 'wrapped', { yawDeg: 0, nativePitchDeg: 0 });
    expect(f).toMatchObject({ cmdSet: 0x04, cmdId: 0x14 });
  });
});

describe('scan list', () => {
  const advert = (id: string, name: string | null, mfr: number[] | null, rssi = -50) => ({
    id,
    name,
    rssi,
    manufacturerData: mfr ? Uint8Array.from(mfr) : null,
    serviceUuids: [],
  });

  it('decodes DJI manufacturer data and Pocket 3 name-only adverts; ignores others', () => {
    const p4 = sightingOf(advert('a', null, [0xaa, 0x08, 0x21, 0x00]), 0);
    expect(p4).toMatchObject({ modelId: 0x21, name: '' });
    expect(sortedCameras([p4!], new Set())[0].name).toBe('Osmo Pocket 4');
    expect(sightingOf(advert('b', 'OsmoPocket3-1A2B', null), 0)).toMatchObject({ modelId: null, name: 'OsmoPocket3-1A2B' });
    expect(sightingOf(advert('c', 'Headphones', [0x4c, 0x00, 1, 2]), 0)).toBeNull();
    expect(sightingOf(advert('d', null, null), 0)).toBeNull();
  });

  it('keeps a real name over a later generic one and marks saved cameras', () => {
    const list = new Map<string, Sighting>();
    mergeSighting(list, sightingOf(advert('a', 'Pocket 4 Pro A', [0xaa, 0x08, 0x22, 0x00]), 0)!);
    mergeSighting(list, sightingOf(advert('a', null, [0xaa, 0x08, 0x22, 0x00], -40), 1)!);
    mergeSighting(list, sightingOf(advert('b', 'OsmoNano-77', null, -80), 1)!);
    const cams = sortedCameras(list.values(), new Set(['b']));
    expect(cams[0]).toMatchObject({ id: 'b', saved: true, model: 'osmo-nano' });
    expect(cams[1]).toMatchObject({ id: 'a', name: 'Pocket 4 Pro A', model: 'osmo-pocket-4-pro', rssi: -40, pairable: true });
  });
});

describe('models and media', () => {
  it('resolves core models and codec hints', () => {
    expect(coreModelFor('osmo-pocket-3', 'x').name).toBe('Osmo Pocket 3');
    expect(codecHint(coreModelFor('osmo-pocket-3', 'x'))).toBe('avc');
    expect(codecHint(coreModelFor('osmo-nano', 'x'))).toBe('avc');
    expect(codecHint(coreModelFor('osmo-pocket-4-pro', 'x'))).toBe('hevc');
    expect(coreModelFor('unknown', 'Osmo', 0x0021).name).toBe('Osmo Pocket 4');
  });

  it('maps the Nano manifest fixture onto media items', () => {
    const fixture = new Uint8Array(
      readFileSync(path.resolve(__dirname, '../../../../../Tests/OpenPocketViewCoreTests/Fixtures/nano-manifest.bin')),
    );
    const items = mediaItemsOf(MediaManifest.decode(fixture));
    expect(items).toHaveLength(34);
    expect(items[0]).toMatchObject({ kind: 'video', fileName: 'DJI_20260814125250_0034_D.MP4', durationSec: 209, width: 3840, height: 2160, fps: 25 });
    expect(items[0].createdAt).toBe(new Date(2026, 7, 14, 12, 52, 50).getTime());
    expect(filenameTimestamp('VID_20260916_123456_00_001.mp4')).toBe(new Date(2026, 8, 16, 12, 34, 56).getTime());
    expect(filenameTimestamp('IMG.JPG')).toBe(0);
  });
});
