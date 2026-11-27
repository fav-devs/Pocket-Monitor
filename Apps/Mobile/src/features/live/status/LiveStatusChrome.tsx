import {
  BatteryCharging01Icon,
  BatteryEmptyIcon,
  BatteryFullIcon,
  BatteryLowIcon,
  BatteryMedium01Icon,
  SdCardIcon,
  ThermometerIcon,
} from '@hugeicons/core-free-icons';
import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useCamera, type CameraState } from '@/camera';
import { Icon } from '@/components/icon';
import { recordRed, recordRedSoft } from '@/constants/monitor';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { usePreferences } from '@/state/preferences';
import { DASH, elapsedLabel, isPhotoMode, storageForms, timecodeComponents } from '../format';
import { STATUS_ROW, type FieldMonitorLayout } from '../layout/fieldMonitorLayout';
import { useLiveUi } from '../liveUiStore';
import { LiveBackButton } from '../chrome/SystemButtons';
import { onVideo, textShadow } from '../chrome/primitives';
import { GaugeBars, batteryTint, linkTint } from './LiveTelemetry';

/** One cluster's soft capsule over the picture. */
const CLUSTER_FILL = 'rgba(0,0,0,0.32)';

function Cluster({ children, tint, label }: { children: ReactNode; tint?: string; label?: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View accessibilityLabel={label} style={[styles.cluster, tint ? { backgroundColor: tint } : null]}>
      {children}
    </View>
  );
}

function Readout({ children, color, mono = true }: { children: ReactNode; color?: string; mono?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Text numberOfLines={1} style={[styles.text, mono && styles.mono, color ? { color } : null]}>
      {children}
    </Text>
  );
}

/**
 * Leading cluster (`MonitorRecordingReadout` + `MonitorClock`): the REC dot (record red, grey at
 * standby, on a red-tinted capsule while recording), REC / STBY and the take's elapsed time, then the camera's timecode when it reports one
 * and Display → Timecode is on. Never invents a clock.
 */
export function RecordingReadout() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const rec = useCamera((s) => s.recording);
  const showTimecode = usePreferences((p) => p.showTimecode ?? true);
  const recording = rec.recording;
  const tc = showTimecode ? rec.timecode : undefined;
  const { base, accent } = timecodeComponents(tc ?? '');
  return (
    <Cluster tint={recording ? recordRedSoft : undefined}>
      <View
        accessible
        accessibilityLabel={recording ? 'Recording' : 'Standby'}
        accessibilityValue={{ text: elapsedLabel(rec.elapsedSec) }}
        style={styles.item}
      >
        <View style={[styles.recDot, recording && styles.recDotOn]} />
        {/* With a timecode beside it the red dot and tint say REC; the word would crowd the clock. */}
        {!tc ? <Readout mono={false}>{recording ? 'REC' : 'STBY'}</Readout> : null}
        <Readout>{elapsedLabel(recording ? rec.elapsedSec : 0)}</Readout>
      </View>
      {tc ? (
        <Text numberOfLines={1} style={[styles.text, styles.mono, styles.clock]} accessibilityLabel={`Timecode ${tc}`}>
          {base}
          <Text style={{ color: colors.accent }}>{accent}</Text>
        </Text>
      ) : null}
    </Cluster>
  );
}

/** Card forms, record time first (Mimo's SD 5:36:07), then free space, then percent. */
function cardForms(s: CameraState): string[] {
  const forms = storageForms(s);
  return forms.length > 1 && s.recording.remainingSec >= 0 ? [forms[1], forms[0], ...forms.slice(2)] : forms;
}
// Selector returns a primitive so the subscription stays stable.
const cardFormsKey = (s: CameraState) => cardForms(s).join('|');

function cameraBatteryIcon(pct: number | null, charging: boolean) {
  if (charging) return BatteryCharging01Icon;
  if (pct == null) return BatteryEmptyIcon;
  return pct > 60 ? BatteryFullIcon : pct > 20 ? BatteryMedium01Icon : pct > 5 ? BatteryLowIcon : BatteryEmptyIcon;
}

/**
 * Trailing cluster: thermal (only when warm or hot), camera battery, card time left (tap cycles
 * free space and percent), and the link bars (tap shows the feed frame rate). The phone battery
 * would join only when low; no battery API is wired, so it never shows.
 */
export function CameraStatusCluster() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const locked = useLiveUi((s) => s.locked);
  const power = useCamera((s) => s.power);
  const conn = useCamera((s) => s.connection);
  const forms = useCamera(cardFormsKey).split('|');
  const [form, setForm] = useState(0);
  const [showsFps, setShowsFps] = useState(false);
  const card = forms[form % forms.length];
  const known = power.batteryPercent >= 0 && power.batteryPercent <= 100;
  const pct = known ? power.batteryPercent : null;
  const batteryColor = batteryTint(colors, pct);
  const link = linkTint(colors, conn.linkBand);
  const thermal = power.thermal;
  const hot = thermal === 'hot' ? colors.destructive : colors.warning;
  return (
    <Cluster>
      {thermal !== 'normal' ? (
        <View accessible accessibilityLabel={thermal === 'hot' ? 'Camera hot' : 'Camera warm'} style={styles.item}>
          <Icon icon={ThermometerIcon} size={14} color={hot} />
          <Readout mono={false} color={hot}>
            {thermal === 'hot' ? 'Hot' : 'Warm'}
          </Readout>
        </View>
      ) : null}
      <View
        accessible
        accessibilityLabel={known ? `Camera battery ${pct} percent${power.charging ? ', charging' : ''}` : 'Camera battery unavailable'}
        style={styles.item}
      >
        <Icon icon={cameraBatteryIcon(pct, power.charging)} size={16} color={power.charging ? colors.success : batteryColor} />
        <Readout color={batteryColor}>{known ? `${pct}%` : DASH}</Readout>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Storage remaining"
        accessibilityValue={{ text: card }}
        disabled={locked}
        hitSlop={{ top: 8, bottom: 8 }}
        onPress={() => setForm((f) => (f + 1) % forms.length)}
        style={({ pressed }) => [styles.item, pressed && styles.pressed]}
      >
        <Icon icon={SdCardIcon} size={14} color={onVideo.ink} />
        <Readout>{card}</Readout>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={showsFps ? `Feed ${conn.videoFps} frames per second` : `Signal ${conn.signalBars} of 4 bars`}
        hitSlop={{ top: 8, bottom: 8, right: 6 }}
        onPress={() => setShowsFps((v) => !v)}
        style={({ pressed }) => [styles.item, pressed && styles.pressed]}
      >
        {showsFps ? <Readout color={link}>{conn.videoFps > 0 ? `${conn.videoFps} fps` : DASH}</Readout> : <GaugeBars filled={conn.signalBars} tint={link} />}
      </Pressable>
    </Cluster>
  );
}

/**
 * `LiveStatusChrome`, picture first: back, then one cluster per side — REC and timecode leading,
 * the camera's battery, card and link trailing. Format, colour and mode live in their own
 * controls (the readout and the mode rail), so nothing here repeats them.
 */
export function LiveStatusChrome({ layout, onBack }: { layout: FieldMonitorLayout; onBack: () => void }) {
  const styles = useThemedStyles(createStyles);
  const photo = useCamera((s) => isPhotoMode(s.format.shootingMode));
  const { status } = layout;
  return (
    <View pointerEvents="box-none" style={[styles.row, { left: status.x, top: status.y, width: status.width }]}>
      <LiveBackButton onPress={onBack} />
      {!photo ? <RecordingReadout /> : null}
      <View style={styles.spacer} />
      <CameraStatusCluster />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    row: {
      position: 'absolute' as const,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      height: STATUS_ROW,
    },
    spacer: { flex: 1, minWidth: 4 },
    cluster: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      height: 28,
      paddingHorizontal: 9,
      borderRadius: 999,
      backgroundColor: CLUSTER_FILL,
      flexShrink: 1,
    },
    item: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, minHeight: 28 },
    text: { fontFamily: fonts.semibold, fontSize: 12.5, color: onVideo.ink, ...textShadow },
    mono: { fontVariant: ['tabular-nums' as const] },
    clock: { color: onVideo.ink },
    recDot: { width: 7, height: 7, borderRadius: 3.5, marginRight: 1, backgroundColor: onVideo.inkMuted },
    recDotOn: { backgroundColor: recordRed },
    pressed: { opacity: 0.7 },
  };
}
