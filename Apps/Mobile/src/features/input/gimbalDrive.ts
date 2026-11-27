import { useEffect } from 'react';
import type { CameraSession } from '@/camera';
import { DRIVE_INTERVAL_MS } from './stickMath';

/**
 * One gimbal drive pump for every input. Sources post their already-mapped vector; the
 * pump streams the winning one to `session.gimbal.drive` at ~30 Hz while it is non-zero
 * and sends a single (0,0) rest when every source lets go.
 *
 * Priority: the on-screen stick wins while held, then the gamepad, then the keyboard.
 */
export type DriveSource = 'screen' | 'gamepad' | 'keyboard';

const PRIORITY: DriveSource[] = ['screen', 'gamepad', 'keyboard'];

interface Held {
  x: number;
  y: number;
  /** The source is engaged (finger down) even when its vector is at rest. */
  held: boolean;
}

const sources = new Map<DriveSource, Held>();
const listeners = new Set<() => void>();

export function postDrive(source: DriveSource, x: number, y: number, held = x !== 0 || y !== 0) {
  sources.set(source, { x, y, held });
  listeners.forEach((l) => l());
}

export function releaseDrive(source: DriveSource) {
  sources.delete(source);
  listeners.forEach((l) => l());
}

export function isSourceHeld(source: DriveSource) {
  return sources.get(source)?.held ?? false;
}

export function currentDrive(): { x: number; y: number; source: DriveSource | null } {
  for (const s of PRIORITY) {
    const v = sources.get(s);
    if (v?.held) return { x: v.x, y: v.y, source: s };
  }
  return { x: 0, y: 0, source: null };
}

/** Streams the arbitrated vector into the session. Mount once (live screen). */
export function useGimbalDrivePump(session: CameraSession, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let restPending = false;
    let lastNonZero = false;
    const tick = () => {
      const v = currentDrive();
      const nonZero = v.x !== 0 || v.y !== 0;
      if (nonZero) {
        session.gimbal.drive(v.x, v.y);
        lastNonZero = true;
      } else if (lastNonZero || restPending) {
        session.gimbal.drive(0, 0);
        lastNonZero = false;
        restPending = false;
      }
    };
    const onChange = () => {
      // Held samples go out on the pump cadence; a release rests the gimbal at once.
      if (!currentDrive().source) {
        restPending = true;
        tick();
      }
    };
    listeners.add(onChange);
    const id = setInterval(tick, DRIVE_INTERVAL_MS);
    return () => {
      clearInterval(id);
      listeners.delete(onChange);
      sources.clear();
      session.gimbal.drive(0, 0);
    };
  }, [session, enabled]);
}
