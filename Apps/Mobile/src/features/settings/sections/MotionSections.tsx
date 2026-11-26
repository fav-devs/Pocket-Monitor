import {
  Airpod01Icon,
  ArrowLeftRightIcon,
  ArrowUpDownIcon,
  CenterFocusIcon,
  DashboardSpeed01Icon,
  EaseCurveControlPointsIcon,
  EaseInOutIcon,
  GameController03Icon,
  Joystick02Icon,
  Resize01Icon,
  Route01Icon,
  Route02Icon,
  ScreenRotationIcon,
  SquareLock02Icon,
  Target01Icon,
  VolumeHighIcon,
} from '@hugeicons/core-free-icons';
import { Platform } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { ResetAction } from '@/components/reset-action';
import { SettingsRow } from '@/components/settings-ui';
import { Slider } from '@/components/slider';
import { settingsFeedback } from '../components/feedback';
import { FieldRow, Group, Segments, Stepper, SwitchRow, ValueRow } from '../components/ui';
import { resetPrefs, usePref } from '../components/usePref';
import { SettingsCopy, SettingsNoteCopy, SettingsRowCopy } from '../copy';

/** Input & Orientation: remote shutter, rotation, game controller, head tracking. */
export function InputSection() {
  const [remote, setRemote] = usePref('remoteShutter');
  const [rotate, setRotate] = usePref('autoRotateFeed');
  const [gamepad, setGamepad] = usePref('gamepadEnabled');
  const [stick, setStick] = usePref('gamepadStick');
  const [head, setHead] = usePref('headTrackingEnabled');
  const gimbal = useCamera((s) => s.capabilities.gimbal);
  const ios = Platform.OS === 'ios';
  const headNotes: string[] = [SettingsNoteCopy.headTracking];
  if (!ios) headNotes.push('Head tracking needs AirPods with motion on iPhone.');
  if (!gimbal) headNotes.push('The connected camera has no gimbal.');
  return (
    <>
      <Group label="Input & orientation">
        <SwitchRow icon={VolumeHighIcon} title="Remote shutter" subtitle={SettingsRowCopy.remoteShutter} value={remote} onChange={setRemote} />
        <SwitchRow icon={ScreenRotationIcon} title="Auto-Rotate Feed" subtitle={SettingsRowCopy.autoRotate} value={rotate} onChange={setRotate} last />
      </Group>
      <Group label="Controller" note={SettingsNoteCopy.gamepad}>
        <SwitchRow icon={GameController03Icon} title="Game controller" subtitle={SettingsRowCopy.gamepad} value={gamepad} onChange={setGamepad} />
        <FieldRow icon={Joystick02Icon} title="Gimbal joystick" subtitle={SettingsRowCopy.gimbalJoystick} disabled={!gamepad}>
          <Segments
            label="Gimbal joystick"
            options={[
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ]}
            value={stick}
            onChange={setStick}
          />
        </FieldRow>
        <ValueRow icon={GameController03Icon} title="Gamepad" value={Platform.OS === 'web' ? 'Not available on web' : 'Not connected'} last />
      </Group>
      <Group label="Head tracking" note={headNotes.join(' ')}>
        <SwitchRow
          icon={Airpod01Icon}
          title="Head Tracking (Experimental)"
          subtitle={SettingsRowCopy.headTracking}
          value={head}
          onChange={setHead}
          disabled={!ios}
          last
        />
      </Group>
    </>
  );
}

/** Motion Control: gimbal feel, on-screen joystick and A → B → C programmed moves. */
export function MotionSection() {
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
  const seconds = (v: number) => `${v} s`;
  return (
    <>
      <Group
        label="Gimbal"
        trailing={
          <ResetAction
            label="Reset"
            accessibilityLabel="Reset gimbal"
            onReset={() => resetPrefs(['stickSensitivity', 'stickPictureRelative', 'directionLock'])}
          />
        }
      >
        <FieldRow icon={DashboardSpeed01Icon} title="Joystick sensitivity" subtitle={SettingsRowCopy.joystickSensitivity} value={String(sensitivity)}>
          <Slider
            value={sensitivity}
            min={1}
            max={5}
            step={1}
            onChange={setSensitivity}
            onEnd={(v) => {
              settingsFeedback();
              setSensitivity(v);
            }}
          />
        </FieldRow>
        <SwitchRow icon={CenterFocusIcon} title="Picture-relative stick" subtitle={SettingsRowCopy.pictureRelative} value={relative} onChange={setRelative} />
        <SwitchRow icon={SquareLock02Icon} title="Direction lock" subtitle={SettingsRowCopy.directionLock} value={lock} onChange={setLock} last />
      </Group>
      <Group
        label="On-screen joystick"
        trailing={
          <ResetAction
            label="Reset"
            accessibilityLabel="Reset on-screen joystick"
            onReset={() => resetPrefs(['stickSize', 'stickInvertPan', 'stickInvertTilt', 'stickDeadzonePercent', 'stickResponse'])}
          />
        }
      >
        <FieldRow icon={Resize01Icon} title="Size" subtitle={SettingsRowCopy.virtualJoystickSize}>
          <Segments
            label="Joystick size"
            options={[
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large' },
            ]}
            value={size}
            onChange={setSize}
          />
        </FieldRow>
        <SwitchRow icon={ArrowLeftRightIcon} title="Invert pan" subtitle={SettingsRowCopy.invertPan} value={invertPan} onChange={setInvertPan} />
        <SwitchRow icon={ArrowUpDownIcon} title="Invert tilt" subtitle={SettingsRowCopy.invertTilt} value={invertTilt} onChange={setInvertTilt} />
        <FieldRow icon={Target01Icon} title="Dead zone" subtitle={SettingsRowCopy.deadZone} value={`${deadzone}%`}>
          <Slider
            value={deadzone}
            min={0}
            max={20}
            step={2}
            format={(v) => `${v}%`}
            onChange={setDeadzone}
            onEnd={(v) => {
              settingsFeedback();
              setDeadzone(v);
            }}
          />
        </FieldRow>
        <FieldRow icon={EaseInOutIcon} title="Response curve" subtitle={SettingsRowCopy.response} last>
          <Segments
            label="Response curve"
            options={[
              { value: 'standard', label: 'Standard' },
              { value: 'linear', label: 'Linear' },
              { value: 'fine', label: 'Fine' },
            ]}
            value={response}
            onChange={setResponse}
          />
        </FieldRow>
      </Group>
      <Group
        label="Programmed moves"
        note={
          gimbal
            ? `${SettingsCopy.programLegs} Capture A, B and C from the gimbal sheet in Live View, then run the move there.`
            : 'Connect a camera with a gimbal (Osmo Pocket) to set programmed moves.'
        }
      >
        <SettingsRow
          icon={Route01Icon}
          title="A → B leg"
          disabled={!gimbal}
          accessory={
            <Stepper
              label="A to B leg"
              value={legA}
              min={1}
              max={60}
              disabled={!gimbal}
              onChange={(v) => session.gimbal.configureProgram({ legSeconds: [v, legB] })}
              format={seconds}
            />
          }
        />
        <SettingsRow
          icon={Route02Icon}
          title="B → C leg"
          disabled={!gimbal}
          accessory={
            <Stepper
              label="B to C leg"
              value={legB}
              min={1}
              max={60}
              disabled={!gimbal}
              onChange={(v) => session.gimbal.configureProgram({ legSeconds: [legA, v] })}
              format={seconds}
            />
          }
        />
        <SettingsRow
          icon={EaseCurveControlPointsIcon}
          title="Smoothness"
          subtitle={SettingsRowCopy.programSmoothness}
          disabled={!gimbal}
          last
          accessory={
            <Stepper
              label="Smoothness"
              value={program.smoothness}
              min={0}
              max={1}
              step={0.25}
              disabled={!gimbal}
              onChange={(v) => session.gimbal.configureProgram({ smoothness: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          }
        />
      </Group>
    </>
  );
}
