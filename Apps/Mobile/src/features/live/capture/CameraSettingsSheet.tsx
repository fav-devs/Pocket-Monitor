import type { IconSvgElement } from '@hugeicons/react-native';
import { Camera01Icon, DashboardSquare01Icon, Settings02Icon, Target02Icon } from '@hugeicons/core-free-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useCamera, useCameraSession, type ColorMode, type FocusMode } from '@/camera';
import { Icon } from '@/components/icon';
import { monitorPanel as P } from '@/constants/monitor';
import { useThemedStyles } from '@/constants/theme';
import { useAssists } from '@/state/assists';
import { usePreferences } from '@/state/preferences';
import { COLOR_LABEL, isPhotoMode, wbLabel } from '../format';
import { LiveGimbalPanel } from '../gimbal/LiveGimbalControls';
import { haptics } from '../haptics';
import { LayoutChips, LayoutRows, LayoutsPanel } from '../layout/LayoutsPanel';
import { useLiveUi, type CameraTab } from '../liveUiStore';
import { PanelBack, PanelHint, PanelRow, PanelSwitch, PanelTitle, RowValue, ValueButton } from '../panel/kit';
import { AudioMeters, ManualFocusDrum, WbControls, useWrite } from './CaptureSheetHost';
import { ShootSheet } from '@/features/markers/MetaSheets';
import { useActiveShoot } from '@/state/clipMeta';

/** The panel's tabs (Mimo's leading tab icons). */
export const CAMERA_TABS: { id: CameraTab; label: string; icon: IconSvgElement }[] = [
  { id: 'camera', label: 'Camera', icon: Camera01Icon },
  { id: 'gimbal', label: 'Gimbal', icon: Target02Icon },
  { id: 'general', label: 'General', icon: DashboardSquare01Icon },
];

const FOCUS_WORD: Record<FocusMode, string> = { afc: 'Continuous', afs: 'Single', mf: 'Manual' };
const DIRECTIONAL_WORD = { off: 'Off', front: 'Front', rear: 'Rear', surround: 'All' } as const;
const DIRECTIONS = ['off', 'front', 'rear', 'surround'] as const;

function next<T>(list: readonly T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length];
}

/** The active shoot: clips recorded now join it (`src/state/clipMeta.ts`). */
function ShootRow() {
  const shoot = useActiveShoot();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PanelRow testID="monitor.camera.shoot" title="Shoot" onPress={() => setOpen(true)}>
        <RowValue value={shoot ? shoot.name : 'None'} />
      </PanelRow>
      <ShootSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Camera tab: Mimo's Video panel rows. */
function CameraTabBody({ onWb }: { onWb: () => void }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const s = useCamera((st) => st);
  const photo = isPhotoMode(s.format.shootingMode);
  const recording = s.recording.recording;
  const grid = useAssists((a) => a.on.GRID);
  const histogram = useAssists((a) => a.on.HISTO);
  const zebra = useAssists((a) => a.on.ZEBRA);
  const setAssist = useAssists((a) => a.setOn);
  const timecode = usePreferences((p) => p.showTimecode ?? true);
  const setPref = usePreferences((p) => p.set);
  const focusModes: FocusMode[] = s.capabilities.manualFocus ? ['afc', 'afs', 'mf'] : ['afc', 'afs'];
  const audio = s.capabilities.audioControls && !photo;
  const a = s.audio;
  const colors = s.format.colorModeOptions;
  return (
    <>
      {!photo ? <ShootRow /> : null}
      <PanelRow title="Grid">
        <ValueButton label={grid ? 'Gridlines' : 'Off'} accessibilityLabel="Grid" onPress={() => setAssist('GRID', !grid, 'live')} />
      </PanelRow>
      <PanelRow title="Focus mode">
        <ValueButton
          testID="monitor.camera.focus"
          label={FOCUS_WORD[s.focus.mode]}
          accessibilityLabel="Focus mode"
          onPress={() => write(control.setFocusMode(next(focusModes, s.focus.mode)))}
        />
      </PanelRow>
      {s.focus.mode === 'mf' ? <ManualFocusDrum s={s} /> : null}
      <PanelRow testID="monitor.camera.wb" title="White balance" onPress={onWb}>
        <RowValue value={s.whiteBalance.preset === 'auto' ? 'Auto' : wbLabel(s.whiteBalance.preset, s.whiteBalance.kelvin)} />
      </PanelRow>
      {!photo && colors.length > 0 ? (
        <PanelRow title="Color">
          <ValueButton
            label={COLOR_LABEL[s.format.colorMode]}
            accessibilityLabel="Color"
            disabled={recording || colors.length < 2}
            onPress={() => write(control.setFormat({ colorMode: next<ColorMode>(colors, s.format.colorMode) }))}
          />
        </PanelRow>
      ) : null}
      {audio ? (
        <>
          <PanelRow title="Channel">
            <ValueButton
              label={a.channel === 'stereo' ? 'Stereo' : 'Mono'}
              accessibilityLabel="Audio channel"
              onPress={() => write(control.setAudio({ channel: a.channel === 'stereo' ? 'mono' : 'stereo' }))}
            />
          </PanelRow>
          <PanelRow title="Wind noise reduction">
            <PanelSwitch label="Wind noise reduction" value={a.windReduction} onChange={(v) => write(control.setAudio({ windReduction: v }))} />
          </PanelRow>
          <PanelRow title="Directional audio">
            <ValueButton
              label={DIRECTIONAL_WORD[a.directional]}
              accessibilityLabel="Directional audio"
              onPress={() => write(control.setAudio({ directional: next(DIRECTIONS, a.directional) }))}
            />
          </PanelRow>
          <PanelRow title="Vocal boost">
            <PanelSwitch label="Vocal boost" value={a.vocalBoost} onChange={(v) => write(control.setAudio({ vocalBoost: v }))} />
          </PanelRow>
          <AudioMeters />
        </>
      ) : null}
      <PanelRow title="Overexposure alert">
        <PanelSwitch label="Overexposure alert" value={zebra} onChange={(v) => setAssist('ZEBRA', v, 'live')} />
      </PanelRow>
      <PanelRow title="Histogram">
        <PanelSwitch label="Histogram" value={histogram} onChange={(v) => setAssist('HISTO', v, 'live')} />
      </PanelRow>
      <PanelRow title="Timecode display" disabled={!s.capabilities.timecode}>
        <PanelSwitch label="Timecode display" value={timecode} disabled={!s.capabilities.timecode} onChange={(v) => setPref('showTimecode', v)} />
      </PanelRow>
    </>
  );
}

/** General tab: the layout (switch, edit) and how the monitor behaves (the live-view preferences). */
function GeneralTabBody({ onLayouts }: { onLayouts: () => void }) {
  const p = usePreferences();
  const tracking = useCamera((s) => s.capabilities.tracking);
  const row = (title: string, key: 'tapToTrack' | 'tapToFocus' | 'doubleTapLevel' | 'recordCountdown' | 'confirmStopRecording' | 'hideChromeWhileRecording' | 'showRecordingBorder' | 'keepScreenAwake', disabled?: boolean) => (
    <PanelRow title={title} disabled={disabled}>
      <PanelSwitch label={title} value={!!p[key]} disabled={disabled} onChange={(v) => p.set(key, v)} />
    </PanelRow>
  );
  return (
    <>
      <LayoutChips />
      <LayoutRows onOpenLayouts={onLayouts} />
      {row('Tap to track', 'tapToTrack', !tracking)}
      {row('Tap to focus', 'tapToFocus')}
      {row('Double-tap stick levels', 'doubleTapLevel')}
      {row('Record countdown', 'recordCountdown')}
      {row('Confirm stop', 'confirmStopRecording')}
      {row('Hide controls while recording', 'hideChromeWhileRecording')}
      {row('Recording border', 'showRecordingBorder')}
      {row('Keep screen awake', 'keepScreenAwake')}
      <PanelRow title="Picture">
        <ValueButton
          label={p.pictureFit === 'fill' ? 'Fill' : 'Fit'}
          accessibilityLabel="Picture fit"
          onPress={() => p.set('pictureFit', p.pictureFit === 'fill' ? 'fit' : 'fill')}
        />
      </PanelRow>
      <PanelRow title="Gamepad" last>
        <ValueButton label={p.gamepadEnabled ? 'On' : 'Off'} accessibilityLabel="Gamepad" onPress={() => p.set('gamepadEnabled', !p.gamepadEnabled)} />
      </PanelRow>
    </>
  );
}

/**
 * Camera settings inside the live view (Mimo's settings panel): its own tab icons down the
 * leading edge (Camera, Gimbal, General) and plain rows with value buttons and switches —
 * grid, focus mode, white balance (a detail page), colour, audio, overexposure alert,
 * histogram and timecode; the gimbal controls; monitor behaviour; then All settings.
 */
export function CameraSettingsSheet({
  tab,
  onTab,
  onOpenSettings,
  notice,
}: {
  tab: CameraTab;
  onTab: (tab: CameraTab) => void;
  onOpenSettings?: () => void;
  notice: (m: string, tone?: 'info' | 'warning' | 'error' | 'success') => void;
}) {
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const set = useLiveUi((s) => s.set);
  const photo = useCamera((s) => isPhotoMode(s.format.shootingMode));
  const gimbal = useCamera((s) => s.capabilities.gimbal && s.gimbal.available);
  const s = useCamera((st) => st);
  const [detail, setDetail] = useState<'wb' | 'layouts' | null>(null);
  const tabs = CAMERA_TABS.filter((t) => t.id !== 'gimbal' || gimbal);
  const shown = tabs.some((t) => t.id === tab) ? tab : 'camera';
  const title = shown === 'camera' ? (photo ? 'Photo' : 'Video') : shown === 'gimbal' ? 'Gimbal' : 'General';

  return (
    <View testID="monitor.panel.camera" style={styles.root}>
      <View accessibilityRole="tablist" style={styles.tabs}>
        {tabs.map((t) => {
          const on = t.id === shown;
          return (
            <Pressable
              key={t.id}
              testID={`monitor.camera.tab.${t.id}`}
              accessibilityRole="tab"
              accessibilityLabel={t.label}
              accessibilityState={{ selected: on }}
              onPress={() => {
                haptics.selection();
                setDetail(null);
                onTab(t.id);
              }}
              style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
            >
              <Icon icon={t.icon} size={26} color={on ? P.chosen : P.text} strokeWidth={1.7} />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.body}>
        {detail === 'wb' ? (
          <>
            <PanelTitle leading={<PanelBack label="Back to camera settings" onPress={() => setDetail(null)} />}>White balance</PanelTitle>
            <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
              <WbControls s={s} />
            </ScrollView>
          </>
        ) : detail === 'layouts' ? (
          <>
            <PanelTitle leading={<PanelBack label="Back to general" onPress={() => setDetail(null)} />}>Layouts</PanelTitle>
            <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <LayoutsPanel onEdit={() => setDetail(null)} />
            </ScrollView>
          </>
        ) : (
          <>
            <PanelTitle>{title}</PanelTitle>
            <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
              {shown === 'camera' ? (
                <CameraTabBody onWb={() => setDetail('wb')} />
              ) : shown === 'gimbal' ? (
                <LiveGimbalPanel notice={notice} />
              ) : (
                <GeneralTabBody onLayouts={() => setDetail('layouts')} />
              )}
              {shown === 'camera' && s.recording.recording ? <PanelHint>Color changes after recording stops.</PanelHint> : null}
              <PanelRow
                testID="monitor.camera.allSettings"
                icon={Settings02Icon}
                title="All settings"
                last
                onPress={() => {
                  set({ captureSheet: null, gimbalPanel: 'none' });
                  if (onOpenSettings) onOpenSettings();
                  else router.push('/settings');
                }}
              >
                <RowValue value="" />
              </PanelRow>
            </ScrollView>
          </>
        )}
      </View>
    </View>
  );
}

function createStyles() {
  return {
    root: { flex: 1, flexDirection: 'row' as const },
    tabs: {
      width: 56,
      paddingVertical: 16,
      alignItems: 'center' as const,
      justifyContent: 'space-around' as const,
      borderRightWidth: 1,
      borderRightColor: P.hairline,
    },
    tab: { width: 48, height: 48, alignItems: 'center' as const, justifyContent: 'center' as const },
    body: { flex: 1, minWidth: 0 },
    scroll: { paddingBottom: 12 },
    pressed: { opacity: 0.65 },
  };
}
