/**
 * Live monitor geometry, laid out like DJI Mimo's camera screen. In landscape the picture sits
 * between two solid black letterbox strips that hold the chrome: the leading strip (back,
 * exposure mode, format, tracking, assists, more) and the trailing strip (the rotated
 * shooting-mode rail, the record disc and media). Over the picture only a few small things
 * float: status, a column of quick icons, the gimbal cluster and the exposure readout.
 * Portrait keeps the picture on top and turns the strips into rows under it.
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
/** Leading strip width (landscape), phone and tablet, before the safe area. */
export const LEAD_STRIP = 64;
export const LEAD_STRIP_TABLET = 88;
/** Trailing strip width (landscape): the record column plus the mode rail. */
export const TRAIL_STRIP = 94;
export const TRAIL_STRIP_TABLET = 124;
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
  /** Quick icons (flip, DISP, recenter, lock): a column over the picture's trailing edge, a row in portrait. */
  quick: Rect;
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
  const edge = tablet ? 20 : portrait ? 16 : 12;
  const lead = safeArea.leading + edge;
  const trail = w - safeArea.trailing - edge;

  let picture: Rect, leadStrip: Rect, trailStrip: Rect, leading: Rect, back: Rect, quick: Rect;
  let status: Rect, statusLead: Rect, values: Rect, modeRail: Rect, record: Rect, media: Rect;
  let aspectToggle: Rect, stick: Rect;
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
    if (overlaid) {
      leading = rect(lead, ceiling + 6, trail - lead, LEAD_ROW_H);
      quick = rect(lead, maxY(leading) + 4, trail - lead, QUICK_SIZE);
      const valuesH = showsValues ? READOUT_LINE_H : 0;
      values = rect(lead, stick.y - CLUSTER_GAP - ZOOM_SIZE - 12 - valuesH, trail - lead, valuesH);
    } else {
      const valuesH = showsValues ? READOUT_LINE_H : 0;
      values = rect(lead, maxY(picture) + 8, trail - lead, valuesH);
      quick = rect(lead, maxY(values) + (showsValues ? 8 : 0), trail - lead, QUICK_SIZE);
      leading = rect(lead, maxY(quick) + 8, trail - lead, LEAD_ROW_H);
    }
    const below = overlaid ? h * 0.5 : maxY(picture) + 6;
    sheet = { dock: null, topInset: clamp(below, h * 0.3, h * 0.68), bottomInset: h - modeRail.y + 4 };
  } else {
    fillsPicture = false;
    const leadW = (tablet ? LEAD_STRIP_TABLET : LEAD_STRIP) + safeArea.leading;
    const trailW = (tablet ? TRAIL_STRIP_TABLET : TRAIL_STRIP) + safeArea.trailing;
    const leftEdge = leadW;
    const rightEdge = w - trailW;
    // The picture may tuck a few points under each strip's empty edge to keep its full height.
    const slack = tablet ? 0 : 6;
    const fitted = fitting(rect(leftEdge - slack, 0, Math.max(1, rightEdge - leftEdge + slack * 2), h), aspect);
    // Centred on the screen like Mimo when the strips allow it.
    const px = clamp((w - fitted.width) / 2, leftEdge - slack, rightEdge + slack - fitted.width);
    picture = rect(px, fitted.y, fitted.width, fitted.height);
    leadStrip = rect(0, 0, leftEdge, h);
    trailStrip = rect(rightEdge, 0, w - rightEdge, h);

    const top = Math.max(6, safeArea.top + 4);
    const bottom = h - Math.max(6, safeArea.bottom);
    const leadX = safeArea.leading + ((tablet ? LEAD_STRIP_TABLET : LEAD_STRIP) - MIN_TAP) / 2;
    back = rect(leadX, top, MIN_TAP, MIN_TAP);
    leading = rect(safeArea.leading, maxY(back), tablet ? LEAD_STRIP_TABLET : LEAD_STRIP, bottom - maxY(back));

    // Trailing strip: the rotated mode rail against the edge, the record column inside it.
    const railW = tablet ? MODE_RAIL_W_TABLET : MODE_RAIL_W;
    modeRail = rect(w - safeArea.trailing - railW, 0, railW, h);
    const colMid = (Math.max(rightEdge, maxX(picture)) + modeRail.x) / 2;
    record = rect(colMid - disc / 2, h / 2 - disc / 2, disc, disc);
    media = rect(colMid - MIN_TAP / 2, bottom - MIN_TAP - 4, MIN_TAP, MIN_TAP);
    aspectToggle = rect();

    // Over the picture: quick icons down its trailing edge, status beside the top one, the
    // gimbal cluster bottom-trailing leading of the column, the readout bottom-centre.
    const picTop = Math.max(picture.y, safeArea.top) + 6;
    const picBottom = Math.min(maxY(picture), h - safeArea.bottom) - 6;
    quick = rect(maxX(picture) - 8 - QUICK_SIZE, picTop, QUICK_SIZE, picBottom - picTop);
    status = rect(midX(picture), picTop + 2, quick.x - 4 - midX(picture), 28);
    statusLead = rect(picture.x + 12, picTop + 2, midX(picture) - picture.x - 12, 28);
    stick = rect(quick.x - 8 - stickSide, picBottom - 4 - stickSide, stickSide, stickSide);
    const centre = midX(picture);
    const half = Math.max(60, Math.min(centre - picture.x - 12, stick.x - 8 - centre));
    const valuesH = showsValues ? READOUT_LINE_H : 0;
    values = rect(centre - half, picBottom - valuesH, half * 2, valuesH);

    const dockTop = Math.max(0, safeArea.top);
    sheet = {
      dock: { left: picture.x, width: panelWidth(w, Math.max(200, quick.x - 8 - picture.x)), top: dockTop, bottom: h - Math.max(0, safeArea.bottom) },
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
