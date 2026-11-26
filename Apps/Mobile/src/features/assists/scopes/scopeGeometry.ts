/** Plot geometry shared by the scope traces and their SVG graticules (`MonitorWaveformAxis`). */

export const TITLE_HEIGHT = 26;
export const BOTTOM_PAD = 2;
export const SIDE_PAD = 6;
export const PLOT_INSET = 1;
export const TRAIL_DECAY = 0.35;

export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function waveformPlotRect(w: number, h: number): PlotRect {
  return { x: SIDE_PAD, y: TITLE_HEIGHT, width: w - SIDE_PAD * 2, height: Math.max(1, h - TITLE_HEIGHT - BOTTOM_PAD) };
}

/** IRE 0…100 onto the plot (0 and 100 on the edges). */
export function plotY(ire: number, r: PlotRect) {
  const span = r.height - 2 * PLOT_INSET;
  return r.y + r.height - PLOT_INSET - (ire / 100) * span;
}

export function plotX(ire: number, r: PlotRect) {
  const span = r.width - 2 * PLOT_INSET;
  return r.x + PLOT_INSET + (ire / 100) * span;
}

export const HISTO = { lampWidth: 7.5, lampHeight: 15, outerPad: 6, lineGap: 4, clipZoneIRE: 95 };
export const histoGutter = HISTO.outerPad + HISTO.lampWidth + HISTO.lineGap;

export function histogramPlotRect(w: number, h: number, lamps: boolean): PlotRect {
  const g = lamps ? histoGutter : SIDE_PAD;
  return { x: g, y: TITLE_HEIGHT, width: Math.max(1, w - g * 2), height: Math.max(1, h - TITLE_HEIGHT - BOTTOM_PAD) };
}

export function vectorscopeSquare(w: number, h: number): PlotRect {
  const plot = { x: 6, y: 26, width: w - 12, height: h - 26 - 8 };
  const side = Math.max(1, Math.min(plot.width, plot.height));
  return { x: plot.x + plot.width / 2 - side / 2, y: plot.y + plot.height / 2 - side / 2, width: side, height: side };
}

export function laneX(xRatio: number, lane: number, lanes: number, plot: PlotRect) {
  const w = plot.width / lanes;
  return plot.x + lane * w + xRatio * (w - 1);
}

/** Trace palette (`MonitorScopePalette`), 0…255 + alpha. */
export const TRACE = {
  lumaGhost: [182, 190, 186, 0.08],
  luma: [222, 230, 224, 1],
  lumaHot: [255, 255, 255, 1],
  overlayRed: [255, 64, 54, 0.55],
  overlayGreen: [70, 240, 110, 0.55],
  overlayBlue: [72, 148, 255, 0.62],
  paradeRed: [255, 86, 78, 1],
  paradeGreen: [102, 232, 132, 1],
  paradeBlue: [92, 156, 255, 1],
} as const;

export const SCOPE_COLORS = {
  boundary: 'rgba(220,235,225,0.8)',
  clip: 'rgba(255,150,142,0.8)',
  middle: 'rgba(246,241,226,0.8)',
  grid: 'rgba(220,235,225,0.10)',
  faintGrid: 'rgba(220,235,225,0.06)',
  ring: 'rgba(220,235,225,0.55)',
  faint: 'rgba(220,235,225,0.30)',
  box: 'rgba(220,235,225,0.6)',
  label: 'rgba(220,235,225,0.55)',
  lampRed: 'rgb(255,92,82)',
  lampGreen: 'rgb(86,235,132)',
  lampBlue: 'rgb(96,158,255)',
};
