/** The gesture, hand-control, face and clap rules of `pm_controller::input::LiveInput`, as phones carry them out. */
import { describe, expect, it } from 'vitest';
import { defaultGestureMap } from './gesture';
import { GestureDriver, HAND_BEAT, HAND_STALE, type GestureFacts, type GestureTarget } from './drive';

function rig(facts: GestureFacts = { tracking: false, recording: false }) {
  const calls: string[] = [];
  const target: GestureTarget = {
    drive: (x, y) => calls.push(`drive ${x} ${y}`),
    zoomBy: (rate) => calls.push(`zoom ${rate}`),
    recenter: () => calls.push('recenter'),
    flip: () => calls.push('flip'),
    stop: () => calls.push('stop'),
    toggleRecording: () => calls.push('record'),
    trackFace: (box) => calls.push(`track ${box.join(',')}`),
    stopTracking: () => calls.push('untrack'),
    marker: () => calls.push('marker'),
    notice: (text) => calls.push(`notice ${text}`),
  };
  const driver = new GestureDriver(target, () => facts, defaultGestureMap());
  return { driver, calls, facts };
}

describe('GestureDriver gestures', () => {
  it('does what the map says, with the desktop notices', () => {
    const { driver, calls } = rig();
    driver.gesture('fist');
    driver.gesture('horns');
    driver.gesture('palm');
    driver.gesture('two');
    driver.gesture('swipe_up');
    driver.gesture('point');
    expect(calls).toEqual([
      'notice GESTURE: RECENTRE',
      'recenter',
      'notice GESTURE: FLIP',
      'flip',
      'notice GESTURE: STOP',
      'stop',
      'notice GESTURE: RECORD',
      'record',
      'notice NO PRESETS SAVED',
    ]);
  });

  it('a gesture set to "Add marker" adds one, with no notice of its own', () => {
    const { driver, calls } = rig({ tracking: false, recording: true });
    driver.map = { ...driver.map, horns: 'marker' };
    driver.gesture('horns');
    expect(calls).toEqual(['marker']);
  });

  it('the face gesture asks for the face while the camera picture is read, else says why not', () => {
    const { driver, calls, facts } = rig();
    driver.gesture('face_track');
    expect(calls).toEqual(["notice FACE TRACKING NEEDS THE CAMERA'S PICTURE"]);
    expect(driver.takeFaceRequest()).toBe(false);
    driver.setFaceFinder(true);
    driver.gesture('face_track');
    expect(driver.takeFaceRequest()).toBe(true);
    expect(driver.takeFaceRequest()).toBe(false);
    facts.tracking = true;
    driver.gesture('face_track');
    expect(calls.slice(1)).toEqual(['notice LOOKING FOR YOUR FACE', 'notice FACE TRACKING OFF', 'untrack']);
    driver.trackFace([0.4, 0.1, 0.2, 0.36]);
    driver.noFace();
    driver.clap();
    expect(calls.slice(4)).toEqual(['notice FACE TRACKING', 'track 0.4,0.1,0.2,0.36', 'notice NO FACE FOUND', 'notice CLAP: RECENTRE', 'recenter']);
  });

  it('shows the record hold between a tenth and the whole, in tenths', () => {
    const { driver, facts } = rig();
    driver.gestureProgress({ gesture: 'two', fraction: 0.05 });
    expect(driver.hold()).toBeNull();
    driver.gestureProgress({ gesture: 'two', fraction: 0.47 });
    expect(driver.hold()).toEqual({ text: 'HOLD TO START RECORDING', fraction: 0.4 });
    facts.recording = true;
    driver.gestureProgress({ gesture: 'two', fraction: 0.99 });
    expect(driver.hold()).toEqual({ text: 'HOLD TO STOP RECORDING', fraction: 0.9 });
    driver.gestureProgress({ gesture: 'fist', fraction: 0.5 });
    expect(driver.hold(), 'only the pose that records').toBeNull();
  });
});

describe('GestureDriver hand control', () => {
  it('drives on a change, beats between readings and lets go when the readings stop', () => {
    const { driver, calls } = rig();
    driver.handControl({ kind: 'stick', x: 0.5, y: 0.25 }, 0);
    // The same throw again inside the beat is not sent again.
    driver.handControl({ kind: 'stick', x: 0.505, y: 0.25 }, 0.03);
    driver.tick(0.05);
    expect(calls).toEqual(['drive 0.5 0.25']);
    // The heartbeat repeats it between readings.
    driver.tick(HAND_BEAT + 0.01);
    expect(calls).toEqual(['drive 0.5 0.25', 'drive 0.51 0.25']);
    expect(driver.handDriving()).toBe(true);
    // No reading for longer than the stale time: let go.
    driver.tick(0.03 + HAND_STALE + 0.01);
    expect(calls[calls.length - 1]).toBe('drive 0 0');
    expect(driver.handDriving()).toBe(false);
    driver.tick(2);
    expect(calls.filter((c) => c === 'drive 0 0')).toHaveLength(1);
  });

  it('a throw inside the rest zone or the end of the pinch rests the gimbal once', () => {
    const { driver, calls } = rig();
    driver.handControl({ kind: 'stick', x: 0.05, y: 0.02 }, 0);
    expect(calls, 'nothing held, nothing to rest').toEqual([]);
    driver.handControl({ kind: 'stick', x: -0.8, y: 0 }, 0.1);
    driver.handControl({ kind: 'stick', x: 0.05, y: 0.02 }, 0.2);
    driver.handControl({ kind: 'stickEnd' }, 0.3);
    expect(calls).toEqual(['drive -0.8 0', 'drive 0 0']);
  });

  it('the zoom hand holds a rate with the rest zone and stops on the end or when stale', () => {
    const { driver, calls } = rig();
    driver.handControl({ kind: 'zoom', rate: 0.05 }, 0);
    driver.handControl({ kind: 'zoom', rate: 1 }, 0.05);
    driver.handControl({ kind: 'zoom', rate: 0.99 }, 0.1);
    driver.handControl({ kind: 'zoom', rate: -0.54 }, 0.15);
    driver.handControl({ kind: 'zoomEnd' }, 0.2);
    expect(calls).toEqual(['zoom 1', 'zoom -0.5', 'zoom 0']);
    driver.handControl({ kind: 'zoom', rate: 0.6 }, 1);
    driver.tick(1 + HAND_STALE / 2);
    driver.tick(1 + HAND_STALE + 0.01);
    expect(calls.slice(3)).toEqual(['zoom 0.55', 'zoom 0']);
  });

  it('release lets go of both', () => {
    const { driver, calls } = rig();
    driver.handControl({ kind: 'stick', x: 0.3, y: 0.3 }, 0);
    driver.handControl({ kind: 'zoom', rate: -1 }, 0);
    driver.gestureProgress({ gesture: 'two', fraction: 0.5 });
    driver.release();
    expect(calls).toEqual(['drive 0.3 0.3', 'zoom -1', 'drive 0 0', 'zoom 0']);
    expect(driver.hold()).toBeNull();
    driver.release();
    expect(calls).toHaveLength(4);
  });
});
