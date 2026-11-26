import { useRouter } from 'expo-router';
import { useCamera, useCameraSession } from '@/camera';
import type { ExposureMode } from '@/camera/types';
import { transferForColorMode } from '@/core/media/transfer';
import { resolveLut, useAssists } from '@/state/assists';
import { CardColumns } from '../components/CardColumns';
import { ActionPill, CardCaption, SegmentedControl, SettingsCard, SettingsRow, SwitchRow, ValueRow, ValueText } from '../components/SettingsControls';
import { usePref } from '../components/usePref';
import { SettingsCopy } from '../copy';

const evLabel = (ev: number) => (ev === 0 ? '0.0' : `${ev > 0 ? '+' : '−'}${Math.abs(ev).toFixed(1)}`);

/** Exposure & Look: EV meter, camera exposure readouts and the monitor look. */
export function ExposureSection({ width }: { width: number }) {
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
    <CardColumns width={width}>
      <SettingsCard key="ev" title="EV Meter">
        <SwitchRow divider={false} title="Enabled" help={SettingsCopy.evMeter} value={evOn} onChange={(v) => setAssist('EV', v)} />
        <SwitchRow title="Shutter as angle" help={SettingsCopy.shutterAngle} value={angle} onChange={setAngle} />
      </SettingsCard>
      <SettingsCard key="lut" title="LUT">
        <SettingsRow divider={false} title="Look" help={SettingsCopy.look}>
          <ValueText value={look} />
        </SettingsRow>
        <SettingsRow title="Choose look">
          <ActionPill title="Open" onPress={() => router.push('/settings/assists')} accessibilityLabel="Choose look in View Assists" />
        </SettingsRow>
      </SettingsCard>
      <SettingsCard key="camera" title="Camera exposure">
        {live ? (
          <>
            <SettingsRow divider={false} title="Exposure mode" stacked>
              <SegmentedControl
                options={['auto', 'manual'] as const}
                value={exposure.mode}
                onChange={(m: ExposureMode) => session.control.setExposureMode(m).catch(() => {})}
                title={(m) => (m === 'auto' ? 'Auto' : 'Manual')}
              />
            </SettingsRow>
            <ValueRow title="ISO" value={exposure.isoAuto ? `Auto${exposure.iso ? ` · ${exposure.iso}` : ''}` : String(exposure.iso ?? '—')} />
            <ValueRow
              title="Shutter"
              value={exposure.shutterAuto ? `Auto${exposure.shutterDenom ? ` · 1/${exposure.shutterDenom}` : ''}` : exposure.shutterDenom ? `1/${exposure.shutterDenom}` : '—'}
            />
            <ValueRow title="EV" value={evLabel(exposure.ev)} />
            <ValueRow title="White balance" value={wb.preset === 'auto' ? `Auto${wb.kelvin ? ` · ${wb.kelvin}K` : ''}` : `${wb.kelvin ?? '—'}K`} />
            <CardCaption>Change exposure from the capture controls in Live View.</CardCaption>
          </>
        ) : (
          <CardCaption>Connect a camera to read its exposure here.</CardCaption>
        )}
      </SettingsCard>
    </CardColumns>
  );
}
