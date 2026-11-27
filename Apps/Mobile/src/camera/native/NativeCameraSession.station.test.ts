/**
 * Station / hotspot path of NativeCameraSession with and without the additive Multiview
 * discovery seam (`deps.station`): a fake shared network with the camera at one address and
 * another camera (different Wi-Fi identity) at another. No hardware.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PocketBluetoothNativeModule, PocketDatalinkNativeModule, PocketWifiNativeModule } from '@modules/pocket-native/src/types';
import { concat } from '@/core/bytes';
import { decodeFrame, type DumlFrame, encodeFrame, isLiveCameraControl, makeFrame, packString } from '@/core/duml/frame';
import type { SavedCamera } from '../types';
import type { StationDiscovery } from './deps';
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
}

const reply = (f: DumlFrame, payload: number[] | Uint8Array) =>
  encodeFrame(makeFrame({ sender: f.receiver, receiver: f.sender, seq: f.seq, flags: 0xc0, cmdSet: f.cmdSet, cmdId: f.cmdId, payload }));
const identityOf = (ssid: string) => concat([0x00], packString(ssid));

function sharedNetwork(cameraHost: string, others: Record<string, string> = {}) {
  const ble = new Emitter();
  const dl = new Emitter();
  const bleWrites: DumlFrame[] = [];
  const hostOf = new Map<string, string>();
  const opened: string[] = [];
  const closed: string[] = [];
  const answering: Record<string, string> = { [cameraHost]: 'OsmoPocket4-CAM', ...others };
  const notify = (id: string, bytes: Uint8Array) => setTimeout(() => ble.emit('onNotify', { id, characteristic: 'FFF4', bytes }), 5);

  const bluetooth: PocketBluetoothNativeModule = {
    getPowerState: () => 'on',
    requestPermissions: async () => true,
    startScan: () => {
      setTimeout(() => ble.emit('onAdvert', { id: 'cam-1', name: null, rssi: -50, manufacturerData: Uint8Array.from([0xaa, 0x08, 0x21, 0x00]), serviceUuids: [] }), 50);
    },
    stopScan: () => {},
    connect: async () => {},
    disconnect: async () => {},
    write: async (id, bytes) => {
      const f = decodeFrame(bytes)?.frame;
      if (!f) return;
      bleWrites.push(f);
      const key = (f.cmdSet << 8) | f.cmdId;
      if (key === 0x0745) notify(id, reply(f, [0x00, 0x01]));
      else if (key === 0x0707) notify(id, reply(f, identityOf('OsmoPocket4-CAM')));
      else if (key === 0x0739) notify(id, reply(f, [0x00, 0x01])); // already a station
      else if (key === 0x0748) notify(id, reply(f, [0x00, 0x00]));
      else if (key === 0x0747) notify(id, reply(f, [0x00, 0x00]));
    },
    addListener: ((event: string, cb: Handler) => ble.addListener(event, cb)) as PocketBluetoothNativeModule['addListener'],
  };
  const wifi: PocketWifiNativeModule = {
    join: vi.fn(async () => ({ joined: true, outcome: 'already-associated' as const })),
    leave: vi.fn(async () => {}),
    currentSsid: async () => 'Studio',
    localAddress: async () => '10.0.0.9',
  };
  const datalink: PocketDatalinkNativeModule = {
    open: async (sid, o) => {
      hostOf.set(sid, o.host);
      opened.push(`${sid}@${o.host}`);
    },
    close: async (sid) => {
      closed.push(sid);
      dl.emit('onState', { sessionId: sid, state: 'closed' });
    },
    sendRaw: (sid) => {
      if (answering[hostOf.get(sid) ?? '']) setTimeout(() => dl.emit('onState', { sessionId: sid, state: 'open' }), 10);
    },
    sendDuml: (sid, bytes) => {
      const f = decodeFrame(bytes)?.frame;
      if (!f) return;
      const ssid = answering[hostOf.get(sid) ?? ''];
      if (f.cmdSet === 0x07 && f.cmdId === 0x07 && ssid) setTimeout(() => dl.emit('onDuml', { sessionId: sid, bytes: reply(f, identityOf(ssid)) }), 5);
      else if (isLiveCameraControl(f.cmdSet, f.cmdId)) setTimeout(() => dl.emit('onDuml', { sessionId: sid, bytes: reply(f, [0]) }), 5);
    },
    attachVideo: vi.fn(),
    detachVideo: vi.fn(),
    addListener: ((event: string, cb: Handler) => dl.addListener(event, cb)) as PocketDatalinkNativeModule['addListener'],
  };
  return {
    bleWrites,
    opened,
    closed,
    hostOf,
    deps: {
      io: { bluetooth, wifi, datalink },
      credentials: { read: async () => undefined, save: async () => {}, remove: async () => {} },
      savedCameras: () => [] as SavedCamera[],
      now: () => Date.now(),
    },
  };
}

const HOTSPOT_CAMERA: SavedCamera = { id: 'cam-1', name: 'Pocket 4', model: 'osmo-pocket-4', path: { kind: 'hotspot', ssid: 'Phone' } };

describe('NativeCameraSession station path', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('without discovery keeps the single-camera rule: no saved host, no probing', async () => {
    const net = sharedNetwork('10.0.0.4');
    const session = new NativeCameraSession(net.deps);
    const done = session.connect(HOTSPOT_CAMERA, { wifiPassword: 'secret-pass' });
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(session.getState().connection.phase).toBe('failed');
    expect(net.opened).toHaveLength(0);
    await session.disconnect();
  });

  it('with a saved host and no discovery opens only that host', async () => {
    const net = sharedNetwork('10.0.0.4');
    const session = new NativeCameraSession(net.deps);
    const saved: SavedCamera = { ...HOTSPOT_CAMERA, path: { kind: 'station', ssid: 'Studio', host: '10.0.0.4' } };
    const done = session.connect(saved, { wifiPassword: 'secret-pass' });
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(session.getState().connection.phase).toBe('live-start');
    expect(net.opened.map((o) => o.split('@')[1])).toEqual(['10.0.0.4']);
    expect(session.getState().connection.transport).toBe('station');
    await session.disconnect();
  });

  it('discovers the camera by probe and identity, skipping another camera', async () => {
    const net = sharedNetwork('10.0.0.4', { '10.0.0.3': 'OsmoPocket3-OTHER' });
    const found: string[] = [];
    const station: StationDiscovery = {
      candidates: ({ localAddress }) => {
        expect(localAddress).toBe('10.0.0.9');
        return ['10.0.0.2', '10.0.0.3', '10.0.0.4'];
      },
      verifyIdentity: true,
      onHost: (_id, host) => found.push(host),
    };
    const session = new NativeCameraSession({ ...net.deps, station });
    const done = session.connect(HOTSPOT_CAMERA, { wifiPassword: 'secret-pass' });
    await vi.advanceTimersByTimeAsync(6_000);
    await done;
    expect(session.getState().connection.phase).toBe('live-start');
    expect(found).toEqual(['10.0.0.4']);
    const sid = (session.video as { sessionId: string }).sessionId;
    expect(net.hostOf.get(sid)).toBe('10.0.0.4');
    // Every probe session was closed again.
    const probes = net.opened.filter((o) => o.startsWith('pm-probe-')).map((o) => o.split('@')[0]);
    expect(probes).toHaveLength(3);
    probes.forEach((p) => expect(net.closed).toContain(p));
    expect(session.getState().connection.transport).toBe('hotspot');

    // Exit: the camera goes back to its own access point over the live BLE link.
    const restored = session.restoreAccessPoint();
    await vi.advanceTimersByTimeAsync(100);
    await expect(restored).resolves.toBe('restored');
    const off = net.bleWrites.find((f) => f.cmdSet === 0x07 && f.cmdId === 0x48);
    expect(Array.from(off!.payload)).toEqual([0]);
    await session.disconnect();
  });
});
