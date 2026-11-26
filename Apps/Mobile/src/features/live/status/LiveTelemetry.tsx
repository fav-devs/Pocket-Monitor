import {
  BatteryCharging01Icon,
  BatteryEmptyIcon,
  BatteryFullIcon,
  BatteryLowIcon,
  BatteryMedium01Icon,
  DashboardSpeed01Icon,
  SmartPhone01Icon,
} from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { View } from 'react-native';
import { useCamera, type LinkHealthBand } from '@/camera';
import { Icon } from '@/components/icon';
import { type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { DASH } from '../format';
import { PillText, VideoPill, onVideo } from '../chrome/primitives';

export function linkTint(colors: ThemeColors, band: LinkHealthBand) {
  return band === 'poor' ? colors.destructive : band === 'watch' ? colors.warning : colors.success;
}

/** Battery text colour: white normally, amber at 20 %, red at 5 %. */
export function batteryTint(colors: ThemeColors, percent: number | null): string {
  if (percent == null) return onVideo.ink;
  if (percent <= 5) return colors.destructive;
  if (percent <= 20) return colors.warning;
  return onVideo.ink;
}

function GaugeBars({ filled, tint }: { filled: number; tint: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.bars}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={[styles.bar, { height: 4 + i * 2.5, backgroundColor: i < filled ? tint : onVideo.inkFaint }]} />
      ))}
    </View>
  );
}

/** Signal bars; tap shows the measured feed frame rate. Colour follows the link band. */
export function LinkGauge() {
  const { colors } = useTheme();
  const conn = useCamera((s) => s.connection);
  const [showsFps, setShowsFps] = useState(false);
  const tint = linkTint(colors, conn.linkBand);
  return (
    <VideoPill
      label={showsFps ? `Feed ${conn.videoFps} frames per second` : `Signal ${conn.signalBars} of 4 bars`}
      onPress={() => setShowsFps((v) => !v)}
    >
      {showsFps ? (
        <>
          <Icon icon={DashboardSpeed01Icon} size={14} color={onVideo.ink} />
          <PillText mono color={tint}>
            {conn.videoFps > 0 ? `${conn.videoFps} fps` : DASH}
          </PillText>
        </>
      ) : (
        <GaugeBars filled={conn.signalBars} tint={tint} />
      )}
    </VideoPill>
  );
}

/** Phone battery. No battery API is wired yet, so the reading stays unknown, never 0 %. */
export function PhoneBatteryGauge() {
  return (
    <VideoPill label="Phone battery unavailable">
      <Icon icon={SmartPhone01Icon} size={14} color={onVideo.ink} />
      <PillText>{DASH}</PillText>
    </VideoPill>
  );
}

export function CameraBatteryGauge() {
  const { colors } = useTheme();
  const power = useCamera((s) => s.power);
  const known = power.batteryPercent >= 0 && power.batteryPercent <= 100;
  const pct = known ? power.batteryPercent : null;
  const tint = batteryTint(colors, pct);
  const icon = power.charging
    ? BatteryCharging01Icon
    : pct == null
      ? BatteryEmptyIcon
      : pct > 60
        ? BatteryFullIcon
        : pct > 20
          ? BatteryMedium01Icon
          : pct > 5
            ? BatteryLowIcon
            : BatteryEmptyIcon;
  return (
    <VideoPill label={known ? `Camera battery ${pct} percent${power.charging ? ', charging' : ''}` : 'Camera battery unavailable'}>
      <Icon icon={icon} size={16} color={power.charging ? colors.success : tint} />
      <PillText mono color={tint}>
        {known ? `${pct}%` : DASH}
      </PillText>
    </VideoPill>
  );
}

function createStyles(_colors: ThemeColors) {
  return {
    bars: { flexDirection: 'row' as const, alignItems: 'flex-end' as const, gap: 2, height: 12, paddingHorizontal: 1 },
    bar: { width: 3, borderRadius: 1 },
  };
}
