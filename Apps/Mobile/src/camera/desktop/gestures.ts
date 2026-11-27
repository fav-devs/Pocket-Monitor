/**
 * Desktop gestures (`Apps/Desktop/crates/pm-desktop/src/{gestures,vision,mic}.rs`,
 * `docs/desktop-expo-port.md` §1.T): the settings in `desktop-app-v1.txt`, what Rust is
 * running, and the hand view (`Y`).
 *
 * - Settings go through `app_settings_get/set`; Rust applies them live (the webcam or the
 *   camera's own picture, hand control, the stick hand, face tracking by itself, the map).
 * - `gestures://state`: what runs now (after `J`, a settings change, a webcam failure).
 * - `vision://hands`: the hand view's landmarks, boxes and faces (≤ 15 Hz, only while the
 *   hand view is on), in fractions of the decoded picture before mirroring.
 *
 * Outside the desktop app nothing here calls Rust. `previewGestures()` lets the web preview
 * show the Gestures page with local settings (`?desktopPreview=1`, dev builds only). On phones
 * (`src/features/gestures`) the same store and pages serve the phone's own gestures: a
 * {@link GestureSettingsBackend} keeps the settings in the app's preferences, and the phone
 * runtime fills `overlay` for the hand view.
 */
import { create } from 'zustand';
import type { DesktopAppSettings } from './connect';
import type { DesktopGesturesState } from './input';
import { invoke, isTauri, listen, type Unlisten } from './tauri';
import { DEFAULT_GESTURE_MAP as CORE_DEFAULT_MAP, type GestureActionKey, type GestureKey } from '@/core/gestures/gesture';

/** Gesture and action keys, as `pm_controller::gesture` (`src/core/gestures/gesture.ts`). */
export type { GestureActionKey, GestureKey };

/** `webcam` is the desktop's; `frontCamera` the phones' own front camera (`PocketHands`). */
export type GestureSource = 'cameraFeed' | 'webcam' | 'frontCamera';

/** The gesture guide, in `Gesture::ALL` order. `held` poses fire after a hold. */
export const GESTURES: readonly { key: GestureKey; label: string; held: boolean }[] = [
  { key: 'swipe_left', label: 'Swipe left', held: false },
  { key: 'swipe_right', label: 'Swipe right', held: false },
  { key: 'swipe_up', label: 'Swipe up', held: false },
  { key: 'swipe_down', label: 'Swipe down', held: false },
  { key: 'palm', label: 'Open palm', held: true },
  { key: 'fist', label: 'Fist', held: true },
  { key: 'point', label: 'One finger', held: true },
  { key: 'two', label: 'Peace sign', held: true },
  { key: 'horns', label: 'Rock sign', held: true },
  { key: 'face_track', label: 'Open and close ×3', held: false },
];

/** What a gesture can do, in `GestureAction::ALL` order. */
export const GESTURE_ACTIONS: readonly { key: GestureActionKey; label: string }[] = [
  { key: 'nothing', label: 'Nothing' },
  { key: 'recenter', label: 'Recentre' },
  { key: 'flip', label: 'Flip' },
  { key: 'next_preset', label: 'Next preset' },
  { key: 'previous_preset', label: 'Previous preset' },
  { key: 'stop', label: 'Stop' },
  { key: 'record', label: 'Record' },
  { key: 'face_track', label: 'Face tracking' },
];

/** `GestureMap::default()`. Raising and lowering a hand reads as a vertical sweep, so those do nothing. */
export const DEFAULT_GESTURE_MAP: Readonly<Record<GestureKey, GestureActionKey>> = CORE_DEFAULT_MAP;

/** `AppSettings::default()`. */
export const DEFAULT_APP_SETTINGS: DesktopAppSettings = {
  gestures: false,
  openCameraAtLaunch: false,
  gestureMap: { ...DEFAULT_GESTURE_MAP },
  gestureSource: 'cameraFeed',
  handControl: true,
  stickIsRight: true,
  autoFaceTrack: false,
};

/** Seconds a pose is held before it fires: recording takes longer (`vision::RECORD_HOLD`). */
export const HOLD_SECONDS = 0.9;
export const RECORD_HOLD_SECONDS = 2.5;

const isGesture = (key: string): key is GestureKey => GESTURES.some((g) => g.key === key);
const isAction = (key: string): key is GestureActionKey => GESTURE_ACTIONS.some((a) => a.key === key);

/** The whole map, as Rust reads it: what the settings say, defaults for the rest, unknown keys dropped. */
export function gestureMapOf(settings: Pick<DesktopAppSettings, 'gestureMap'> | null | undefined): Record<GestureKey, GestureActionKey> {
  const map: Record<GestureKey, GestureActionKey> = { ...DEFAULT_GESTURE_MAP };
  for (const [gesture, action] of Object.entries(settings?.gestureMap ?? {})) {
    if (isGesture(gesture) && isAction(action)) map[gesture] = action;
  }
  return map;
}

/** Every field filled in, so a `set` never resets something the web did not show. */
export function normaliseAppSettings(settings: Partial<DesktopAppSettings> | null | undefined): DesktopAppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    ...settings,
    gestures: !!settings?.gestures,
    openCameraAtLaunch: !!settings?.openCameraAtLaunch,
    gestureMap: gestureMapOf(settings),
    gestureSource: settings?.gestureSource === 'webcam' || settings?.gestureSource === 'frontCamera' ? settings.gestureSource : 'cameraFeed',
    handControl: settings?.handControl ?? DEFAULT_APP_SETTINGS.handControl,
    stickIsRight: settings?.stickIsRight ?? DEFAULT_APP_SETTINGS.stickIsRight,
    autoFaceTrack: settings?.autoFaceTrack ?? DEFAULT_APP_SETTINGS.autoFaceTrack,
  };
}

/** The settings with one gesture given another action. */
export function withGestureAction(settings: DesktopAppSettings, gesture: GestureKey, action: GestureActionKey): DesktopAppSettings {
  return { ...settings, gestureMap: { ...gestureMapOf(settings), [gesture]: action } };
}

export function actionLabel(action: GestureActionKey): string {
  return GESTURE_ACTIONS.find((a) => a.key === action)?.label ?? 'Nothing';
}

/** How long this gesture is held with this map, for the guide ("Hold 2.5 s"); null for a movement. */
export function holdSeconds(gesture: GestureKey, map: Record<GestureKey, GestureActionKey>): number | null {
  if (!GESTURES.find((g) => g.key === gesture)?.held) return null;
  return map[gesture] === 'record' ? RECORD_HOLD_SECONDS : HOLD_SECONDS;
}

/** The source as the live controls name it. */
export function sourceLabel(source: GestureSource): string {
  return source === 'webcam' ? 'Webcam' : source === 'frontCamera' ? 'Front camera' : 'Camera picture';
}

// ───────────── The hand view ─────────────

/** `vision://hands` (`pm_controller::vision::HandOverlay`). */
export interface DesktopHandOverlay {
  /** `frontCamera`: a phone's front camera (`src/features/gestures`). */
  source: 'cameraFeed' | 'webcam' | 'frontCamera' | 'off';
  status: string;
  hands: {
    points: [number, number][];
    /** Left, top, right, bottom, with room. */
    bounds: [number, number, number, number];
    right: boolean;
    role: 'stick' | 'zoom';
    pose: 'fist' | 'point' | 'two' | 'horns' | 'palm' | null;
    score: number;
    reach: [number, number, number, number];
    pinch: number;
  }[];
  grabs: { role: 'stick' | 'zoom'; anchor: [number, number]; point: [number, number] }[];
  hold: number;
  faces: { x: number; y: number; width: number; height: number; score: number }[];
}

// ───────────── The store ─────────────

interface DesktopGesturesStore {
  /** The saved settings, once read. */
  settings: DesktopAppSettings | null;
  /** What Rust runs now. */
  running: DesktopGesturesState | null;
  /** `Y`. */
  handView: boolean;
  overlay: DesktopHandOverlay | null;
  /** The last save failed. */
  error: string | null;
}

export const useDesktopGestures = create<DesktopGesturesStore>()(() => ({
  settings: null,
  running: null,
  handView: false,
  overlay: null,
  error: null,
}));

let preview = false;

/**
 * Where the settings live when Rust does not keep them: a phone with `PocketHands`
 * (`src/features/gestures/phoneGestures.ts` registers one; it keeps them in the app's
 * preferences and runs the gestures itself). Desktop behaviour is unchanged.
 */
export interface GestureSettingsBackend {
  /** The sources this device offers, in the order the page lists them. */
  sources: readonly GestureSource[];
  load(): DesktopAppSettings;
  save(settings: DesktopAppSettings): void;
}

let backend: GestureSettingsBackend | null = null;

/** Registers (or clears) the phone's settings backend and shows its settings at once. */
export function setGestureSettingsBackend(next: GestureSettingsBackend | null) {
  if (isTauri()) return;
  backend = next;
  if (next) useDesktopGestures.setState({ settings: normaliseAppSettings(next.load()) });
}

/** The sources the Gestures page offers here: the desktop's camera picture and webcam, or the phone's. */
export function gestureSources(): readonly GestureSource[] {
  if (!isTauri() && !preview && backend) return backend.sources;
  return ['cameraFeed', 'webcam'];
}

/** True when the Gestures page belongs to a phone (its own models and settings), not the desktop app. */
export function gesturesRunOnPhone(): boolean {
  return !isTauri() && !preview && backend != null;
}

/** The web preview of the desktop pages (dev only): local settings, no Rust. */
export function previewGestures() {
  if (isTauri()) return;
  preview = true;
  if (!useDesktopGestures.getState().settings) useDesktopGestures.setState({ settings: normaliseAppSettings(null) });
}

/** Dev builds on the web: `?desktopPreview=1` shows the desktop-only pages with local settings. */
function previewAskedFor(): boolean {
  const dev = typeof __DEV__ !== 'undefined' && __DEV__;
  const search = typeof window !== 'undefined' ? (window.location?.search ?? '') : '';
  return dev && /(?:^|[?&])desktopPreview=1(?:&|$)/.test(search);
}
/** A hand view to look at in the web preview (`&handView=1`): two hands, a pinch, a face. */
function previewOverlay(): DesktopHandOverlay {
  const hand = (cx: number, open: boolean): [number, number][] => {
    const pts: [number, number][] = [[cx, 0.62]];
    // Thumb, then four fingers fanned upward from the palm.
    for (let j = 1; j <= 4; j++) pts.push([cx - 0.02 * j, 0.6 - 0.025 * j]);
    for (let f = 0; f < 4; f++) {
      const x = cx - 0.02 + f * 0.018;
      for (let j = 0; j < 4; j++) pts.push([x, 0.52 - (open ? 0.03 : 0.008) * j]);
    }
    return pts;
  };
  const bounds = (pts: [number, number][]): [number, number, number, number] => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs) - 0.01, Math.min(...ys) - 0.02, Math.max(...xs) + 0.01, Math.max(...ys) + 0.02];
  };
  const right = hand(0.68, true);
  const left = hand(0.3, false);
  return {
    source: 'cameraFeed',
    status: 'GPU 9 ms',
    hands: [
      { points: right, bounds: bounds(right), right: true, role: 'stick', pose: 'palm', score: 0.97, reach: [1.7, 1.8, 1.7, 1.6], pinch: 0.83 },
      { points: left, bounds: bounds(left), right: false, role: 'zoom', pose: null, score: 0.94, reach: [1.1, 1.1, 1.0, 1.0], pinch: 0.12 },
    ],
    grabs: [{ role: 'zoom', anchor: [0.3, 0.5], point: [0.3, 0.42] }],
    hold: 0.45,
    faces: [{ x: 0.45, y: 0.12, width: 0.1, height: 0.17, score: 0.92 }],
  };
}

if (!isTauri() && previewAskedFor()) {
  previewGestures();
  if (/(?:^|[?&])handView=1(?:&|$)/.test(window.location?.search ?? '')) {
    useDesktopGestures.setState({ handView: true, overlay: previewOverlay(), settings: { ...normaliseAppSettings(null), gestures: true } });
  }
}

/** True where the Gestures page belongs: the desktop app, its web preview, or a phone with `PocketHands`. */
export function gesturesAvailable(): boolean {
  return isTauri() || preview || backend != null;
}

/** Reads the settings (once is enough; `gestures://state` refreshes them after `J`). */
export async function loadGestureSettings(): Promise<DesktopAppSettings | null> {
  if (!isTauri()) {
    if (preview) previewGestures();
    else if (backend) useDesktopGestures.setState({ settings: normaliseAppSettings(backend.load()) });
    return useDesktopGestures.getState().settings;
  }
  try {
    const settings = normaliseAppSettings(await invoke<DesktopAppSettings>('app_settings_get'));
    useDesktopGestures.setState({ settings });
    return settings;
  } catch {
    return null;
  }
}

/** Lays a change over the settings, shows it at once and saves it; Rust applies it live. */
export async function saveGestureSettings(patch: Partial<DesktopAppSettings>): Promise<void> {
  const before = useDesktopGestures.getState().settings ?? (await loadGestureSettings());
  if (!before) return;
  const next = normaliseAppSettings({ ...before, ...patch });
  useDesktopGestures.setState({ settings: next, error: null });
  if (!isTauri()) {
    if (!preview) backend?.save(next);
    return;
  }
  try {
    const saved = await invoke<DesktopAppSettings>('app_settings_set', { settings: next });
    useDesktopGestures.setState({ settings: normaliseAppSettings(saved) });
  } catch (error) {
    useDesktopGestures.setState({
      settings: before,
      error: typeof error === 'string' ? error : error instanceof Error ? error.message : 'Not saved',
    });
  }
}

/** Shows or hides the hand view; Rust sends `vision://hands` only while it shows. */
export function setHandView(on: boolean) {
  useDesktopGestures.setState({ handView: on, ...(on ? {} : { overlay: null }) });
  if (isTauri()) invoke('hand_view_set', { on }).catch(() => {});
}

export function toggleHandView() {
  setHandView(!useDesktopGestures.getState().handView);
}

/** Listens for Rust's gesture events. Called once by `DesktopCameraSession`. */
export function watchGestures(): Unlisten[] {
  const stops = [
    listen<DesktopGesturesState>('gestures://state', (running) => {
      const settings = useDesktopGestures.getState().settings;
      useDesktopGestures.setState({
        running,
        ...(settings ? { settings: { ...settings, gestures: running.on, gestureSource: running.source ?? settings.gestureSource } } : {}),
      });
    }),
    listen<DesktopHandOverlay>('vision://hands', (overlay) => {
      if (useDesktopGestures.getState().handView) useDesktopGestures.setState({ overlay });
    }),
  ];
  loadGestureSettings().catch(() => {});
  invoke<DesktopGesturesState>('gestures_state')
    .then((running) => useDesktopGestures.setState({ running }))
    .catch(() => {});
  // A reloaded web view starts with the hand view hidden; tell Rust so it stops sending.
  invoke('hand_view_set', { on: false }).catch(() => {});
  return stops;
}
