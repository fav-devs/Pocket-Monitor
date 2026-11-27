/**
 * Live monitor geometry, laid out like DJI Mimo's camera screen. In landscape the picture sits
 * between two slim black letterbox strips: the leading strip (back, exposure mode, format,
 * tracking, assists, more) and the trailing strip (the rotated shooting-mode rail). Like Mimo the
 * strips live mostly inside the unsafe area (the notch / Dynamic Island side), so the picture
 * keeps the full screen height. Record and media sit over the picture's trailing edge (Mimo's
 * column), with the quick icons above and the lock below record. Over the picture float status,
 * the gimbal cluster and the exposure readout; these and the quick icons are movable (saved
 * layouts, `layoutModel.ts`). Portrait keeps the picture on top and turns the strips into rows.
 *
 * Pure geometry: every chrome region for a viewport, safe area and picture aspect. No React
 * here so it can be unit tested. Multiview reuses the constants and `readoutRows`.
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

/** Multiview's rail button: a 40pt circle over an 11pt caption. */
export const RAIL_CIRCLE = 40;
export const RAIL_W = 56;
export const RAIL_H = 58;
/** Multiview's record ring (ai-cut, 84pt). The live view uses `RECORD_DISC`. */
export const RECORD_SIZE = 84;
/** The live view's record disc (Mimo's plain red disc), phone and tablet. */
export const RECORD_DISC = 56;
export const RECORD_DISC_TABLET = 74;
/** Status row height. */
export const STATUS_ROW = 32;
export const STATUS_GAP = 6;
export const MIN_TAP = 44;
/** `MonitorJoystickSize.medium` (Multiview). The live stick is `LIVE_STICK`. */
export const STICK_SIDE = 101;
/** The live view's small translucent stick (Mimo). */
export const LIVE_STICK = 92;
export const LIVE_STICK_TABLET = 112;
/** `GimbalCluster` constants. */
export const ZOOM_SIZE = 44;
export const CLUSTER_GAP = 8;
/** Leading strip's control column (landscape), phone and tablet, outside the reachable inset. */
export const LEAD_STRIP = 44;
export const LEAD_STRIP_TABLET = 64;
/** Trailing strip (landscape): the mode rail plus a hairline of black, outside the reachable inset. */
export const TRAIL_STRIP = 32;
export const TRAIL_STRIP_TABLET = 42;
/** The picture may run this far under each strip's inner edge (the strip glyphs stay on black). */
export const PICTURE_TUCK = 8;
/**
 * iOS reports landscape side insets symmetric and deeper than the notch or Dynamic Island itself
 * (47–59pt for a ~30–48pt cutout), so strip controls may reach this far into them, as Mimo's do.
 * Android reports the real cutout, so it passes 0.
 */
export const IOS_INSET_OVERLAP = 12;
/** Gap between quick icons in a column (Mimo spaces its glyphs ~40pt apart: 44pt targets edge to edge). */
export const QUICK_GAP = 0;
/** The rotated shooting-mode rail's thickness (landscape). */
export const MODE_RAIL_W = 28;
export const MODE_RAIL_W_TABLET = 34;
/** Portrait mode rail row and leading/quick rows. */
export const MODE_ROW_H = 36;
export const LEAD_ROW_H = 56;
export const QUICK_SIZE = 44;
/** Legacy (Multiview): a vertical rail word. */
export const MODE_ITEM_H = 44;
/** One line of the bottom readout text. */
export const READOUT_LINE_H = 26;
/** Readout strip (Multiview): tile height and the plate's padding. */
export const READOUT_TILE_H = 44;
export const READOUT_PAD = 4;
export const READOUT_MIN_TILE = 50;

/** Where the monitor's panels sit: docked against the leading strip (landscape) or under the picture (portrait). */
export interface MonitorSheetPlacement {
  dock: { left: number; width: number; top: number; bottom: number } | null;
  /** Portrait: the panel's top edge, so the picture stays in view. */
  topInset: number;
  /** Optional (additive). Portrait: room kept under the panel (the mode rail and record stay reachable). */
  bottomInset?: number;
}

export interface FieldMonitorLayout {
  viewport: Rect;
  picture: Rect;
  /** Landscape: the solid black letterbox strips. Portrait: empty. */
  leadStrip: Rect;
  trailStrip: Rect;
  /** Exposure mode, format, tracking, assists, more: a column in the leading strip, a row in portrait. */
  leading: Rect;
  /** Back to cameras: the top of the leading strip, or the status row's leading end in portrait. */
  back: Rect;
  /** Quick icons (flip, DISP, recenter): a column over the picture's trailing edge above record, a row in portrait. */
  quick: Rect;
  /** Optional (additive). The screen lock (and Picture in Picture): under record in landscape, the row's end in portrait. */
  lock: Rect;
  /**
   * Optional (additive). Where movable chrome may sit (`layoutModel.ts`): the visible picture in
   * landscape; in portrait the band from the header to the mode rail. Saved positions are
   * normalized to it.
   */
  stage: Rect;
  /** Optional (additive). Fixed controls inside `stage` that movable chrome keeps clear of. */
  fixed: Rect[];
  axis: 'vertical' | 'horizontal';
  /** Camera status (battery, card, link), right-aligned in this rect. */
  status: Rect;
  statusRows: 1 | 2;
  /** REC + timecode, left-aligned in this rect. */
  statusLead: Rect;
  /** The exposure readout text (a tile strip in Multiview). */
  values: Rect;
  valuesPerRow: number;
  /** The shooting-mode rail: rotated words down the trailing edge (landscape), a row (portrait). */
  modeRail: Rect;
  record: Rect;
  media: Rect;
  /** Portrait: Fit / Fill beside record. Empty in landscape. */
  aspectToggle: Rect;
  stick: Rect;
  zoom: Rect;
  gimbal: Rect;
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
  /** How far strip controls may reach into the reported side insets (`IOS_INSET_OVERLAP` on iOS). */
  insetOverlap?: number;
  /** Quick icons in the column (flip, DISP, recenter); default 3. */
  quickCount?: number;
  /** Items in the lock group (lock, Picture in Picture); default 1. */
  lockCount?: number;
}

/** A column (or row) of `n` 44pt quick icons. */
export const quickExtent = (n: number) => Math.max(1, n) * QUICK_SIZE + Math.max(0, n - 1) * QUICK_GAP;

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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The panel's width: Mimo's panels cover at most ~40 % of the screen. */
export function panelWidth(viewportWidth: number, room: number) {
  return Math.round(Math.min(room, clamp(viewportWidth * 0.4, 290, 380)));
}

export function computeFieldMonitorLayout(input: FieldMonitorLayoutInput): FieldMonitorLayout {
  const safeArea = input.safeArea ?? { top: 0, leading: 0, bottom: 0, trailing: 0 };
  const showsValues = input.showsValues ?? true;
  const w = Math.max(1, Number.isFinite(input.width) ? input.width : 1);
  const h = Math.max(1, Number.isFinite(input.height) ? input.height : 1);
  const aspect = input.sourceAspect && input.sourceAspect > 0 ? input.sourceAspect : 16 / 9;
  const viewport = rect(0, 0, w, h);
  const portrait = h > w;
  const tablet = Math.min(w, h) >= 600;
  const disc = tablet ? RECORD_DISC_TABLET : RECORD_DISC;
  const stickSide = input.stickSide ?? (tablet ? LIVE_STICK_TABLET : LIVE_STICK);
  const quickN = Math.max(1, input.quickCount ?? 3);
  const lockN = Math.max(1, input.lockCount ?? 1);
  const edge = tablet ? 20 : portrait ? 16 : 12;
  const lead = safeArea.leading + edge;
  const trail = w - safeArea.trailing - edge;

  let picture: Rect, leadStrip: Rect, trailStrip: Rect, leading: Rect, back: Rect, quick: Rect, lock: Rect;
  let status: Rect, statusLead: Rect, values: Rect, modeRail: Rect, record: Rect, media: Rect;
  let aspectToggle: Rect, stick: Rect, stage: Rect;
  let fixed: Rect[];
  let fillsPicture: boolean;
  let sheet: MonitorSheetPlacement;

  if (portrait) {
    const headerTop = portraitHeaderSafeTop(w, h, safeArea.top);
    leadStrip = rect();
    trailStrip = rect();
    back = rect(lead - 10, headerTop + STATUS_ROW / 2 - MIN_TAP / 2, MIN_TAP, MIN_TAP);
    statusLead = rect(maxX(back) + 2, headerTop, w / 2 - maxX(back) - 2, STATUS_ROW);
    status = rect(w / 2, headerTop, trail - w / 2, STATUS_ROW);
    // Bottom: record centred, Fit/Fill leading of it, media trailing; the mode rail above it.
    const bottomY = h - Math.max(14, safeArea.bottom);
    record = rect((w - disc) / 2, bottomY - disc, disc, disc);
    const sideMid = (maxX(record) + trail) / 2;
    media = rect(Math.min(sideMid, maxX(record) + 110) - MIN_TAP / 2, midY(record) - MIN_TAP / 2, MIN_TAP, MIN_TAP);
    const leadMid = (lead + record.x) / 2;
    aspectToggle = rect(Math.max(leadMid, record.x - 110) - MIN_TAP / 2, midY(record) - MIN_TAP / 2, MIN_TAP, MIN_TAP);
    modeRail = rect(lead, record.y - 8 - MODE_ROW_H, trail - lead, MODE_ROW_H);
    stick = rect(trail - stickSide, modeRail.y - 10 - stickSide, stickSide, stickSide);

    const ceiling = maxY(status) + 8;
    fillsPicture = !!input.fill || aspect < 1;
    const rowsH = (showsValues ? READOUT_LINE_H + 8 : 0) + QUICK_SIZE + 8 + LEAD_ROW_H + 8;
    // Room for the picture above the rows and the gimbal cluster.
    const clusterTop = stick.y - CLUSTER_GAP - ZOOM_SIZE - 8;
    const room = Math.max(1, clusterTop - rowsH - ceiling);
    let overlaid = false;
    if (fillsPicture) {
      // Vertical or Fill: the picture takes the screen under the status row; rows float over it.
      const area = rect(0, ceiling, w, Math.max(1, modeRail.y - 8 - ceiling));
      picture = aspect < 1 && !input.fill ? fitting(area, aspect) : area;
      overlaid = true;
    } else {
      const fullH = w / aspect;
      picture = fullH <= room ? rect(0, ceiling, w, fullH) : fitting(rect(0, ceiling, w, room), aspect);
    }
    let quickRow: Rect;
    if (overlaid) {
      leading = rect(lead, ceiling + 6, trail - lead, LEAD_ROW_H);
      quickRow = rect(lead, maxY(leading) + 4, trail - lead, QUICK_SIZE);
      const valuesH = showsValues ? READOUT_LINE_H : 0;
      values = rect(lead, stick.y - CLUSTER_GAP - ZOOM_SIZE - 12 - valuesH, trail - lead, valuesH);
    } else {
      const valuesH = showsValues ? READOUT_LINE_H : 0;
      values = rect(lead, maxY(picture) + 8, trail - lead, valuesH);
      quickRow = rect(lead, maxY(values) + (showsValues ? 8 : 0), trail - lead, QUICK_SIZE);
      leading = rect(lead, maxY(quickRow) + 8, trail - lead, LEAD_ROW_H);
    }
    // The quick row: flip, DISP, recenter spread from the leading end, the lock group at the trailing end.
    const lockW = quickExtent(lockN);
    lock = rect(maxX(quickRow) - lockW, quickRow.y, lockW, QUICK_SIZE);
    quick = rect(quickRow.x, quickRow.y, Math.max(QUICK_SIZE, lock.x - 8 - quickRow.x), QUICK_SIZE);
    const below = overlaid ? h * 0.5 : maxY(picture) + 6;
    sheet = { dock: null, topInset: clamp(below, h * 0.3, h * 0.68), bottomInset: h - modeRail.y + 4 };
    // Movable chrome lives between the header's top and the mode rail.
    stage = rect(Math.max(0, safeArea.leading), headerTop, w - Math.max(0, safeArea.leading) - Math.max(0, safeArea.trailing), modeRail.y - 6 - headerTop);
    fixed = [back, leading];
  } else {
    // Mimo: the strips hold only what must stay on black and sit mostly in the unsafe area,
    // so the picture keeps the full height between them.
    const overlap = Math.max(0, input.insetOverlap ?? 0);
    const leadInset = Math.max(0, safeArea.leading - overlap);
    const trailInset = Math.max(0, safeArea.trailing - overlap);
    const column = tablet ? LEAD_STRIP_TABLET : LEAD_STRIP;
    const railW = tablet ? MODE_RAIL_W_TABLET : MODE_RAIL_W;
    const leftEdge = leadInset + column;
    const rightEdge = w - trailInset - (tablet ? TRAIL_STRIP_TABLET : TRAIL_STRIP);
    const tuck = tablet ? 0 : PICTURE_TUCK;
    const area = rect(leftEdge - tuck, 0, Math.max(1, rightEdge - leftEdge + tuck * 2), h);
    fillsPicture = !!input.fill;
    if (fillsPicture) {
      // Fill: the picture covers everything between the strips (cropped, never stretched).
      picture = area;
    } else {
      const fitted = fitting(area, aspect);
      // Centred on the screen like Mimo when the strips allow it.
      const px = clamp((w - fitted.width) / 2, area.x, maxX(area) - fitted.width);
      picture = rect(px, fitted.y, fitted.width, fitted.height);
    }
    leadStrip = rect(0, 0, leftEdge, h);
    trailStrip = rect(rightEdge, 0, w - rightEdge, h);

    const top = Math.max(6, safeArea.top + 4);
    const bottom = h - Math.max(6, safeArea.bottom);
    back = rect(leadInset + (column - MIN_TAP) / 2, top, MIN_TAP, MIN_TAP);
    leading = rect(leadInset, maxY(back), column, bottom - maxY(back));
    modeRail = rect(w - trailInset - railW, 0, railW, h);

    // The visible picture (between the strips, inside the safe height).
    const seenX = Math.max(picture.x, leftEdge);
    const seenR = Math.min(maxX(picture), rightEdge);
    const picTop = Math.max(picture.y, safeArea.top) + 6;
    const picBottom = Math.min(maxY(picture), h - safeArea.bottom) - 6;
    stage = rect(seenX, picTop - 6, seenR - seenX, picBottom - picTop + 12);

    // Mimo's trailing column over the picture: quick icons, record in the middle, lock, media.
    const colMid = seenR - (tablet ? 16 : 10) - disc / 2;
    record = rect(colMid - disc / 2, midY(stage) - disc / 2, disc, disc);
    media = rect(colMid - MIN_TAP / 2, picBottom - MIN_TAP, MIN_TAP, MIN_TAP);
    aspectToggle = rect();
    const quickH = Math.min(quickExtent(quickN), Math.max(QUICK_SIZE, record.y - 4 - picTop));
    quick = rect(colMid - QUICK_SIZE / 2, picTop, QUICK_SIZE, quickH);
    const lockRoom = media.y - 6 - (maxY(record) + 6);
    const lockH = Math.min(quickExtent(lockN), Math.max(QUICK_SIZE, lockRoom));
    lock = rect(colMid - QUICK_SIZE / 2, maxY(record) + 6 + Math.max(0, (lockRoom - lockH) / 2), QUICK_SIZE, lockH);
    fixed = [record, media];

    // Over the picture: status beside the top quick icon, the gimbal cluster bottom-trailing
    // leading of the column, the readout bottom-centre.
    status = rect(midX(stage), picTop + 2, quick.x - 4 - midX(stage), 28);
    statusLead = rect(seenX + 10, picTop + 2, midX(stage) - seenX - 10, 28);
    stick = rect(colMid - disc / 2 - 8 - stickSide, picBottom - 4 - stickSide, stickSide, stickSide);
    const centre = midX(stage);
    const half = Math.max(60, Math.min(centre - seenX - 12, stick.x - 8 - centre));
    const valuesH = showsValues ? READOUT_LINE_H : 0;
    values = rect(centre - half, picBottom - valuesH, half * 2, valuesH);

    const dockTop = Math.max(0, safeArea.top);
    sheet = {
      dock: { left: leftEdge, width: panelWidth(w, Math.max(200, quick.x - 8 - leftEdge)), top: dockTop, bottom: h - Math.max(0, safeArea.bottom) },
      topInset: 0,
    };
  }

  // Gimbal cluster (CONTEXT.md): zoom stacks above the stick, trailing-aligned; the gimbal
  // controls button sits leading of zoom, the same size. Same rule in every orientation.
  const zoom = rect(maxX(stick) - ZOOM_SIZE, stick.y - CLUSTER_GAP - ZOOM_SIZE, ZOOM_SIZE, ZOOM_SIZE);
  const gimbal = rect(zoom.x - CLUSTER_GAP - ZOOM_SIZE, zoom.y, ZOOM_SIZE, ZOOM_SIZE);

  return {
    viewport,
    picture,
    leadStrip,
    trailStrip,
    leading,
    back,
    quick,
    lock,
    stage,
    fixed,
    axis: portrait ? 'horizontal' : 'vertical',
    status,
    statusRows: 1,
    statusLead,
    values,
    valuesPerRow: 1,
    modeRail,
    record,
    media,
    aspectToggle,
    stick,
    zoom,
    gimbal,
    sheet,
    portrait,
    tablet,
    fillsPicture,
    safeArea,
  };
}
