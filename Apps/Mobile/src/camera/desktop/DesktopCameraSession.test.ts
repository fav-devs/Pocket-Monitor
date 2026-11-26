import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialCameraState } from '../defaults';
import type { SessionEvent } from '../session';
import type { CameraState, SavedCamera } from '../types';
import { DesktopCameraSession, desktopTarget, shareSlices } from './DesktopCameraSession';
import { isTauri } from './tauri';

type Call = { cmd: string; args?: Record<string, unknown> };

/** A stand-in for Tauri's injected internals: records invokes, delivers events. */
function fakeTauri(answers: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const callbacks = new Map<number, (response: unknown) => void>();
  const listeners = new Map<string, number>();
  let next = 1;
  const internals = {
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
      const answer = answers[cmd];
      try {
        return Promise.resolve(answer ? answer(args) : null);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: internals,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return {
    calls,
    emit(event: string, payload: unknown) {
      const id = listeners.get(event);
      if (id != null) callbacks.get(id)?.({ event, id: 0, payload });
    },
    named: (cmd: string) => calls.filter((c) => c.cmd === cmd),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.useRealTimers();
});

describe('desktop target', () => {
  it('connects a station camera to its address and names the model', () => {
    const station: SavedCamera = {
      id: 'a',
      name: 'Pocket 3',
      model: 'osmo-pocket-3',
      path: { kind: 'station', ssid: 'Home', host: '10.0.0.7' },
    };
    expect(desktopTarget(station)).toEqual({ host: '10.0.0.7', model: 0x20 });
    expect(desktopTarget({ ...station, path: { kind: 'softap', ssid: 'Osmo' } })).toEqual({ model: 0x20 });
    expect(desktopTarget({ ...station, model: 'unknown' }).model).toBeUndefined();
  });
});

describe('shareSlices', () => {
  it('keeps unchanged slices and returns the same state when nothing changed', () => {
    const prev = initialCameraState('osmo-pocket-3');
    const same = JSON.parse(JSON.stringify(prev)) as CameraState;
    expect(shareSlices(prev, same)).toBe(prev);
    const next = { ...same, recording: { ...same.recording, recording: true } };
    const shared = shareSlices(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared.exposure).toBe(prev.exposure);
    expect(shared.recording.recording).toBe(true);
  });
});

describe('DesktopCameraSession', () => {
  let tauri: ReturnType<typeof fakeTauri>;

  beforeEach(() => {
    tauri = fakeTauri({
      camera_state: () => ({ ...initialCameraState(), connection: { ...initialCameraState().connection, phase: 'live' } }),
      camera_command: (args) => {
        const command = args!.command as { type: string };
        if (command.type === 'setAperture') throw 'THIS CAMERA HAS A FIXED APERTURE';
        return null;
      },
    });
  });

  it('is only picked inside Tauri', () => {
    expect(isTauri()).toBe(true);
    delete (globalThis as unknown as { window?: unknown }).window;
    expect(isTauri()).toBe(false);
  });

  it('re-attaches to the running link and follows camera://state', async () => {
    const session = new DesktopCameraSession();
    expect(session.kind).toBe('desktop');
    expect(session.video).toEqual({ kind: 'desktop' });
    await flush();
    expect(tauri.named('camera_state')).toHaveLength(1);
    expect(tauri.named('camera_connect')).toHaveLength(0);
    expect(session.getState().connection.phase).toBe('live');
    const seen: CameraState[] = [];
    session.subscribe((s) => seen.push(s));
    const state = session.getState();
    tauri.emit('camera://state', { ...state, recording: { ...state.recording, recording: true } });
    expect(seen).toHaveLength(1);
    expect(session.getState().recording.recording).toBe(true);
    expect(session.getState().exposure).toBe(state.exposure);
    session.dispose();
  });

  it('sends controller calls as typed commands and turns a refusal into one notice', async () => {
    const session = new DesktopCameraSession();
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.control.setIso('auto');
    await session.control.setWhiteBalance({ kelvin: 5600 });
    await session.gimbal.setMode('fpv');
    expect(tauri.named('camera_command').map((c) => c.args!.command)).toEqual([
      { type: 'setIso', iso: 'auto' },
      { type: 'setWhiteBalance', kelvin: 5600 },
      { type: 'gimbalSetMode', mode: 'fpv' },
    ]);
    await session.control.setAperture(2.8);
    await session.control.setAperture(2.8);
    const notices = events.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].type === 'notice' && notices[0].notice.message).toBe('THIS CAMERA HAS A FIXED APERTURE');
    session.dispose();
  });

  it('streams the stick with a heartbeat and releases on rest', async () => {
    vi.useFakeTimers();
    const session = new DesktopCameraSession();
    session.gimbal.drive(0.5, 0);
    expect(tauri.named('gimbal_drive')).toHaveLength(1);
    // Held still: the heartbeat keeps it alive inside Rust's 250 ms window.
    vi.advanceTimersByTime(350);
    expect(tauri.named('gimbal_drive').length).toBeGreaterThanOrEqual(3);
    session.gimbal.drive(0, 0);
    expect(tauri.named('gimbal_release')).toHaveLength(1);
    const after = tauri.named('gimbal_drive').length;
    vi.advanceTimersByTime(500);
    expect(tauri.named('gimbal_drive')).toHaveLength(after);
    session.dispose();
  });

  it('connects and disconnects through the backend', async () => {
    const session = new DesktopCameraSession();
    await session.connect({ id: 'x', name: 'Pocket 3', model: 'osmo-pocket-3', path: { kind: 'softap', ssid: 'Osmo' } });
    // A saved SoftAP camera joins its Windows profile, then links (./connect.ts).
    expect(tauri.named('camera_open')[0].args).toEqual({ target: { kind: 'softap', ssid: 'Osmo', model: 0x20 } });
    await session.disconnect();
    expect(tauri.named('camera_disconnect')).toHaveLength(1);
    await session.retry();
    expect(tauri.named('camera_reconnect')).toHaveLength(1);
    session.dispose();
  });
});
