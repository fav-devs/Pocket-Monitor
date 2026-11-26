import { useEffect, useRef } from 'react';
import { scopeIntensity, traceTint } from '@/core/media';
import type { DesktopScopeFrame } from '@/camera/desktop/picture';
import type { ScopeTracesProps } from '@/features/assists/scopes/ScopeTraces.types';
import { TRACE, TRAIL_DECAY, laneX, plotY, vectorscopeSquare, waveformPlotRect, type PlotRect } from '@/features/assists/scopes/scopeGeometry';
import { desktopFrameOf } from './scopeBundle';

type Rgba = readonly [number, number, number, number];

/**
 * The web's sample tap has 192 × 108 points; the desktop grid counts about 256 × 144. Each
 * cell is weighted by this ratio so a desktop trace builds to the same brightness as the
 * phones' web plate at the same setting.
 */
const WEB_POINTS = 192 * 108;

/** Additive RGB accumulation, then one blit with 'lighter' (as the web traces draw). */
class Plane {
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
  add(x: number, y0: number, y1: number, span: number, c: Rgba, opacity: number) {
    const a = c[3] * opacity;
    const xa = Math.max(0, Math.floor(x));
    const xb = Math.min(this.w - 1, Math.floor(x + span));
    const ya = Math.max(0, Math.round(Math.min(y0, y1)));
    const yb = Math.min(this.h - 1, Math.round(Math.max(y0, y1)));
    for (let yi = ya; yi <= yb; yi++)
      for (let xi = xa; xi <= xb; xi++) {
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
      const m = Math.max(this.r[i], this.g[i], this.b[i]);
      if (m <= 0) continue;
      d[i * 4] = Math.min(255, this.r[i] * 255);
      d[i * 4 + 1] = Math.min(255, this.g[i] * 255);
      d[i * 4 + 2] = Math.min(255, this.b[i] * 255);
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

type Lane = { grid: (f: DesktopScopeFrame) => Uint8Array | null; color: Rgba; ghost?: Rgba; opacity: number };

/** Draws one or more grids across the plot (overlaid for WAVE, side by side for PARADE). */
function drawGrids(ctx: CanvasRenderingContext2D, plot: PlotRect, frame: DesktopScopeFrame, trail: DesktopScopeFrame | null, lanes: Lane[], sideBySide: boolean, k: number, dpr: number) {
  const W = Math.max(1, Math.round(plot.width * dpr));
  const H = Math.max(1, Math.round(plot.height * dpr));
  const plane = new Plane(W, H);
  const local: PlotRect = { x: 0, y: 0, width: W, height: H };
  const pass = (f: DesktopScopeFrame, gain: number) => {
    const { columns, levels } = f;
    const weight = (WEB_POINTS / Math.max(1, f.pixels)) * gain * k;
    const rowStep = Math.max(1, H / levels) / 2;
    lanes.forEach((lane, li) => {
      const grid = lane.grid(f);
      if (!grid) return;
      const span = sideBySide ? Math.max(1, W / lanes.length / columns) : Math.max(1, W / columns);
      for (let r = 0; r < levels; r++) {
        const y = plotY((r / Math.max(1, levels - 1)) * 100, local);
        const row = r * columns;
        for (let c = 0; c < columns; c++) {
          const n = grid[row + c];
          if (!n) continue;
          const ratio = c / columns;
          const x = sideBySide ? laneX(ratio, li, lanes.length, local) : ratio * W;
          if (lane.ghost) plane.add(x, y - rowStep, y + rowStep, span, lane.ghost, n * weight);
          plane.add(x, y - rowStep, y + rowStep, span, lane.color, n * weight * lane.opacity);
        }
      }
    });
  };
  if (trail) pass(trail, TRAIL_DECAY);
  pass(frame, 1);
  ctx.save();
  ctx.scale(1 / dpr, 1 / dpr);
  plane.blit(ctx, plot.x * dpr, plot.y * dpr);
  ctx.restore();
}

/** Premultiplied RGBA raster of the log densities, tinted by each bin's chroma direction. */
export function vectorRaster(frame: DesktopScopeFrame, intensity: number): Uint8ClampedArray | null {
  const n = frame.vectorBins;
  const v = frame.vector;
  if (!v || n < 2) return null;
  const px = new Uint8ClampedArray(n * n * 4);
  let any = false;
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) {
      const d = v[row * n + col];
      if (!d) continue;
      any = true;
      // The bin's chroma at mid grey: its hue, with the saturation its distance gives.
      const cb = col / (n - 1) - 0.5;
      const cr = (n - 1 - row) / (n - 1) - 0.5;
      const y = 0.5;
      const r = Math.min(1, Math.max(0, y + 1.5748 * cr));
      const b = Math.min(1, Math.max(0, y + 1.8556 * cb));
      const g = Math.min(1, Math.max(0, (y - 0.2126 * r - 0.0722 * b) / 0.7152));
      const t = traceTint(r, g, b);
      const alpha = Math.min(1, Math.max(0, (0.4 + 0.6 * (d / 255)) * intensity));
      const o = (row * n + col) * 4;
      px[o] = 255 * t[0] * alpha;
      px[o + 1] = 255 * t[1] * alpha;
      px[o + 2] = 255 * t[2] * alpha;
      px[o + 3] = 255 * alpha;
    }
  return any ? px : null;
}

function rasterCanvas(px: Uint8ClampedArray, n: number) {
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), n, n), 0, 0);
  return c;
}

function drawVector(ctx: CanvasRenderingContext2D, sq: PlotRect, frame: DesktopScopeFrame, trail: DesktopScopeFrame | null, brightness: number) {
  const intensity = scopeIntensity.vector(brightness);
  const blur = (sq.width / Math.max(1, frame.vectorBins)) * 1.1;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  if (trail) {
    const t = vectorRaster(trail, intensity);
    if (t) {
      ctx.filter = `blur(${blur}px)`;
      ctx.globalAlpha = TRAIL_DECAY;
      ctx.drawImage(rasterCanvas(t, trail.vectorBins), sq.x, sq.y, sq.width, sq.height);
    }
  }
  const r = vectorRaster(frame, intensity);
  if (r) {
    const c = rasterCanvas(r, frame.vectorBins);
    ctx.filter = `blur(${blur}px)`;
    ctx.globalAlpha = 1;
    ctx.drawImage(c, sq.x, sq.y, sq.width, sq.height);
    ctx.filter = 'none';
    ctx.globalAlpha = 0.85;
    ctx.drawImage(c, sq.x, sq.y, sq.width, sq.height);
  }
  ctx.restore();
}

const luma: Lane = { grid: (f) => f.waveLuma, color: TRACE.luma, ghost: TRACE.lumaGhost, opacity: 0.32 };

/**
 * Desktop scope traces (WAVE, PARADE, VECTOR) from the Rust scope thread's grids. HISTO is not
 * here: the desktop bundle carries the phones' `HistogramDisplay`, which the web plate draws.
 */
export function DesktopScopeTraces(props: ScopeTracesProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { width, height, bundle, kind, mode, brightness } = props;
  useEffect(() => {
    const canvas = ref.current;
    const desktop = desktopFrameOf(bundle);
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
    if (!desktop) return;
    const frame = desktop.desktop;
    const trail = desktop.desktopTrail;
    const intensity = scopeIntensity.trace(brightness);
    if (kind === 'waveform') {
      const lanes: Lane[] =
        mode === 'Luma'
          ? [luma]
          : [
              { grid: (f) => f.waveRed, color: TRACE.overlayRed, opacity: 0.45 },
              { grid: (f) => f.waveGreen, color: TRACE.overlayGreen, opacity: 0.45 },
              { grid: (f) => f.waveBlue, color: TRACE.overlayBlue, opacity: 0.45 },
            ];
      drawGrids(ctx, waveformPlotRect(width, height), frame, trail, lanes, false, Math.max(0.05, intensity) * 2, dpr);
    } else if (kind === 'parade') {
      const lanes: Lane[] = [
        ...(mode === 'YRGB' ? [{ grid: (f: DesktopScopeFrame) => f.waveLuma, color: TRACE.luma as Rgba, opacity: 1 }] : []),
        { grid: (f) => f.waveRed, color: TRACE.paradeRed, opacity: 1 },
        { grid: (f) => f.waveGreen, color: TRACE.paradeGreen, opacity: 1 },
        { grid: (f) => f.waveBlue, color: TRACE.paradeBlue, opacity: 1 },
      ];
      drawGrids(ctx, waveformPlotRect(width, height), frame, trail, lanes, true, Math.max(0.05, intensity) * 0.9, dpr);
    } else if (kind === 'vectorscope') {
      drawVector(ctx, vectorscopeSquare(width, height), frame, trail, brightness);
    }
  }, [bundle, width, height, kind, mode, brightness]);
  return <canvas ref={ref} style={{ position: 'absolute', left: 0, top: 0, width, height, pointerEvents: 'none' }} />;
}
