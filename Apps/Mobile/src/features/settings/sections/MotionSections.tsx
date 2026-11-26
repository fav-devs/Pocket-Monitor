import { Platform } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { CardColumns } from '../components/CardColumns';
import {
  CardCaption,
  NotchSlider,
  SegmentedControl,
  SettingsCard,
  SettingsRow,
  Stepper,
  SwitchRow,
  ValueRow,
} from '../components/SettingsControls';
import { resetPrefs, usePref } from '../components/usePref';
import { SettingsCopy } from '../copy';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Input & Orientation: remote shutter, rotation, game controller, head tracking. */
export function InputSection({ width }: { width: number }) {
  const [remote, setRemote] = usePref('remoteShutter');
  const [rotate, setRotate] = usePref('autoRotateFeed');
  const [gamepad, setGamepad] = usePref('gamepadEnabled');
  const [stick, setStick] = usePref('gamepadStick');
  const [head, setHead] = usePref('headTrackingEnabled');
  const gimbal = useCamera((s) => s.capabilities.gimbal);
  return (
    <CardColumns width={width}>
      <SettingsCard key="input" title="Input & orientation">
        <SwitchRow divider={false} title="Remote shutter" help={SettingsCopy.remoteShutter} value={remote} onChange={setRemote} />
        <SwitchRow title="Auto-Rotate Feed" help={SettingsCopy.autoRotate} value={rotate} onChange={setRotate} />
      </SettingsCard>
      <SettingsCard key="controller" title="Controller">
        <SwitchRow divider={false} title="Game controller" help={SettingsCopy.gamepad} value={gamepad} onChange={setGamepad} />
        <SettingsRow title="Gimbal joystick" help={SettingsCopy.gimbalJoystick} stacked>
          <SegmentedControl options={['left', 'right'] as const} value={stick} onChange={setStick} title={cap} disabled={!gamepad} />
        </SettingsRow>
        <ValueRow title="Gamepad" help={SettingsCopy.gamepad} value={Platform.OS === 'web' ? 'Not available on web' : 'Not connected'} />
      </SettingsCard>
      <SettingsCard key="head" title="Head tracking">
        <SwitchRow
          divider={false}
          title="Head Tracking (Experimental)"
          help={SettingsCopy.headTracking}
          value={head}
          onChange={setHead}
          disabled={Platform.OS !== 'ios'}
        />
        {Platform.OS !== 'ios' ? <CardCaption>Head tracking needs AirPods with motion on iPhone.</CardCaption> : null}
        {!gimbal ? <CardCaption>The connected camera has no gimbal.</CardCaption> : null}
      </SettingsCard>
    </CardColumns>
  );
}

/** Motion Control: gimbal feel, on-screen joystick and A → B → C programmed moves. */
export function MotionSection({ width }: { width: number }) {
  const session = useCameraSession();
  const gimbal = useCamera((s) => s.capabilities.gimbal);
  const program = useCamera((s) => s.gimbal.program);
  const [sensitivity, setSensitivity] = usePref('stickSensitivity');
  const [size, setSize] = usePref('stickSize');
  const [invertPan, setInvertPan] = usePref('stickInvertPan');
  const [invertTilt, setInvertTilt] = usePref('stickInvertTilt');
  const [deadzone, setDeadzone] = usePref('stickDeadzonePercent');
  const [response, setResponse] = usePref('stickResponse');
  const [relative, setRelative] = usePref('stickPictureRelative');
  const [lock, setLock] = usePref('directionLock');
  const [legA, legB] = program.legSeconds;
  return (
    <CardColumns width={width}>
      <SettingsCard key="gimbal" title="Gimbal" onReset={() => resetPrefs(['stickSensitivity', 'stickPictureRelative', 'directionLock'])}>
        <SettingsRow divider={false} title="Joystick sensitivity" help={SettingsCopy.joystickSensitivity} stacked>
          <NotchSlider label="Joystick sensitivity" value={sensitivity} min={1} max={5} onChange={setSensitivity} />
        </SettingsRow>
        <SwitchRow title="Picture-relative stick" help={SettingsCopy.pictureRelative} value={relative} onChange={setRelative} />
        <SwitchRow title="Direction lock" help={SettingsCopy.directionLock} value={lock} onChange={setLock} />
      </SettingsCard>
      <SettingsCard
        key="joystick"
        title="On-screen joystick"
        onReset={() => resetPrefs(['stickSize', 'stickInvertPan', 'stickInvertTilt', 'stickDeadzonePercent', 'stickResponse'])}
      >
        <SettingsRow divider={false} title="Size" help={SettingsCopy.virtualJoystickSize} stacked>
          <SegmentedControl options={['small', 'medium', 'large'] as const} value={size} onChange={setSize} title={cap} />
        </SettingsRow>
        <SwitchRow title="Invert pan" help={SettingsCopy.invertPan} value={invertPan} onChange={setInvertPan} />
        <SwitchRow title="Invert tilt" help={SettingsCopy.invertTilt} value={invertTilt} onChange={setInvertTilt} />
        <SettingsRow title="Dead zone" help={SettingsCopy.deadZone} stacked>
          <NotchSlider label="Dead zone" value={deadzone} min={0} max={20} step={2} onChange={setDeadzone} format={(v) => `${v}%`} />
        </SettingsRow>
        <SettingsRow title="Response curve" help={SettingsCopy.response} stacked>
          <SegmentedControl options={['standard', 'linear', 'fine'] as const} value={response} onChange={setResponse} title={cap} />
        </SettingsRow>
      </SettingsCard>
      <SettingsCard key="program" title="Programmed moves">
        {gimbal ? (
          <>
            <SettingsRow divider={false} title="A → B leg" help={SettingsCopy.programLegs}>
              <Stepper
                label="A to B leg"
                value={legA}
                min={1}
                max={60}
                onChange={(v) => session.gimbal.configureProgram({ legSeconds: [v, legB] })}
                format={(v) => `${v} s`}
              />
            </SettingsRow>
            <SettingsRow title="B → C leg" help={SettingsCopy.programLegs}>
              <Stepper
                label="B to C leg"
                value={legB}
                min={1}
                max={60}
                onChange={(v) => session.gimbal.configureProgram({ legSeconds: [legA, v] })}
                format={(v) => `${v} s`}
              />
            </SettingsRow>
            <SettingsRow title="Smoothness" help={SettingsCopy.programSmoothness}>
              <Stepper
                label="Smoothness"
                value={program.smoothness}
                min={0}
                max={1}
                step={0.25}
                onChange={(v) => session.gimbal.configureProgram({ smoothness: v })}
                format={(v) => `${Math.round(v * 100)}%`}
              />
            </SettingsRow>
            <CardCaption>Capture A, B and C from the gimbal sheet in Live View, then run the move there.</CardCaption>
          </>
        ) : (
          <CardCaption>Connect a camera with a gimbal (Osmo Pocket) to set programmed moves.</CardCaption>
        )}
      </SettingsCard>
    </CardColumns>
  );
}
