import {
  ColorsIcon,
  PaintBoardIcon,
  PlusMinus01Icon,
  Sun02Icon,
  Sun03Icon,
  Timer01Icon,
  CameraVideoIcon,
  DropletIcon,
  SlidersHorizontalIcon,
} from '@hugeicons/core-free-icons';
import { useRouter } from 'expo-router';
import { useCamera, useCameraSession } from '@/camera';
import type { ExposureMode } from '@/camera/types';
import { transferForColorMode } from '@/core/media/transfer';
import { resolveLut, useAssists } from '@/state/assists';
import { FieldRow, Group, LinkRow, Segments, SwitchRow, ValueRow } from '../components/ui';
import { usePref } from '../components/usePref';
import { SettingsNoteCopy, SettingsRowCopy } from '../copy';

const evLabel = (ev: number) => (ev === 0 ? '0.0' : `${ev > 0 ? '+' : '−'}${Math.abs(ev).toFixed(1)}`);

/** Exposure & Look: EV meter, camera exposure readouts and the monitor look. */
export function ExposureSection() {
  const router = useRouter();
  const session = useCameraSession();
  const live = useCamera((s) => s.connection.phase === 'live');
  const exposure = useCamera((s) => s.exposure);
  const wb = useCamera((s) => s.whiteBalance);
  const colorMode = useCamera((s) => s.format.colorMode);
  const evOn = useAssists((s) => s.on.EV);
  const lutOn = useAssists((s) => s.on.LUT);
  const lut = useAssists((s) => s.options.lut);
  const setAssist = useAssists((s) => s.setOn);
  const [angle, setAngle] = usePref('shutterUsesAngle');
  const look = resolveLut(lut, lutOn, transferForColorMode(live ? colorMode : undefined)).label;

  return (
    <>
      <Group label="EV meter" note={SettingsNoteCopy.evMeter}>
        <SwitchRow icon={Sun03Icon} title="Enabled" subtitle={SettingsRowCopy.evMeter} value={evOn} onChange={(v) => setAssist('EV', v)} />
        <SwitchRow icon={Timer01Icon} title="Shutter as angle" subtitle={SettingsRowCopy.shutterAngle} value={angle} onChange={setAngle} last />
      </Group>
      <Group label="LUT" note={SettingsRowCopy.look}>
        <ValueRow icon={ColorsIcon} title="Look" value={look} />
        <LinkRow icon={PaintBoardIcon} title="Choose look" subtitle="In View Assists" onPress={() => router.push('/settings/assists')} last />
      </Group>
      <Group
        label="Camera exposure"
        note={live ? 'Change exposure from the capture controls in Live View.' : 'Connect a camera to read its exposure here.'}
      >
        {live ? (
          <>
            <FieldRow icon={CameraVideoIcon} title="Exposure mode">
              <Segments
                label="Exposure mode"
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'manual', label: 'Manual' },
                ]}
                value={exposure.mode}
                onChange={(m: ExposureMode) => session.control.setExposureMode(m).catch(() => {})}
              />
            </FieldRow>
            <ValueRow
              icon={SlidersHorizontalIcon}
              title="ISO"
              value={exposure.isoAuto ? `Auto${exposure.iso ? ` · ${exposure.iso}` : ''}` : String(exposure.iso ?? '—')}
            />
            <ValueRow
              icon={Timer01Icon}
              title="Shutter"
              value={
                exposure.shutterAuto
                  ? `Auto${exposure.shutterDenom ? ` · 1/${exposure.shutterDenom}` : ''}`
                  : exposure.shutterDenom
                    ? `1/${exposure.shutterDenom}`
                    : '—'
              }
            />
            <ValueRow icon={PlusMinus01Icon} title="EV" value={evLabel(exposure.ev)} />
            <ValueRow
              icon={DropletIcon}
              title="White balance"
              value={wb.preset === 'auto' ? `Auto${wb.kelvin ? ` · ${wb.kelvin}K` : ''}` : `${wb.kelvin ?? '—'}K`}
              last
            />
          </>
        ) : (
          <ValueRow icon={Sun02Icon} title="Exposure" value="Not connected" last />
        )}
      </Group>
    </>
  );
}
