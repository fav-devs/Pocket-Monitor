import { describe, expect, it } from 'vitest';
import { initialCameraState } from '@/camera/defaults';
import type { CameraState } from '@/camera/types';
import {
  activityPhase,
  batteryBand,
  isUrgentChange,
  liveActivityKey,
  liveActivityState,
  remainingBand,
  shouldStartActivity,
  TakeClock,
} from './liveActivityState';

function camera(patch: { phase?: CameraState['connection']['phase']; recording?: boolean; elapsedSec?: number; battery?: number; remainingSec?: number; bars?: number } = {}): CameraState {
  const s = initialCameraState('osmo-pocket-3');
  return {
    ...s,
    connection: { ...s.connection, phase: patch.phase ?? 'live', signalBars: patch.bars ?? 4, linkBand: 'stable' },
    recording: { ...s.recording, recording: patch.recording ?? false, elapsedSec: patch.elapsedSec ?? 0, remainingSec: patch.remainingSec ?? 3600 },
    power: { ...s.power, batteryPercent: patch.battery ?? 80 },
  };
}

describe('live activity policy', () => {
  it('runs through live and recovering, starts only when live', () => {
    expect(activityPhase('live')).toBe('live');
    expect(activityPhase('recovering')).toBe('recovering');
    expect(activityPhase('live-start')).toBeNull();
    expect(activityPhase('disconnected')).toBeNull();
    expect(activityPhase('failed')).toBeNull();
    expect(shouldStartActivity('live')).toBe(true);
    expect(shouldStartActivity('recovering')).toBe(false);
  });

  it('bands battery and card time so ticks do not update', () => {
    expect(batteryBand(81)).toBe(80);
    expect(batteryBand(83)).toBe(85);
    expect(batteryBand(-1)).toBe(-1);
    expect(remainingBand(3659)).toBe(3600);
    expect(remainingBand(-1)).toBe(-1);
    const a = liveActivityState(camera({ battery: 81, remainingSec: 3601 }), null);
    const b = liveActivityState(camera({ battery: 82, remainingSec: 3640 }), null);
    expect(liveActivityKey(a)).toBe(liveActivityKey(b));
    const c = liveActivityState(camera({ battery: 74 }), null);
    expect(liveActivityKey(a)).not.toBe(liveActivityKey(c));
  });

  it('backdates the take start once and keeps it while recording', () => {
    let now = 100_000;
    const clock = new TakeClock(() => now);
    expect(clock.next(false, 0)).toBeNull();
    expect(clock.next(true, 12)).toBe(88_000);
    now += 5000;
    expect(clock.next(true, 17)).toBe(88_000);
    expect(clock.next(false, 0)).toBeNull();
    expect(clock.next(true, 0)).toBe(105_000);
  });

  it('elapsed ticks never change the key; REC and phase are urgent', () => {
    const start = 1_000;
    const a = liveActivityState(camera({ recording: true, elapsedSec: 3 }), start);
    const b = liveActivityState(camera({ recording: true, elapsedSec: 9 }), start);
    expect(liveActivityKey(a)).toBe(liveActivityKey(b));
    expect(a.recordingStartedAtMs).toBe(start);
    const stopped = liveActivityState(camera({ recording: false }), start);
    expect(stopped.recordingStartedAtMs).toBeNull();
    expect(isUrgentChange(a, stopped)).toBe(true);
    expect(isUrgentChange(a, liveActivityState(camera({ phase: 'recovering', recording: true }), start))).toBe(true);
    expect(isUrgentChange(a, liveActivityState(camera({ recording: true, bars: 2 }), start))).toBe(false);
    expect(isUrgentChange(null, a)).toBe(true);
  });

  it('maps a dropped link to ended', () => {
    expect(liveActivityState(camera({ phase: 'disconnected' }), null).phase).toBe('ended');
  });
});
