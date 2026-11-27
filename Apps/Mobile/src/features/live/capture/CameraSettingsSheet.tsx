import { Alert02Icon, ChartHistogramIcon, GridIcon, Settings02Icon, Timer01Icon } from '@hugeicons/core-free-icons';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useCamera } from '@/camera';
import { FieldSection } from '@/components/field-section';
import { TabRow } from '@/components/tab-row';
import { spacing } from '@/constants/theme';
import { Group, LinkRow, SwitchRow } from '@/features/settings/components/ui';
import { useAssists } from '@/state/assists';
import { usePreferences } from '@/state/preferences';
import { isPhotoMode } from '../format';
import { useLiveUi, type CameraTab } from '../liveUiStore';
import { AudioControls, ColorControls, FocusControls, WbControls } from './CaptureSheetHost';
import { Hint } from './controls';

/** The tabs this camera offers: Audio only where it has audio controls and is shooting video. */
export function cameraTabs(audio: boolean): { id: CameraTab; label: string }[] {
  return [{ id: 'video', label: 'Video' }, ...(audio ? [{ id: 'audio' as const, label: 'Audio' }] : []), { id: 'display', label: 'Display' }];
}

function VideoTab() {
  const s = useCamera((st) => st);
  const photo = isPhotoMode(s.format.shootingMode);
  const recording = s.recording.recording;
  return (
    <>
      <FieldSection title="Focus">
        <FocusControls s={s} />
      </FieldSection>
      <FieldSection title="White balance">
        <WbControls s={s} />
      </FieldSection>
      {!photo && s.format.colorModeOptions.length > 0 ? (
        <FieldSection title="Color">
          {recording ? <Hint tone="warning">Stop recording to change this.</Hint> : null}
          <ColorControls s={s} locked={recording} />
        </FieldSection>
      ) : null}
    </>
  );
}

function DisplayTab() {
  const grid = useAssists((a) => a.on.GRID);
  const histogram = useAssists((a) => a.on.HISTO);
  const zebra = useAssists((a) => a.on.ZEBRA);
  const setAssist = useAssists((a) => a.setOn);
  const timecode = usePreferences((p) => p.showTimecode ?? true);
  const setPref = usePreferences((p) => p.set);
  const hasTimecode = useCamera((s) => s.capabilities.timecode);
  return (
    <Group>
      <SwitchRow icon={GridIcon} title="Grid" value={grid} onChange={(v) => setAssist('GRID', v, 'live')} />
      <SwitchRow icon={ChartHistogramIcon} title="Histogram" value={histogram} onChange={(v) => setAssist('HISTO', v, 'live')} />
      <SwitchRow icon={Alert02Icon} title="Overexposure alert" value={zebra} onChange={(v) => setAssist('ZEBRA', v, 'live')} />
      <SwitchRow icon={Timer01Icon} title="Timecode" value={timecode} disabled={!hasTimecode} onChange={(v) => setPref('showTimecode', v)} last />
    </Group>
  );
}

/**
 * Camera settings inside the live view (Mimo's Video panel): Video (focus, white balance,
 * colour), Audio (channel, wind, directional, vocal boost) and Display (grid, histogram,
 * overexposure alert, timecode), with the full app Settings one row away. Values come from the
 * camera and go back through `control.*`; nothing here is forked from the capture sheets.
 */
export function CameraSettingsSheet({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const router = useRouter();
  const tab = useLiveUi((s) => s.cameraTab);
  const set = useLiveUi((s) => s.set);
  const audio = useCamera((s) => s.capabilities.audioControls && !isPhotoMode(s.format.shootingMode));
  const tabs = cameraTabs(audio);
  const shown = tabs.some((t) => t.id === tab) ? tab : 'video';
  return (
    <View style={{ gap: spacing.md }}>
      <TabRow tabs={tabs} selected={shown} onSelect={(id) => set({ cameraTab: id })} />
      <View style={{ gap: spacing.md }}>
        {shown === 'video' ? <VideoTab /> : shown === 'audio' ? <AudioControls /> : <DisplayTab />}
      </View>
      <Group>
        <LinkRow
          testID="monitor.camera.allSettings"
          icon={Settings02Icon}
          title="All settings"
          onPress={() => {
            set({ captureSheet: null });
            if (onOpenSettings) onOpenSettings();
            else router.push('/settings');
          }}
          last
        />
      </Group>
    </View>
  );
}
