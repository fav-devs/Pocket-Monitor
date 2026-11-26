import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  LogDisplayTransform,
  crushClipThreshold,
  cubeFrom,
  histogramDisplay,
  mapCube,
  ndReading,
  pictureStops,
  sampleRGBA,
  scopeLevelAxis,
  trafficLights,
  type CrushClipCompensation,
  type CubeLUT,
  type HistogramDisplay,
  type MonitorTransfer,
  type NDSuggestion,
  type ScopeSamples,
  type TrafficLightsReading,
} from '@/core/media';

/**
 * The shared small RGBA tap (`LiveFrameSample` / `ScopeAssistBundle`): one ~192×108 sample of
 * the camera signal (never the monitoring LUT) at ~10 Hz, published by whatever draws the
 * picture (web WebGL renderer, native `OpcVideo.sampleFrame` poll, a playback sampler) and
 * analysed once per tick for every scope and meter.
 */
export interface FrameSample {
  width: number;
  height: number;
  /** Top-down RGBA8 rows. */
  rgba: Uint8Array | Uint8ClampedArray;
  revision: number;
  /** Which picture produced it. */
  context: 'live' | 'playback';
}

export const SAMPLE_WIDTH = 192;
export const SAMPLE_HEIGHT = 108;
export const SAMPLE_INTERVAL_MS = 100;

const latest: Record<'live' | 'playback', FrameSample | null> = { live: null, playback: null };
const listeners = new Set<() => void>();
let revision = 0;
let demand = 0;
const demandListeners = new Set<() => void>();

export function publishFrameSample(s: Omit<FrameSample, 'revision'>) {
  latest[s.context] = { ...s, revision: ++revision };
  for (const l of listeners) l();
}

export function clearFrameSample(context: 'live' | 'playback') {
  latest[context] = null;
  for (const l of listeners) l();
}

export const getFrameSample = (context: 'live' | 'playback') => latest[context];

/** True while any scope / meter is mounted, so renderers only read back when needed. */
export const hasSampleDemand = () => demand > 0;
export function useSampleDemandValue() {
  return useSyncExternalStore(
    (cb) => {
      demandListeners.add(cb);
      return () => demandListeners.delete(cb);
    },
    () => demand > 0,
    () => demand > 0,
  );
}

/** Register demand for samples while mounted and return the latest one. */
export function useFrameSample(context: 'live' | 'playback', enabled = true): FrameSample | null {
  useEffect(() => {
    if (!enabled) return;
    demand++;
    for (const l of demandListeners) l();
    return () => {
      demand--;
      for (const l of demandListeners) l();
    };
  }, [enabled]);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (enabled ? latest[context] : null),
    () => null,
  );
}

// ───────────────────────────── Analysis bundle ─────────────────────────────

export interface ScopeBundle {
  revision: number;
  samples: ScopeSamples;
  /** Previous tick's samples, drawn as a decayed trail. */
  trail: ScopeSamples | null;
  /** Points through the source's display transform for VECTOR (log chroma collapses without it). */
  vector: ScopeSamples;
  vectorTrail: ScopeSamples | null;
  histogram: HistogramDisplay;
  traffic: TrafficLightsReading;
  nd: NDSuggestion | null;
  pictureStops: number | null;
  transfer: MonitorTransfer;
  clipByte: number;
}

const displayCubes = new Map<MonitorTransfer, CubeLUT | null>();
function displayCube(t: MonitorTransfer): CubeLUT | null {
  if (displayCubes.has(t)) return displayCubes.get(t)!;
  const x = new LogDisplayTransform(t);
  const cube = x.isIdentity ? null : cubeFrom(17, (r, g, b) => x.map(r, g, b));
  displayCubes.set(t, cube);
  return cube;
}

function vectorPoints(s: ScopeSamples, transfer: MonitorTransfer): ScopeSamples {
  const cube = displayCube(transfer);
  if (!cube) return s;
  const n = s.count;
  const r = new Uint8Array(n);
  const g = new Uint8Array(n);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = mapCube(cube, s.r[i] / 255, s.g[i] / 255, s.b[i] / 255);
    r[i] = Math.round(Math.min(1, Math.max(0, m[0])) * 255);
    g[i] = Math.round(Math.min(1, Math.max(0, m[1])) * 255);
    b[i] = Math.round(Math.min(1, Math.max(0, m[2])) * 255);
  }
  return { ...s, r, g, b };
}

const bundles: Record<'live' | 'playback', ScopeBundle | null> = { live: null, playback: null };

/** Analyse a sample once (memoized across every consumer of the same tick and settings). */
export function analyse(sample: FrameSample, transfer: MonitorTransfer, clipByte: number, crushClip: CrushClipCompensation): ScopeBundle {
  const prev = bundles[sample.context];
  if (prev && prev.revision === sample.revision && prev.transfer === transfer && prev.clipByte === clipByte) return prev;
  // Stride 1 on the 192×108 tap: ~20k points, the density the upstream 200-wide stride-2 tap
  // reaches with GPU point sprites.
  const samples = sampleRGBA(sample.rgba, sample.width, sample.height, transfer, 1);
  const axis = scopeLevelAxis(transfer, clipByte);
  const sameAxis = prev && prev.transfer === transfer && prev.clipByte === clipByte;
  const vector = vectorPoints(samples, transfer);
  const bundle: ScopeBundle = {
    revision: sample.revision,
    samples,
    trail: sameAxis ? prev!.samples : null,
    vector,
    vectorTrail: sameAxis ? prev!.vector : null,
    histogram: histogramDisplay(samples, sameAxis ? prev!.histogram : null, axis),
    traffic: trafficLights(
      { red: samples.histRed, green: samples.histGreen, blue: samples.histBlue, luma: samples.histLuma },
      transfer,
      clipByte,
      crushClipThreshold(crushClip),
      sameAxis ? prev!.traffic : undefined,
    ),
    nd: ndReading(samples.histLuma, transfer),
    pictureStops: pictureStops(samples.histLuma, transfer),
    transfer,
    clipByte,
  };
  bundles[sample.context] = bundle;
  return bundle;
}

/** The analysed bundle for a context; null until the picture publishes a sample. */
export function useScopeBundle(
  context: 'live' | 'playback',
  transfer: MonitorTransfer,
  clipByte: number,
  crushClip: CrushClipCompensation,
  enabled = true,
): ScopeBundle | null {
  const sample = useFrameSample(context, enabled);
  return useMemo(() => (sample ? analyse(sample, transfer, clipByte, crushClip) : null), [sample, transfer, clipByte, crushClip]);
}

/**
 * Web helper for a playback `<video>` element: draws it into a small canvas at ~10 Hz and
 * publishes playback samples while scopes are shown. Returns a stop function.
 */
export function startVideoElementSampler(video: HTMLVideoElement, context: 'live' | 'playback' = 'playback'): () => void {
  if (typeof document === 'undefined') return () => {};
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const timer = setInterval(() => {
    if (!ctx || !hasSampleDemand() || video.readyState < 2) return;
    try {
      ctx.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
      const data = ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
      publishFrameSample({ width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT, rgba: data, context });
    } catch {
      // Cross-origin video: no samples.
    }
  }, SAMPLE_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** Keep a value in a ref (for rAF loops reading the latest props). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
