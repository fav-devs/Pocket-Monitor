/** `pm_controller::gesture` map tests, with the same vectors. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GESTURE_MAP,
  GESTURE_ACTION_KEYS,
  GESTURE_KEYS,
  defaultGestureMap,
  gestureMapFromJson,
  gestureMapOrDefault,
  gestureMapToJson,
  gestureMapToLines,
  readGestureMapLine,
} from './gesture';

describe('GestureMap', () => {
  it('the map survives its lines and ignores junk', () => {
    const map = defaultGestureMap();
    map.fist = 'record';
    map.swipe_up = 'nothing';
    const read = defaultGestureMap();
    for (const line of gestureMapToLines(map).split('\n')) readGestureMapLine(read, line);
    readGestureMapLine(read, 'gesture.palm=launch_missiles');
    readGestureMapLine(read, 'gesture.unknown=flip');
    readGestureMapLine(read, 'nonsense');
    expect(read).toEqual(map);
    expect(defaultGestureMap().palm).toBe('stop');
  });

  it('the web reads and writes the map as gesture to action names', () => {
    const map = defaultGestureMap();
    map.fist = 'record';
    const json = gestureMapToJson(map);
    expect(Object.keys(json)).toHaveLength(GESTURE_KEYS.length);
    expect(Object.keys(json)).toEqual([...GESTURE_KEYS]);
    expect(json.fist).toBe('record');
    expect(json.swipe_left).toBe('previous_preset');
    expect(json.face_track).toBe('face_track');
    expect(gestureMapFromJson(JSON.parse(JSON.stringify(json)))).toEqual(map);

    // A partial object keeps the defaults; strangers are ignored.
    const read = gestureMapFromJson(JSON.parse('{"palm":"flip","horns":"launch_missiles","wave":"stop"}'));
    expect(read).toEqual({ ...DEFAULT_GESTURE_MAP, palm: 'flip' });
    expect(() => gestureMapFromJson([1, 2])).toThrow();
    expect(gestureMapOrDefault([1, 2])).toEqual(DEFAULT_GESTURE_MAP);
  });

  it('reads and writes "Add marker", which no gesture does by default', () => {
    expect(Object.values(DEFAULT_GESTURE_MAP)).not.toContain('marker');
    const read = gestureMapFromJson({ horns: 'marker' });
    expect(read.horns).toBe('marker');
    expect(gestureMapToJson(read).horns).toBe('marker');
    const lines = defaultGestureMap();
    readGestureMapLine(lines, 'gesture.point=marker');
    expect(lines.point).toBe('marker');
  });

  it('carries the desktop serde names', () => {
    expect(GESTURE_KEYS).toEqual(['swipe_left', 'swipe_right', 'swipe_up', 'swipe_down', 'palm', 'fist', 'point', 'two', 'horns', 'face_track']);
    expect(GESTURE_ACTION_KEYS).toEqual(['nothing', 'recenter', 'flip', 'next_preset', 'previous_preset', 'stop', 'record', 'face_track', 'marker']);
    // `GestureMap::default()`.
    expect(DEFAULT_GESTURE_MAP).toEqual({
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
    });
  });
});
