import { SdCardIcon, ThermometerIcon } from '@hugeicons/core-free-icons';
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useCamera, type CameraState } from '@/camera';
import { Icon } from '@/components/icon';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import {
  COLOR_LABEL,
  MODE_LABEL,
  TIMECODE_PLACEHOLDER,
  elapsedLabel,
  formatChip,
  isPhotoMode,
  storageForms,
  timecodeComponents,
} from '../format';
import { STATUS_GAP, STATUS_ROW, type FieldMonitorLayout } from '../layout/fieldMonitorLayout';
import { useLiveUi, type CaptureSheetId } from '../liveUiStore';
import { LiveBackButton } from '../chrome/SystemButtons';
import { PillText, VideoPill, onVideo, textShadow } from '../chrome/primitives';
import { CameraBatteryGauge, LinkGauge, PhoneBatteryGauge } from './LiveTelemetry';

/** `MonitorRecordingReadout`: a pill with the dotPink REC dot (white at standby) and elapsed time. */
export function RecordingReadout() {
  const styles = useThemedStyles(createStyles);
  const rec = useCamera((s) => s.recording);
  const recording = rec.recording;
  return (
    <VideoPill
      label={recording ? 'Recording' : 'Standby'}
      accessibilityValue={{ text: elapsedLabel(rec.elapsedSec) }}
      style={recording ? styles.recPill : undefined}
    >
      <View style={[styles.recDot, recording && styles.recDotOn]} />
      <PillText>{recording ? 'REC' : 'STBY'}</PillText>
      <PillText mono>{elapsedLabel(recording ? rec.elapsedSec : 0)}</PillText>
    </VideoPill>
  );
}

/** `MonitorClock`: the reported timecode; the last field in accent. Never invents a clock. */
export function MonitorClock() {
  const styles = useThemedStyles(createStyles);
  const tc = useCamera((s) => s.recording.timecode);
  const { base, accent } = timecodeComponents(tc ?? TIMECODE_PLACEHOLDER);
  return (
    <Text numberOfLines={1} style={styles.clock} accessibilityLabel={tc ? `Timecode ${tc}` : 'Timecode not available'}>
      {base}
      <Text style={styles.clockAccent}>{accent}</Text>
    </Text>
  );
}

// Selector returns a primitive so the subscription stays stable.
const storageFormsKey = (s: CameraState) => storageForms(s).join('|');

/** Storage remaining; tap cycles free space → record time → percent. */
export function StorageReadout() {
  const forms = useCamera(storageFormsKey);
  const [form, setForm] = useState(0);
  const list = forms.split('|');
  const value = list[form % list.length];
  const locked = useLiveUi((s) => s.locked);
  return (
    <VideoPill label="Storage remaining" accessibilityValue={{ text: value }} disabled={locked} onPress={() => setForm((f) => (f + 1) % list.length)}>
      <Icon icon={SdCardIcon} size={14} color={onVideo.ink} />
      <PillText mono>{value}</PillText>
    </VideoPill>
  );
}

/** A pill that opens one of the top-edge capture sheets (format, colour, mode). */
function SheetPill({ sheet, value, label, accent }: { sheet: CaptureSheetId; value: string; label: string; accent?: boolean }) {
  const { colors } = useTheme();
  const open = useLiveUi((s) => s.captureSheet === sheet);
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  return (
    <VideoPill
      testID={`monitor.capture.${sheet}`}
      label={label}
      accessibilityValue={{ text: value }}
      chosen={open}
      disabled={locked}
      onPress={() => set({ captureSheet: open ? null : sheet, gimbalPanel: 'none', zoomDialOpen: false })}
    >
      <PillText chosen={open} color={accent ? colors.accent : undefined}>
        {value}
      </PillText>
    </VideoPill>
  );
}

function ThermalBadge() {
  const { colors } = useTheme();
  const thermal = useCamera((s) => s.power.thermal);
  if (thermal === 'normal') return null;
  const tint = thermal === 'hot' ? colors.destructive : colors.warning;
  return (
    <VideoPill label={thermal === 'hot' ? 'Camera hot' : 'Camera warm'}>
      <Icon icon={ThermometerIcon} size={14} color={tint} />
      <PillText color={tint}>{thermal === 'hot' ? 'Hot' : 'Warm'}</PillText>
    </VideoPill>
  );
}

function Row({ children, style }: { children: ReactNode; style?: object }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View pointerEvents="box-none" style={[styles.row, style]}>
      {children}
    </View>
  );
}

/**
 * `LiveStatusChrome`: status pills along the top. Landscape is one row (back, REC and timecode
 * leading; format, colour, mode and telemetry trailing). Portrait is two rows: telemetry, then
 * REC + timecode with format and colour.
 */
export function LiveStatusChrome({ layout, onBack }: { layout: FieldMonitorLayout; onBack: () => void }) {
  const styles = useThemedStyles(createStyles);
  const format = useCamera((s) => s.format);
  const photo = isPhotoMode(format.shootingMode);
  const { status } = layout;

  const formatPills = photo ? (
    <SheetPill sheet="mode" value={MODE_LABEL[format.shootingMode]} accent label="Shooting mode" />
  ) : (
    <>
      <SheetPill sheet="format" value={formatChip(format.resolution, format.fps)} label="Recording format" />
      <SheetPill sheet="color" value={COLOR_LABEL[format.colorMode]} label="Color mode" />
    </>
  );
  const recGroup = !photo ? (
    <>
      <RecordingReadout />
      <MonitorClock />
    </>
  ) : null;

  if (layout.portrait) {
    const roomy = status.width >= 560;
    return (
      <View pointerEvents="box-none" style={[styles.box, { left: status.x, top: status.y, width: status.width }]}>
        <Row>
          <LiveBackButton onPress={onBack} />
          <StorageReadout />
          <LinkGauge />
          <ThermalBadge />
          <View style={styles.spacer} />
          <PhoneBatteryGauge />
          <CameraBatteryGauge />
        </Row>
        <Row style={{ marginTop: STATUS_GAP }}>
          {recGroup}
          <View style={styles.spacer} />
          {formatPills}
          {!photo && roomy ? <SheetPill sheet="mode" value={MODE_LABEL[format.shootingMode]} accent label="Shooting mode" /> : null}
        </Row>
      </View>
    );
  }

  const showsMode = !photo && status.width >= 700;
  return (
    <View pointerEvents="box-none" style={[styles.box, { left: status.x, top: status.y, width: status.width }]}>
      <Row>
        <LiveBackButton onPress={onBack} />
        {recGroup}
        <View style={styles.spacer} />
        {formatPills}
        {showsMode ? <SheetPill sheet="mode" value={MODE_LABEL[format.shootingMode]} accent label="Shooting mode" /> : null}
        <StorageReadout />
        <LinkGauge />
        <PhoneBatteryGauge />
        <CameraBatteryGauge />
        <ThermalBadge />
      </Row>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    box: { position: 'absolute' as const },
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, height: STATUS_ROW },
    spacer: { flex: 1, minWidth: 4 },
    recPill: { backgroundColor: 'rgba(214,21,95,0.28)' },
    recDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: onVideo.inkMuted },
    recDotOn: { backgroundColor: colors.dotPink },
    clock: {
      fontFamily: fonts.semibold,
      fontSize: 13,
      color: onVideo.ink,
      fontVariant: ['tabular-nums' as const],
      marginLeft: 2,
      ...textShadow,
    },
    clockAccent: { color: colors.accent },
  };
}
