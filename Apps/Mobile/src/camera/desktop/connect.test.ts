import { afterEach, describe, expect, it } from 'vitest';
import { usePendingConnect } from '@/features/pairing/pairingStore';
import type { ConnectionState, DiscoveredCamera, SavedCamera } from '../types';
import { useDesktopHomeWifi } from './homeWifi';
import {
  addressTarget,
  cameraModelFor,
  desktopConnect,
  directTarget,
  knownToSaved,
  openTargetForSaved,
  startDesktopScan,
} from './connect';

type Call = { cmd: string; args?: Record<string, unknown> };

/** Tauri's injected internals: records invokes, answers from a table, delivers events. */
function fakeTauri(answers: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const callbacks = new Map<number, (response: unknown) => void>();
  const listeners = new Map<string, number>();
  let next = 1;
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      transformCallback(callback: (response: unknown) => void) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      invoke(cmd: string, args?: Record<string, unknown>) {
        calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') {
          listeners.set(args!.event as string, args!.handler as number);
          return Promise.resolve(next++);
        }
        if (cmd === 'plugin:event|unlisten') return Promise.resolve();
        try {
          return Promise.resolve(answers[cmd] ? answers[cmd](args) : null);
        } catch (error) {
          return Promise.reject(error);
        }
      },
    },
  };
  return {
    emit(event: string, payload: unknown) {
      const id = listeners.get(event);
      if (id != null) callbacks.get(id)?.({ event, id: 0, payload });
    },
    named: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    commands: () => calls.map((c) => c.cmd).filter((c) => !c.startsWith('plugin:')),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  usePendingConnect.getState().clear();
  useDesktopHomeWifi.setState({ home: null, remember: true });
});

const sighting: DiscoveredCamera = { id: 'AA:BB', name: 'Pocket 3', model: 'osmo-pocket-3', rssi: -50, pairable: true, saved: false };

describe('remembered cameras', () => {
  it('maps the backend files onto saved-camera records and back to open targets', () => {
    const lan = knownToSaved({ id: 'desktop-lan', kind: 'lan', name: 'Osmo Pocket 3', modelId: 0x20, host: '10.0.0.5' });
    expect(lan).toEqual({ id: 'desktop-lan', name: 'Osmo Pocket 3', model: 'osmo-pocket-3', path: { kind: 'station', ssid: '10.0.0.5', host: '10.0.0.5' } });
    expect(openTargetForSaved(lan)).toEqual({ kind: 'lan' });
    const station = knownToSaved({ id: 'desktop-station', kind: 'station', name: 'Osmo Nano', modelId: 0x19, ssid: 'Home' });
    expect(station.path).toEqual({ kind: 'station', ssid: 'Home' });
    expect(openTargetForSaved(station)).toEqual({ kind: 'station' });
    const softap = knownToSaved({ id: 'desktop-softap', kind: 'softap', name: 'DJI camera', ssid: 'Osmo-1' }, {
      id: 'desktop-softap',
      name: 'Studio',
      model: 'unknown',
      path: { kind: 'softap', ssid: 'Osmo-1' },
      lastConnectedAt: 5,
    });
    expect(softap.name).toBe('Studio');
    expect(softap.lastConnectedAt).toBe(5);
    expect(openTargetForSaved(softap)).toEqual({ kind: 'softap' });
    expect(openTargetForSaved(addressTarget('10.0.0.9:9004'))).toEqual({ kind: 'address', host: '10.0.0.9:9004' });
    expect(openTargetForSaved(directTarget)).toEqual({ kind: 'direct' });
    const phoneSaved: SavedCamera = { id: 'ble-1', name: 'P3', model: 'osmo-pocket-3', path: { kind: 'softap', ssid: 'Osmo-2' } };
    expect(openTargetForSaved(phoneSaved)).toEqual({ kind: 'softap', ssid: 'Osmo-2', model: 0x20 });
    expect(cameraModelFor(0x22)).toBe('osmo-pocket-4-pro');
    expect(cameraModelFor(null)).toBe('unknown');
  });
});

describe('scan', () => {
  it('turns adverts into sightings and stops the radio with the last screen', async () => {
    const tauri = fakeTauri();
    const seen: DiscoveredCamera[][] = [];
    const stopA = startDesktopScan((c) => seen.push(c));
    await flush();
    tauri.emit('ble://adverts', [{ id: 'AA', name: 'Osmo Pocket 3', modelId: 0x20, rssi: -61, pairable: true }]);
    expect(seen.at(-1)).toEqual([{ id: 'AA', name: 'Osmo Pocket 3', model: 'osmo-pocket-3', rssi: -61, pairable: true, saved: false }]);
    const stopB = startDesktopScan(() => {});
    expect(tauri.named('ble_scan_start')).toHaveLength(2);
    stopA();
    expect(tauri.named('ble_scan_stop')).toHaveLength(0);
    stopB();
    stopB();
    expect(tauri.named('ble_scan_stop')).toHaveLength(1);
  });
});

describe('first pair', () => {
  it('pairs, then has the backend join the camera Wi-Fi with what it read', async () => {
    const tauri = fakeTauri({
      ble_pair: () => ({ ssid: 'OsmoPocket3-1A2B', modelId: 0x20 }),
      camera_open: () => ({ connected: true, pair: false }),
    });
    const reports: (Partial<ConnectionState> | null)[] = [];
    await desktopConnect(sighting, undefined, (p) => reports.push(p));
    expect(tauri.commands()).toEqual(['ble_pair', 'camera_open']);
    expect(tauri.named('ble_pair')[0].args).toEqual({ address: 'AA:BB', model: 0x20 });
    expect(tauri.named('camera_open')[0].args).toEqual({ target: { kind: 'paired', model: 0x20 } });
    expect(reports.map((r) => r?.phase ?? null)).toEqual(['bluetooth', 'joining-wifi', null]);
    // The password never reaches the web.
    expect(JSON.stringify(reports)).not.toContain('password');
  });

  it('puts the camera on the chosen network, then finds it there', async () => {
    const tauri = fakeTauri({
      station_join: () => ({ host: '10.0.0.7:9004', modelId: 0x20, confirmed: true }),
      camera_open: () => ({ connected: true, pair: false }),
    });
    usePendingConnect.getState().begin({ id: 'AA:BB', name: 'Pocket 3', model: 'osmo-pocket-3', path: { kind: 'station', ssid: 'Home' } }, { firstPair: true });
    await desktopConnect(sighting, { wifiPassword: 'hunter22' }, () => {});
    expect(tauri.named('station_join')[0].args).toEqual({ address: 'AA:BB', ssid: 'Home', password: 'hunter22', remember: true, model: 0x20 });
    expect(tauri.named('camera_open')[0].args).toEqual({ target: { kind: 'station' } });
    // The kept network is read back after the join (name and whether a password is kept).
    expect(tauri.commands()).toContain('home_wifi_get');
  });

  it('joins the kept network with nothing typed, so no password crosses IPC', async () => {
    const tauri = fakeTauri({
      station_join: () => ({ host: '10.0.0.7:9004', modelId: 0x20, confirmed: true }),
      camera_open: () => ({ connected: true, pair: false }),
    });
    useDesktopHomeWifi.setState({ home: { ssid: 'Home', hasPassword: true }, remember: true });
    usePendingConnect.getState().begin({ id: 'AA:BB', name: 'Pocket 3', model: 'osmo-pocket-3', path: { kind: 'station', ssid: 'Home' } }, { firstPair: true });
    await desktopConnect(sighting, undefined, () => {});
    expect(tauri.named('station_join')[0].args).toEqual({ address: 'AA:BB', ssid: 'Home', remember: true, model: 0x20 });
  });

  it('a camera that gives no Wi-Fi name is looked for on the LAN', async () => {
    const tauri = fakeTauri({
      ble_pair: () => ({ ssid: '', modelId: 0x20, onLan: true }),
      camera_open: () => ({ connected: true, host: '10.0.0.7:9004', pair: false }),
    });
    const reports: (Partial<ConnectionState> | null)[] = [];
    await desktopConnect(sighting, undefined, (p) => reports.push(p));
    expect(tauri.named('camera_open')[0].args).toEqual({ target: { kind: 'paired', model: 0x20 } });
    expect(reports[1]).toMatchObject({ phase: 'joining-wifi', detail: 'Finding the camera on your Wi-Fi…', transport: 'station' });
  });

  it('shows a failure in the camera’s own words and keeps quiet about a cancel', async () => {
    fakeTauri({
      ble_pair: () => {
        throw 'Pairing timed out. Hold the camera closer and try again.';
      },
    });
    const reports: (Partial<ConnectionState> | null)[] = [];
    await expect(desktopConnect(sighting, undefined, (p) => reports.push(p))).rejects.toBeTruthy();
    expect(reports.at(-1)).toEqual({ phase: 'failed', detail: undefined, error: 'Pairing timed out. Hold the camera closer and try again.' });
    fakeTauri({
      ble_pair: () => {
        throw 'cancelled';
      },
    });
    const quiet: (Partial<ConnectionState> | null)[] = [];
    await expect(desktopConnect(sighting, undefined, (p) => quiet.push(p))).rejects.toBeTruthy();
    expect(quiet.at(-1)?.phase).toBe('disconnected');
  });

  it('relays the backend’s steps while pairing', async () => {
    let release: (value: unknown) => void = () => {};
    const tauri = fakeTauri({
      ble_pair: () => new Promise((resolve) => (release = resolve)),
      camera_open: () => ({ connected: true, pair: false }),
    });
    const reports: (Partial<ConnectionState> | null)[] = [];
    const done = desktopConnect(sighting, undefined, (p) => reports.push(p));
    await flush();
    tauri.emit('pair://step', { phase: 'authorizing', detail: 'Press the pairing button on the camera body.' });
    release({ ssid: 'Osmo', modelId: 0x20 });
    await done;
    expect(reports.map((r) => r?.phase ?? null)).toEqual(['bluetooth', 'authorizing', 'joining-wifi', null]);
  });

  it('a remembered camera that does not answer sends the operator to pairing', async () => {
    fakeTauri({ camera_open: () => ({ connected: false, pair: true }) });
    await expect(desktopConnect(directTarget, undefined, () => {})).rejects.toThrow(/Pair it again/);
  });
});
