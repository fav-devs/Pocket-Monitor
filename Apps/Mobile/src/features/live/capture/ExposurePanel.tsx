import { MinusSignCircleIcon, PlusSignCircleIcon } from '@hugeicons/core-free-icons';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { monitorPanel as P } from '@/constants/monitor';
import { fonts, useThemedStyles } from '@/constants/theme';
import { usePreferences } from '@/state/preferences';
import { apertureLabel, evLabel, isPhotoMode, shutterAngleLabel, shutterLabel } from '../format';
import { PanelKey, PanelLabel, PanelSegments, PanelToggleKey } from '../panel/kit';
import { nearestIndex, useWrite } from './CaptureSheetHost';
import { MonitorValueDrum } from './MonitorValueDrum';

/** One exposure row: a label (with its keys) over a drum or a read-only value, a hairline under. */
function Row({ label, value, trailing, children }: { label: string; value?: string; trailing?: ReactNode; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.row}>
      <PanelLabel value={value} trailing={trailing}>
        {label}
      </PanelLabel>
      {children}
    </View>
  );
}

/** A value the camera sets itself (Mimo's ISO 400 / Shutter 1/60 under AUTO). */
function ReadOnly({ value, label }: { value: string; label: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View accessible accessibilityLabel={label} accessibilityValue={{ text: value }} style={styles.readOnly}>
      <Text style={styles.readOnlyText}>{value}</Text>
    </View>
  );
}

/**
 * The exposure panel (Mimo's M / AUTO panel): the program at the top, then ISO MAX (while ISO is
 * auto), ISO, Shutter (speed or angle), EV between − and +, and aperture where the camera has an
 * iris. Each value is a tick drum; a value the camera sets itself reads as plain text, and its
 * Auto key hands it back.
 */
export function ExposurePanel() {
  const styles = useThemedStyles(createStyles);
  const { control } = useCameraSession();
  const write = useWrite();
  const e = useCamera((s) => s.exposure);
  const fps = useCamera((s) => s.format.fps);
  const photo = useCamera((s) => isPhotoMode(s.format.shootingMode));
  const hasAperture = useCamera((s) => s.capabilities.aperture);
  const angle = usePreferences((p) => !!p.shutterUsesAngle);
  const setPref = usePreferences((p) => p.set);
  const useAngle = angle && !photo;
  const limits = e.isoLimitOptions ?? e.isoOptions;
  const apertures = e.apertureOptions ?? [];
  const manual = e.mode === 'manual';
  // EV biases the camera's own exposure: it applies while anything is automatic.
  const evApplies = !manual || e.isoAuto || e.shutterAuto;
  const evIndex = nearestIndex(e.evOptions, e.ev);
  const shutterText = (d: number | null) => (useAngle ? shutterAngleLabel(d, fps) : shutterLabel(d));

  return (
    <View testID="monitor.panel.exposure">
      <View style={styles.program}>
        <PanelSegments
          accessibilityLabel="Exposure program"
          options={['M', 'AUTO']}
          selected={manual ? 0 : 1}
          onSelect={(i) => write(control.setExposureMode(i === 0 ? 'manual' : 'auto'))}
        />
      </View>
      {e.isoAuto ? (
        <Row label="ISO MAX">
          <MonitorValueDrum
            tone="panel"
            compact
            accessibilityLabel="Maximum ISO"
            options={limits.map(String)}
            index={nearestIndex(limits, e.isoLimit ?? limits[limits.length - 1])}
            onChange={(i) => write(control.setIsoLimit(limits[i]))}
          />
        </Row>
      ) : null}
      <Row
        label="ISO"
        trailing={
          <PanelToggleKey
            label="Auto"
            accessibilityLabel="Auto ISO"
            on={e.isoAuto}
            onPress={() => write(e.isoAuto ? control.setIso(e.iso ?? 400) : control.setIso('auto'))}
          />
        }
      >
        {e.isoAuto ? (
          <ReadOnly label="ISO" value={e.iso != null ? String(e.iso) : '--'} />
        ) : (
          <MonitorValueDrum
            tone="panel"
            compact
            accessibilityLabel="ISO"
            options={e.isoOptions.map(String)}
            index={nearestIndex(e.isoOptions, e.iso)}
            onChange={(i) => write(control.setIso(e.isoOptions[i]))}
          />
        )}
      </Row>
      <Row
        label="Shutter"
        trailing={
          <>
            {!photo ? (
              <PanelToggleKey label="Angle" accessibilityLabel="Shutter as angle" on={useAngle} onPress={() => setPref('shutterUsesAngle', !useAngle)} />
            ) : null}
            <PanelToggleKey
              label="Auto"
              accessibilityLabel="Auto shutter"
              on={e.shutterAuto}
              onPress={() => write(e.shutterAuto ? control.setShutter(e.shutterDenom ?? e.shutterOptions[0]) : control.setShutter('auto'))}
            />
          </>
        }
      >
        {e.shutterAuto ? (
          <ReadOnly label="Shutter" value={shutterText(e.shutterDenom)} />
        ) : (
          <MonitorValueDrum
            tone="panel"
            compact
            accessibilityLabel="Shutter"
            options={e.shutterOptions.map(shutterText)}
            index={nearestIndex(e.shutterOptions, e.shutterDenom)}
            onChange={(i) => write(control.setShutter(e.shutterOptions[i]))}
          />
        )}
      </Row>
      <Row label="EV">
        <View style={[styles.ev, !evApplies && styles.dim]}>
          <PanelKey
            icon={MinusSignCircleIcon}
            label="Lower EV"
            disabled={!evApplies || evIndex <= 0}
            onPress={() => write(control.setEv(e.evOptions[Math.max(0, evIndex - 1)]))}
          />
          <View style={styles.flex}>
            <MonitorValueDrum
              tone="panel"
              compact
              accessibilityLabel="Exposure compensation"
              disabled={!evApplies}
              options={e.evOptions.map(evLabel)}
              index={evIndex}
              onChange={(i) => write(control.setEv(e.evOptions[i]))}
            />
          </View>
          <PanelKey
            icon={PlusSignCircleIcon}
            label="Raise EV"
            disabled={!evApplies || evIndex >= e.evOptions.length - 1}
            onPress={() => write(control.setEv(e.evOptions[Math.min(e.evOptions.length - 1, evIndex + 1)]))}
          />
        </View>
      </Row>
      {hasAperture && apertures.length > 0 ? (
        <Row label="Aperture">
          <MonitorValueDrum
            tone="panel"
            compact
            accessibilityLabel="Aperture"
            options={apertures.map((f) => apertureLabel(f))}
            index={nearestIndex(apertures, e.aperture)}
            onChange={(i) => write(control.setAperture(apertures[i]))}
          />
        </Row>
      ) : null}
    </View>
  );
}

function createStyles() {
  return {
    program: { padding: 12, paddingBottom: 6 },
    row: { borderTopWidth: 1, borderTopColor: P.hairline, paddingBottom: 2 },
    readOnly: { height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    readOnlyText: { fontFamily: fonts.semibold, fontSize: 17, color: P.text, fontVariant: ['tabular-nums' as const] },
    ev: { flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 6 },
    flex: { flex: 1, minWidth: 0 },
    dim: { opacity: 0.45 },
  };
}
