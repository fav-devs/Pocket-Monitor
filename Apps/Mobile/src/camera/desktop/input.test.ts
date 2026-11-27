import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialCameraState } from '../defaults';
import { DesktopCameraSession } from './DesktopCameraSession';
import { useDesktopInput, withInput, zoomWrite, type DesktopInputView, type DesktopTrackingView } from './input';

type Call = { cmd: string; args?: Record<string, unknown> };

function fakeTauri() {
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
        if (cmd === 'camera_state') return Promise.resolve({ ...initialCameraState(), connection: { ...initialCameraState().connection, phase: 'live' } });
        if (cmd === 'moves_set_point') return Promise.resolve({ yaw: 12.5, pitch: -3 });
        return Promise.resolve(null);
      },
    },
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

const view: DesktopInputView = {
  countdown: 2,
  countdownSeconds: 3,
  lockedAllAxes: true,
  program: {
    status: 'running',
    a: { yaw: 10, pitch: 0 },
    b: { yaw: 60, pitch: 5 },
    c: null,
    legSeconds: [4, 5],
    smoothness: 0.5,
    progress: 0.25,
    error: null,
    readout: 'MOVE · A→B 1.0 / 4.0 s',
    paused: false,
  },
  presets: { slots: [null, null, null, null, null, null], seconds: 2, choices: [0.5, 1, 2, 4, 8, 15], cursor: null },
  gamepadEnabled: true,
};

const tracking: DesktopTrackingView = {
  status: 'tracking',
  box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
  sensor: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
  drag: null,
  focus: null,
  mirror: false,
};

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  useDesktopInput.setState({ input: null, tracking: null, gamepad: { connected: false } });
});

describe('desktop live controls', () => {
  let tauri: ReturnType<typeof fakeTauri>;
  beforeEach(() => {
    tauri = fakeTauri();
  });

  it('leaves the state alone until Rust reports', () => {
    const state = initialCameraState();
    expect(withInput(state)).toBe(state);
  });

  it('folds the countdown, the program, the lock and the tracking box into the state', async () => {
    const session = new DesktopCameraSession();
    await flush();
    tauri.emit('input://state', view);
    tauri.emit('tracking://box', tracking);
    const s = session.getState();
    expect(s.recording.countdown).toBe(2);
    expect(s.gimbal.lockedAllAxes).toBe(true);
    expect(s.gimbal.program.status).toBe('running');
    expect(s.gimbal.program.a).toEqual({ yaw: 10, pitch: 0 });
    expect(s.gimbal.program.legSeconds).toEqual([4, 5]);
    expect(s.tracking.status).toBe('tracking');
    expect(s.tracking.box).toEqual(tracking.box);
    // A later camera://state from Rust keeps the overlay.
    tauri.emit('camera://state', { ...initialCameraState(), connection: { ...initialCameraState().connection, phase: 'live' } });
    expect(session.getState().recording.countdown).toBe(2);
    expect(tauri.named('input_resend')).toHaveLength(1);
    session.dispose();
  });

  it('routes the live calls to the input thread, not camera_command', async () => {
    const session = new DesktopCameraSession();
    await session.control.focusAt({ x: 0.5, y: 0.4 });
    await session.control.startTracking({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    await session.control.stopTracking();
    session.control.zoomBy(0.6);
    session.control.zoomBy(0.6);
    await session.control.startRecording({ countdown: true });
    session.gimbal.setLockedAllAxes(true);
    const point = await session.gimbal.captureWaypoint('a');
    session.gimbal.configureProgram({ legSeconds: [3, 4] });
    await session.gimbal.runProgram();
    session.gimbal.stopProgram();
    await flush();
    expect(tauri.named('camera_command')).toHaveLength(0);
    expect(tauri.named('focus_at')[0].args).toEqual({ x: 0.5, y: 0.4 });
    expect(tauri.named('picture_pointer').map((c) => c.args!.phase)).toEqual(['down', 'move', 'up']);
    expect(tauri.named('picture_pointer')[2].args).toMatchObject({ x: 0.4, y: 0.6000000000000001 });
    expect(tauri.named('track_clear')).toHaveLength(1);
    expect(tauri.named('zoom_rate')).toHaveLength(1);
    expect(tauri.named('record_countdown')).toHaveLength(1);
    expect(tauri.named('gimbal_lock_all')[0].args).toEqual({ on: true });
    expect(point).toEqual({ yaw: 12.5, pitch: -3 });
    expect(tauri.named('moves_configure')[0].args).toEqual({ legSeconds: [3, 4], smoothness: null });
    expect(tauri.named('moves_start')).toHaveLength(1);
    expect(tauri.named('moves_stop')).toHaveLength(1);
    session.dispose();
  });

  it('sends a lone zoom as a jump and a stream as the dial', async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    zoomWrite(3);
    zoomWrite(3.1);
    zoomWrite(3.2);
    await new Promise((resolve) => setTimeout(resolve, 250));
    zoomWrite(1);
    expect(tauri.named('zoom_write').map((c) => c.args!.mode)).toEqual(['jump', 'slider', 'slider', 'jump']);
  });
});
