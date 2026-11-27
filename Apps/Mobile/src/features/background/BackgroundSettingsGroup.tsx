import { Notification03Icon, PictureInPictureOnIcon } from '@hugeicons/core-free-icons';
import { useEffect } from 'react';
import { Group, SwitchRow } from '@/features/settings/components/ui';
import { useBackgroundPreferences, useBackgroundRuntime } from './backgroundStore';
import { backgroundIos, loadBackgroundCapabilities } from './nativeBackground';

/** Settings → Operator → Background (iOS only; renders nothing elsewhere). */
export function BackgroundSettingsGroup() {
  if (!backgroundIos) return null;
  return <BackgroundSettingsRows />;
}

function BackgroundSettingsRows() {
  const liveActivity = useBackgroundPreferences((s) => s.liveActivity);
  const autoPip = useBackgroundPreferences((s) => s.autoPictureInPicture);
  const set = useBackgroundPreferences((s) => s.set);
  const caps = useBackgroundRuntime((s) => s.capabilities);
  useEffect(() => {
    void loadBackgroundCapabilities();
  }, []);
  const activitiesOff = caps != null && !caps.liveActivities;
  const showsPip = caps?.pictureInPicture !== false;
  return (
    <Group label="Background">
      <SwitchRow
        icon={Notification03Icon}
        title="Live Activity"
        subtitle={activitiesOff ? 'Off in iOS Settings' : undefined}
        value={liveActivity && !activitiesOff}
        disabled={activitiesOff}
        onChange={(v) => set('liveActivity', v)}
        testID="settings.background.liveActivity"
        last={!showsPip}
      />
      {showsPip ? (
        <SwitchRow
          icon={PictureInPictureOnIcon}
          title="Auto Picture in Picture"
          value={autoPip}
          onChange={(v) => set('autoPictureInPicture', v)}
          testID="settings.background.autoPip"
          last
        />
      ) : null}
    </Group>
  );
}
