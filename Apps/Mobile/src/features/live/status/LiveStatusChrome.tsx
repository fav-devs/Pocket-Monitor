import { MemoryStick, Thermometer } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useCamera, type CameraState } from '@/camera';
import { MText, colors } from '@/theme';
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
import type { FieldMonitorLayout } from '../layout/fieldMonitorLayout';
import { useLiveUi, type CaptureSheetId } from '../liveUiStore';
import { readoutShadow, rectStyle } from '../chrome/primitives';
import { CameraBatteryGauge, LinkGauge, PhoneBatteryGauge } from './LiveTelemetry';

/** `MonitorRecordingReadout`: STBY/REC + elapsed in a dark capsule. */
export function RecordingReadout() {
  const rec = useCamera((s) => s.recording);
  const recording = rec.recording;
  return (
    <View
      accessible
      accessibilityLabel={recording ? 'Recording' : 'Standby'}
      accessibilityValue={{ text: elapsedLabel(rec.elapsedSec) }}
      style={{
        flexDirection: 'row',
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: 'rgba(0,0,0,0.65)',
      }}
    >
      <MText size={10} weight="semibold" mono color={recording ? colors.recording : colors.text}>
        {recording ? 'REC' : 'STBY'}
      </MText>
      <MText size={10} weight="semibold" mono color={colors.secondary}>
        {elapsedLabel(recording ? rec.elapsedSec : 0)}
      </MText>
    </View>
  );
}

/** `MonitorClock`: the reported timecode; the last field in accent. Never invents a clock. */
export function MonitorClock({ size }: { size: number }) {
  const tc = useCamera((s) => s.recording.timecode);
  const shown = tc ?? TIMECODE_PLACEHOLDER;
  const { base, accent } = timecodeComponents(shown);
  return (
    <MText
      size={size}
      weight="medium"
      mono
      numberOfLines={1}
      style={readoutShadow}
      accessibilityLabel={tc ? `Timecode ${tc}` : 'Timecode not available'}
    >
      {base}
      <MText size={size} weight="medium" mono color={colors.accent}>
        {accent}
      </MText>
    </MText>
  );
}

/** Storage remaining; tap cycles free space → record time → percent. */
export function StorageReadout({ size }: { size: number }) {
  const forms = useCamera(storageFormsKey);
  const [form, setForm] = useState(0);
  const list = forms.split('|');
  const value = list[form % list.length];
  const locked = useLiveUi((s) => s.locked);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Storage remaining"
      accessibilityValue={{ text: value }}
      disabled={locked}
      onPress={() => setForm((f) => (f + 1) % list.length)}
      hitSlop={10}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 32 }}
    >
      <MemoryStick size={12} color={colors.text} />
      <MText size={size} weight="medium" mono numberOfLines={1} style={readoutShadow}>
        {value}
      </MText>
    </Pressable>
  );
}

// Selector returns a primitive so the subscription stays stable.
const storageFormsKey = (s: CameraState) => storageForms(s).join('|');

function TopReadout({
  sheet,
  value,
  size,
  accent,
  caption,
  label,
  weight = 'medium',
}: {
  sheet: CaptureSheetId;
  value: string;
  size: number;
  accent?: boolean;
  caption?: string;
  label: string;
  weight?: 'medium' | 'semibold';
}) {
  const open = useLiveUi((s) => s.captureSheet === sheet);
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{ text: value }}
      disabled={locked}
      hitSlop={10}
      onPress={() => set({ captureSheet: open ? null : sheet, gimbalPanel: 'none', zoomDialOpen: false })}
      style={{ minHeight: 32, justifyContent: 'center', alignItems: caption ? 'flex-end' : 'flex-start' }}
    >
      <MText size={size} weight={weight} mono numberOfLines={1} color={accent || open ? colors.accent : colors.text} style={readoutShadow}>
        {value}
      </MText>
      {caption ? (
        <MText size={11} weight="semibold" numberOfLines={1} color={open ? colors.accent : colors.text} style={readoutShadow}>
          {caption}
        </MText>
      ) : null}
    </Pressable>
  );
}

function ThermalBadge() {
  const thermal = useCamera((s) => s.power.thermal);
  if (thermal === 'normal') return null;
  const tint = thermal === 'hot' ? colors.recording : colors.linkWatch;
  return (
    <View
      accessible
      accessibilityLabel={thermal === 'hot' ? 'Camera hot' : 'Camera warm'}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}
    >
      <Thermometer size={14} color={tint} />
      <MText size={12} weight="semibold" color={tint} uppercase style={readoutShadow}>
        {thermal}
      </MText>
    </View>
  );
}

/** `LiveStatusChrome` over `MonitorStatusChrome`: storage, format, colour, mode, REC + clock. */
export function LiveStatusChrome({ layout }: { layout: FieldMonitorLayout }) {
  const format = useCamera((s) => s.format);
  const photo = isPhotoMode(format.shootingMode);
  const tablet = layout.tablet;

  if (layout.portrait) {
    const clockSize = tablet ? 25 : 23;
    return (
      <>
        {/* Storage + link on the left of the island, batteries trailing it. */}
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: layout.status.x,
            top: layout.telemetry.y - 6,
            right: layout.viewport.width - layout.telemetry.x + 8,
            height: 32,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <StorageReadout size={14} />
          <LinkGauge />
          <ThermalBadge />
        </View>
        <View
          pointerEvents="box-none"
          style={{ ...rectStyle(layout.telemetry), flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}
        >
          <PhoneBatteryGauge />
          <CameraBatteryGauge />
        </View>
        <View
          pointerEvents="box-none"
          style={{ ...rectStyle(layout.status), top: layout.status.y + 14, flexDirection: 'row', alignItems: 'flex-start' }}
        >
          <View style={{ flex: 1, alignItems: 'flex-start', paddingTop: 4 }}>{!photo ? <RecordingReadout /> : null}</View>
          <View style={{ alignItems: 'center' }}>{!photo ? <MonitorClock size={clockSize} /> : null}</View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            {photo ? (
              <TopReadout sheet="mode" value="MODE" size={12} weight="semibold" label="Shooting mode" />
            ) : (
              <TopReadout
                sheet="format"
                value={`${format.resolution}${format.fps}p`}
                caption={COLOR_LABEL[format.colorMode]}
                size={tablet ? 18 : 16}
                label="Recording options"
              />
            )}
          </View>
        </View>
      </>
    );
  }

  const size = tablet ? 18 : 16;
  return (
    <View
      pointerEvents="box-none"
      style={{ ...rectStyle(layout.status), flexDirection: 'row', alignItems: 'center' }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 24, flexShrink: 1 }}>
        <StorageReadout size={size} />
        {photo ? (
          <TopReadout sheet="mode" value={MODE_LABEL[format.shootingMode]} size={size} accent label="Shooting mode" />
        ) : (
          <>
            <TopReadout sheet="format" value={formatChip(format.resolution, format.fps)} size={size} label="Recording format" />
            <TopReadout sheet="color" value={COLOR_LABEL[format.colorMode]} size={size} label="Color mode" />
            {layout.viewport.width >= 800 ? (
              <TopReadout sheet="mode" value={MODE_LABEL[format.shootingMode]} size={size} accent label="Shooting mode" />
            ) : null}
          </>
        )}
        <ThermalBadge />
      </View>
      <View style={{ flex: 1, minWidth: 24 }} />
      {!photo ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: layout.recordingReadoutTrailingInset }}
        >
          <RecordingReadout />
          <MonitorClock size={tablet ? 25 : 23} />
        </View>
      ) : null}
    </View>
  );
}
