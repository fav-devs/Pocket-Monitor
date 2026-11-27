import { useEffect, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useCamera, useCameraSession, type CameraState } from '@/camera';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { COLOR_LABEL, MODE_LABEL, WB_PRESET_LABEL, isPhotoMode } from '../format';
import { useLiveUi, type CameraTab, type CaptureSheetId } from '../liveUiStore';
import { ChoiceChips, FieldLabel, Hint, ModeBar, StepperRow, ToggleRow } from './controls';
import { MonitorValueDrum } from './MonitorValueDrum';

export const nearestIndex = (options: number[], value: number | null | undefined) => {
  if (value == null || options.length === 0) return 0;
  let best = 0;
  options.forEach((o, i) => {
    if (Math.abs(o - value) < Math.abs(options[best] - value)) best = i;
  });
  return best;
};

/** Run a camera write; a refusal must not become an unhandled rejection. */
export function useWrite() {
  return (p: Promise<unknown>) => {
    p.catch(() => {});
  };
}

export function Stack({ children, gap = spacing.md - 4 }: { children: ReactNode; gap?: number }) {
  return <View style={{ gap }}>{children}</View>;
}

const WB_PRESETS = ['daylight', 'cloudy', 'incandescent', 'fluorescent'] as const;

/** White balance: Auto, presets, or kelvin with G–M tint (the old WB sheet). */
export function WbControls({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const wb = s.whiteBalance;
  const tab = wb.preset === 'auto' ? 0 : wb.preset === 'custom' ? 2 : 1;
  const kelvins: number[] = [];
  for (let k = wb.kelvinMin; k <= wb.kelvinMax; k += wb.kelvinStep) kelvins.push(k);
  const tint = wb.tint ?? 0;
  return (
    <Stack>
      <ModeBar
        accessibilityLabel="White balance mode"
        tabs={['Auto', 'Preset', 'Kelvin']}
        selected={tab}
        onSelect={(i) =>
          write(
            i === 0
              ? control.setWhiteBalance({ preset: 'auto' })
              : i === 1
                ? control.setWhiteBalance({ preset: 'daylight' })
                : control.setWhiteBalance({ kelvin: wb.kelvin ?? 5600 }),
          )
        }
      />
      {tab === 2 ? (
        <>
          <MonitorValueDrum
            accessibilityLabel="Colour temperature"
            options={kelvins.map((k) => `${k}K`)}
            index={nearestIndex(kelvins, wb.kelvin)}
            onChange={(i) => write(control.setWhiteBalance({ kelvin: kelvins[i] }))}
          />
          <StepperRow
            title="Tint G–M"
            value={tint > 0 ? `+${tint}` : String(tint)}
            minusLabel="Tint toward green"
            plusLabel="Tint toward magenta"
            minusDisabled={tint <= wb.tintMin}
            plusDisabled={tint >= wb.tintMax}
            onMinus={() => write(control.setWhiteBalance({ tint: Math.max(wb.tintMin, tint - 1) }))}
            onPlus={() => write(control.setWhiteBalance({ tint: Math.min(wb.tintMax, tint + 1) }))}
          />
        </>
      ) : tab === 1 ? (
        <ChoiceChips
          options={[...WB_PRESETS]}
          value={wb.preset as (typeof WB_PRESETS)[number]}
          label={(p) => WB_PRESET_LABEL[p]}
          onSelect={(p) => write(control.setWhiteBalance({ preset: p }))}
        />
      ) : null}
    </Stack>
  );
}

const MF_STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

/** Focus mode, and the focus-distance drum in MF. */
export function FocusControls({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const f = s.focus;
  const modes = ['afc', 'afs', 'mf'] as const;
  return (
    <Stack>
      <ModeBar
        accessibilityLabel="Focus mode"
        tabs={['AF-C', 'AF-S', 'MF']}
        selected={modes.indexOf(f.mode)}
        onSelect={(i) => {
          if (modes[i] === 'mf' && !s.capabilities.manualFocus) return;
          write(control.setFocusMode(modes[i]));
        }}
      />
      {f.mode === 'mf' ? (
        <MonitorValueDrum
          accessibilityLabel="Manual focus distance"
          options={MF_STEPS.map((v) => (v === 0 ? 'Near' : v === 1 ? 'Far' : `${Math.round(v * 100)}`))}
          index={nearestIndex(MF_STEPS, f.manualPosition ?? 0.5)}
          onChange={(i) => write(control.setManualFocus(MF_STEPS[i]))}
        />
      ) : null}
    </Stack>
  );
}

function Meter({ label, db }: { label: string; db: number }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const frac = Math.max(0, Math.min(1, (db + 60) / 60));
  const tint = db > -6 ? colors.destructive : db > -18 ? colors.warning : colors.success;
  return (
    <View style={styles.meterRow}>
      <Text style={styles.meterLabel}>{label}</Text>
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${frac * 100}%`, backgroundColor: tint }]} />
      </View>
    </View>
  );
}

/** Meters, channel, directional audio, wind reduction, vocal boost. */
export function AudioControls() {
  const { control } = useCameraSession();
  const write = useWrite();
  const a = useCamera((s) => s.audio);
  const dirs = ['off', 'front', 'rear', 'surround'] as const;
  return (
    <Stack>
      <View style={{ gap: 6 }}>
        <Meter label="L" db={a.left.rmsDb} />
        <Meter label="R" db={a.right.rmsDb} />
      </View>
      <ModeBar
        accessibilityLabel="Channels"
        tabs={['Stereo', 'Mono']}
        selected={a.channel === 'stereo' ? 0 : 1}
        onSelect={(i) => write(control.setAudio({ channel: i === 0 ? 'stereo' : 'mono' }))}
      />
      <FieldLabel>Directional</FieldLabel>
      <ModeBar
        accessibilityLabel="Directional"
        tabs={['Off', 'Front', 'Rear', 'Surround']}
        selected={dirs.indexOf(a.directional)}
        onSelect={(i) => write(control.setAudio({ directional: dirs[i] }))}
      />
      <View>
        <ToggleRow title="Wind reduction" value={a.windReduction} onChange={(v) => write(control.setAudio({ windReduction: v }))} />
        <ToggleRow title="Vocal boost" value={a.vocalBoost} onChange={(v) => write(control.setAudio({ vocalBoost: v }))} />
      </View>
    </Stack>
  );
}

/** `CaptureFormatPicker` + `CaptureCodecColorPanel`: resolution, frame-rate drum, codec, bitrate. */
export function FormatSheet({ s, locked }: { s: CameraState; locked: boolean }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const f = s.format;
  const optIndex = Math.max(0, f.options.findIndex((o) => o.resolution === f.resolution));
  const opt = f.options[optIndex];
  const fpsList = opt?.fps ?? [f.fps];
  const bitrates = ['low', 'normal', 'high'] as const;
  return (
    <Stack>
      <ModeBar
        accessibilityLabel="Resolution"
        tabs={f.options.map((o) => o.resolution)}
        disabled={locked}
        selected={optIndex}
        details={f.options.map((o) => `${o.width}×${o.height}`)}
        onSelect={(i) => {
          const next = f.options[i];
          const fps = next.fps.includes(f.fps) ? f.fps : next.fps[nearestIndex(next.fps, f.fps)];
          write(control.setFormat({ resolution: next.resolution, fps }));
        }}
      />
      <MonitorValueDrum
        accessibilityLabel="Frame rate"
        disabled={locked}
        options={fpsList.map((v) => `${v}p`)}
        index={nearestIndex(fpsList, f.fps)}
        onChange={(i) => write(control.setFormat({ fps: fpsList[i] }))}
      />
      <FieldLabel>Codec{f.bitrate ? ' and bitrate' : ''}</FieldLabel>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <ModeBar
            accessibilityLabel="Codec"
            tabs={['H.264', 'H.265']}
            disabled={locked}
            selected={f.codec === 'h264' ? 0 : 1}
            onSelect={(i) => write(control.setFormat({ codec: i === 0 ? 'h264' : 'h265' }))}
          />
        </View>
        {f.bitrate ? (
          <View style={{ flex: 1.4 }}>
            <ModeBar
              accessibilityLabel="Bitrate"
              tabs={['Low', 'Normal', 'High']}
              disabled={locked}
              selected={bitrates.indexOf(f.bitrate)}
              onSelect={(i) => write(control.setFormat({ bitrate: bitrates[i] }))}
            />
          </View>
        ) : null}
      </View>
    </Stack>
  );
}

export function ColorControls({ s, locked }: { s: CameraState; locked: boolean }) {
  const { control } = useCameraSession();
  const write = useWrite();
  return (
    <ChoiceChips
      options={s.format.colorModeOptions}
      value={s.format.colorMode}
      disabled={locked}
      label={(c) => COLOR_LABEL[c]}
      onSelect={(c) => write(control.setFormat({ colorMode: c }))}
    />
  );
}

export function ModeSheet({ s, locked }: { s: CameraState; locked: boolean }) {
  const { control } = useCameraSession();
  const write = useWrite();
  return (
    <ChoiceChips
      options={s.format.shootingModeOptions}
      value={s.format.shootingMode}
      disabled={locked}
      label={(m) => MODE_LABEL[m]}
      onSelect={(m) => write(control.setShootingMode(m))}
    />
  );
}

/** Which sheet a capture id opens: one exposure panel, one camera settings sheet, format, mode. */
export type CapturePanel = { kind: 'exposure' } | { kind: 'camera'; tab: CameraTab } | { kind: 'format' } | { kind: 'mode' };

export function capturePanelFor(id: CaptureSheetId, cameraTab: CameraTab): CapturePanel {
  switch (id) {
    case 'iso':
    case 'shutter':
    case 'ev':
    case 'exposure':
    case 'aperture':
      return { kind: 'exposure' };
    case 'wb':
    case 'focus':
    case 'color':
      return { kind: 'camera', tab: 'video' };
    case 'audio':
      return { kind: 'camera', tab: 'audio' };
    case 'camera':
      return { kind: 'camera', tab: cameraTab };
    case 'format':
      return { kind: 'format' };
    case 'mode':
      return { kind: 'mode' };
  }
}

/** Sheet titles: short, in the words the readout uses. */
export const CAPTURE_PANEL_TITLES: Record<CapturePanel['kind'], string> = {
  exposure: 'Exposure',
  camera: 'Camera',
  format: 'Recording format',
  mode: 'Shooting mode',
};

/** The format and shooting-mode sheets' bodies (the Sheet itself is the live screen's). */
export function CaptureSheetBody({ id }: { id: 'format' | 'mode' }) {
  const s = useCamera((st) => st);
  const locked = s.recording.recording;
  return (
    <Stack>
      {locked ? <Hint tone="warning">Stop recording to change this.</Hint> : null}
      {id === 'format' ? <FormatSheet s={s} locked={locked} /> : <ModeSheet s={s} locked={locked} />}
    </Stack>
  );
}

/** Retire sheets the camera no longer offers (`CaptureReadoutAdmission`). */
export function useCaptureSheetAdmission() {
  const sheet = useLiveUi((s) => s.captureSheet);
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  const photo = useCamera((s) => isPhotoMode(s.format.shootingMode));
  useEffect(() => {
    if (!sheet) return;
    if (locked) set({ captureSheet: null });
    else if (photo && sheet === 'format') set({ captureSheet: null });
    else if (photo && sheet === 'audio') set({ captureSheet: 'camera', cameraTab: 'video' });
  }, [sheet, locked, photo, set]);
}

function createStyles(colors: ThemeColors) {
  return {
    meterRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 },
    meterLabel: { width: 12, fontFamily: fonts.semibold, fontSize: 11, color: colors.mutedForeground },
    meterTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.surfaceStrong, overflow: 'hidden' as const },
    meterFill: { height: 6, borderRadius: 3 },
  };
}
