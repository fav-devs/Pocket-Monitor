import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useCamera, useCameraSession, type ConnectionPhase } from '@/camera';
import { backgroundIos, quietly } from './nativeBackground';

const isLive = (phase: ConnectionPhase) => phase === 'live' || phase === 'recovering';

/**
 * Grace period for a quick app switch while live without Picture in Picture: native starts a
 * background task when the app leaves the foreground while armed (PocketBackgroundGrace), so the
 * datalink and ACK pump keep running for iOS's background allowance.
 *
 * On return nothing is re-sent here. A session that is still live or recovering belongs to its
 * FeedWatchdog, the only owner of a repeated `0x09/0xa8` (CONTEXT.md "Enable-once", "Watchdog").
 * Only a session that gave up while the app was away is reconnected, with `retry()`: a fresh spine
 * and datalink session, whose one connect-time enable is its own.
 */
export function useBackgroundGrace() {
  const session = useCameraSession();
  const live = useCamera((s) => isLive(s.connection.phase));

  useEffect(() => {
    quietly(backgroundIos?.setGraceArmed(live));
  }, [live]);

  useEffect(() => {
    if (!backgroundIos) return;
    let leftWhileLive = false;
    const sub = AppState.addEventListener('change', (next) => {
      const phase = session.getState().connection.phase;
      if (next === 'background') {
        leftWhileLive = isLive(phase);
        return;
      }
      if (next !== 'active') return;
      const wasLive = leftWhileLive;
      leftWhileLive = false;
      if (wasLive && phase === 'failed' && session.kind === 'native') session.retry().catch(() => {});
    });
    return () => {
      sub.remove();
      quietly(backgroundIos?.setGraceArmed(false));
    };
  }, [session]);
}
