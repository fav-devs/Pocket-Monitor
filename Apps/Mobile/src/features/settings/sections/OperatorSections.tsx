import { View } from 'react-native';
import { useAssists } from '@/state/assists';
import { CardColumns } from '../components/CardColumns';
import { CardCaption, SegmentedControl, SettingsCard, SettingsRow, Stepper, SwitchRow, ToggleTile } from '../components/SettingsControls';
import { resetPrefs, usePref } from '../components/usePref';
import { SettingsCopy } from '../copy';

/** Display: panel, recording chrome and picture fit (`MonitorPanelSettings`, display sections). */
export function DisplaySection({ width }: { width: number }) {
  const [hdr, setHdr] = usePref('hdrChrome');
  const [border, setBorder] = usePref('showRecordingBorder');
  const [hide, setHide] = usePref('hideChromeWhileRecording');
  const [fit, setFit] = usePref('pictureFit');
  const [opacity, setOpacity] = usePref('chromeOpacity');
  const [stats, setStats] = usePref('showLinkStats');
  const ev = useAssists((st) => st.on.EV);
  const setAssist = useAssists((st) => st.setOn);
  return (
    <CardColumns width={width}>
      <SettingsCard key="panel" title="Panel">
        <SwitchRow divider={false} title="HDR display" help={SettingsCopy.hdrPanel} value={hdr} onChange={setHdr} />
      </SettingsCard>
      <SettingsCard
        key="picture"
        title="Picture"
        onReset={() => resetPrefs(['pictureFit', 'chromeOpacity'])}
      >
        <SettingsRow divider={false} title="Picture fit" help={SettingsCopy.pictureFit} stacked>
          <SegmentedControl options={['fit', 'fill'] as const} value={fit} onChange={setFit} title={(v) => (v === 'fit' ? 'Fit' : 'Fill')} />
        </SettingsRow>
        <SettingsRow title="Chrome opacity" help={SettingsCopy.chromeOpacity}>
          <Stepper
            label="Chrome opacity"
            value={opacity}
            min={0.4}
            max={1}
            step={0.1}
            onChange={setOpacity}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </SettingsRow>
      </SettingsCard>
      <SettingsCard
        key="recording"
        title="While recording"
        onReset={() => resetPrefs(['showRecordingBorder', 'hideChromeWhileRecording'])}
      >
        <SwitchRow divider={false} title="Recording border" help={SettingsCopy.recordingBorder} value={border} onChange={setBorder} />
        <SwitchRow title="Hide chrome" help={SettingsCopy.hideChrome} value={hide} onChange={setHide} />
      </SettingsCard>
      <SettingsCard key="pins" title="DISP 1 readouts">
        <CardCaption>Readouts that stay on the clean picture. Assist tools have their own page.</CardCaption>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingBottom: 9 }}>
          <ToggleTile title="Link stats" value={stats} onChange={setStats} />
          <ToggleTile title="EV meter" value={ev} onChange={(v) => setAssist('EV', v)} />
        </View>
      </SettingsCard>
    </CardColumns>
  );
}

/** Operator: touch & safety, recording and picture gestures (`MonitorOperatorSafetySettings`). */
export function OperatorSection({ width }: { width: number }) {
  const [confirm, setConfirm] = usePref('confirmStopRecording');
  const [haptics, setHaptics] = usePref('recordHaptics');
  const [awake, setAwake] = usePref('keepScreenAwake');
  const [countdown, setCountdown] = usePref('recordCountdown');
  const [tapFocus, setTapFocus] = usePref('tapToFocus');
  const [tapTrack, setTapTrack] = usePref('tapToTrack');
  const [level, setLevel] = usePref('doubleTapLevel');
  return (
    <CardColumns width={width}>
      <SettingsCard key="safety" title="Touch & safety">
        <SwitchRow divider={false} title="Record confirmation" help={SettingsCopy.recordConfirmation} value={confirm} onChange={setConfirm} />
        <SwitchRow title="Haptics" help={SettingsCopy.gimbalHaptics} value={haptics} onChange={setHaptics} />
        <SwitchRow title="Keep screen awake" help={SettingsCopy.keepScreenAwake} value={awake} onChange={setAwake} />
      </SettingsCard>
      <SettingsCard key="record" title="Recording">
        <SwitchRow divider={false} title="Record countdown" help={SettingsCopy.recordCountdown} value={countdown} onChange={setCountdown} />
      </SettingsCard>
      <SettingsCard
        key="gestures"
        title="Picture gestures"
        onReset={() => resetPrefs(['tapToFocus', 'tapToTrack', 'doubleTapLevel'])}
      >
        <SwitchRow divider={false} title="Tap to focus" help={SettingsCopy.tapToFocus} value={tapFocus} onChange={setTapFocus} />
        <SwitchRow title="Hold to track" help={SettingsCopy.tapToTrack} value={tapTrack} onChange={setTapTrack} />
        <SwitchRow title="Double-tap to level" help={SettingsCopy.doubleTapLevel} value={level} onChange={setLevel} />
      </SettingsCard>
    </CardColumns>
  );
}
