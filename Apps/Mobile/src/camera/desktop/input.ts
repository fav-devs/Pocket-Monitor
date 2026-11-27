/**
 * The desktop app's live controls over IPC (`Apps/Desktop/crates/pm-desktop/src/input.rs`).
 *
 * Rust owns every time-critical control on its 100 Hz input thread: the stick from keys,
 * pad and controller, zoom (body stops, the D-Log2 hop, hold-to-zoom at 20 Hz), tracking
 * (poll 0.5 s, push silence 0.35 s), tap focus (ACK wait 0.4 s), the record countdown,
 * programmed moves (40 ms late abort) and gimbal presets. This module only sends intents and
 * folds what Rust reports back into the mobile `CameraState`:
 *
 * - `input://state`: countdown, Motion Control program, presets, the all-axes lock.
 * - `tracking://box`: the tracking box and the tap-focus reticle, as seen (≤ 15 Hz).
 * - `gamepad://state`: the controller, for display only (Rust already applied it).
 *
 * `DesktopCameraSession` calls `withInput` on every state it publishes and `watchInput` once.
 */
import { create } from 'zustand';
import type { CameraState, MotionProgramState, MotionWaypoint, PicturePoint, PictureRect } from '../types';
import { invoke, isTauri, listen, type Unlisten } from './tauri';

/** A pose as Rust reports it (display degrees, unwrapped pan). */
export interface DesktopPose {
  yaw: number;
  pitch: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `tracking://box`. */
export interface DesktopTrackingView {
  status: 'idle' | 'searching' | 'tracking';
  box: Rect | null;
  sensor: Rect | null;
  drag: Rect | null;
  focus: [number, number] | null;
  mirror: boolean;
}

/** `input://state`. */
export interface DesktopInputView {
  countdown: number | null;
  countdownSeconds: number;
  lockedAllAxes: boolean;
  program: {
    status: MotionProgramState['status'];
    a: DesktopPose | null;
    b: DesktopPose | null;
    c: DesktopPose | null;
    legSeconds: [number, number];
    smoothness: number;
    progress: number;
    error: string | null;
    readout: string;
    paused: boolean;
  };
  presets: {
    slots: (DesktopPose | null)[];
    seconds: number;
    choices: number[];
    cursor: number | null;
  };
  gamepadEnabled: boolean;
  /** A held gesture on its way to recording (the old `HOLD TO START RECORDING` bar). */
  gestureHold?: { text: string; fraction: number } | null;
}

/** `gamepad://state` (the mobile `GamepadState` shape). */
export interface DesktopGamepadState {
  connected: boolean;
  name?: string;
  leftX?: number;
  leftY?: number;
  rightX?: number;
  rightY?: number;
  l2?: number;
  r2?: number;
  buttons?: Record<string, boolean>;
}

interface DesktopInputStore {
  input: DesktopInputView | null;
  tracking: DesktopTrackingView | null;
  gamepad: DesktopGamepadState;
}

/** What Rust last reported. Desktop-only UI (presets, the gamepad row) reads this. */
export const useDesktopInput = create<DesktopInputStore>()(() => ({
  input: null,
  tracking: null,
  gamepad: { connected: false },
}));

/** True inside the desktop app: the live controls run in Rust. */
export function desktopInput(): boolean {
  return isTauri();
}

const pose = (p: DesktopPose | null | undefined): MotionWaypoint | undefined => (p ? { yaw: p.yaw, pitch: p.pitch } : undefined);

/** Folds Rust's live-control state into a `CameraState`. Unchanged slices keep identity. */
export function withInput(state: CameraState): CameraState {
  const { input, tracking } = useDesktopInput.getState();
  if (!input && !tracking) return state;
  let next = state;
  if (input) {
    const p = input.program;
    const program: MotionProgramState = {
      status: p.status,
      a: pose(p.a),
      b: pose(p.b),
      c: pose(p.c),
      legSeconds: p.legSeconds,
      smoothness: p.smoothness,
      progress: p.progress,
      ...(p.error ? { error: p.error } : {}),
    };
    next = {
      ...next,
      recording: { ...next.recording, countdown: input.countdown },
      gimbal: { ...next.gimbal, lockedAllAxes: input.lockedAllAxes, program },
    };
  }
  if (tracking) {
    // The box being dragged is drawn by the feed well itself; this is what the body has.
    next = {
      ...next,
      tracking: { ...next.tracking, status: tracking.status, box: tracking.box ?? undefined },
      focus: tracking.focus
        ? { ...next.focus, x: tracking.focus[0], y: tracking.focus[1], hasPoint: true }
        : { ...next.focus, hasPoint: false },
    };
  }
  return next;
}

/** Listens for Rust's live-control events; `onChange` re-publishes the session's state. */
export function watchInput(onChange: () => void): Unlisten[] {
  const stops = [
    listen<DesktopInputView>('input://state', (input) => {
      useDesktopInput.setState({ input });
      onChange();
    }),
    listen<DesktopTrackingView>('tracking://box', (tracking) => {
      useDesktopInput.setState({ tracking });
      onChange();
    }),
    listen<DesktopGamepadState>('gamepad://state', (gamepad) => useDesktopInput.setState({ gamepad })),
  ];
  // A reloaded web view asks for everything again; a fresh one gets it anyway.
  invoke('input_resend').catch(() => {});
  return stops;
}

const quiet = (p: Promise<unknown>) => {
  p.catch(() => {});
};

// ───────────── Keys ─────────────

/** What the web does for a key Rust routed back (`pm_controller::keys::UiAction`). */
export type DesktopKeyAction =
  | 'toggle-settings'
  | 'toggle-exposure'
  | 'toggle-moves'
  | 'toggle-assists'
  | 'toggle-zebra'
  | 'toggle-peaking'
  | 'toggle-grade'
  | 'toggle-mirror'
  | 'toggle-chrome'
  | 'library'
  | 'still'
  | 'escape'
  | 'fullscreen'
  /** `Y`: the hand view over the picture. */
  | 'toggle-hand-view'
  /** `J`: gestures on or off, already switched in Rust; the web reflects it. */
  | 'toggle-gestures'
  /** `M` (additive): a marker on the take being recorded; the web owns markers. */
  | 'marker';

/** One key event to Rust. Resolves with the web's part, if any. */
export async function controlKey(key: string, down: boolean, repeat = false): Promise<DesktopKeyAction | null> {
  try {
    return (await invoke<DesktopKeyAction | null>('control_key', { key, down, repeat })) ?? null;
  } catch {
    return null;
  }
}

// ───────────── Pointer, tracking, focus ─────────────

/** One pointer event on the picture, in picture fractions as seen. */
export function picturePointer(phase: 'down' | 'move' | 'up' | 'cancel', x: number, y: number, id = 1, mirror?: boolean) {
  quiet(invoke('picture_pointer', { phase, x, y, id, ...(mirror == null ? {} : { mirror }) }));
}

/** The picture's mirror as shown, so Rust undoes it onto the sensor. */
export function setPictureMirror(mirror: boolean) {
  quiet(invoke('input_configure', { config: { mirror } }));
}

/** A tap: a click Rust classifies (focus there, clearing tracking first). */
export function focusAt(point: PicturePoint) {
  quiet(invoke('focus_at', { x: point.x, y: point.y }));
}

/** A box drawn as seen: sent as the drag it was, so Rust applies the desktop rules. */
export async function trackBox(box: PictureRect) {
  await invoke('picture_pointer', { phase: 'down', x: box.x, y: box.y, id: 99 });
  await invoke('picture_pointer', { phase: 'move', x: box.x + box.width, y: box.y + box.height, id: 99 });
  await invoke('picture_pointer', { phase: 'up', x: box.x + box.width, y: box.y + box.height, id: 99 });
}

export function trackClear() {
  quiet(invoke('track_clear'));
}

// ───────────── Zoom ─────────────

/** A second write this soon after the last is the dial being dragged, not a stop. */
const SLIDER_WINDOW_MS = 200;
let lastZoomAt = 0;

/**
 * `setZoom`: a lone write is a jump to a stop (urgent, retransmitted); a stream of writes is
 * the dial (coalesced, pipelined at 20 Hz). Rust clamps to the body's stops and hops D-Log2.
 */
export function zoomWrite(factor: number, mode?: 'jump' | 'slider') {
  const now = Date.now();
  const resolved = mode ?? (now - lastZoomAt < SLIDER_WINDOW_MS ? 'slider' : 'jump');
  lastZoomAt = now;
  quiet(invoke('zoom_write', { factor, mode: resolved }));
}

let lastRate = 0;
/** `zoomBy`: only a change goes over IPC; Rust streams the dial at the phones' rate. */
export function zoomRate(rate: number) {
  if (rate === lastRate) return;
  lastRate = rate;
  quiet(invoke('zoom_rate', { rate }));
}

export function zoomStep(direction: 1 | -1) {
  quiet(invoke('zoom_step', { direction }));
}

// ───────────── Countdown, lock, feel ─────────────

/** Arms the record countdown, or cancels it. It fires in Rust. */
export function recordCountdown() {
  quiet(invoke('record_countdown'));
}

export function lockAllAxes(on: boolean) {
  quiet(invoke('gimbal_lock_all', { on }));
}

export interface DesktopInputConfig {
  stickSensitivity?: number;
  ramp?: 0 | 1 | 2;
  countdownSeconds?: number;
  gamepad?: boolean;
  directionLock?: boolean;
  mirror?: boolean;
}

export function configureInput(config: DesktopInputConfig) {
  quiet(invoke('input_configure', { config }));
}

// ───────────── Motion Control and presets ─────────────

export async function movesSetPoint(slot: 'a' | 'b' | 'c'): Promise<MotionWaypoint> {
  const p = await invoke<DesktopPose>('moves_set_point', { slot });
  return { yaw: p.yaw, pitch: p.pitch };
}

export function movesClearPoint(slot: 'a' | 'b' | 'c') {
  quiet(invoke('moves_clear_point', { slot }));
}

export function movesConfigure(options: { legSeconds?: [number, number]; smoothness?: number }) {
  quiet(invoke('moves_configure', { legSeconds: options.legSeconds ?? null, smoothness: options.smoothness ?? null }));
}

export function movesStart() {
  quiet(invoke('moves_start'));
}

export function movesStop() {
  quiet(invoke('moves_stop'));
}

export function movesPause() {
  quiet(invoke('moves_pause'));
}

export function movesResume() {
  quiet(invoke('moves_resume'));
}

/** Presets are slots 0…5 here; the operator reads them as 1…6 (keys 1–6). */
export function presetSave(slot: number): Promise<DesktopPose> {
  return invoke<DesktopPose>('preset_save', { slot });
}

export function presetGo(slot: number) {
  quiet(invoke('preset_go', { slot }));
}

export function presetClear(slot: number) {
  quiet(invoke('preset_clear', { slot }));
}

export function presetSeconds(seconds: number) {
  quiet(invoke('preset_seconds', { seconds }));
}

// ───────────── Gestures (`gestures.ts` has the settings and the hand view) ─────────────

export interface DesktopGesturesState {
  /** Gestures are on (the setting), whichever source. */
  on: boolean;
  source?: 'cameraFeed' | 'webcam' | null;
  /** The webcam being read. */
  device?: string | null;
  /** Why the webcam is not running. */
  problem?: string | null;
}

export function gesturesSet(on: boolean): Promise<DesktopGesturesState> {
  return invoke<DesktopGesturesState>('gestures_set', { on });
}

export function gesturesState(): Promise<DesktopGesturesState> {
  return invoke<DesktopGesturesState>('gestures_state');
}
