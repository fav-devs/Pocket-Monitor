import type { CameraState, ConnectionPhase } from '@/camera/types';
import type { LiveActivityState } from '@modules/pocket-native/src/types';

/**
 * Live Activity policy (pure; no React, no native). The activity starts when a camera goes live
 * and ends on disconnect; updates are sent only when something the Lock Screen shows changes
 * (REC, phase, link band / bars, battery band, card minutes), never per status tick. The elapsed
 * time is drawn by the system from `recordingStartedAtMs`, so it needs no updates at all.
 */

/** The activity runs through these phases; anything else ends it. */
export function activityPhase(phase: ConnectionPhase): LiveActivityState['phase'] | null {
  if (phase === 'live') return 'live';
  if (phase === 'recovering') return 'recovering';
  return null;
}

/** Start only once the picture is live (not during the spine). */
export function shouldStartActivity(phase: ConnectionPhase): boolean {
  return phase === 'live';
}

/** Battery shown in 5 % steps (fewer updates; the Lock Screen does not need 1 %). */
export function batteryBand(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0) return -1;
  return Math.min(100, Math.round(percent / 5) * 5);
}

/** Card time in whole minutes (the Lock Screen shows minutes). */
export function remainingBand(sec: number): number {
  if (!Number.isFinite(sec) || sec < 0) return -1;
  return Math.floor(sec / 60) * 60;
}

/**
 * Tracks the take start across updates: set once when REC turns on (backdated by the camera's
 * elapsed time, so joining mid-take is right), kept while recording, cleared on stop.
 */
export class TakeClock {
  private startedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  next(recording: boolean, elapsedSec: number): number | null {
    if (!recording) {
      this.startedAt = null;
      return null;
    }
    if (this.startedAt == null) {
      const elapsed = Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec : 0;
      this.startedAt = Math.round(this.now() - elapsed * 1000);
    }
    return this.startedAt;
  }

  reset(): void {
    this.startedAt = null;
  }
}

export function liveActivityState(state: CameraState, recordingStartedAtMs: number | null): LiveActivityState {
  const c = state.connection;
  return {
    phase: activityPhase(c.phase) ?? 'ended',
    recording: state.recording.recording,
    recordingStartedAtMs: state.recording.recording ? recordingStartedAtMs : null,
    remainingSec: remainingBand(state.recording.remainingSec),
    batteryPercent: batteryBand(state.power.batteryPercent),
    charging: state.power.charging,
    linkBand: c.linkBand,
    signalBars: Math.max(0, Math.min(4, Math.round(c.signalBars))),
  };
}

/** Equal keys mean the Lock Screen would look the same. */
export function liveActivityKey(s: LiveActivityState): string {
  return [s.phase, s.recording ? 1 : 0, s.recordingStartedAtMs ?? '', s.remainingSec, s.batteryPercent, s.charging ? 1 : 0, s.linkBand, s.signalBars].join('|');
}

/** REC and phase changes go out at once; the rest is throttled. */
export function isUrgentChange(prev: LiveActivityState | null, next: LiveActivityState): boolean {
  return !prev || prev.recording !== next.recording || prev.phase !== next.phase;
}

/** Minimum gap between non-urgent updates, ms. */
export const LIVE_ACTIVITY_THROTTLE_MS = 2000;
/** Heartbeat while JS runs: keeps `staleDate` (90 s native) ahead. */
export const LIVE_ACTIVITY_HEARTBEAT_MS = 30_000;
