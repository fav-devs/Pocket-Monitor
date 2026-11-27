import { useEffect } from 'react';
import { useCameraSession, type CameraState } from '@/camera';
import type { LiveActivityState } from '@modules/pocket-native/src/types';
import {
  activityPhase,
  isUrgentChange,
  LIVE_ACTIVITY_HEARTBEAT_MS,
  LIVE_ACTIVITY_THROTTLE_MS,
  liveActivityKey,
  liveActivityState,
  shouldStartActivity,
  TakeClock,
} from './liveActivityState';
import { backgroundIos, quietly } from './nativeBackground';

/**
 * Runs the Live Activity from camera state: starts when the camera goes live, updates on what the
 * Lock Screen shows (REC and phase at once, the rest at most every 2 s), heartbeats every 30 s so
 * the activity only turns stale when the app stops running, and ends on disconnect or unmount.
 * An activity the operator dismissed, or one iOS refused, is not started again until the next live
 * session.
 */
export function useLiveActivity(enabled: boolean) {
  const session = useCameraSession();

  useEffect(() => {
    const ios = backgroundIos;
    if (!ios || !enabled) return;
    const clock = new TakeClock();
    let running = false;
    let starting = false;
    let declined = false;
    let disposed = false;
    let last: LiveActivityState | null = null;
    let lastKey = '';
    let lastSentAt = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;

    const clearTrailing = () => {
      if (trailing) clearTimeout(trailing);
      trailing = null;
    };

    const send = (next: LiveActivityState) => {
      last = next;
      lastKey = liveActivityKey(next);
      lastSentAt = Date.now();
      ios
        .updateLiveActivity(next)
        .then((ok) => {
          if (!ok && running && !disposed) {
            // Dismissed from the Lock Screen: respect it for this live session.
            running = false;
            declined = true;
          }
        })
        .catch(() => {});
    };

    const onState = (state: CameraState) => {
      if (disposed) return;
      const recordingStartedAt = clock.next(state.recording.recording, state.recording.elapsedSec);
      const next = liveActivityState(state, recordingStartedAt);
      if (!activityPhase(state.connection.phase)) {
        clock.reset();
        declined = false;
        clearTrailing();
        if (running) {
          running = false;
          quietly(ios.endLiveActivity({ ...next, phase: 'ended' }, true));
        }
        last = null;
        lastKey = '';
        return;
      }
      if (!running) {
        if (starting || declined || !shouldStartActivity(state.connection.phase)) return;
        starting = true;
        const identity = state.identity;
        ios
          .startLiveActivity({ cameraName: identity?.name ?? 'Camera', cameraModel: identity?.model ?? 'unknown' }, next)
          .then((id) => {
            starting = false;
            if (disposed) {
              if (id) quietly(ios.endLiveActivity(null, true));
              return;
            }
            if (!id) {
              declined = true;
              return;
            }
            running = true;
            last = next;
            lastKey = liveActivityKey(next);
            lastSentAt = Date.now();
            onState(session.getState());
          })
          .catch(() => {
            starting = false;
            declined = true;
          });
        return;
      }
      if (liveActivityKey(next) === lastKey) return;
      const since = Date.now() - lastSentAt;
      if (isUrgentChange(last, next) || since >= LIVE_ACTIVITY_THROTTLE_MS) {
        clearTrailing();
        send(next);
        return;
      }
      trailing ??= setTimeout(() => {
        trailing = null;
        onState(session.getState());
      }, LIVE_ACTIVITY_THROTTLE_MS - since);
    };

    const heartbeat = setInterval(() => {
      if (running && last) send(last);
    }, LIVE_ACTIVITY_HEARTBEAT_MS);
    onState(session.getState());
    const unsubscribe = session.subscribe(onState);

    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(heartbeat);
      clearTrailing();
      if (running) quietly(ios.endLiveActivity(last ? { ...last, phase: 'ended' } : null, true));
    };
  }, [session, enabled]);
}

/** Keeps the record control (Control Center / Lock Screen / Action button) in step with the camera. */
export function useRecordControlState() {
  const session = useCameraSession();

  useEffect(() => {
    const ios = backgroundIos;
    if (!ios) return;
    let key = '';
    const write = (state: CameraState) => {
      const live = activityPhase(state.connection.phase) != null;
      const recording = live && state.recording.recording;
      const name = live ? (state.identity?.name ?? null) : null;
      const next = `${live}|${recording}|${name ?? ''}`;
      if (next === key) return;
      key = next;
      ios.setRecordControlState(live, recording, name);
    };
    write(session.getState());
    const unsubscribe = session.subscribe(write);
    return () => {
      unsubscribe();
      ios.setRecordControlState(false, false, null);
    };
  }, [session]);
}
