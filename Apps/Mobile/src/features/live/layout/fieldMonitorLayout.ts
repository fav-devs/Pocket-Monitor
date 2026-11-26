/**
 * Live monitor geometry after OpenCine `FieldMonitorLayout` + `GimbalCluster`, laid out in the
 * Sondr camera style: status pills on top, a rail of circle buttons, the record ring.
 * Pure geometry: every chrome region of the live monitor for a viewport, safe area and
 * picture aspect. No React here so it can be unit tested.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SafeArea {
  top: number;
  leading: number;
  bottom: number;
  trailing: number;
}

export const rect = (x = 0, y = 0, width = 0, height = 0): Rect => ({
  x,
  y,
  width: Math.max(0, width),
  height: Math.max(0, height),
});
export const maxX = (r: Rect) => r.x + r.width;
export const maxY = (r: Rect) => r.y + r.height;
export const midX = (r: Rect) => r.x + r.width / 2;
export const midY = (r: Rect) => r.y + r.height / 2;
export const isEmptyRect = (r: Rect) => r.width < 1 || r.height < 1;
export function contains(r: Rect, x: number, y: number, slop = 0) {
  return x >= r.x - slop && x <= maxX(r) + slop && y >= r.y - slop && y <= maxY(r) + slop;
}
export function intersects(a: Rect, b: Rect) {
  return a.x < maxX(b) && maxX(a) > b.x && a.y < maxY(b) && maxY(a) > b.y;
}

function fitting(r: Rect, aspect: number): Rect {
  if (!(aspect > 0) || r.height <= 0) return r;
  if (r.width / r.height > aspect) {
    const w = r.height * aspect;
    return rect(r.x + (r.width - w) / 2, r.y, w, r.height);
  }
  const h = r.width / aspect;
  return rect(r.x, r.y + (r.height - h) / 2, r.width, h);
}

/** Rail button: a 40pt circle over an 11pt caption (ai-cut camera rail). */
export const RAIL_CIRCLE = 40;
export const RAIL_W = 56;
export const RAIL_H = 58;
/** ai-cut record button: 84pt ring around a dotPink core. */
export const RECORD_SIZE = 84;
/** Status pills row height. */
export const STATUS_ROW = 32;
export const STATUS_GAP = 6;
export const MIN_TAP = 44;
/** `MonitorJoystickSize.medium`. */
export const STICK_SIDE = 101;
/** `GimbalCluster` constants. */
export const ZOOM_SIZE = 44;
export const CLUSTER_GAP = 8;
/** Readout strip: tile height and the plate's padding. */
export const READOUT_TILE_H = 44;
export const READOUT_PAD = 4;
export const READOUT_MIN_TILE = 50;
const FRAME_ASPECT = 16 / 9;
/** The assist palette's cell (owned by AssistBar) and its padding. */
const ASSIST_CELL = 48;
const PALETTE_PADDING = 4;
const PALETTE_SPACING = 6;
const PALETTE_EXPANSION = 16;
const PALETTE_INSETS = PALETTE_PADDING * 2 + PALETTE_SPACING + PALETTE_EXPANSION;

/** Where the monitor's sheets sit: docked beside the picture (landscape) or under it (portrait). */
export interface MonitorSheetPlacement {
  dock: { left: number; width: number; top: number; bottom: number } | null;
  /** Portrait: room kept above the tray, so the picture stays in view. */
  topInset: number;
}

export interface FieldMonitorLayout {
  viewport: Rect;
  picture: Rect;
  /** The status pills: one row in landscape, two in portrait (see `statusRows`). */
  status: Rect;
  statusRows: 1 | 2;
  values: Rect;
  /** Readout tiles per row of the strip. */
  valuesPerRow: number;
  system: Rect;
  lock: Rect;
  settings: Rect;
  media: Rect;
  record: Rect;
  display: Rect;
  assists: Rect;
  stick: Rect;
  zoom: Rect;
  gimbal: Rect;
  aspectToggle: Rect;
  exposureGauge: Rect;
  sheet: MonitorSheetPlacement;
  portrait: boolean;
  tablet: boolean;
  fillsPicture: boolean;
  safeArea: SafeArea;
}

export interface FieldMonitorLayoutInput {
  width: number;
  height: number;
  safeArea?: SafeArea;
  sourceAspect?: number;
  fill?: boolean;
  showsValues?: boolean;
  valueCount?: number;
  stickSide?: number;
}

/** Readout strip rows for `count` tiles across `width`. */
export function readoutRows(count: number | undefined, width: number) {
  const perRow = Math.max(1, Math.floor((width - READOUT_PAD * 2) / READOUT_MIN_TILE));
  const n = Math.max(1, count ?? 7);
  const rows = Math.ceil(n / perRow);
  return { rows, perRow: Math.ceil(n / rows) };
}

function portraitHeaderSafeTop(w: number, h: number, safeTop: number) {
  return h > w && w < 600 ? Math.max(44, safeTop) : Math.max(12, safeTop);
}

function landscapeFrame(w: number, h: number, cut: number, aspect: number): Rect {
  const imageW = Math.min(w - 2 * cut, h * aspect);
  const imageH = imageW / aspect;
  return rect((w - imageW) / 2, (h - imageH) / 2, imageW, imageH);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function computeFieldMonitorLayout(input: FieldMonitorLayoutInput): FieldMonitorLayout {
  const safeArea = input.safeArea ?? { top: 0, leading: 0, bottom: 0, trailing: 0 };
  const showsValues = input.showsValues ?? true;
  const stickSide = input.stickSide ?? STICK_SIDE;
  const w = Math.max(1, Number.isFinite(input.width) ? input.width : 1);
  const h = Math.max(1, Number.isFinite(input.height) ? input.height : 1);
  const aspect = input.sourceAspect && input.sourceAspect > 0 ? input.sourceAspect : 16 / 9;
  const viewport = rect(0, 0, w, h);
  const portrait = h > w;
  const tablet = Math.min(w, h) >= 600;
  const rec = RECORD_SIZE;
  const edge = tablet ? 20 : portrait ? 16 : 12;
  const lead = safeArea.leading + edge;
  const trail = w - safeArea.trailing - edge;
  const assistHeightLandscape = ASSIST_CELL * 2 + PALETTE_PADDING * 2 + PALETTE_SPACING;

  let picture: Rect, status: Rect, values: Rect, system: Rect, lock: Rect;
  let settings: Rect, media: Rect, record: Rect, display: Rect, assists: Rect, stick: Rect;
  let aspectToggle: Rect, exposureGauge: Rect;
  let fillsPicture: boolean;
  let sheet: MonitorSheetPlacement;
  let valuesPerRow: number;
  const statusRows: 1 | 2 = portrait ? 2 : 1;

  if (portrait) {
    const headerTop = portraitHeaderSafeTop(w, h, safeArea.top);
    status = rect(lead, headerTop, trail - lead, STATUS_ROW * 2 + STATUS_GAP);
    // Bottom rail: lock and DISP, record, media and settings.
    const systemH = rec + 16;
    const systemY = Math.max(0, h - Math.max(12, safeArea.bottom - 14) - systemH);
    system = rect(0, systemY, w, h - systemY);
    const cy = systemY + systemH / 2;
    record = rect((w - rec) / 2, cy - rec / 2, rec, rec);
    const railY = cy - RAIL_H / 2;
    // Each pair centres in its side, but never drifts far from record on a wide tablet.
    const leftMid = Math.max((lead + record.x - 8) / 2, record.x - 96);
    const rightMid = Math.min((maxX(record) + 8 + trail) / 2, maxX(record) + 96);
    lock = rect(leftMid - RAIL_W - 4, railY, RAIL_W, RAIL_H);
    display = rect(leftMid + 4, railY, RAIL_W, RAIL_H);
    media = rect(rightMid - RAIL_W - 4, railY, RAIL_W, RAIL_H);
    settings = rect(rightMid + 4, railY, RAIL_W, RAIL_H);
    // The readout strip sits on the rail.
    const strip = readoutRows(input.valueCount, trail - lead);
    valuesPerRow = strip.perRow;
    const valuesH = showsValues ? READOUT_PAD * 2 + strip.rows * READOUT_TILE_H : 0;
    values = rect(lead, systemY - 4 - valuesH, trail - lead, valuesH);
    const floor = values.y - (showsValues ? 10 : 0);
    fillsPicture = !!input.fill || aspect < 1;
    const ratio = fillsPicture ? Math.min(aspect, 9 / 16) : aspect;
    const ceiling = maxY(status) + 8;
    const pillarbox = tablet && w / ratio > Math.max(0, floor - ceiling);
    const pictureH = pillarbox ? Math.max(1, floor - ceiling) : w / ratio;
    const pictureW = pillarbox ? pictureH * ratio : w;
    let pictureY: number;
    let vertical: Rect | null = null;
    if (aspect < 1 && !pillarbox) {
      const room = Math.max(1, systemY - Math.max(0, safeArea.top));
      const fittedH = Math.min(w / aspect, room);
      const fittedW = fittedH * aspect;
      pictureY = Math.max(Math.max(0, safeArea.top), systemY - fittedH);
      vertical = rect((w - fittedW) / 2, pictureY, fittedW, fittedH);
    } else if (pictureH > h || pictureH > floor - ceiling) {
      pictureY = (h - pictureH) / 2;
    } else {
      const ideal = (h - pictureH) / 2;
      pictureY = Math.max(ceiling, Math.min(ideal, floor - pictureH));
    }
    picture = vertical ?? rect((w - pictureW) / 2, pictureY, pictureW, pictureH);
    stick = rect(trail - stickSide, floor - 12 - stickSide, stickSide, stickSide);
    const assistH = ASSIST_CELL + 35;
    assists = rect(lead, floor - 12 - assistH, ASSIST_CELL + 8, assistH);
    aspectToggle = rect(w / 2 - RAIL_W / 2, floor - 12 - RAIL_H, RAIL_W, RAIL_H);
    const gaugeTop = Math.max(maxY(status) + 12, picture.y + 12);
    const gaugeRoom = Math.min(maxY(picture), stick.y - 60) - 12 - gaugeTop;
    exposureGauge = rect(lead, gaugeTop, 34, clamp(gaugeRoom, 110, 170));
    const below = fillsPicture ? h * 0.5 : maxY(picture) + 10;
    sheet = { dock: null, topInset: clamp(below, h * 0.36, h * 0.68) };
  } else {
    fillsPicture = false;
    const cut = Math.max(0, Math.max(safeArea.leading, safeArea.trailing) - 14);
    const frame = landscapeFrame(w, h, cut, FRAME_ASPECT);
    picture = aspect < FRAME_ASPECT ? fitting(frame, aspect) : landscapeFrame(w, h, cut, aspect);
    system = rect();
    const top = Math.max(8, safeArea.top + 6);
    const bottom = h - (safeArea.bottom > 0 ? safeArea.bottom + 4 : 10);
    // Trailing column: settings and media above record, DISP and lock below, record centred.
    const colX = trail - rec;
    const colMid = colX + rec / 2;
    const gap = clamp((bottom - top - RAIL_H * 4 - rec) / 4, 4, tablet ? 28 : 18);
    record = rect(colX, (top + bottom) / 2 - rec / 2, rec, rec);
    media = rect(colMid - RAIL_W / 2, record.y - gap - RAIL_H, RAIL_W, RAIL_H);
    settings = rect(media.x, media.y - gap - RAIL_H, RAIL_W, RAIL_H);
    display = rect(media.x, maxY(record) + gap, RAIL_W, RAIL_H);
    lock = rect(media.x, maxY(display) + gap, RAIL_W, RAIL_H);
    status = rect(lead, top, colX - 16 - lead, STATUS_ROW);
    stick = rect(colX - 16 - stickSide, bottom - stickSide, stickSide, stickSide);
    assists = rect(lead, bottom - assistHeightLandscape, ASSIST_CELL + PALETTE_INSETS, assistHeightLandscape);
    const stripLeft = maxX(assists) + 12;
    const stripRight = stick.x - 12;
    const valuesH = showsValues ? READOUT_PAD * 2 + READOUT_TILE_H : 0;
    values = rect(stripLeft, bottom - valuesH, stripRight - stripLeft, valuesH);
    valuesPerRow = Math.max(1, input.valueCount ?? 7);
    aspectToggle = rect();
    const gaugeX = Math.max(lead, picture.x + 10);
    const gaugeTopY = maxY(status) + 12;
    exposureGauge = rect(gaugeX, gaugeTopY, 34, clamp(assists.y - 12 - gaugeTopY, 90, 200));
    const dockWidth = Math.min(clamp(w * 0.42, 300, 400), stick.x - 12 - lead);
    sheet = { dock: { left: lead, width: dockWidth, top: maxY(status) + 8, bottom }, topInset: 0 };
  }

  // Gimbal cluster (CONTEXT.md): zoom stacks above the stick, trailing-aligned; the gimbal
  // controls button sits leading of zoom, the same size. Same rule in every orientation.
  const zoom = rect(maxX(stick) - ZOOM_SIZE, stick.y - CLUSTER_GAP - ZOOM_SIZE, ZOOM_SIZE, ZOOM_SIZE);
  const gimbal = rect(zoom.x - CLUSTER_GAP - ZOOM_SIZE, zoom.y, ZOOM_SIZE, ZOOM_SIZE);

  return {
    viewport,
    picture,
    status,
    statusRows,
    values,
    valuesPerRow,
    system,
    lock,
    settings,
    media,
    record,
    display,
    assists,
    stick,
    zoom,
    gimbal,
    aspectToggle,
    exposureGauge,
    sheet,
    portrait,
    tablet,
    fillsPicture,
    safeArea,
  };
}

