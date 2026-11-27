import { useBackgroundPreferences } from './backgroundStore';
import { useBackgroundActions } from './useBackgroundActions';
import { useBackgroundGrace } from './useBackgroundGrace';
import { useLiveActivity, useRecordControlState } from './useLiveActivity';
import { usePictureInPictureMonitor } from './usePictureInPicture';

/**
 * iOS background features for the live screen: Live Activity, record control state, Picture in
 * Picture, the grace task and actions from the Lock Screen / Control Center. Renders nothing.
 * Mount only where `backgroundIos` is non-null (see `hasBackgroundFeatures`).
 */
export function BackgroundMonitor({ onDisconnect }: { onDisconnect: () => void }) {
  const liveActivity = useBackgroundPreferences((s) => s.liveActivity);
  const autoPictureInPicture = useBackgroundPreferences((s) => s.autoPictureInPicture);
  useLiveActivity(liveActivity);
  useRecordControlState();
  usePictureInPictureMonitor(autoPictureInPicture);
  useBackgroundGrace();
  useBackgroundActions(onDisconnect);
  return null;
}
