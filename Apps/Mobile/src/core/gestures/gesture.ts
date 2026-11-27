/**
 * Gesture names and what each does: a port of `pm_controller::gesture`
 * (`Apps/Desktop/crates/pm-controller/src/gesture.rs`) — `Gesture`, `GestureAction` and
 * `GestureMap` with its defaults, file lines and JSON. Keys are the Rust serde names, so a
 * settings object written by the desktop app reads the same here and the other way round.
 *
 * The frame-differencing `Tracker` in that file is not ported: phones read hands with the
 * landmark models (`./hand.ts`, `./vision.ts`), as the desktop viewfinder now does.
 */

/** What the operator did, as they see it (`Gesture::key`). */
export type GestureKey =
  | 'swipe_left'
  | 'swipe_right'
  | 'swipe_up'
  | 'swipe_down'
  | 'palm'
  | 'fist'
  | 'point'
  | 'two'
  | 'horns'
  | 'face_track';

/** What a gesture can be set to do (`GestureAction::key`). */
export type GestureActionKey = 'nothing' | 'recenter' | 'flip' | 'next_preset' | 'previous_preset' | 'stop' | 'record' | 'face_track';

/** `Gesture::ALL`, in order. */
export const GESTURE_KEYS: readonly GestureKey[] = [
  'swipe_left',
  'swipe_right',
  'swipe_up',
  'swipe_down',
  'palm',
  'fist',
  'point',
  'two',
  'horns',
  'face_track',
];

/** `GestureAction::ALL`, in order. */
export const GESTURE_ACTION_KEYS: readonly GestureActionKey[] = [
  'nothing',
  'recenter',
  'flip',
  'next_preset',
  'previous_preset',
  'stop',
  'record',
  'face_track',
];

/** `Gesture::label`. */
export const GESTURE_LABEL: Readonly<Record<GestureKey, string>> = {
  swipe_left: 'Swipe left',
  swipe_right: 'Swipe right',
  swipe_up: 'Swipe up',
  swipe_down: 'Swipe down',
  palm: 'Open palm',
  fist: 'Fist',
  point: 'One finger',
  two: 'Two fingers (peace sign)',
  horns: 'Rock sign',
  face_track: 'Open and close, three times',
};

/** `Gesture::how`: how to make it. */
export const GESTURE_HOW: Readonly<Record<GestureKey, string>> = {
  swipe_left: 'Sweep your hand to your left, quickly, in view of the camera',
  swipe_right: 'Sweep your hand to your right, quickly',
  swipe_up: 'Sweep your hand upward',
  swipe_down: 'Sweep your hand downward',
  palm: 'Hold up an open hand, four fingers out, for about a second',
  fist: 'Hold up a closed fist for one second',
  point: 'Hold up one finger for one second',
  two: 'Hold up two fingers for one second',
  horns: 'Index and little finger out, the others folded, for about a second',
  face_track: 'Open your hand and close it to a fist, quickly, three times over',
};

/** `GestureAction::label`. */
export const GESTURE_ACTION_LABEL: Readonly<Record<GestureActionKey, string>> = {
  nothing: 'Do nothing',
  recenter: 'Recentre the gimbal',
  flip: 'Flip (selfie)',
  next_preset: 'Next preset',
  previous_preset: 'Previous preset',
  stop: 'Stop everything',
  record: 'Start / stop recording (hold 2.5 s)',
  face_track: 'Face tracking on / off',
};

export type GestureMap = Record<GestureKey, GestureActionKey>;

/**
 * `GestureMap::default()`. Raising and lowering a hand reads as a vertical sweep, so those do
 * nothing until the operator chooses otherwise; recording is a peace sign, held.
 */
export const DEFAULT_GESTURE_MAP: Readonly<GestureMap> = {
  swipe_left: 'previous_preset',
  swipe_right: 'next_preset',
  swipe_up: 'nothing',
  swipe_down: 'nothing',
  palm: 'stop',
  fist: 'recenter',
  point: 'next_preset',
  two: 'record',
  horns: 'flip',
  face_track: 'face_track',
};

export const isGestureKey = (key: unknown): key is GestureKey => typeof key === 'string' && (GESTURE_KEYS as readonly string[]).includes(key);
export const isGestureActionKey = (key: unknown): key is GestureActionKey =>
  typeof key === 'string' && (GESTURE_ACTION_KEYS as readonly string[]).includes(key);

export function defaultGestureMap(): GestureMap {
  return { ...DEFAULT_GESTURE_MAP };
}

/** One `gesture.NAME=action` line each (`GestureMap::to_lines`). */
export function gestureMapToLines(map: GestureMap): string {
  return GESTURE_KEYS.map((g) => `gesture.${g}=${map[g]}\n`).join('');
}

/** Reads one line of {@link gestureMapToLines} into `map`; anything else is ignored (`read_line`). */
export function readGestureMapLine(map: GestureMap, line: string): void {
  if (!line.startsWith('gesture.')) return;
  const rest = line.slice('gesture.'.length);
  const eq = rest.indexOf('=');
  if (eq < 0) return;
  const key = rest.slice(0, eq);
  const value = rest.slice(eq + 1);
  if (isGestureKey(key) && isGestureActionKey(value)) map[key] = value;
}

/**
 * The map from its JSON object (`GestureMap`'s `Deserialize`): starts from the defaults, so a
 * gesture the object leaves out keeps its default; an unknown gesture or action is ignored.
 * Anything but an object of strings is an error, as serde's is.
 */
export function gestureMapFromJson(value: unknown): GestureMap {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('a gesture map is an object');
  const map = defaultGestureMap();
  for (const [gesture, action] of Object.entries(value as Record<string, unknown>)) {
    if (typeof action !== 'string') throw new TypeError(`gesture ${gesture}: the action is not a string`);
    readGestureMapLine(map, `gesture.${gesture}=${action}`);
  }
  return map;
}

/** The map as JSON (`Serialize`): every gesture listed, in `Gesture::ALL` order. */
export function gestureMapToJson(map: GestureMap): Record<GestureKey, GestureActionKey> {
  const out = {} as Record<GestureKey, GestureActionKey>;
  for (const g of GESTURE_KEYS) out[g] = map[g];
  return out;
}

/** The map from whatever a settings object holds: defaults for a missing or broken one. */
export function gestureMapOrDefault(value: unknown): GestureMap {
  try {
    return gestureMapFromJson(value);
  } catch {
    return defaultGestureMap();
  }
}
