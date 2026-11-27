import { useEffect } from 'react';
import { configureInput, desktopInput } from '@/camera/desktop/input';
import { useAssists } from '@/state/assists';
import { usePreferences } from '@/state/preferences';

/**
 * Keeps the desktop input thread's feel in step with the operator's preferences: stick
 * sensitivity, Direction Lock (the controller stick), and the picture's mirror (so a drag or a
 * click is undone onto the sensor). Sent on change only. Desktop app only; a no-op elsewhere.
 */
export function useDesktopInputSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !desktopInput()) return;
    const mirror = () => {
      const a = useAssists.getState();
      return a.isOn('MIRROR', 'live') && a.options.mirror.horizontal;
    };
    let last = '';
    const push = () => {
      const p = usePreferences.getState();
      const config = {
        stickSensitivity: Math.round(p.stickSensitivity ?? 4),
        directionLock: !!p.directionLock,
        mirror: mirror(),
      };
      const key = JSON.stringify(config);
      if (key === last) return;
      last = key;
      configureInput(config);
    };
    push();
    const stopPrefs = usePreferences.subscribe(push);
    const stopAssists = useAssists.subscribe(push);
    return () => {
      stopPrefs();
      stopAssists();
    };
  }, [enabled]);
}
