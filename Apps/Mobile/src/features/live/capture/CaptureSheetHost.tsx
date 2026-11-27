import { MinusSignCircleIcon, PlusSignCircleIcon } from '@hugeicons/core-free-icons';
import { useEffect, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useCamera, useCameraSession, type CameraState, type VideoFormatOption } from '@/camera';
import { monitorPanel as P } from '@/constants/monitor';
import { fonts, spacing, useThemedStyles } from '@/constants/theme';
import { COLOR_LABEL, MODE_LABEL, WB_PRESET_LABEL, isPhotoMode } from '../format';
import { useLiveUi, type CameraTab, type CaptureSheetId } from '../liveUiStore';
import { PanelGrid, PanelHeading, PanelHint, PanelKey, PanelLabel, PanelSegments } from '../panel/kit';
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

/** White balance detail (Mimo's White Balance page): Auto, presets, or kelvin with G–M tint. */
export function WbControls({ s }: { s: CameraState }) {
  const styles = useThemedStyles(createStyles);
  const { control } = useCameraSession();
  const write = useWrite();
  const wb = s.whiteBalance;
  const tab = wb.preset === 'auto' ? 0 : wb.preset === 'custom' ? 2 : 1;
  const kelvins: number[] = [];
  for (let k = wb.kelvinMin; k <= wb.kelvinMax; k += wb.kelvinStep) kelvins.push(k);
  const tint = wb.tint ?? 0;
  return (
    <View>
      <View style={styles.pad}>
        <PanelSegments
          accessibilityLabel="White balance mode"
          options={['Auto', 'Preset', 'Kelvin']}
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
      </View>
      {tab === 2 ? (
        <>
          <PanelLabel>Temperature</PanelLabel>
          <MonitorValueDrum
            tone="panel"
            compact
            accessibilityLabel="Colour temperature"
            options={kelvins.map((k) => `${k}K`)}
            index={nearestIndex(kelvins, wb.kelvin)}
            onChange={(i) => write(control.setWhiteBalance({ kelvin: kelvins[i] }))}
          />
          <PanelLabel>Tint G–M</PanelLabel>
          <View style={styles.stepper}>
            <PanelKey
              icon={MinusSignCircleIcon}
              label="Tint toward green"
              disabled={tint <= wb.tintMin}
              onPress={() => write(control.setWhiteBalance({ tint: Math.max(wb.tintMin, tint - 1) }))}
            />
            <Text style={styles.stepperValue}>{tint > 0 ? `+${tint}` : String(tint)}</Text>
            <PanelKey
              icon={PlusSignCircleIcon}
              label="Tint toward magenta"
              disabled={tint >= wb.tintMax}
              onPress={() => write(control.setWhiteBalance({ tint: Math.min(wb.tintMax, tint + 1) }))}
            />
          </View>
        </>
      ) : tab === 1 ? (
        <PanelGrid
          accessibilityLabel="White balance preset"
          columns={2}
          cells={WB_PRESETS.map((p) => ({
            key: p,
            label: WB_PRESET_LABEL[p],
            chosen: wb.preset === p,
            onPress: () => write(control.setWhiteBalance({ preset: p })),
          }))}
        />
      ) : null}
    </View>
  );
}

const MF_STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

/** The manual-focus distance drum (under the Focus row while in MF). */
export function ManualFocusDrum({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  return (
    <MonitorValueDrum
      tone="panel"
      compact
      accessibilityLabel="Manual focus distance"
      options={MF_STEPS.map((v) => (v === 0 ? 'Near' : v === 1 ? 'Far' : `${Math.round(v * 100)}`))}
      index={nearestIndex(MF_STEPS, s.focus.manualPosition ?? 0.5)}
      onChange={(i) => write(control.setManualFocus(MF_STEPS[i]))}
    />
  );
}

/** Live L / R meters (shown under the audio rows). */
export function AudioMeters() {
  const styles = useThemedStyles(createStyles);
  const a = useCamera((s) => s.audio);
  const meter = (label: string, db: number) => {
    const frac = Math.max(0, Math.min(1, (db + 60) / 60));
    const tint = db > -6 ? '#ff6b6b' : db > -18 ? '#fbbf24' : '#22c55e';
    return (
      <View style={styles.meterRow} key={label}>
        <Text style={styles.meterLabel}>{label}</Text>
        <View style={styles.meterTrack}>
          <View style={[styles.meterFill, { width: `${frac * 100}%`, backgroundColor: tint }]} />
        </View>
      </View>
    );
  };
  return (
    <View accessible accessibilityLabel="Audio levels" style={styles.meters}>
      {meter('L', a.left.rmsDb)}
      {meter('R', a.right.rmsDb)}
    </View>
  );
}

const ASPECT_ORDER: VideoFormatOption['aspect'][] = ['16:9', '4:3', '3:2', '1:1', '9:16'];

/** A resolution cell's label: Mimo's `2160P(1:1)` style for the non-16:9 variants. */
export function resolutionCellLabel(o: VideoFormatOption) {
  return o.aspect === '16:9' ? o.resolution : `${o.resolution} (${o.aspect})`;
}

/**
 * The format panel (Mimo's Resolution + Video Frame Rate): a grid of the resolutions the camera
 * reports, one row per aspect, then the frame-rate drum, codec and bitrate, and colour mode.
 */
export function FormatSheet({ s, locked }: { s: CameraState; locked: boolean }) {
  const styles = useThemedStyles(createStyles);
  const { control } = useCameraSession();
  const write = useWrite();
  const f = s.format;
  const optIndex = Math.max(0, f.options.findIndex((o) => o.resolution === f.resolution));
  const opt = f.options[optIndex];
  const fpsList = opt?.fps ?? [f.fps];
  const bitrates = ['low', 'normal', 'high'] as const;
  // Rows by aspect (16:9 first), each row smallest to largest like Mimo.
  const byAspect = [...f.options].sort(
    (a, b) => ASPECT_ORDER.indexOf(a.aspect) - ASPECT_ORDER.indexOf(b.aspect) || a.width * a.height - b.width * b.height,
  );
  const choose = (next: VideoFormatOption) => {
    const fps = next.fps.includes(f.fps) ? f.fps : next.fps[nearestIndex(next.fps, f.fps)];
    write(control.setFormat({ resolution: next.resolution, fps }));
  };
  return (
    <View testID="monitor.panel.format">
      {locked ? <PanelHint tone="warning">Stop recording to change this.</PanelHint> : null}
      <PanelHeading>Resolution</PanelHeading>
      <PanelGrid
        accessibilityLabel="Resolution"
        disabled={locked}
        columns={3}
        cells={byAspect.map((o) => ({
          key: `${o.resolution}-${o.aspect}`,
          label: resolutionCellLabel(o),
          chosen: o.resolution === f.resolution,
          onPress: () => choose(o),
        }))}
      />
      <View style={styles.gap} />
      <PanelHeading>Frame rate</PanelHeading>
      <MonitorValueDrum
        tone="panel"
        compact
        chosenTint
        accessibilityLabel="Frame rate"
        disabled={locked}
        options={fpsList.map(String)}
        index={nearestIndex(fpsList, f.fps)}
        onChange={(i) => write(control.setFormat({ fps: fpsList[i] }))}
      />
      <PanelHeading>Codec</PanelHeading>
      <View style={styles.pad}>
        <PanelSegments
          accessibilityLabel="Codec"
          options={['H.264', 'H.265']}
          disabled={locked}
          selected={f.codec === 'h264' ? 0 : 1}
          onSelect={(i) => write(control.setFormat({ codec: i === 0 ? 'h264' : 'h265' }))}
        />
      </View>
      {f.bitrate ? (
        <>
          <PanelHeading>Bitrate</PanelHeading>
          <View style={styles.pad}>
            <PanelSegments
              accessibilityLabel="Bitrate"
              options={['Low', 'Normal', 'High']}
              disabled={locked}
              selected={bitrates.indexOf(f.bitrate)}
              onSelect={(i) => write(control.setFormat({ bitrate: bitrates[i] }))}
            />
          </View>
        </>
      ) : null}
      {f.colorModeOptions.length > 0 ? (
        <>
          <PanelHeading>Color</PanelHeading>
          <ColorControls s={s} locked={locked} />
        </>
      ) : null}
    </View>
  );
}

export function ColorControls({ s, locked }: { s: CameraState; locked: boolean }) {
  const { control } = useCameraSession();
  const write = useWrite();
  return (
    <PanelGrid
      accessibilityLabel="Color mode"
      disabled={locked}
      columns={3}
      cells={s.format.colorModeOptions.map((c) => ({
        key: c,
        label: COLOR_LABEL[c],
        chosen: c === s.format.colorMode,
        onPress: () => write(control.setFormat({ colorMode: c })),
      }))}
    />
  );
}

export function ModeSheet({ s, locked }: { s: CameraState; locked: boolean }) {
  const { control } = useCameraSession();
  const write = useWrite();
  return (
    <PanelGrid
      accessibilityLabel="Shooting mode"
      disabled={locked}
      columns={2}
      cells={s.format.shootingModeOptions.map((m) => ({
        key: m,
        label: MODE_LABEL[m],
        chosen: m === s.format.shootingMode,
        onPress: () => write(control.setShootingMode(m)),
      }))}
    />
  );
}

/** Which panel a capture id opens. */
export type CapturePanel =
  | { kind: 'exposure' }
  | { kind: 'camera'; tab: CameraTab }
  | { kind: 'format' }
  | { kind: 'mode' }
  | { kind: 'assists' };

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
    case 'audio':
      return { kind: 'camera', tab: 'camera' };
    case 'camera':
      return { kind: 'camera', tab: cameraTab };
    case 'format':
      return { kind: 'format' };
    case 'mode':
      return { kind: 'mode' };
    case 'assists':
      return { kind: 'assists' };
  }
}

/** Panel titles: short, in the words the readout uses. */
export const CAPTURE_PANEL_TITLES: Record<CapturePanel['kind'], string> = {
  exposure: 'Exposure',
  camera: 'Camera',
  format: 'Recording format',
  mode: 'Shooting mode',
  assists: 'Assists',
};

/** The format and shooting-mode panels' bodies. */
export function CaptureSheetBody({ id }: { id: 'format' | 'mode' }) {
  const s = useCamera((st) => st);
  const locked = s.recording.recording;
  if (id === 'format') return <FormatSheet s={s} locked={locked} />;
  return (
    <View testID="monitor.panel.mode">
      <PanelHeading>Shooting mode</PanelHeading>
      {locked ? <PanelHint tone="warning">Stop recording to change this.</PanelHint> : null}
      <ModeSheet s={s} locked={locked} />
    </View>
  );
}

/** Retire panels the camera no longer offers (`CaptureReadoutAdmission`). */
export function useCaptureSheetAdmission() {
  const sheet = useLiveUi((s) => s.captureSheet);
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  const photo = useCamera((s) => isPhotoMode(s.format.shootingMode));
  useEffect(() => {
    if (!sheet) return;
    if (locked) set({ captureSheet: null });
    else if (photo && sheet === 'format') set({ captureSheet: null });
    else if (photo && sheet === 'audio') set({ captureSheet: 'camera', cameraTab: 'camera' });
  }, [sheet, locked, photo, set]);
}

function createStyles() {
  return {
    pad: { paddingHorizontal: 16, paddingVertical: 6 },
    gap: { height: 6 },
    stepper: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 12 },
    stepperValue: { minWidth: 48, textAlign: 'center' as const, fontFamily: fonts.semibold, fontSize: 17, color: P.text, fontVariant: ['tabular-nums' as const] },
    meters: { gap: 6, paddingHorizontal: 16, paddingVertical: 10 },
    meterRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 },
    meterLabel: { width: 12, fontFamily: fonts.semibold, fontSize: 11, color: P.muted },
    meterTrack: { flex: 1, height: 5, borderRadius: 3, backgroundColor: P.wellStrong, overflow: 'hidden' as const },
    meterFill: { height: 5, borderRadius: 3 },
  };
}
