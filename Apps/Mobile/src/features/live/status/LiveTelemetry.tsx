import { Camera, Gauge, Signal, Smartphone, Zap } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useCamera } from '@/camera';
import { MText, colors, linkHealthColor, withAlpha } from '@/theme';
import { DASH } from '../format';

const PILL_W = 40;
const PILL_H = 18;

function GaugeBars({ filled, count = 4, tint }: { filled: number; count?: number; tint: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 2, alignItems: 'center' }}>
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={{ width: 4, height: 9, borderRadius: 1, backgroundColor: i < filled ? tint : withAlpha('#FFFFFF', 0.18) }}
        />
      ))}
    </View>
  );
}

/** `MonitorTelemetryPill`: icon, then an outlined capsule with bars or a value. */
function TelemetryGauge({
  icon,
  tint,
  children,
  label,
  onPress,
}: {
  icon: ReactNode;
  tint: string;
  children: ReactNode;
  label: string;
  onPress?: () => void;
}) {
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 20 }}>
      <View style={{ width: 12, alignItems: 'center' }}>{icon}</View>
      <View
        style={{
          width: PILL_W,
          height: PILL_H,
          borderRadius: 5,
          borderWidth: 1.2,
          borderColor: withAlpha(tint.startsWith('#') ? tint : '#FFFFFF', 0.9),
          backgroundColor: 'rgba(0,0,0,0.35)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </View>
    </View>
  );
  if (!onPress) {
    return (
      <View accessibilityLabel={label} accessible>
        {body}
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={12}>
      {body}
    </Pressable>
  );
}

export function batteryTint(percent: number | null): string {
  if (percent == null) return colors.text;
  if (percent <= 5) return colors.recording;
  if (percent <= 20) return colors.linkWatch;
  return colors.linkStable;
}

/** Signal bars tapping to the measured feed frame rate. Colour follows the link band. */
export function LinkGauge() {
  const conn = useCamera((s) => s.connection);
  const [showsFps, setShowsFps] = useState(false);
  const tint = linkHealthColor(conn.linkBand);
  return (
    <TelemetryGauge
      label={showsFps ? `Feed ${conn.videoFps} frames per second` : `Signal ${conn.signalBars} of 4 bars`}
      onPress={() => setShowsFps((v) => !v)}
      tint={tint}
      icon={showsFps ? <Gauge size={11} color={colors.secondary} /> : <Signal size={11} color={colors.secondary} />}
    >
      {showsFps ? (
        <MText size={10} weight="semibold" mono color={tint}>
          {conn.videoFps > 0 ? `${conn.videoFps}fps` : DASH}
        </MText>
      ) : (
        <GaugeBars filled={conn.signalBars} tint={tint} />
      )}
    </TelemetryGauge>
  );
}

/** Phone battery. No battery API is wired yet, so the reading stays unknown, never 0 %. */
export function PhoneBatteryGauge() {
  return (
    <TelemetryGauge label="Phone battery unavailable" tint={colors.linkStable} icon={<Smartphone size={11} color={colors.secondary} />}>
      <MText size={10} weight="semibold" color={colors.linkStable}>
        {DASH}
      </MText>
    </TelemetryGauge>
  );
}

export function CameraBatteryGauge() {
  const power = useCamera((s) => s.power);
  const known = power.batteryPercent >= 0 && power.batteryPercent <= 100;
  const pct = known ? power.batteryPercent : null;
  const tint = batteryTint(pct);
  return (
    <TelemetryGauge
      label={known ? `Camera battery ${pct} percent${power.charging ? ', charging' : ''}` : 'Camera battery unavailable'}
      tint={tint}
      icon={power.charging ? <Zap size={11} color={tint} /> : <Camera size={11} color={colors.secondary} />}
    >
      <MText size={10} weight="semibold" mono color={tint}>
        {known ? `${pct}%` : DASH}
      </MText>
    </TelemetryGauge>
  );
}

/** Landscape: link, phone and camera stacked in the leading rail. */
export function LiveTelemetryStack() {
  return (
    <View style={{ gap: 4 }}>
      <LinkGauge />
      <PhoneBatteryGauge />
      <CameraBatteryGauge />
    </View>
  );
}
