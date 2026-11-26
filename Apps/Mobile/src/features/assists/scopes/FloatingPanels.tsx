import { useCamera } from '@/camera';
import { SCOPE_BASE_SIZE, falseColorReference, middleGrayPaperIRE, transferLabel, type Insets, type Point, type Rect, type Size } from '@/core/media';
import { useScopeBundle } from '@/features/picture/frameSample';
import { useAssists, useSourceTransfer, type AssistContext, type AssistTool } from '@/state/assists';
import type { DemoScene, PictureEffects } from '@modules/opc-native/src/types';
import { AudioMeter, FALSE_COLOR_LEGEND_SIZE, FalseColorLegend, NDChip, TrafficLightsMeter, useAudioBallistics } from '../overlays/Meters';
import { MovableScopePanel } from './MovableScopePanel';
import { HistogramFrame, ParadeLanes, VectorscopeGraticule, WaveformGuides } from './ScopeGraticule';
import { ScopePlate } from './ScopePlate';
import ScopeTraces from './ScopeTraces';

export interface FloatingPanelsProps {
  context: AssistContext;
  canvas: Rect;
  clearance?: Partial<Insets>;
  obstacles?: Rect[];
  effects: PictureEffects;
  sessionId: string | null;
  demoScene: DemoScene | null;
  colorModeOverride?: Parameters<typeof useSourceTransfer>[0];
  enabled?: boolean;
}

/** Default resting spots so panels a fresh operator turns on do not stack. */
const at =
  (fx: number, fy: number) =>
  (b: Rect, s: Size): Point => ({
    x: b.x + s.width / 2 + fx * Math.max(0, b.width - s.width),
    y: b.y + s.height / 2 + fy * Math.max(0, b.height - s.height),
  });

const DEFAULTS = {
  waveform: at(0.02, 0.92),
  parade: at(0.98, 0.92),
  histogram: at(0.98, 0.04),
  vectorscope: at(0.02, 0.1),
  trafficLights: at(0.98, 0.5),
  ndMeter: at(0.5, 0.04),
  audio: at(0.86, 0.5),
  falseColorLegend: at(0.5, 0.96),
};

/** WAVE / PARADE / HISTO / VECTOR / LIGHTS / ND / AUDIO / false colour key panels. */
export function FloatingPanels({ context, canvas, clearance, obstacles, effects, sessionId, demoScene, colorModeOverride, enabled = true }: FloatingPanelsProps) {
  const on = useAssists((s) => (context === 'live' ? s.on : s.playbackOn));
  const options = useAssists((s) => s.options);
  const openInspector = useAssists((s) => s.openInspector);
  const { transfer, clipByte } = useSourceTransfer(colorModeOverride);
  const needsSample = on.WAVE || on.PARADE || on.HISTO || on.VECTOR || on.LIGHTS || on.ND || on.EV;
  const bundle = useScopeBundle(context, transfer, clipByte, options.crushClip, needsSample);
  const common = { canvas, clearance, obstacles, enabled };
  const open = (t: AssistTool) => () => openInspector(t, context);
  const traces = { bundle, effects, sessionId, demoScene };

  return (
    <>
      {on.WAVE ? (
        <MovableScopePanel id="waveform" baseSize={SCOPE_BASE_SIZE.waveform} defaultCenter={DEFAULTS.waveform} onOpenOptions={open('WAVE')} accessibilityLabel="Waveform" {...common}>
          {(s) => (
            <ScopePlate title="Wave" chip={options.waveform.mode.toUpperCase()} width={s.width} height={s.height}>
              <ScopeTraces kind="waveform" width={s.width} height={s.height} mode={options.waveform.mode} brightness={options.waveform.brightness} {...traces} />
              <WaveformGuides width={s.width} height={s.height} guides={options.waveform.guides} middleGrayIRE={middleGrayPaperIRE(transfer)} />
            </ScopePlate>
          )}
        </MovableScopePanel>
      ) : null}
      {on.PARADE ? (
        <MovableScopePanel id="parade" baseSize={SCOPE_BASE_SIZE.parade} defaultCenter={DEFAULTS.parade} onOpenOptions={open('PARADE')} accessibilityLabel="RGB Parade" {...common}>
          {(s) => (
            <ScopePlate title="Parade" chip={options.parade.mode} width={s.width} height={s.height}>
              <ScopeTraces kind="parade" width={s.width} height={s.height} mode={options.parade.mode} brightness={options.parade.brightness} {...traces} />
              <ParadeLanes width={s.width} height={s.height} lanes={options.parade.mode === 'YRGB' ? 4 : 3} />
              <WaveformGuides width={s.width} height={s.height} guides={options.parade.guides} middleGrayIRE={middleGrayPaperIRE(transfer)} />
            </ScopePlate>
          )}
        </MovableScopePanel>
      ) : null}
      {on.HISTO ? (
        <MovableScopePanel id="histogram" baseSize={SCOPE_BASE_SIZE.histogram} defaultCenter={DEFAULTS.histogram} onOpenOptions={open('HISTO')} accessibilityLabel="Histogram" {...common}>
          {(s) => (
            <ScopePlate title="Histo" chip="RGBL" width={s.width} height={s.height}>
              <ScopeTraces kind="histogram" width={s.width} height={s.height} brightness={100} lamps={options.histogram.trafficLights} {...traces} />
              <HistogramFrame width={s.width} height={s.height} lamps={options.histogram.trafficLights} traffic={bundle?.traffic ?? null} />
            </ScopePlate>
          )}
        </MovableScopePanel>
      ) : null}
      {on.VECTOR ? (
        <MovableScopePanel id="vectorscope" baseSize={SCOPE_BASE_SIZE.vectorscope} defaultCenter={DEFAULTS.vectorscope} onOpenOptions={open('VECTOR')} accessibilityLabel="Vectorscope" {...common}>
          {(s) => (
            <ScopePlate title="Vector" chip={`MON · ${options.vectorscope.zoom.toUpperCase()}`} width={s.width} height={s.height}>
              <VectorscopeGraticule width={s.width} height={s.height} />
              <ScopeTraces kind="vectorscope" width={s.width} height={s.height} zoom={options.vectorscope.zoom} brightness={options.vectorscope.brightness} {...traces} />
            </ScopePlate>
          )}
        </MovableScopePanel>
      ) : null}
      {on.LIGHTS ? (
        <MovableScopePanel id="trafficLights" baseSize={SCOPE_BASE_SIZE.trafficLights} defaultCenter={DEFAULTS.trafficLights} onOpenOptions={open('LIGHTS')} accessibilityLabel="Traffic Lights" {...common}>
          {(s) => <TrafficLightsMeter reading={bundle?.traffic ?? null} width={s.width} height={s.height} />}
        </MovableScopePanel>
      ) : null}
      {on.ND ? (
        <MovableScopePanel id="ndMeter" baseSize={SCOPE_BASE_SIZE.ndMeter} defaultCenter={DEFAULTS.ndMeter} resizable={false} fixedScale={1} onOpenOptions={open('ND')} accessibilityLabel="ND Suggestion" {...common}>
          {(s) => <NDChip reading={bundle?.nd ?? null} notation={options.nd.notation} width={s.width} height={s.height} />}
        </MovableScopePanel>
      ) : null}
      {on.AUDIO && context === 'live' ? (
        <MovableScopePanel
          id="audio"
          baseSize={options.audio.orientation === 'Vertical' ? SCOPE_BASE_SIZE.audio : { width: SCOPE_BASE_SIZE.audio.height, height: SCOPE_BASE_SIZE.audio.width }}
          defaultCenter={DEFAULTS.audio}
          resizable={false}
          fixedScale={1}
          onOpenOptions={open('AUDIO')}
          accessibilityLabel="Audio Levels"
          {...common}
        >
          {(s) => <LiveAudioMeter orientation={options.audio.orientation} showDB={options.audio.showDB} width={s.width} height={s.height} />}
        </MovableScopePanel>
      ) : null}
      {on.FALSE && options.falseColor.reference ? (
        <MovableScopePanel
          id="falseColorLegend"
          baseSize={FALSE_COLOR_LEGEND_SIZE}
          defaultCenter={DEFAULTS.falseColorLegend}
          resizable={false}
          fixedScale={1}
          onOpenOptions={open('FALSE')}
          accessibilityLabel="False color reference"
          {...common}
        >
          {() => <FalseColorLegend reference={falseColorReference(options.falseColor.mode, transfer, clipByte, transferLabel(transfer))} />}
        </MovableScopePanel>
      ) : null}
    </>
  );
}

/** Camera audio through the meter ballistics; owns its 20 Hz tick so only the meter re-renders. */
function LiveAudioMeter(props: { orientation: 'Vertical' | 'Horizontal'; showDB: boolean; width: number; height: number }) {
  const audio = useCamera((s) => s.audio);
  const levels = useAudioBallistics(audio);
  return <AudioMeter left={levels.left} right={levels.right} {...props} />;
}
