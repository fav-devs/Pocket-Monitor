import { useEffect, useRef } from 'react';
import {
  VECTOR_BINS,
  VECTOR_GAIN,
  scopeIntensity,
  scopeLevelAxis,
  vectorscopeRaster,
  type ScopeSamples,
} from '@/core/media';
import type { ScopeTracesProps } from './ScopeTraces.types';
import { TRACE, TRAIL_DECAY, histogramPlotRect, laneX, plotX, plotY, vectorscopeSquare, waveformPlotRect, type PlotRect } from './scopeGeometry';

export type { ScopeTracesProps } from './ScopeTraces.types';

type Rgba = readonly [number, number, number, number];

/** Additive point accumulation into an RGB float plane, then one ImageData blit. */
class Accum {
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.r = new Float32Array(w * h);
    this.g = new Float32Array(w * h);
    this.b = new Float32Array(w * h);
  }
  add(x: number, y: number, span: number, c: Rgba, opacity: number) {
    const yi = Math.round(y);
    if (yi < 0 || yi >= this.h) return;
    const x0 = Math.max(0, Math.floor(x));
    const x1 = Math.min(this.w - 1, Math.floor(x + span));
    const a = c[3] * opacity;
    for (let xi = x0; xi <= x1; xi++) {
      const i = yi * this.w + xi;
      this.r[i] += (c[0] / 255) * a;
      this.g[i] += (c[1] / 255) * a;
      this.b[i] += (c[2] / 255) * a;
    }
  }
  blit(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    const img = ctx.createImageData(this.w, this.h);
    const d = img.data;
    for (let i = 0; i < this.w * this.h; i++) {
      const r = this.r[i];
      const g = this.g[i];
      const b = this.b[i];
      const m = Math.max(r, g, b);
      if (m <= 0) continue;
      d[i * 4] = Math.min(255, r * 255);
      d[i * 4 + 1] = Math.min(255, g * 255);
      d[i * 4 + 2] = Math.min(255, b * 255);
      d[i * 4 + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = this.w;
    tmp.height = this.h;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(tmp, ox, oy);
    ctx.restore();
  }
}

function drawWaveform(ctx: CanvasRenderingContext2D, plot: PlotRect, s: ScopeSamples, trail: ScopeSamples | null, table: Float32Array, mode: 'Luma' | 'RGB', intensity: number, dpr: number) {
  const W = Math.max(1, Math.round(plot.width * dpr));
  const H = Math.max(1, Math.round(plot.height * dpr));
  const acc = new Accum(W, H);
  const local: PlotRect = { x: 0, y: 0, width: W, height: H };
  // The tap is 192 sample columns across the plot.
  const span = Math.max(1, W / 192);
  const pass = (p: ScopeSamples, gain: number) => {
    // Brightness 100% = former 25%, so a point lands at ~0.25; density builds the trace.
    const k = gain * Math.max(0.05, intensity) * 2;
    for (let i = 0; i < p.count; i++) {
      const x = p.xRatio[i] * W;
      if (mode === 'Luma') {
        const y = plotY(table[p.luma[i]], local);
        acc.add(x, y, span, TRACE.lumaGhost, k);
        acc.add(x, y, span, TRACE.luma, k * 0.32);
      } else {
        acc.add(x, plotY(table[p.r[i]], local), span, TRACE.overlayRed, k * 0.45);
        acc.add(x, plotY(table[p.g[i]], local), span, TRACE.overlayGreen, k * 0.45);
        acc.add(x, plotY(table[p.b[i]], local), span, TRACE.overlayBlue, k * 0.45);
      }
    }
  };
  if (trail) pass(trail, TRAIL_DECAY);
  pass(s, 1);
  ctx.save();
  ctx.scale(1 / dpr, 1 / dpr);
  acc.blit(ctx, plot.x * dpr, plot.y * dpr);
  ctx.restore();
}

function drawParade(ctx: CanvasRenderingContext2D, plot: PlotRect, s: ScopeSamples, trail: ScopeSamples | null, table: Float32Array, mode: 'RGB' | 'YRGB', intensity: number, dpr: number) {
  const W = Math.max(1, Math.round(plot.width * dpr));
  const H = Math.max(1, Math.round(plot.height * dpr));
  const acc = new Accum(W, H);
  const local: PlotRect = { x: 0, y: 0, width: W, height: H };
  const lanes: { c: Rgba; v: (p: ScopeSamples, i: number) => number }[] = [
    ...(mode === 'YRGB' ? [{ c: TRACE.luma as Rgba, v: (p: ScopeSamples, i: number) => p.luma[i] }] : []),
    { c: TRACE.paradeRed, v: (p, i) => p.r[i] },
    { c: TRACE.paradeGreen, v: (p, i) => p.g[i] },
    { c: TRACE.paradeBlue, v: (p, i) => p.b[i] },
  ];
  const span = Math.max(1, W / lanes.length / 192);
  const pass = (p: ScopeSamples, gain: number) => {
    const k = gain * Math.max(0.05, intensity) * 0.9;
    lanes.forEach((lane, li) => {
      for (let i = 0; i < p.count; i++) acc.add(laneX(p.xRatio[i], li, lanes.length, local), plotY(table[lane.v(p, i)], local), span, lane.c, k);
    });
  };
  if (trail) pass(trail, TRAIL_DECAY);
  pass(s, 1);
  ctx.save();
  ctx.scale(1 / dpr, 1 / dpr);
  acc.blit(ctx, plot.x * dpr, plot.y * dpr);
  ctx.restore();
}

function histPath(ctx: CanvasRenderingContext2D, bins: Float32Array, plot: PlotRect, peak: number, close: boolean) {
  const last = bins.length - 1;
  const pt = (i: number) => [plotX((i / last) * 100, plot), plot.y + plot.height - (bins[i] / peak) * plot.height] as const;
  ctx.beginPath();
  if (close) {
    ctx.moveTo(plotX(0, plot), plot.y + plot.height);
    ctx.lineTo(...pt(0));
  } else ctx.moveTo(...pt(0));
  for (let i = 1; i <= last; i++) {
    const [px, py] = pt(i - 1);
    const [cx, cy] = pt(i);
    ctx.quadraticCurveTo(px, py, (px + cx) / 2, (py + cy) / 2);
  }
  if (close) {
    ctx.lineTo(plotX(100, plot), plot.y + plot.height);
    ctx.closePath();
  }
}

function drawHistogram(ctx: CanvasRenderingContext2D, plot: PlotRect, props: ScopeTracesProps) {
  const h = props.bundle!.histogram;
  let peak = 1;
  for (const ch of [h.red, h.green, h.blue, h.luma]) for (let i = 0; i < ch.length; i++) if (ch[i] > peak) peak = ch[i];
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX(0, plot), plot.y, plotX(100, plot) - plotX(0, plot), plot.height);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.92;
  const channels: [Float32Array, string, string][] = [
    [h.red, 'rgba(255,48,44,0.17)', 'rgba(255,48,44,0.96)'],
    [h.green, 'rgba(0,238,70,0.15)', 'rgba(0,238,70,0.92)'],
    [h.blue, 'rgba(45,76,255,0.19)', 'rgba(45,76,255,0.94)'],
  ];
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [bins, fill, stroke] of channels) {
    histPath(ctx, bins, plot, peak, true);
    ctx.fillStyle = fill;
    ctx.fill();
    histPath(ctx, bins, plot, peak, false);
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.58;
  ctx.lineWidth = 1.4;
  histPath(ctx, h.luma, plot, peak, false);
  ctx.strokeStyle = 'rgba(245,242,232,0.58)';
  ctx.stroke();
  ctx.restore();
}

function rasterCanvas(px: Uint8ClampedArray) {
  const c = document.createElement('canvas');
  c.width = VECTOR_BINS;
  c.height = VECTOR_BINS;
  const img = new ImageData(new Uint8ClampedArray(px), VECTOR_BINS, VECTOR_BINS);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

function drawVectorscope(ctx: CanvasRenderingContext2D, sq: PlotRect, props: ScopeTracesProps) {
  const b = props.bundle!;
  const gain = VECTOR_GAIN[props.zoom ?? '1x'];
  const intensity = scopeIntensity.vector(props.brightness);
  const blur = (sq.width / VECTOR_BINS) * 1.1;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  if (b.vectorTrail) {
    const t = vectorscopeRaster(b.vectorTrail, gain, intensity);
    if (t) {
      ctx.filter = `blur(${blur}px)`;
      ctx.globalAlpha = TRAIL_DECAY;
      ctx.drawImage(rasterCanvas(t), sq.x, sq.y, sq.width, sq.height);
    }
  }
  const r = vectorscopeRaster(b.vector, gain, intensity);
  if (r) {
    const c = rasterCanvas(r);
    ctx.filter = `blur(${blur}px)`;
    ctx.globalAlpha = 1;
    ctx.drawImage(c, sq.x, sq.y, sq.width, sq.height);
    ctx.filter = 'none';
    ctx.globalAlpha = 0.35;
    ctx.drawImage(c, sq.x, sq.y, sq.width, sq.height);
  }
  ctx.restore();
}

/** Web scope traces: 2D canvas fed by the shared frame sample bundle. */
export default function ScopeTraces(props: ScopeTracesProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { width, height, bundle, kind } = props;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(width * dpr));
    const H = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!bundle) return;
    const table = scopeLevelAxis(bundle.transfer, bundle.clipByte).table;
    const intensity = scopeIntensity.trace(props.brightness);
    if (kind === 'waveform') drawWaveform(ctx, waveformPlotRect(width, height), bundle.samples, bundle.trail, table, (props.mode as 'Luma' | 'RGB') ?? 'RGB', intensity, dpr);
    else if (kind === 'parade') drawParade(ctx, waveformPlotRect(width, height), bundle.samples, bundle.trail, table, (props.mode as 'RGB' | 'YRGB') ?? 'RGB', intensity, dpr);
    else if (kind === 'histogram') drawHistogram(ctx, histogramPlotRect(width, height, !!props.lamps), props);
    else drawVectorscope(ctx, vectorscopeSquare(width, height), props);
  }, [bundle, width, height, kind, props.mode, props.brightness, props.zoom, props.lamps]);
  return <canvas ref={ref} style={{ position: 'absolute', left: 0, top: 0, width, height, pointerEvents: 'none' }} />;
}
