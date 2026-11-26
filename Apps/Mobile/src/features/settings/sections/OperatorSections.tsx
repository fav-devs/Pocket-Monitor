import {
  Activity01Icon,
  Alert02Icon,
  CropIcon,
  FocusPointIcon,
  Layers01Icon,
  RecordIcon,
  SmartPhone01Icon,
  Sun02Icon,
  Sun03Icon,
  Tap02Icon,
  Target02Icon,
  Timer01Icon,
  TouchInteraction01Icon,
  ViewOffIcon,
} from '@hugeicons/core-free-icons';
import { ResetAction } from '@/components/reset-action';
import { Slider } from '@/components/slider';
import { useAssists } from '@/state/assists';
import { FieldRow, Group, Segments, SwitchRow } from '../components/ui';
import { resetPrefs, usePref } from '../components/usePref';
import { SettingsCopy, SettingsNoteCopy, SettingsRowCopy } from '../copy';
import { settingsFeedback } from '../components/feedback';

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** Display: panel, recording chrome and picture fit (`MonitorPanelSettings`, display sections). */
export function DisplaySection() {
  const [hdr, setHdr] = usePref('hdrChrome');
  const [border, setBorder] = usePref('showRecordingBorder');
  const [hide, setHide] = usePref('hideChromeWhileRecording');
  const [fit, setFit] = usePref('pictureFit');
  const [opacity, setOpacity] = usePref('chromeOpacity');
  const [stats, setStats] = usePref('showLinkStats');
  const ev = useAssists((st) => st.on.EV);
  const setAssist = useAssists((st) => st.setOn);
  return (
    <>
      <Group label="Panel" note={SettingsCopy.hdrPanel.replace(SettingsRowCopy.hdrPanel, '').trim()}>
        <SwitchRow icon={Sun03Icon} title="HDR display" subtitle={SettingsRowCopy.hdrPanel} value={hdr} onChange={setHdr} last />
      </Group>
      <Group
        label="Picture"
        trailing={<ResetAction label="Reset" accessibilityLabel="Reset picture" onReset={() => resetPrefs(['pictureFit', 'chromeOpacity'])} />}
      >
        <FieldRow icon={CropIcon} title="Picture fit" subtitle={SettingsRowCopy.pictureFit}>
          <Segments
            label="Picture fit"
            options={[
              { value: 'fit', label: 'Fit' },
              { value: 'fill', label: 'Fill' },
            ]}
            value={fit}
            onChange={setFit}
          />
        </FieldRow>
        <FieldRow icon={Layers01Icon} title="Chrome opacity" subtitle={SettingsRowCopy.chromeOpacity} value={percent(opacity)} last>
          <Slider
            value={opacity}
            min={0.4}
            max={1}
            step={0.1}
            format={percent}
            onChange={(v) => setOpacity(Number(v.toFixed(2)))}
            onEnd={(v) => {
              settingsFeedback();
              setOpacity(Number(v.toFixed(2)));
            }}
          />
        </FieldRow>
      </Group>
      <Group
        label="While recording"
        trailing={
          <ResetAction
            label="Reset"
            accessibilityLabel="Reset while recording"
            onReset={() => resetPrefs(['showRecordingBorder', 'hideChromeWhileRecording'])}
          />
        }
      >
        <SwitchRow icon={RecordIcon} title="Recording border" subtitle={SettingsRowCopy.recordingBorder} value={border} onChange={setBorder} />
        <SwitchRow icon={ViewOffIcon} title="Hide chrome" subtitle={SettingsRowCopy.hideChrome} value={hide} onChange={setHide} last />
      </Group>
      <Group label="DISP 1 readouts" note="Readouts that stay on the clean picture. Assist tools have their own page.">
        <SwitchRow icon={Activity01Icon} title="Link stats" subtitle={SettingsRowCopy.linkStats} value={stats} onChange={setStats} />
        <SwitchRow icon={Sun02Icon} title="EV meter" subtitle={SettingsRowCopy.evMeter} value={ev} onChange={(v) => setAssist('EV', v)} last />
      </Group>
    </>
  );
}

/** Operator: touch & safety, recording and picture gestures (`MonitorOperatorSafetySettings`). */
export function OperatorSection() {
  const [confirm, setConfirm] = usePref('confirmStopRecording');
  const [haptics, setHaptics] = usePref('recordHaptics');
  const [awake, setAwake] = usePref('keepScreenAwake');
  const [countdown, setCountdown] = usePref('recordCountdown');
  const [tapFocus, setTapFocus] = usePref('tapToFocus');
  const [tapTrack, setTapTrack] = usePref('tapToTrack');
  const [level, setLevel] = usePref('doubleTapLevel');
  return (
    <>
      <Group label="Touch & safety" note={SettingsNoteCopy.keepScreenAwake}>
        <SwitchRow
          icon={Alert02Icon}
          title="Record confirmation"
          subtitle={SettingsRowCopy.recordConfirmation}
          value={confirm}
          onChange={setConfirm}
        />
        <SwitchRow icon={TouchInteraction01Icon} title="Haptics" subtitle={SettingsRowCopy.gimbalHaptics} value={haptics} onChange={setHaptics} />
        <SwitchRow
          icon={SmartPhone01Icon}
          title="Keep screen awake"
          subtitle={SettingsRowCopy.keepScreenAwake}
          value={awake}
          onChange={setAwake}
          last
        />
      </Group>
      <Group label="Recording">
        <SwitchRow
          icon={Timer01Icon}
          title="Record countdown"
          subtitle={SettingsRowCopy.recordCountdown}
          value={countdown}
          onChange={setCountdown}
          last
        />
      </Group>
      <Group
        label="Picture gestures"
        trailing={
          <ResetAction
            label="Reset"
            accessibilityLabel="Reset picture gestures"
            onReset={() => resetPrefs(['tapToFocus', 'tapToTrack', 'doubleTapLevel'])}
          />
        }
      >
        <SwitchRow icon={FocusPointIcon} title="Tap to focus" subtitle={SettingsRowCopy.tapToFocus} value={tapFocus} onChange={setTapFocus} />
        <SwitchRow icon={Target02Icon} title="Hold to track" subtitle={SettingsRowCopy.tapToTrack} value={tapTrack} onChange={setTapTrack} />
        <SwitchRow icon={Tap02Icon} title="Double-tap to level" subtitle={SettingsRowCopy.doubleTapLevel} value={level} onChange={setLevel} last />
      </Group>
    </>
  );
}
