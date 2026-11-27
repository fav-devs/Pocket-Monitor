import { Fragment, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useCamera, type CameraState } from '@/camera';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { usePreferences } from '@/state/preferences';
import {
  COLOR_LABEL,
  FOCUS_LABEL,
  apertureLabel,
  audioLabel,
  evLabel,
  isPhotoMode,
  shutterAngleLabel,
  shutterLabel,
  wbLabel,
} from '../format';
import { haptics } from '../haptics';
import type { Rect } from '../layout/fieldMonitorLayout';
import { useLiveUi, type CameraTab, type CaptureSheetId } from '../liveUiStore';
import { onVideo, rectStyle, textShadow } from '../chrome/primitives';

interface Readout {
  /** The program badge (M / A) before the exposure values. */
  program: 'M' | 'A';
  format: string | null;
  exposure: string[];
  camera: { id: 'wb' | 'focus' | 'audio'; label: string; value: string }[];
}

/** What the bottom edge reads, in Mimo's order: format, then `1/60 · ISO 400 · −0.3`, then WB / focus / audio. */
export function captureReadout(s: CameraState, shutterUsesAngle: boolean): Readout {
  const e = s.exposure;
  const photo = isPhotoMode(s.format.shootingMode);
  const manual = e.mode === 'manual';
  const exposure: string[] = [];
  const shutter = shutterUsesAngle && !photo ? shutterAngleLabel(e.shutterDenom, s.format.fps) : shutterLabel(e.shutterDenom);
  // In M, a value the camera still sets itself carries an A.
  exposure.push(manual && e.shutterAuto ? `A ${shutter}` : shutter);
  exposure.push(e.iso != null ? `ISO ${manual && e.isoAuto ? 'A' : ''}${e.iso}` : e.isoAuto ? 'ISO A' : 'ISO --');
  if (!manual || e.isoAuto || e.shutterAuto) exposure.push(evLabel(e.ev));
  if (s.capabilities.aperture) exposure.push(apertureLabel(e.aperture));
  const camera: Readout['camera'] = [
    { id: 'wb', label: 'White balance', value: wbLabel(s.whiteBalance.preset, s.whiteBalance.kelvin) },
    { id: 'focus', label: 'Focus', value: FOCUS_LABEL[s.focus.mode] },
  ];
  if (s.capabilities.audioControls && !photo) camera.push({ id: 'audio', label: 'Audio', value: audioLabel(s.audio.channel) });
  const color = s.format.colorMode !== 'normal' ? ` · ${COLOR_LABEL[s.format.colorMode]}` : '';
  return {
    program: manual ? 'M' : 'A',
    format: photo ? null : `${s.format.resolution} ${s.format.fps}${color}`,
    exposure,
    camera,
  };
}

function Dot() {
  const styles = useThemedStyles(createStyles);
  return <Text style={[styles.text, styles.dot]}> · </Text>;
}

/** A tappable run of readout text: accent while its sheet is open. */
function Group({
  testID,
  label,
  value,
  active,
  onPress,
  children,
}: {
  testID: string;
  label: string;
  value: string;
  active: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  const locked = useLiveUi((s) => s.locked);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{ text: value }}
      accessibilityState={{ selected: active, disabled: locked }}
      disabled={locked}
      hitSlop={{ top: 10, bottom: 8, left: 4, right: 4 }}
      onPress={() => {
        haptics.light();
        onPress();
      }}
      style={({ pressed }) => [styles.group, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

/**
 * The capture readout as plain shadowed text along the bottom edge (Mimo's `1/60 ISO 400 −0.3`),
 * in place of the boxed strip. Format opens the format sheet, the exposure values open the one
 * exposure panel, and WB / focus / audio open the camera settings sheet at their tab.
 */
export function CaptureReadout({
  rect,
  align = 'center',
  exposureOnly = false,
}: {
  /** Absent: sized to its content (a movable item places it). */
  rect?: Rect;
  align?: 'center' | 'leading';
  /**
   * Optional (additive). Mimo's readout: only `1/60 · ISO 400 · −0.3` (the format chip and the
   * settings panel carry the rest, and the strip shows AUTO / M).
   */
  exposureOnly?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const angle = usePreferences((p) => !!p.shutterUsesAngle);
  const key = useCamera((s) => JSON.stringify(captureReadout(s, angle)));
  const r: Readout = JSON.parse(key);
  const open = useLiveUi((s) => s.captureSheet);
  const tab = useLiveUi((s) => s.cameraTab);
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  const toggle = (id: CaptureSheetId, cameraTab?: CameraTab) =>
    set({
      captureSheet: open === id && (!cameraTab || tab === cameraTab) ? null : id,
      ...(cameraTab ? { cameraTab } : null),
      gimbalPanel: 'none',
      zoomDialOpen: false,
    });
  const exposureOpen = open === 'exposure' || open === 'iso' || open === 'shutter' || open === 'ev' || open === 'aperture';
  const cameraOpen = (id: 'wb' | 'focus' | 'audio') =>
    open === id || (open === 'camera' && tab === 'camera');
  const tint = (on: boolean) => (on ? { color: colors.accent } : null);

  return (
    <View
      pointerEvents={locked ? 'none' : 'box-none'}
      style={[rect ? rectStyle(rect) : null, styles.root, !rect && styles.sized, align === 'leading' && styles.rootLeading, locked && styles.locked]}
    >
      {r.format && !exposureOnly ? (
        <Group testID="monitor.capture.format" label="Recording format" value={r.format} active={open === 'format'} onPress={() => toggle('format')}>
          <Text numberOfLines={1} style={[styles.text, tint(open === 'format')]}>
            {r.format}
          </Text>
        </Group>
      ) : null}
      <Group
        testID="monitor.capture.exposure"
        label="Exposure"
        value={`${r.program === 'M' ? 'Manual' : 'Auto'}, ${r.exposure.join(', ')}`}
        active={exposureOpen}
        onPress={() => toggle('exposure')}
      >
        {!exposureOnly ? (
          <View style={[styles.badge, exposureOpen && { borderColor: colors.accent }]}>
            <Text style={[styles.badgeText, tint(exposureOpen)]}>{r.program}</Text>
          </View>
        ) : null}
        {r.exposure.map((v, i) => (
          <Fragment key={i}>
            {i > 0 ? <Dot /> : null}
            <Text numberOfLines={1} style={[styles.text, tint(exposureOpen)]}>
              {v}
            </Text>
          </Fragment>
        ))}
      </Group>
      {exposureOnly ? null : (
      <View style={styles.words}>
        {r.camera.map((c, i) => (
          <Fragment key={c.id}>
            {i > 0 ? <Dot /> : null}
            <Group
              testID={`monitor.capture.${c.id}`}
              label={c.label}
              value={c.value}
              active={cameraOpen(c.id)}
              onPress={() => toggle('camera', 'camera')}
            >
              <Text numberOfLines={1} style={[styles.text, styles.muted, tint(cameraOpen(c.id))]}>
                {c.value}
              </Text>
            </Group>
          </Fragment>
        ))}
      </View>
      )}
    </View>
  );
}

function createStyles(_colors: ThemeColors) {
  return {
    root: {
      flexDirection: 'row' as const,
      flexWrap: 'wrap' as const,
      justifyContent: 'center' as const,
      alignItems: 'flex-end' as const,
      alignContent: 'flex-end' as const,
      columnGap: 18,
      rowGap: 0,
    },
    rootLeading: { justifyContent: 'flex-start' as const },
    sized: { flexWrap: 'nowrap' as const },
    group: { flexDirection: 'row' as const, alignItems: 'center' as const, height: 26 },
    words: { flexDirection: 'row' as const, alignItems: 'center' as const },
    text: {
      fontFamily: fonts.semibold,
      fontSize: 13,
      color: onVideo.ink,
      fontVariant: ['tabular-nums' as const],
      ...textShadow,
    },
    muted: { color: 'rgba(255,255,255,0.82)' },
    dot: { color: onVideo.inkMuted },
    badge: {
      minWidth: 16,
      height: 16,
      paddingHorizontal: 2,
      marginRight: 6,
      borderRadius: 4,
      borderWidth: 1.2,
      borderColor: onVideo.ink,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: 'rgba(0,0,0,0.2)',
    },
    badgeText: { fontFamily: fonts.bold, fontSize: 10, lineHeight: 12, color: onVideo.ink },
    locked: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
  };
}
