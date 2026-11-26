import { useEffect, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useCamera, useCameraSession, type CameraState } from '@/camera';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { usePreferences } from '@/state/preferences';
import {
  COLOR_LABEL,
  MODE_LABEL,
  WB_PRESET_LABEL,
  apertureLabel,
  evLabel,
  isPhotoMode,
  shutterAngleLabel,
  shutterLabel,
} from '../format';
import { useLiveUi, type CaptureSheetId } from '../liveUiStore';
import { ChoiceChips, FieldLabel, Hint, ModeBar, StepButton, StepperRow, ToggleRow } from './controls';
import { MonitorValueDrum } from './MonitorValueDrum';

const nearestIndex = (options: number[], value: number | null | undefined) => {
  if (value == null || options.length === 0) return 0;
  let best = 0;
  options.forEach((o, i) => {
    if (Math.abs(o - value) < Math.abs(options[best] - value)) best = i;
  });
  return best;
};

/** Run a camera write; a refusal must not become an unhandled rejection. */
function useWrite() {
  return (p: Promise<unknown>) => {
    p.catch(() => {});
  };
}

function Stack({ children, gap = spacing.md - 4 }: { children: ReactNode; gap?: number }) {
  return <View style={{ gap }}>{children}</View>;
}

function IsoSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const e = s.exposure;
  const limits = e.isoLimitOptions ?? e.isoOptions;
  return (
    <Stack>
      <ModeBar
        accessibilityLabel="ISO mode"
        tabs={['Auto', 'Manual']}
        selected={e.isoAuto ? 0 : 1}
        details={[e.isoAuto && e.iso != null ? String(e.iso) : undefined, undefined]}
        onSelect={(i) => write(i === 0 ? control.setIso('auto') : control.setIso(e.iso ?? 400))}
      />
      {e.isoAuto ? (
        <>
          <FieldLabel>Auto ISO limit</FieldLabel>
          <MonitorValueDrum
            accessibilityLabel="Maximum ISO"
            options={limits.map(String)}
            index={nearestIndex(limits, e.isoLimit ?? limits[limits.length - 1])}
            onChange={(i) => write(control.setIsoLimit(limits[i]))}
          />
        </>
      ) : (
        <MonitorValueDrum
          accessibilityLabel="ISO"
          options={e.isoOptions.map(String)}
          index={nearestIndex(e.isoOptions, e.iso)}
          onChange={(i) => write(control.setIso(e.isoOptions[i]))}
        />
      )}
    </Stack>
  );
}

function ShutterSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const angle = usePreferences((p) => !!p.shutterUsesAngle);
  const setPref = usePreferences((p) => p.set);
  const e = s.exposure;
  const photo = isPhotoMode(s.format.shootingMode);
  const useAngle = angle && !photo;
  return (
    <Stack>
      <MonitorValueDrum
        accessibilityLabel="Shutter"
        options={e.shutterOptions.map((d) => (useAngle ? shutterAngleLabel(d, s.format.fps) : shutterLabel(d)))}
        index={nearestIndex(e.shutterOptions, e.shutterDenom)}
        onChange={(i) => write(control.setShutter(e.shutterOptions[i]))}
      />
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        {!photo ? (
          <View style={{ flex: 1 }}>
            <ModeBar
              accessibilityLabel="Shutter display"
              tabs={['Speed', 'Angle']}
              selected={useAngle ? 1 : 0}
              details={[shutterLabel(e.shutterDenom), shutterAngleLabel(e.shutterDenom, s.format.fps)]}
              onSelect={(i) => setPref('shutterUsesAngle', i === 1)}
            />
          </View>
        ) : null}
        <StepButton label="Auto" accessibilityLabel="Auto shutter" active={e.shutterAuto} onPress={() => write(control.setShutter('auto'))} />
      </View>
    </Stack>
  );
}

function EvSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const e = s.exposure;
  return (
    <Stack>
      <MonitorValueDrum
        accessibilityLabel="Exposure compensation"
        options={e.evOptions.map(evLabel)}
        index={nearestIndex(e.evOptions, e.ev)}
        onChange={(i) => write(control.setEv(e.evOptions[i]))}
      />
      <Hint>Auto exposure. The camera picks the shutter{e.shutterDenom ? ` (now ${shutterLabel(e.shutterDenom)})` : ''}.</Hint>
    </Stack>
  );
}

function ExposureSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  return (
    <Stack>
      <ModeBar
        accessibilityLabel="Exposure program"
        tabs={['Auto', 'Manual']}
        selected={s.exposure.mode === 'auto' ? 0 : 1}
        onSelect={(i) => write(control.setExposureMode(i === 0 ? 'auto' : 'manual'))}
      />
      <Hint>
        {s.exposure.mode === 'auto' ? 'The camera sets ISO and shutter. EV biases brightness.' : 'You set ISO and shutter. Exposure stays fixed while you shoot.'}
      </Hint>
    </Stack>
  );
}

const WB_PRESETS = ['daylight', 'cloudy', 'incandescent', 'fluorescent'] as const;

function WbSheet({ s }: { s: CameraState }) {
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
            title="Tint"
            value={tint > 0 ? `+${tint}` : String(tint)}
            minusLabel="Tint toward green"
            plusLabel="Tint toward magenta"
            minusDisabled={tint <= wb.tintMin}
            plusDisabled={tint >= wb.tintMax}
            onMinus={() => write(control.setWhiteBalance({ tint: Math.max(wb.tintMin, tint - 1) }))}
            onPlus={() => write(control.setWhiteBalance({ tint: Math.min(wb.tintMax, tint + 1) }))}
            detail="− green · + magenta"
          />
        </>
      ) : tab === 1 ? (
        <ChoiceChips
          options={[...WB_PRESETS]}
          value={wb.preset as (typeof WB_PRESETS)[number]}
          label={(p) => WB_PRESET_LABEL[p]}
          onSelect={(p) => write(control.setWhiteBalance({ preset: p }))}
        />
      ) : (
        <Hint>Auto white balance{wb.kelvin ? `, measuring about ${wb.kelvin}K` : ''}.</Hint>
      )}
    </Stack>
  );
}

const MF_STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

function FocusSheet({ s }: { s: CameraState }) {
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
      ) : (
        <Hint>{f.mode === 'afc' ? 'Continuous AF follows the subject.' : 'Single AF locks on a tap.'} Tap the picture to set the point.</Hint>
      )}
    </Stack>
  );
}

function ApertureSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const options = s.exposure.apertureOptions ?? [];
  if (options.length === 0) return <Hint>This camera reports no iris stops.</Hint>;
  return (
    <MonitorValueDrum
      accessibilityLabel="Aperture"
      options={options.map((f) => apertureLabel(f))}
      index={nearestIndex(options, s.exposure.aperture)}
      onChange={(i) => write(control.setAperture(options[i]))}
    />
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

function AudioSheet() {
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
function FormatSheet({ s, locked }: { s: CameraState; locked: boolean }) {
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

function ColorSheet({ s, locked }: { s: CameraState; locked: boolean }) {
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

function ModeSheet({ s, locked }: { s: CameraState; locked: boolean }) {
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

/** Sheet titles: short, in the words the strip uses. */
export const CAPTURE_TITLES: Record<CaptureSheetId, string> = {
  iso: 'ISO',
  shutter: 'Shutter',
  ev: 'Exposure compensation',
  exposure: 'Exposure',
  wb: 'White balance',
  focus: 'Focus',
  aperture: 'Aperture',
  audio: 'Audio',
  format: 'Recording format',
  color: 'Color',
  mode: 'Shooting mode',
};

/** The open capture sheet's controls (the Sheet itself is the live screen's). */
export function CaptureSheetBody({ id }: { id: CaptureSheetId }) {
  const s = useCamera((st) => st);
  const recording = s.recording.recording;
  const formatLocked = recording && (id === 'format' || id === 'color' || id === 'mode');
  let body: ReactNode = null;
  switch (id) {
    case 'iso':
      body = <IsoSheet s={s} />;
      break;
    case 'shutter':
      body = <ShutterSheet s={s} />;
      break;
    case 'ev':
      body = <EvSheet s={s} />;
      break;
    case 'exposure':
      body = <ExposureSheet s={s} />;
      break;
    case 'wb':
      body = <WbSheet s={s} />;
      break;
    case 'focus':
      body = <FocusSheet s={s} />;
      break;
    case 'aperture':
      body = <ApertureSheet s={s} />;
      break;
    case 'audio':
      body = <AudioSheet />;
      break;
    case 'format':
      body = <FormatSheet s={s} locked={formatLocked} />;
      break;
    case 'color':
      body = <ColorSheet s={s} locked={formatLocked} />;
      break;
    case 'mode':
      body = <ModeSheet s={s} locked={formatLocked} />;
      break;
  }
  return (
    <Stack>
      {formatLocked ? <Hint tone="warning">Stop recording to change this.</Hint> : null}
      {body}
    </Stack>
  );
}

/** Retire sheets the strip no longer offers (`CaptureReadoutAdmission`). */
export function useCaptureSheetAdmission() {
  const sheet = useLiveUi((s) => s.captureSheet);
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  const photo = useCamera((s) => isPhotoMode(s.format.shootingMode));
  const auto = useCamera((s) => s.exposure.mode === 'auto');
  useEffect(() => {
    if (!sheet) return;
    if (locked) set({ captureSheet: null });
    else if (photo && (sheet === 'audio' || sheet === 'format' || sheet === 'color')) set({ captureSheet: null });
    else if (auto && sheet === 'shutter') set({ captureSheet: 'ev' });
    else if (!auto && sheet === 'ev') set({ captureSheet: 'shutter' });
  }, [sheet, locked, photo, auto, set]);
}

function createStyles(colors: ThemeColors) {
  return {
    meterRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 },
    meterLabel: { width: 12, fontFamily: fonts.semibold, fontSize: 11, color: colors.mutedForeground },
    meterTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.surfaceStrong, overflow: 'hidden' as const },
    meterFill: { height: 6, borderRadius: 3 },
  };
}
