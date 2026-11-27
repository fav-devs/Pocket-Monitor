/**
 * Framing geometry: composition grids, aspect guide frames, safe areas, crosshair, level gauges,
 * desqueeze picture rects. Port of OpenCine `MonitorFramingValues`, `MonitorFeedMarks`,
 * `MonitorLevelOverlay`, `MonitorLevelGauge`, `Framing.swift`.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ───────────────────────────── Grid ─────────────────────────────

export type GridOption = 'thirds' | 'phi' | 'diagonal';
export const THIRDS_FRACTIONS = [1 / 3, 2 / 3];
export const PHI_FRACTIONS = [0.382, 0.618];
export const GRID_STROKE_OPACITY = 0.22;

export function gridSegments(feed: Rect, o: { thirds: boolean; phi: boolean; diagonal: boolean }): Segment[] {
  const lines: Segment[] = [];
  const add = (fractions: number[]) => {
    for (const f of fractions) {
      const x = feed.x + feed.width * f;
      const y = feed.y + feed.height * f;
      lines.push({ x1: x, y1: feed.y, x2: x, y2: feed.y + feed.height });
      lines.push({ x1: feed.x, y1: y, x2: feed.x + feed.width, y2: y });
    }
  };
  if (o.thirds) add(THIRDS_FRACTIONS);
  if (o.phi) add(PHI_FRACTIONS);
  if (o.diagonal) {
    lines.push({ x1: feed.x, y1: feed.y, x2: feed.x + feed.width, y2: feed.y + feed.height });
    lines.push({ x1: feed.x + feed.width, y1: feed.y, x2: feed.x, y2: feed.y + feed.height });
  }
  return lines;
}

// ───────────────────────────── Guides ─────────────────────────────

export type GuideFamily = 'Film' | 'Social';
export type GuideAspect =
  | '2.76:1'
  | '2.39:1'
  | '2.35:1'
  | '2.00:1'
  | '1.85:1'
  | '16:9'
  | '1.66:1'
  | '1.43:1'
  | '4:3'
  | '9:16'
  | '4:5'
  | '1:1'
  | '2:3'
  | '1.91:1';

export const GUIDE_RATIOS: Record<GuideFamily, GuideAspect[]> = {
  Film: ['2.76:1', '2.39:1', '2.35:1', '2.00:1', '1.85:1', '16:9', '1.66:1', '1.43:1', '4:3'],
  Social: ['9:16', '4:5', '1:1', '2:3', '16:9', '1.91:1'],
};

export function aspectRatio(a: GuideAspect): number {
  const [w, h] = a.split(':').map(Number);
  return h > 0 ? w / h : 1;
}

/** Largest centred rect of `ratio` inside `feed`. */
export function rectForRatio(feed: Rect, ratio: number): Rect {
  let width: number;
  let height: number;
  if (feed.width / feed.height > ratio) {
    height = feed.height;
    width = feed.height * ratio;
  } else {
    width = feed.width;
    height = feed.width / ratio;
  }
  return { x: feed.x + (feed.width - width) / 2, y: feed.y + (feed.height - height) / 2, width, height };
}

export const SAFE_PERCENT_RANGE: [number, number] = [50, 99];
export const clampSafePercent = (p: number) => Math.min(SAFE_PERCENT_RANGE[1], Math.max(SAFE_PERCENT_RANGE[0], Math.round(p)));

export interface GuideSafeAreas {
  actionSafe: boolean;
  actionPercent: number;
  titleSafe: boolean;
  titlePercent: number;
}
export const STANDARD_SAFE_AREAS: GuideSafeAreas = { actionSafe: false, actionPercent: 90, titleSafe: false, titlePercent: 80 };

/** Centred `percent` share of a frame line's width and height. */
export function safeRect(frame: Rect, percent: number): Rect {
  const share = clampSafePercent(percent) / 100;
  const width = frame.width * share;
  const height = frame.height * share;
  return { x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height };
}

export function guideSummaryLabel(selected: GuideAspect[]): string {
  if (selected.length === 1) return selected[0];
  return selected.length === 0 ? '—' : `${selected.length} ratios`;
}

/** Frames sorted narrow → wide with their rects. */
export function guideFrames(feed: Rect, selected: GuideAspect[]): { aspect: GuideAspect; rect: Rect }[] {
  return [...selected]
    .sort((a, b) => aspectRatio(a) - aspectRatio(b))
    .map((aspect) => ({ aspect, rect: rectForRatio(feed, aspectRatio(aspect)) }));
}

// ───────────────────────────── Crosshair ─────────────────────────────

export const CROSSHAIR = { arm: 40, stroke: 1.4, opacity: 0.65 };

// ───────────────────────────── Level ─────────────────────────────

export const LEVEL_GAUGE = {
  thickness: 28,
  maxLength: 180,
  spanDeg: 8,
  levelDeg: 0.6,
  band: 8,
  rollLiftLandscape: 84,
  rollLiftPortrait: 22,
  bubbleRadius: 64,
  bubbleSpanDeg: 10,
};

export function levelLabel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const v = Math.abs(value) < 0.05 ? 0 : value;
  const s = v.toFixed(1);
  return `${v >= 0 ? '+' : '−'}${s.replace('-', '')}°`;
}

/** Roll strip along the lower picture and tilt strip at the side, kept on the visible picture. */
export function levelFrames(feed: Rect, portrait: boolean): { roll: Rect; tilt: Rect } {
  const t = LEVEL_GAUGE.thickness;
  const rollWidth = Math.max(0, Math.min(LEVEL_GAUGE.maxLength, feed.width - 24));
  const rollMidY = feed.y + feed.height - (portrait ? LEVEL_GAUGE.rollLiftPortrait : LEVEL_GAUGE.rollLiftLandscape);
  const tiltHeight = Math.max(0, Math.min(LEVEL_GAUGE.maxLength, feed.height - 12));
  const midX = feed.x + feed.width / 2;
  const midY = feed.y + feed.height / 2;
  const tiltMidX = Math.min(midX + (rollMidY - midY), feed.x + feed.width - 6 - t / 2);
  return {
    roll: { x: midX - rollWidth / 2, y: rollMidY - t / 2, width: rollWidth, height: t },
    tilt: { x: tiltMidX - t / 2, y: midY - tiltHeight / 2, width: t, height: tiltHeight },
  };
}

/** Marker position 0…1 along a gauge (positive right / up). */
export function levelGaugeFraction(deg: number): number {
  const s = LEVEL_GAUGE.spanDeg;
  return (Math.min(s, Math.max(-s, deg)) + s) / (2 * s);
}

// ───────────────────────────── Picture fit ─────────────────────────────

/** Where a picture of `aspect` lands inside a container, fit (letterbox) or fill (crop). */
export function fitRect(container: { width: number; height: number }, aspect: number, mode: 'fit' | 'fill'): Rect {
  const cw = container.width;
  const ch = container.height;
  if (!(cw > 0) || !(ch > 0) || !(aspect > 0)) return { x: 0, y: 0, width: cw, height: ch };
  const containerAspect = cw / ch;
  const wider = aspect > containerAspect;
  let width: number;
  let height: number;
  if ((mode === 'fit') === wider) {
    width = cw;
    height = cw / aspect;
  } else {
    height = ch;
    width = ch * aspect;
  }
  return { x: (cw - width) / 2, y: (ch - height) / 2, width, height };
}

/** Feed aspect from a raster; degenerate sizes keep 16:9. */
export const rasterAspect = (w?: number, h?: number, fallback = 16 / 9) => (w && h && w > 1 && h > 1 ? w / h : fallback);

/** EV meter strip on the picture's left edge (`MonitorOperatorExposureGeometry`). */
export function evMeterFrame(feed: Rect): Rect | null {
  const width = 28;
  const minimumHeight = 72;
  if (feed.width < width + 12 || feed.height < minimumHeight + 12) return null;
  const top = feed.y + 6;
  const bottom = feed.y + feed.height - 6;
  const height = Math.min(180, bottom - top);
  const preferredY = feed.y + feed.height / 2 - 16 - height / 2;
  return { x: feed.x + 6, y: Math.min(Math.max(preferredY, top), bottom - height), width, height };
}
