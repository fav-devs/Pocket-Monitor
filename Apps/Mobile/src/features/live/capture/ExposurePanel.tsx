import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { fonts, radius, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { usePreferences } from '@/state/preferences';
import { apertureLabel, evLabel, isPhotoMode, shutterAngleLabel, shutterLabel } from '../format';
import { haptics } from '../haptics';
import { nearestIndex, useWrite } from './CaptureSheetHost';
import { ModeBar } from './controls';
import { MonitorValueDrum } from './MonitorValueDrum';

/** A small on/off key in a row's header (Auto, Angle). Ink when on; 44pt with its hit slop. */
function HeaderToggle({ label, on, onPress, accessibilityLabel }: { label: string; on: boolean; onPress: () => void; accessibilityLabel: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: on }}
      hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => [styles.toggle, on && styles.toggleOn, pressed && styles.pressed]}
    >
      <Text style={[styles.toggleLabel, on && styles.toggleLabelOn]}>{label}</Text>
    </Pressable>
  );
}

/** One value: a caps label (with header keys) over a compact drum. */
function DrumRow({ label, value, trailing, children }: { label: string; value?: string; trailing?: ReactNode; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.label}>{label}</Text>
        {value ? <Text style={styles.value}>{value}</Text> : null}
        {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      </View>
      {children}
    </View>
  );
}

/**
 * The exposure panel (Mimo's M / Auto panel): the program at the top, then ISO (its ceiling while
 * ISO is auto), shutter (speed or angle), EV and aperture as drums. A value the camera sets itself shows
 * as a dimmed drum; its Auto key hands it back. Replaces the separate ISO, shutter and EV sheets.
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
  // EV biases the camera's own exposure: it applies while anything is automatic.
  const evApplies = e.mode === 'auto' || e.isoAuto || e.shutterAuto;

  return (
    <View style={styles.stack}>
      <ModeBar
        accessibilityLabel="Exposure program"
        tabs={['M', 'Auto']}
        selected={e.mode === 'manual' ? 0 : 1}
        onSelect={(i) => write(control.setExposureMode(i === 0 ? 'manual' : 'auto'))}
      />
      {/* Auto ISO: the drum sets the ceiling and the header shows what the camera chose. */}
      <DrumRow
        label={e.isoAuto ? 'ISO max' : 'ISO'}
        value={e.isoAuto && e.iso != null ? `A ${e.iso}` : undefined}
        trailing={
          <HeaderToggle
            label="Auto"
            accessibilityLabel="Auto ISO"
            on={e.isoAuto}
            onPress={() => write(e.isoAuto ? control.setIso(e.iso ?? 400) : control.setIso('auto'))}
          />
        }
      >
        {e.isoAuto ? (
          <MonitorValueDrum
            compact
            accessibilityLabel="Maximum ISO"
            options={limits.map(String)}
            index={nearestIndex(limits, e.isoLimit ?? limits[limits.length - 1])}
            onChange={(i) => write(control.setIsoLimit(limits[i]))}
          />
        ) : (
          <MonitorValueDrum
            compact
            accessibilityLabel="ISO"
            options={e.isoOptions.map(String)}
            index={nearestIndex(e.isoOptions, e.iso)}
            onChange={(i) => write(control.setIso(e.isoOptions[i]))}
          />
        )}
      </DrumRow>
      <DrumRow
        label="Shutter"
        trailing={
          <>
            {!photo ? (
              <HeaderToggle
                label="Angle"
                accessibilityLabel="Shutter as angle"
                on={useAngle}
                onPress={() => setPref('shutterUsesAngle', !useAngle)}
              />
            ) : null}
            <HeaderToggle
              label="Auto"
              accessibilityLabel="Auto shutter"
              on={e.shutterAuto}
              onPress={() => write(e.shutterAuto ? control.setShutter(e.shutterDenom ?? e.shutterOptions[0]) : control.setShutter('auto'))}
            />
          </>
        }
      >
        <MonitorValueDrum
          compact
          accessibilityLabel="Shutter"
          disabled={e.shutterAuto}
          options={e.shutterOptions.map((d) => (useAngle ? shutterAngleLabel(d, fps) : shutterLabel(d)))}
          index={nearestIndex(e.shutterOptions, e.shutterDenom)}
          onChange={(i) => write(control.setShutter(e.shutterOptions[i]))}
        />
      </DrumRow>
      <DrumRow label="EV">
        <MonitorValueDrum
          compact
          accessibilityLabel="Exposure compensation"
          disabled={!evApplies}
          options={e.evOptions.map(evLabel)}
          index={nearestIndex(e.evOptions, e.ev)}
          onChange={(i) => write(control.setEv(e.evOptions[i]))}
        />
      </DrumRow>
      {hasAperture && apertures.length > 0 ? (
        <DrumRow label="Aperture">
          <MonitorValueDrum
            compact
            accessibilityLabel="Aperture"
            options={apertures.map((f) => apertureLabel(f))}
            index={nearestIndex(apertures, e.aperture)}
            onChange={(i) => write(control.setAperture(apertures[i]))}
          />
        </DrumRow>
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    stack: { gap: spacing.sm },
    row: { gap: 3 },
    header: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, minHeight: 22 },
    value: { flex: 1, fontFamily: fonts.medium, fontSize: 12, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    label: {
      fontFamily: fonts.semibold,
      fontSize: 11,
      letterSpacing: 1.2,
      textTransform: 'uppercase' as const,
      color: colors.mutedForeground,
    },
    trailing: { flexDirection: 'row' as const, gap: 6, marginLeft: 'auto' as const },
    toggle: {
      height: 22,
      minWidth: 44,
      paddingHorizontal: 10,
      borderRadius: radius.pill,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: colors.surface,
    },
    toggleOn: { backgroundColor: colors.ink },
    toggleLabel: { fontFamily: fonts.semibold, fontSize: 12, color: colors.foreground, fontVariant: ['tabular-nums' as const] },
    toggleLabelOn: { color: colors.inkForeground },
    pressed: { opacity: 0.7 },
  };
}
