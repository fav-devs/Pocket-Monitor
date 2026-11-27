import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GESTURE_MAP,
  GESTURES,
  GESTURE_ACTIONS,
  actionLabel,
  gestureMapOf,
  holdSeconds,
  normaliseAppSettings,
  saveGestureSettings,
  setHandView,
  useDesktopGestures,
  watchGestures,
  withGestureAction,
  type DesktopHandOverlay,
} from './gestures';

type Call = { cmd: string; args?: Record<string, unknown> };

function fakeTauri(saved: Record<string, unknown> = {}) {
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
        if (cmd === 'app_settings_get') return Promise.resolve(saved);
        if (cmd === 'app_settings_set') return Promise.resolve(args!.settings);
        if (cmd === 'gestures_state') return Promise.resolve({ on: false, source: 'cameraFeed' });
        return Promise.resolve(null);
      },
    },
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
  useDesktopGestures.setState({ settings: null, running: null, handView: false, overlay: null, error: null });
});

describe('the gesture map', () => {
  it('names every gesture and action Rust knows, with its defaults', () => {
    expect(GESTURES.map((g) => g.key)).toEqual(['swipe_left', 'swipe_right', 'swipe_up', 'swipe_down', 'palm', 'fist', 'point', 'two', 'horns', 'face_track']);
    expect(GESTURE_ACTIONS.map((a) => a.key)).toEqual(['nothing', 'recenter', 'flip', 'next_preset', 'previous_preset', 'stop', 'record', 'face_track', 'marker']);
    expect(DEFAULT_GESTURE_MAP.two).toBe('record');
    expect(DEFAULT_GESTURE_MAP.swipe_down).toBe('nothing');
  });

  it('fills what the file leaves out and drops what it does not know', () => {
    const map = gestureMapOf({ gestureMap: { fist: 'flip', wave: 'recenter', palm: 'dance' } });
    expect(map.fist).toBe('flip');
    expect(map.palm).toBe('stop');
    expect(Object.keys(map)).toHaveLength(10);
    expect('wave' in map).toBe(false);
    expect(gestureMapOf(null)).toEqual(DEFAULT_GESTURE_MAP);
  });

  it('normalises settings so a save never resets a field the page did not show', () => {
    const s = normaliseAppSettings({ gestures: true, gestureSource: 'webcam', stickIsRight: false });
    expect(s).toMatchObject({ gestures: true, gestureSource: 'webcam', stickIsRight: false, handControl: true, autoFaceTrack: false, openCameraAtLaunch: false });
    expect(normaliseAppSettings({ gestureSource: 'nonsense' as 'webcam' }).gestureSource).toBe('cameraFeed');
  });

  it('gives one gesture another action and says how long each pose is held', () => {
    const s = withGestureAction(normaliseAppSettings(null), 'fist', 'record');
    const map = gestureMapOf(s);
    expect(map.fist).toBe('record');
    expect(holdSeconds('fist', map)).toBe(2.5);
    expect(holdSeconds('palm', map)).toBe(0.9);
    expect(holdSeconds('swipe_left', map)).toBeNull();
    expect(actionLabel('previous_preset')).toBe('Previous preset');
  });
});

describe('the desktop gesture store', () => {
  it('saves the whole settings and keeps what Rust answered', async () => {
    const tauri = fakeTauri({ gestures: false, openCameraAtLaunch: true, gestureMap: { fist: 'flip' } });
    await saveGestureSettings({ gestures: true, gestureSource: 'webcam' });
    const [set] = tauri.named('app_settings_set');
    const sent = set.args!.settings as Record<string, unknown>;
    expect(sent).toMatchObject({ gestures: true, gestureSource: 'webcam', openCameraAtLaunch: true, handControl: true });
    expect((sent.gestureMap as Record<string, string>).fist).toBe('flip');
    expect(Object.keys(sent.gestureMap as object)).toHaveLength(10);
    expect(useDesktopGestures.getState().settings?.gestureSource).toBe('webcam');
  });

  it('follows J and shows hands only while the hand view is on', async () => {
    const tauri = fakeTauri({ gestures: false });
    watchGestures();
    await flush();
    expect(tauri.named('hand_view_set')[0].args).toEqual({ on: false });
    tauri.emit('gestures://state', { on: true, source: 'cameraFeed' });
    expect(useDesktopGestures.getState().settings?.gestures).toBe(true);
    const overlay: DesktopHandOverlay = { source: 'cameraFeed', status: 'GPU 9 ms', hands: [], grabs: [], hold: 0, faces: [] };
    tauri.emit('vision://hands', overlay);
    expect(useDesktopGestures.getState().overlay).toBeNull();
    setHandView(true);
    expect(tauri.named('hand_view_set').at(-1)!.args).toEqual({ on: true });
    tauri.emit('vision://hands', overlay);
    expect(useDesktopGestures.getState().overlay).toEqual(overlay);
    setHandView(false);
    expect(useDesktopGestures.getState().overlay).toBeNull();
  });
});
