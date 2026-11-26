import type { DesktopScopeFrame, DesktopScopePlates } from '@/camera/desktop/picture';
import {
  TRAFFIC_NONE,
  VECTOR_GAIN,
  boxBlur,
  crushClipThreshold,
  evLabel,
  opticalFactor,
  sampleRGBA,
  type HistogramDisplay,
  type MonitorTransfer,
  type NDSuggestion,
  type ScopeSamples,
  type TrafficLightsReading,
} from '@/core/media';
import type { ScopeBundle } from '@/features/picture/frameSample';
import type { AssistOptions, AssistTool } from '@/state/assists';

/**
 * The desktop scope source: the same `ScopeBundle` the web's frame sample produces, built from
 * the Rust scope thread's `scope://samples` instead (`@/camera/desktop/picture`). Rust does the
 * reading and everything that needs the core (the level table, the lamps, the ND / EV
 * reading); this only blends the histogram the way the phones do and keeps the previous tick
 * for the trails. The grids ride along as `desktop`, which `DesktopScopeTraces` draws.
 */
export interface DesktopScopeBundle extends ScopeBundle {
  desktop: DesktopScopeFrame;
  /** The previous tick, drawn as a decayed trail. */
  desktopTrail: DesktopScopeFrame | null;
}

/** The desktop bundle inside a `ScopeBundle`, if it is one. */
export function desktopFrameOf(bundle: ScopeBundle | null | undefined): DesktopScopeBundle | null {
  return bundle && 'desktop' in bundle ? (bundle as DesktopScopeBundle) : null;
}

/** What the floating panels need, from the assist switches and options. */
export function platesFor(on: Record<AssistTool, boolean>, options: AssistOptions): DesktopScopePlates {
  return {
    waveform: on.WAVE ? options.waveform.mode : null,
    parade: on.PARADE ? options.parade.mode : null,
    histogram: !!on.HISTO,
    vectorscope: on.VECTOR ? VECTOR_GAIN[options.vectorscope.zoom] : null,
    lights: !!on.LIGHTS || (!!on.HISTO && options.histogram.trafficLights),
    lightsThreshold: crushClipThreshold(options.crushClip),
    nd: !!on.ND || !!on.EV,
  };
}

const emptySamples = new Map<MonitorTransfer, ScopeSamples>();
function noSamples(transfer: MonitorTransfer): ScopeSamples {
  let s = emptySamples.get(transfer);
  if (!s) emptySamples.set(transfer, (s = sampleRGBA(new Uint8Array(0), 0, 0, transfer)));
  return s;
}

/** IRE-axis buckets → the phones' display: 0.65 / 0.35 with the previous tick, box blur r = 2. */
function histogramChannel(buckets: Uint16Array, previous: Float32Array | null): Float32Array {
  const out = new Float32Array(256);
  for (let i = 0; i < 256; i++) out[i] = buckets[i] ?? 0;
  if (previous && previous.length === 256) for (let i = 0; i < 256; i++) out[i] = 0.65 * out[i] + 0.35 * previous[i];
  return boxBlur(out, 2);
}

function histogramDisplay(frame: DesktopScopeFrame, previous: HistogramDisplay | null): HistogramDisplay {
  const h = frame.histogram;
  if (!h) return previous ?? { luma: new Float32Array(256), red: new Float32Array(256), green: new Float32Array(256), blue: new Float32Array(256) };
  return {
    luma: histogramChannel(h.luma, previous?.luma ?? null),
    red: histogramChannel(h.red, previous?.red ?? null),
    green: histogramChannel(h.green, previous?.green ?? null),
    blue: histogramChannel(h.blue, previous?.blue ?? null),
  };
}

function traffic(frame: DesktopScopeFrame): TrafficLightsReading {
  return frame.lights ?? TRAFFIC_NONE;
}

/** The core's ND reading in the phones' `NDSuggestion` shape. */
export function ndFrom(frame: DesktopScopeFrame, none = '—'): NDSuggestion | null {
  if (frame.pictureStops == null || frame.ndStops == null) return null;
  const ndStops = frame.ndStops;
  const factor = opticalFactor(ndStops);
  return {
    pictureStops: frame.pictureStops,
    ndStops,
    opticalFactor: factor,
    ndLabel: ndStops >= 1 ? `ND${factor}` : none,
    stopsLabel: evLabel(frame.pictureStops),
    needsGlass: ndStops >= 1,
  };
}

/** Builds the bundle for one frame, blending with the previous bundle. */
export function bundleFrom(frame: DesktopScopeFrame, previous: DesktopScopeBundle | null, transfer: MonitorTransfer, clipByte: number): DesktopScopeBundle {
  const sameAxis = !!previous && previous.transfer === transfer && previous.clipByte === clipByte;
  const samples = noSamples(transfer);
  return {
    revision: frame.sequence,
    samples,
    trail: null,
    vector: samples,
    vectorTrail: null,
    histogram: histogramDisplay(frame, sameAxis ? previous!.histogram : null),
    traffic: traffic(frame),
    nd: ndFrom(frame),
    pictureStops: frame.pictureStops,
    transfer,
    clipByte,
    desktop: frame,
    desktopTrail: sameAxis && previous!.desktop.sequence !== frame.sequence ? previous!.desktop : null,
  };
}
