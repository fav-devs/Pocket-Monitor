/**
 * The gimbal panel's gesture rows (desktop only): gestures on or off (the same setting as
 * `J` and Settings → Gestures), the hand view (`Y`), and the Gestures page. The old
 * viewfinder kept these on its Moves sheet.
 */
import { WavingHand01Icon } from '@hugeicons/core-free-icons';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { loadGestureSettings, saveGestureSettings, setHandView, sourceLabel, useDesktopGestures } from '@/camera/desktop/gestures';
import { PanelHeading, PanelRow, PanelSwitch, RowValue } from '../panel/kit';
import { useLiveUi } from '../liveUiStore';

export function DesktopGestureRows() {
  const settings = useDesktopGestures((s) => s.settings);
  const handView = useDesktopGestures((s) => s.handView);
  const set = useLiveUi((s) => s.set);

  useEffect(() => {
    if (!useDesktopGestures.getState().settings) loadGestureSettings().catch(() => {});
  }, []);

  const on = !!settings?.gestures;
  return (
    <View testID="monitor.gimbal.gestures">
      <PanelHeading>Gestures</PanelHeading>
      <PanelRow title="Gestures">
        <PanelSwitch label="Gestures (J)" value={on} disabled={!settings} onChange={(gestures) => void saveGestureSettings({ gestures })} />
      </PanelRow>
      <PanelRow title="Hand view">
        <PanelSwitch label="Hand view (Y)" value={handView} onChange={setHandView} />
      </PanelRow>
      <PanelRow
        testID="monitor.gimbal.gestureSettings"
        icon={WavingHand01Icon}
        title="Gesture settings"
        onPress={() => {
          set({ captureSheet: null, gimbalPanel: 'none' });
          router.push('/settings/gestures');
        }}
      >
        <RowValue value={settings ? sourceLabel(settings.gestureSource ?? 'cameraFeed') : ''} />
      </PanelRow>
    </View>
  );
}
