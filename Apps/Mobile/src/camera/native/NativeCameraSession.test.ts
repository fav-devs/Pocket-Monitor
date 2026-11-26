/**
 * NativeCameraSession against fake native modules: a scripted camera answers the BLE pairing /
 * Wi-Fi handoff, the fake datalink admits the handshake and ACKs SETs. No hardware.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BluetoothPowerState,
  DatalinkOpenOptions,
  PocketBluetoothNativeModule,
  PocketDatalinkNativeModule,
  PocketWifiNativeModule,
  WifiJoinResult,
} from '@modules/pocket-native/src/types';
import { decodeFrame, type DumlFrame, encodeFrame, isLiveCameraControl, makeFrame, packString } from '@/core/duml/frame';
import { concat } from '@/core/bytes';
import type { DiscoveredCamera, SavedCamera } from '../types';
import { NativeCameraSession } from './NativeCameraSession';

type Handler = (e: never) => void;

class Emitter {
  private handlers = new Map<string, Set<Handler>>();
  addListener(event: string, cb: Handler) {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(cb);
    this.handlers.set(event, set);
    return { remove: () => set.delete(cb) };
  }
  emit(event: string, payload: unknown) {
    this.handlers.get(event)?.forEach((h) => (h as (e: unknown) => void)(payload));
  }
  get listenerCount() {
    let n = 0;
    this.handlers.forEach((s) => (n += s.size));
    return n;
  }
}

const SSID = 'OsmoPocket4-TEST';
const PASSWORD = 'not-a-real-pass';
const replyTo = (f: DumlFrame, payload: number[] | Uint8Array) =>
  encodeFrame(makeFrame({ sender: f.receiver, receiver: f.sender, seq: f.seq, flags: 0xc0, cmdSet: f.cmdSet, cmdId: f.cmdId, payload }));

interface FakeOptions {
  pairing?: 'known' | 'approve';
  join?: WifiJoinResult;
}

function fakeCamera(opts: FakeOptions = {}) {
  const bleEvents = new Emitter();
  const dlEvents = new Emitter();
  const bleWrites: DumlFrame[] = [];
  const dumlSent: Array<{ frame: DumlFrame; open: boolean }> = [];
  const rawSent: Uint8Array[] = [];
  const opened: DatalinkOpenOptions[] = [];
  const closed: string[] = [];
  let dlState = 'closed';
  let bleConnectedId: string | null = null;
  const notify = (id: string, bytes: Uint8Array) => setTimeout(() => bleEvents.emit('onNotify', { id, characteristic: 'FFF4', bytes }), 5);

  const bluetooth: PocketBluetoothNativeModule = {
    getPowerState: (): BluetoothPowerState => 'on',
    requestPermissions: async () => true,
    startScan: () => {
      setTimeout(() => bleEvents.emit('onAdvert', { id: 'cam-1', name: null, rssi: -50, manufacturerData: Uint8Array.from([0xaa, 0x08, 0x21, 0x00]), serviceUuids: [] }), 50);
    },
    stopScan: () => {},
    connect: async (id) => {
      bleConnectedId = id;
    },
    disconnect: async () => {
      bleConnectedId = null;
    },
    write: async (id, bytes) => {
      const f = decodeFrame(bytes)?.frame;
      if (!f) return;
      bleWrites.push(f);
      const key = (f.cmdSet << 8) | f.cmdId;
      if (key === 0x0745) {
        if (opts.pairing === 'approve') {
          notify(id, replyTo(f, [0x00, 0x02]));
          // The operator taps Approve: the camera sends its own 0x07/0x46 request.
          setTimeout(() => bleEvents.emit('onNotify', { id, characteristic: 'FFF4', bytes: encodeFrame(makeFrame({ sender: 0x07, receiver: 0x02, seq: 0x1234, flags: 0x40, cmdSet: 0x07, cmdId: 0x46, payload: [] })) }), 2000);
        } else notify(id, replyTo(f, [0x00, 0x01]));
      } else if (key === 0x5310) notify(id, replyTo(f, [1, 0, 0, 0]));
      else if (key === 0x0707) notify(id, replyTo(f, concat([0x00], packString(SSID))));
      else if (key === 0x070e) notify(id, replyTo(f, concat([0x00], packString(PASSWORD))));
    },
    addListener: ((event: string, cb: Handler) => bleEvents.addListener(event, cb)) as PocketBluetoothNativeModule['addListener'],
  };

  const wifi: PocketWifiNativeModule = {
    join: vi.fn(async () => opts.join ?? { joined: true, outcome: 'joined' as const }),
    leave: vi.fn(async () => {}),
    currentSsid: async () => SSID,
    localAddress: async () => '192.168.2.20',
  };

  const datalink: PocketDatalinkNativeModule = {
    open: async (sid, o) => {
      opened.push(o);
      dlState = 'opening';
      dlEvents.emit('onState', { sessionId: sid, state: 'opening' });
    },
    close: async (sid) => {
      closed.push(sid);
      dlState = 'closed';
      dlEvents.emit('onState', { sessionId: sid, state: 'closed' });
    },
    sendRaw: (sid, bytes) => {
      rawSent.push(bytes);
      setTimeout(() => {
        dlState = 'open';
        dlEvents.emit('onState', { sessionId: sid, state: 'open' });
      }, 10);
    },
    sendDuml: (sid, bytes) => {
      const f = decodeFrame(bytes)?.frame;
      if (!f) return;
      dumlSent.push({ frame: f, open: dlState === 'open' });
      if (isLiveCameraControl(f.cmdSet, f.cmdId) || f.cmdSet === 0x04) {
        setTimeout(() => dlEvents.emit('onDuml', { sessionId: sid, bytes: replyTo(f, [0x00]) }), 5);
      }
    },
    attachVideo: vi.fn(),
    detachVideo: vi.fn(),
    addListener: ((event: string, cb: Handler) => dlEvents.addListener(event, cb)) as PocketDatalinkNativeModule['addListener'],
  };

  const saved = new Map<string, string>();
  const credentials = {
    read: async (id: string, ssid: string) => saved.get(`${id}/${ssid}`),
    save: async (id: string, ssid: string, pw: string) => void saved.set(`${id}/${ssid}`, pw),
    remove: async (id: string, ssid: string) => void saved.delete(`${id}/${ssid}`),
  };

  return {
    bleEvents,
    dlEvents,
    bleWrites,
    dumlSent,
    rawSent,
    opened,
    closed,
    saved,
    wifi,
    datalink,
    get bleConnectedId() {
      return bleConnectedId;
    },
    deps: {
      io: { bluetooth, wifi, datalink },
      credentials,
      savedCameras: () => [] as SavedCamera[],
      now: () => Date.now(),
    },
  };
}

const TARGET: DiscoveredCamera = { id: 'cam-1', name: 'Pocket 4', model: 'osmo-pocket-4', rssi: -50, pairable: true, saved: false };
const enables = (cam: ReturnType<typeof fakeCamera>) => cam.dumlSent.filter((s) => s.frame.cmdSet === 0x09 && s.frame.cmdId === 0xa8);
const opcode = (s: { frame: DumlFrame }) => (s.frame.cmdSet << 8) | s.frame.cmdId;

/** Camera-side traffic: status pushes keep `lastStatus` young; stats report video. */
function startCameraTraffic(cam: ReturnType<typeof fakeCamera>, sid: () => string | null, video: { on: boolean }) {
  const push = setInterval(() => {
    const id = sid();
    if (!id) return;
    const payload = new Array(60).fill(0);
    cam.dlEvents.emit('onDuml', { sessionId: id, bytes: encodeFrame(makeFrame({ sender: 0x01, receiver: 0x02, seq: 1, flags: 0, cmdSet: 0x02, cmdId: 0x80, payload })) });
  }, 250);
  const stats = setInterval(() => {
    const id = sid();
    if (!id) return;
    cam.dlEvents.emit('onStats', { sessionId: id, rxPackets: 1000, txPackets: 100, rxBytesPerSec: video.on ? 400_000 : 2_000, videoPacketsPerSec: video.on ? 300 : 0, ackHz: 40, lastRxAgeMs: 10 });
  }, 1000);
  return () => {
    clearInterval(push);
    clearInterval(stats);
  };
}

describe('NativeCameraSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('walks the spine BLE → pairing → Wi-Fi → datalink → enable once → live', async () => {
    const cam = fakeCamera();
    const session = new NativeCameraSession(cam.deps);
    const phases: string[] = [];
    session.subscribe((s) => {
      if (phases[phases.length - 1] !== s.connection.phase) phases.push(s.connection.phase);
    });
    const done = session.connect(TARGET);
    await vi.advanceTimersByTimeAsync(5000);
    await done;

    expect(phases).toEqual(['scanning', 'bluetooth', 'authorizing', 'wifi-handoff', 'joining-wifi', 'datalink', 'live-start']);
    // BLE order: wake + SetPairingPIN, AP wake, GetSSID, GetPassword.
    const ble = cam.bleWrites.map((f) => (f.cmdSet << 8) | f.cmdId);
    expect(ble.slice(0, 5)).toEqual([0x002b, 0x0745, 0x5310, 0x0707, 0x070e]);
    expect(cam.wifi.join).toHaveBeenCalledWith(SSID, PASSWORD, expect.objectContaining({ joinOnce: false }));
    expect(cam.saved.get(`cam-1/${SSID}`)).toBe(PASSWORD);
    expect(session.getState().identity?.ssid).toBe(SSID);
    // Datalink: SoftAP host, 9004, ephemeral port, 40 Hz, TCP 7001 SetPairingPIN poke.
    expect(cam.opened[0]).toMatchObject({ host: '192.168.2.1', port: 9004, localPort: 0, ackHz: 40 });
    expect(cam.opened[0].tcpPoke?.port).toBe(7001);
    expect(decodeFrame(cam.opened[0].tcpPoke!.bytes)?.frame).toMatchObject({ cmdSet: 0x07, cmdId: 0x45 });
    expect(cam.rawSent.length).toBeGreaterThanOrEqual(1);
    // Nothing written before admission; registration → subscriptions → prepare → enable.
    expect(cam.dumlSent.every((s) => s.open)).toBe(true);
    const order = cam.dumlSent.map(opcode);
    const iInfo = order.indexOf(0x0081);
    const iSub = order.indexOf(0x0099);
    const iPrep = order.indexOf(0x0268);
    const iEnable = order.indexOf(0x09a8);
    expect(iInfo).toBeGreaterThanOrEqual(0);
    expect(iInfo).toBeLessThan(iSub);
    expect(iSub).toBeLessThan(iPrep);
    expect(iPrep).toBeLessThan(iEnable);
    expect(enables(cam)).toHaveLength(1);
    expect(cam.datalink.attachVideo).toHaveBeenCalledWith(expect.any(String), 'hevc');
    expect(session.video).toMatchObject({ kind: 'native' });

    // First video → live. A minute of healthy video never repeats the enable.
    const sid = (session.video as { sessionId: string }).sessionId;
    const video = { on: true };
    const stop = startCameraTraffic(cam, () => sid, video);
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.getState().connection.phase).toBe('live');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enables(cam)).toHaveLength(1);
    expect(session.getState().connection.signalBars).toBeGreaterThan(0);

    // Encoder pause (status young, video gone): only the watchdog sends the next enable.
    video.on = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(enables(cam).length).toBe(2);
    expect(['recovering', 'live']).toContain(session.getState().connection.phase);
    video.on = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(session.getState().connection.phase).toBe('live');

    stop();
    await session.disconnect();
    expect(session.getState().connection.phase).toBe('disconnected');
    expect(cam.dlEvents.listenerCount).toBe(0);
    expect(cam.bleEvents.listenerCount).toBe(0);
    expect(cam.closed).toContain(sid);
    expect(cam.bleConnectedId).toBeNull();
    expect(session.video).toEqual({ kind: 'none' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for on-camera approval and answers the 0x07/0x46 request', async () => {
    const cam = fakeCamera({ pairing: 'approve' });
    const session = new NativeCameraSession(cam.deps);
    const done = session.connect(TARGET);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getState().connection).toMatchObject({ phase: 'authorizing', detail: 'Approve this phone on the camera screen' });
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    const ack = cam.bleWrites.find((f) => f.cmdSet === 0x07 && f.cmdId === 0x46);
    expect(ack).toMatchObject({ seq: 0x1234, flags: 0xc0 });
    expect(session.getState().connection.phase).toBe('live-start');
    await session.disconnect();
  });

  it('fails with operator copy when the phone cannot join the camera Wi-Fi', async () => {
    const cam = fakeCamera({ join: { joined: false, outcome: 'user-denied' } });
    const session = new NativeCameraSession(cam.deps);
    const done = session.connect(TARGET);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    const c = session.getState().connection;
    expect(c.phase).toBe('failed');
    expect(c.error).toMatch(/cancelled/i);
    expect(cam.opened).toHaveLength(0);
    expect(cam.dlEvents.listenerCount).toBe(0);
    expect(cam.bleEvents.listenerCount).toBe(0);
  });

  it('skips the BLE Wi-Fi handoff for a saved camera with a stored password', async () => {
    const cam = fakeCamera();
    cam.saved.set(`cam-1/${SSID}`, PASSWORD);
    const savedCamera: SavedCamera = { id: 'cam-1', name: 'Pocket 4', model: 'osmo-pocket-4', path: { kind: 'softap', ssid: SSID } };
    const session = new NativeCameraSession(cam.deps);
    const done = session.connect(savedCamera);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    const ble = cam.bleWrites.map((f) => (f.cmdSet << 8) | f.cmdId);
    expect(ble).not.toContain(0x0707);
    expect(ble).not.toContain(0x070e);
    expect(cam.wifi.join).toHaveBeenCalledWith(SSID, PASSWORD, expect.anything());
    expect(session.getState().connection.phase).toBe('live-start');
    await session.disconnect();
  });

  it('sends controls through core builders and settles on the camera ACK', async () => {
    const cam = fakeCamera();
    const session = new NativeCameraSession(cam.deps);
    const done = session.connect(TARGET);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    const before = cam.dumlSent.length;
    const iso = session.control.setIso('auto');
    await vi.advanceTimersByTimeAsync(50);
    await iso;
    const rec = session.control.startRecording();
    await vi.advanceTimersByTimeAsync(50);
    await rec;
    const sent = cam.dumlSent.slice(before).map(opcode);
    expect(sent).toContain(0x022a);
    expect(sent).toContain(0x0202);

    // Stick: 25 Hz while held, one centre on release.
    const t0 = cam.dumlSent.length;
    session.gimbal.drive(0.5, 0);
    await vi.advanceTimersByTimeAsync(400);
    session.gimbal.drive(0, 0);
    const sticks = cam.dumlSent.slice(t0).filter((s) => s.frame.cmdSet === 0x04 && s.frame.cmdId === 0x01);
    expect(sticks.length).toBeGreaterThanOrEqual(9);
    expect(sticks.length).toBeLessThanOrEqual(12);
    const last = sticks[sticks.length - 1].frame.payload;
    expect([last[0] | (last[1] << 8), last[4] | (last[5] << 8)]).toEqual([1024, 1024]);
    await vi.advanceTimersByTimeAsync(200);
    expect(cam.dumlSent.slice(t0).filter((s) => s.frame.cmdSet === 0x04 && s.frame.cmdId === 0x01).length).toBe(sticks.length);

    await expect(session.media.download('x')).rejects.toThrow(/not available/);
    await session.disconnect();
    expect(cam.wifi.leave).toHaveBeenCalledWith(SSID);
  });
});
