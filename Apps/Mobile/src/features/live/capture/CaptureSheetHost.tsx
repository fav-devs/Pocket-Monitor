import { X } from 'lucide-react-native';
import { useEffect, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useCamera, useCameraSession, type CameraState } from '@/camera';
import { MText, colors, withAlpha } from '@/theme';
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
import { capturePopupLayout, type FieldMonitorLayout } from '../layout/fieldMonitorLayout';
import { TOP_EDGE_SHEETS, useLiveUi, type CaptureSheetId } from '../liveUiStore';
import { ChoiceChips, FieldLabel, ModeBar, StepButton, ToggleRow } from './controls';
import { MonitorValueDrum } from './MonitorValueDrum';
import { PanelSurface } from '../chrome/primitives';

const nearestIndex = (options: number[], value: number | null | undefined) => {
  if (value == null || options.length === 0) return 0;
  let best = 0;
  options.forEach((o, i) => {
    if (Math.abs(o - value) < Math.abs(options[best] - value)) best = i;
  });
  return best;
};

/** Run a camera write; a refusal becomes a notice instead of an unhandled rejection. */
function useWrite() {
  return (p: Promise<unknown>) => {
    p.catch(() => {});
  };
}

function Header({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
      <View style={{ flex: 1 }}>
        <MText size={13} weight="semibold" tracking={0.6} uppercase>
          {title}
        </MText>
        {subtitle ? (
          <MText size={11} color={colors.muted} numberOfLines={1}>
            {subtitle}
          </MText>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        hitSlop={8}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -10 }}
      >
        <X size={18} color={colors.secondary} />
      </Pressable>
    </View>
  );
}

function IsoSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const e = s.exposure;
  const limits = e.isoLimitOptions ?? e.isoOptions;
  return (
    <View style={{ gap: 8 }}>
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
      <ModeBar
        tabs={['Auto', 'Manual']}
        selected={e.isoAuto ? 0 : 1}
        details={[e.isoAuto && e.iso != null ? String(e.iso) : undefined, undefined]}
        onSelect={(i) => write(i === 0 ? control.setIso('auto') : control.setIso(e.iso ?? 400))}
      />
    </View>
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
    <View style={{ gap: 8 }}>
      <MonitorValueDrum
        accessibilityLabel="Shutter"
        options={e.shutterOptions.map((d) => (useAngle ? shutterAngleLabel(d, s.format.fps) : shutterLabel(d)))}
        index={nearestIndex(e.shutterOptions, e.shutterDenom)}
        onChange={(i) => write(control.setShutter(e.shutterOptions[i]))}
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {!photo ? (
          <View style={{ flex: 1 }}>
            <ModeBar
              tabs={['Speed', 'Angle']}
              selected={useAngle ? 1 : 0}
              details={[shutterLabel(e.shutterDenom), shutterAngleLabel(e.shutterDenom, s.format.fps)]}
              onSelect={(i) => setPref('shutterUsesAngle', i === 1)}
            />
          </View>
        ) : null}
        <StepButton label="AUTO" active={e.shutterAuto} onPress={() => write(control.setShutter('auto'))} />
      </View>
    </View>
  );
}

function EvSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const e = s.exposure;
  return (
    <View style={{ gap: 8 }}>
      <MonitorValueDrum
        accessibilityLabel="Exposure compensation"
        options={e.evOptions.map(evLabel)}
        index={nearestIndex(e.evOptions, e.ev)}
        onChange={(i) => write(control.setEv(e.evOptions[i]))}
      />
      <MText size={11} color={colors.muted}>
        Auto exposure. The camera chooses shutter{e.shutterDenom ? ` (now ${shutterLabel(e.shutterDenom)})` : ''}.
      </MText>
    </View>
  );
}

function ExposureSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  return (
    <View style={{ gap: 10 }}>
      <ModeBar
        tabs={['Auto', 'Manual']}
        selected={s.exposure.mode === 'auto' ? 0 : 1}
        onSelect={(i) => write(control.setExposureMode(i === 0 ? 'auto' : 'manual'))}
      />
      <MText size={11} color={colors.muted}>
        {s.exposure.mode === 'auto'
          ? 'The camera sets ISO and shutter. Adjust EV to bias brightness.'
          : 'You set ISO and shutter. Exposure stays fixed while you shoot.'}
      </MText>
    </View>
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
    <View style={{ gap: 10 }}>
      {tab === 2 ? (
        <>
          <MonitorValueDrum
            accessibilityLabel="Colour temperature"
            options={kelvins.map((k) => `${k}K`)}
            index={nearestIndex(kelvins, wb.kelvin)}
            onChange={(i) => write(control.setWhiteBalance({ kelvin: kelvins[i] }))}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <MText size={11} weight="semibold" tracking={1} color={colors.muted} style={{ flex: 1 }}>
              TINT
            </MText>
            <StepButton
              label="− G"
              accessibilityLabel="Tint toward green"
              disabled={tint <= wb.tintMin}
              onPress={() => write(control.setWhiteBalance({ tint: Math.max(wb.tintMin, tint - 1) }))}
            />
            <MText size={15} weight="semibold" mono style={{ minWidth: 40, textAlign: 'center' }}>
              {tint > 0 ? `+${tint}` : String(tint)}
            </MText>
            <StepButton
              label="+ M"
              accessibilityLabel="Tint toward magenta"
              disabled={tint >= wb.tintMax}
              onPress={() => write(control.setWhiteBalance({ tint: Math.min(wb.tintMax, tint + 1) }))}
            />
          </View>
        </>
      ) : tab === 1 ? (
        <ChoiceChips
          options={[...WB_PRESETS]}
          value={wb.preset as (typeof WB_PRESETS)[number]}
          label={(p) => WB_PRESET_LABEL[p]}
          onSelect={(p) => write(control.setWhiteBalance({ preset: p }))}
        />
      ) : (
        <MText size={11} color={colors.muted}>
          Auto white balance{wb.kelvin ? ` (measuring about ${wb.kelvin}K)` : ''}.
        </MText>
      )}
      <ModeBar
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
    </View>
  );
}

const MF_STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

function FocusSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const f = s.focus;
  const modes = ['afc', 'afs', 'mf'] as const;
  return (
    <View style={{ gap: 10 }}>
      {f.mode === 'mf' ? (
        <MonitorValueDrum
          accessibilityLabel="Manual focus distance"
          options={MF_STEPS.map((v) => (v === 0 ? 'Near' : v === 1 ? 'Far' : `${Math.round(v * 100)}`))}
          index={nearestIndex(MF_STEPS, f.manualPosition ?? 0.5)}
          onChange={(i) => write(control.setManualFocus(MF_STEPS[i]))}
        />
      ) : (
        <MText size={11} color={colors.muted}>
          {f.mode === 'afc' ? 'Continuous autofocus follows the subject.' : 'Single autofocus locks on a tap.'} Tap the picture
          to set the focus point.
        </MText>
      )}
      <ModeBar
        tabs={['AF-C', 'AF-S', 'MF']}
        uppercase={false}
        selected={modes.indexOf(f.mode)}
        onSelect={(i) => {
          if (modes[i] === 'mf' && !s.capabilities.manualFocus) return;
          write(control.setFocusMode(modes[i]));
        }}
      />
    </View>
  );
}

function ApertureSheet({ s }: { s: CameraState }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const options = s.exposure.apertureOptions ?? [];
  if (options.length === 0) {
    return (
      <MText size={11} color={colors.muted}>
        This camera reports no iris stops.
      </MText>
    );
  }
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
  const frac = Math.max(0, Math.min(1, (db + 60) / 60));
  const tint = db > -6 ? colors.recording : db > -18 ? colors.digitalCrop : colors.linkStable;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <MText size={10} weight="semibold" color={colors.muted} style={{ width: 10 }}>
        {label}
      </MText>
      <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: withAlpha('#FFFFFF', 0.1), overflow: 'hidden' }}>
        <View style={{ width: `${frac * 100}%`, height: 6, backgroundColor: tint }} />
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
    <View style={{ gap: 8 }}>
      <Meter label="L" db={a.left.rmsDb} />
      <Meter label="R" db={a.right.rmsDb} />
      <ModeBar
        tabs={['Stereo', 'Mono']}
        selected={a.channel === 'stereo' ? 0 : 1}
        onSelect={(i) => write(control.setAudio({ channel: i === 0 ? 'stereo' : 'mono' }))}
      />
      <FieldLabel>Directional</FieldLabel>
      <ModeBar tabs={['Off', 'Front', 'Rear', 'Surround']} selected={dirs.indexOf(a.directional)} onSelect={(i) => write(control.setAudio({ directional: dirs[i] }))} />
      <ToggleRow title="Wind reduction" value={a.windReduction} onChange={(v) => write(control.setAudio({ windReduction: v }))} />
      <ToggleRow title="Vocal boost" value={a.vocalBoost} onChange={(v) => write(control.setAudio({ vocalBoost: v }))} />
    </View>
  );
}

/** `CaptureFormatPicker` + `CaptureCodecColorPanel`: resolution tabs, fps drum, codec, bitrate. */
function FormatSheet({ s, locked }: { s: CameraState; locked: boolean }) {
  const { control } = useCameraSession();
  const write = useWrite();
  const f = s.format;
  const optIndex = Math.max(0, f.options.findIndex((o) => o.resolution === f.resolution));
  const opt = f.options[optIndex];
  const fpsList = opt?.fps ?? [f.fps];
  const bitrates = ['low', 'normal', 'high'] as const;
  return (
    <View style={{ gap: 8 }}>
      <MonitorValueDrum
        accessibilityLabel="Frame rate"
        disabled={locked}
        options={fpsList.map((v) => `${v}p`)}
        index={nearestIndex(fpsList, f.fps)}
        onChange={(i) => write(control.setFormat({ fps: fpsList[i] }))}
      />
      <ModeBar
        tabs={f.options.map((o) => o.resolution)}
        uppercase={false}
        disabled={locked}
        selected={optIndex}
        details={f.options.map((o) => `${o.width}×${o.height}`)}
        onSelect={(i) => {
          const next = f.options[i];
          const fps = next.fps.includes(f.fps) ? f.fps : next.fps[nearestIndex(next.fps, f.fps)];
          write(control.setFormat({ resolution: next.resolution, fps }));
        }}
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <ModeBar
            tabs={['H.264', 'H.265']}
            uppercase={false}
            disabled={locked}
            selected={f.codec === 'h264' ? 0 : 1}
            onSelect={(i) => write(control.setFormat({ codec: i === 0 ? 'h264' : 'h265' }))}
          />
        </View>
        {f.bitrate ? (
          <View style={{ flex: 1.4 }}>
            <ModeBar
              tabs={['Low', 'Normal', 'High']}
              disabled={locked}
              selected={bitrates.indexOf(f.bitrate)}
              onSelect={(i) => write(control.setFormat({ bitrate: bitrates[i] }))}
            />
          </View>
        ) : null}
      </View>
    </View>
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

const TITLES: Record<CaptureSheetId, [string, string?]> = {
  iso: ['ISO', 'Sensor gain'],
  shutter: ['Shutter', 'Exposure time per frame'],
  ev: ['EV', 'Exposure compensation'],
  exposure: ['Exposure', 'Program'],
  wb: ['White balance'],
  focus: ['Focus'],
  aperture: ['Aperture'],
  audio: ['Audio', 'Camera microphones'],
  format: ['Recording format', 'Resolution, frame rate and codec'],
  color: ['Color', 'Picture profile'],
  mode: ['Mode', 'Shooting mode'],
};

function SheetBody({ id }: { id: CaptureSheetId }) {
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
    <>
      {formatLocked ? (
        <MText size={11} weight="medium" color={colors.digitalCrop} style={{ marginBottom: 6 }}>
          Stop recording to change this.
        </MText>
      ) : null}
      {body}
    </>
  );
}

/**
 * `CaptureSheetHost`: the open capture drawer. Camera values hang from a bottom-centre well,
 * format / colour / mode from a top-centre well (`MonitorCapturePopupLayout`).
 */
export function CaptureSheetHost({ layout }: { layout: FieldMonitorLayout }) {
  const sheet = useLiveUi((s) => s.captureSheet);
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  const photo = useCamera((s) => isPhotoMode(s.format.shootingMode));
  const auto = useCamera((s) => s.exposure.mode === 'auto');

  // Retire sheets the strip no longer offers (`CaptureReadoutAdmission`).
  useEffect(() => {
    if (!sheet) return;
    if (locked) set({ captureSheet: null });
    else if (photo && (sheet === 'audio' || sheet === 'format' || sheet === 'color')) set({ captureSheet: null });
    else if (auto && sheet === 'shutter') set({ captureSheet: 'ev' });
    else if (!auto && sheet === 'ev') set({ captureSheet: 'shutter' });
  }, [sheet, locked, photo, auto, set]);

  if (!sheet) return null;
  const edge = TOP_EDGE_SHEETS.includes(sheet) ? 'top' : 'bottom';
  const pop = capturePopupLayout(layout.viewport, layout.tablet, layout.safeArea, edge, {
    bottomBoundary: layout.portrait ? layout.system.y - 4 : layout.viewport.height,
    topBoundary: layout.portrait ? layout.status.y + layout.status.height + 8 : 0,
  });
  const close = () => set({ captureSheet: null });
  const [title, subtitle] = TITLES[sheet];
  const placement =
    edge === 'bottom'
      ? { bottom: layout.viewport.height - pop.bottom, maxHeight: pop.maximumHeight }
      : { top: pop.top, maxHeight: pop.maximumHeight };

  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
      <Pressable accessibilityLabel="Close drawer" onPress={close} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} />
      <PanelSurface
        style={{
          position: 'absolute',
          left: pop.centerX - pop.width / 2,
          width: pop.width,
          ...placement,
          borderTopLeftRadius: pop.topRadius,
          borderTopRightRadius: pop.topRadius,
          borderBottomLeftRadius: pop.bottomRadius,
          borderBottomRightRadius: pop.bottomRadius,
        }}
      >
        <ScrollView
          bounces={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: pop.topPadding, paddingBottom: pop.bottomPadding }}
        >
          <Header title={title} subtitle={subtitle} onClose={close} />
          <SheetBody id={sheet} />
        </ScrollView>
      </PanelSurface>
    </View>
  );
}
