/**
 * Port of OpenCine `FieldMonitorLayout` + `GimbalCluster` (MonitorPresentation).
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

/** `MonitorSystemButtonMetrics.side`. */
export const SYSTEM_BUTTON = 48;
export const MIN_TAP = 44;
export const SETTINGS_MEDIA_GAP = 12;
/** `MonitorJoystickSize.medium`. */
export const STICK_SIDE = 101;
/** `GimbalCluster` constants. */
export const ZOOM_SIZE = 44;
export const CLUSTER_GAP = 8;
const FRAME_ASPECT = 16 / 9;
/** `MonitorAssistPaletteLayout` padding/spacing/expansion. */
const PALETTE_PADDING = 4;
const PALETTE_SPACING = 6;
const PALETTE_EXPANSION = 16;
const PALETTE_INSETS = PALETTE_PADDING * 2 + PALETTE_SPACING + PALETTE_EXPANSION;

export interface FieldMonitorLayout {
  viewport: Rect;
  picture: Rect;
  status: Rect;
  values: Rect;
  system: Rect;
  lock: Rect;
  gauges: Rect;
  telemetry: Rect;
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
  back: Rect;
  portrait: boolean;
  tablet: boolean;
  fillsPicture: boolean;
  recordingReadoutTrailingInset: number;
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

export function portraitValuesHeight(count: number | undefined, tablet: boolean) {
  if (tablet) return 43;
  const columns = 3;
  const rows = count != null ? Math.ceil(Math.max(1, count) / columns) : 2;
  return 74 + Math.max(0, rows - 2) * 42;
}

function portraitHeaderSafeTop(w: number, h: number, safeTop: number) {
  return h > w && w < 600 ? Math.max(44, safeTop) : safeTop;
}

function landscapeFrame(w: number, h: number, cut: number, aspect: number): Rect {
  const imageW = Math.min(w - 2 * cut, h * aspect);
  const imageH = imageW / aspect;
  return rect((w - imageW) / 2, (h - imageH) / 2, imageW, imageH);
}

function landscapeBottomClearance(safeBottom: number) {
  return safeBottom > 0 ? Math.max(safeBottom, 14) + 10 : 8;
}

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
  const rec = tablet ? 84 : 70;
  const button = SYSTEM_BUTTON;
  const hasHome = safeArea.bottom > 0;
  const edge = 14;

  let picture: Rect, status: Rect, values: Rect, system: Rect, lock: Rect, gauges: Rect, telemetry: Rect;
  let settings: Rect, media: Rect, record: Rect, display: Rect, assists: Rect, stick: Rect;
  let aspectToggle: Rect, exposureGauge: Rect, back: Rect;
  let fillsPicture: boolean;
  let floor: number;

  if (portrait) {
    const systemH = tablet ? 116 : 100;
    const systemY = Math.max(0, h - Math.max(0, safeArea.bottom - 24) - systemH);
    system = rect(0, systemY, w, h - systemY);
    const valuesH = showsValues ? portraitValuesHeight(input.valueCount, tablet) : 0;
    const valuesY = systemY - 8 - valuesH;
    values = rect(edge, valuesY + 4, w - 28, valuesH);
    floor = valuesY - (showsValues ? 8 : 0);
    fillsPicture = !!input.fill || aspect < 1;
    const ratio = fillsPicture ? Math.min(aspect, 9 / 16) : aspect;
    const statusH = tablet ? 52 : 44;
    const headerLift = tablet ? 0 : 6;
    const headerSafeTop = portraitHeaderSafeTop(w, h, safeArea.top);
    const headerLeading = tablet ? edge : Math.max(16, safeArea.leading + 8);
    const headerTrailing = tablet ? edge : Math.max(16, safeArea.trailing + 8);
    status = rect(headerLeading, Math.max(0, headerSafeTop - headerLift), Math.max(0, w - headerLeading - headerTrailing), statusH);
    const pictureAnchor = Math.max(0, safeArea.top);
    const ceiling = pictureAnchor + statusH;
    const pillarbox = tablet && w / ratio > Math.max(0, floor - ceiling);
    const pictureH = pillarbox ? Math.max(1, floor - ceiling) : w / ratio;
    const pictureW = pillarbox ? pictureH * ratio : w;
    let pictureY: number;
    let vertical: Rect | null = null;
    if (aspect < 1 && !pillarbox) {
      const room = Math.max(1, systemY - pictureAnchor);
      const fittedH = Math.min(w / aspect, room);
      const fittedW = fittedH * aspect;
      pictureY = Math.max(pictureAnchor, systemY - fittedH);
      vertical = rect((w - fittedW) / 2, pictureY, fittedW, fittedH);
    } else if (pictureH > h || pictureH > floor - ceiling) {
      pictureY = (h - pictureH) / 2;
    } else {
      const ideal = (h - pictureH) / 2;
      pictureY = Math.max(ceiling, Math.min(ideal, floor - pictureH));
    }
    picture = vertical ?? rect((w - pictureW) / 2, pictureY, pictureW, pictureH);
    const cy = systemY + systemH / 2;
    lock = rect(edge, cy - button / 2, button, button);
    display = rect(edge + button + 8, lock.y, button, button);
    record = rect((w - rec) / 2, cy - rec / 2, rec, rec);
    settings = rect(w - edge - button, lock.y, button, button);
    media = rect(settings.x - button - SETTINGS_MEDIA_GAP, lock.y, button, button);
    const cornerTop = Math.max(0, headerSafeTop - 24);
    const gaugeTop = tablet ? 82 : Math.max(4, cornerTop - 16);
    gauges = rect(tablet ? edge : w - edge - 122, gaugeTop, tablet ? 64 : 122, tablet ? 76 : 22);
    telemetry = tablet ? gauges : rect(w - headerTrailing - 122, gaugeTop + 13 - headerLift, 122, 22);
    assists = rect(edge, floor - 16 - (button + 35), button + 8, button + 35);
    stick = rect(w - 16 - stickSide, floor - 16 - stickSide, stickSide, stickSide);
    aspectToggle = rect(w / 2 - 24, floor - 56, 48, 48);
    exposureGauge = rect(edge, Math.max(status.y + status.height + 52, picture.y + picture.height * 0.28), 30, 156);
    back = rect(edge, status.y + status.height + 4, MIN_TAP, MIN_TAP);
  } else {
    fillsPicture = false;
    const cut = Math.max(0, Math.max(safeArea.leading, safeArea.trailing) - 14);
    const frame = landscapeFrame(w, h, cut, FRAME_ASPECT);
    picture = aspect < FRAME_ASPECT ? fitting(frame, aspect) : landscapeFrame(w, h, cut, aspect);
    const anchor = aspect < FRAME_ASPECT && frame.height < h - 0.5 ? frame : picture;
    system = rect();
    const bottom = hasHome ? 16 : 12;
    record = rect(w - 10 - rec, h - bottom - rec, rec, rec);
    const cutoutHeight = safeArea.trailing >= 55 ? 112 : 124;
    const availableDisplayHeight =
      safeArea.trailing > 0 && !tablet ? record.y - 8 - (h + cutoutHeight) / 2 - 4 : button;
    const dispH = Math.max(36, Math.min(button, availableDisplayHeight));
    display = rect(midX(record) - button / 2, record.y - 8 - dispH, button, dispH);
    const hasCutout = Math.max(safeArea.leading, safeArea.trailing) > 0;
    const cornerClearance = hasCutout && !tablet ? h * 0.025 : 0;
    const cornerTop = (tablet ? 12 : hasCutout ? 8 : 52) + cornerClearance;
    settings = rect(
      tablet ? w - 14 - button * 2 - SETTINGS_MEDIA_GAP : midX(record) - button / 2,
      cornerTop,
      button,
      button,
    );
    media = rect(
      tablet ? maxX(settings) + SETTINGS_MEDIA_GAP : settings.x,
      tablet ? cornerTop : maxY(settings) + SETTINGS_MEDIA_GAP,
      button,
      button,
    );
    lock = rect(18, cornerTop, button, button);
    const gaugeGap = Math.max(6, (MIN_TAP - (tablet ? 22 : 20)) / 2);
    gauges = rect(18, maxY(lock) + gaugeGap, tablet ? 64 : 58, tablet ? 76 : 68);
    telemetry = gauges;
    const statusX = Math.max(77, anchor.x + 12);
    status = rect(statusX, tablet ? 4 : 0, settings.x - statusX - 12, tablet ? 46 : 44);
    const side = 14 + rec + 28;
    const valuesH = showsValues ? 43 : 0;
    const bottomPad = landscapeBottomClearance(safeArea.bottom);
    const valuesY = h - bottomPad - valuesH;
    values = rect(side, valuesY + 4, w - side * 2, valuesH);
    floor = valuesY - 8;
    const assistHeight = button * 2 + PALETTE_PADDING * 2 + PALETTE_SPACING;
    assists = rect(18, h - bottomPad - assistHeight, button + PALETTE_INSETS, assistHeight);
    stick = rect(w - Math.max(16 + rec + 12, safeArea.trailing + 6) - stickSide, floor - stickSide, stickSide, stickSide);
    aspectToggle = rect();
    const gaugeX = Math.max(maxX(gauges) + 10, picture.x + 10);
    const gaugeTopY = maxY(status) + 8;
    exposureGauge = rect(gaugeX, gaugeTopY, 30, Math.max(90, Math.min(220, assists.y - 12 - gaugeTopY)));
    back = rect(18 + (button - MIN_TAP) / 2, maxY(gauges) + 10, MIN_TAP, MIN_TAP);
  }

  // GimbalCluster.stacked with the gimbal-controls button on: button trailing above the
  // stick, zoom leading of the button, both zoom-sized. Same rule in every orientation.
  const zoomY = stick.y - CLUSTER_GAP - ZOOM_SIZE;
  const gimbal = rect(maxX(stick) - ZOOM_SIZE, zoomY, ZOOM_SIZE, ZOOM_SIZE);
  const zoom = rect(gimbal.x - CLUSTER_GAP - ZOOM_SIZE, zoomY, ZOOM_SIZE, ZOOM_SIZE);

  return {
    viewport,
    picture,
    status,
    values,
    system,
    lock,
    gauges,
    telemetry,
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
    back,
    portrait,
    tablet,
    fillsPicture,
    recordingReadoutTrailingInset: portrait ? 0 : Math.max(8, maxX(status) - maxX(picture) + 12),
    safeArea,
  };
}

/** `MonitorCapturePopupLayout` (bottom/top capture drawers). */
export interface CapturePopupLayout {
  edge: 'top' | 'bottom';
  width: number;
  centerX: number;
  top: number;
  bottom: number;
  maximumHeight: number;
  topPadding: number;
  bottomPadding: number;
  topRadius: number;
  bottomRadius: number;
}

export function capturePopupLayout(
  viewport: Rect,
  tablet: boolean,
  safe: SafeArea,
  edge: 'top' | 'bottom',
  opts: { bottomBoundary?: number; topBoundary?: number } = {},
): CapturePopupLayout {
  const w = viewport.width;
  const h = viewport.height;
  const portrait = h > w;
  const left = Math.min(w, Math.max(14, safe.leading + 8));
  const right = Math.max(left, w - Math.max(14, safe.trailing + 8));
  const width = Math.min(tablet ? 620 : 480, Math.max(0, right - left));
  const centerX = Math.min(right - width / 2, Math.max(left + width / 2, w / 2));
  const bottom = Math.min(h, Math.max(0, opts.bottomBoundary ?? h));
  const margin = Math.max(8, safe.top + 8);
  if (edge === 'bottom') {
    return {
      edge,
      width,
      centerX,
      top: margin,
      bottom,
      maximumHeight: Math.max(0, bottom - margin),
      topPadding: 11,
      bottomPadding: Math.max(12, safe.bottom > 0 ? safe.bottom + 6 : 12),
      topRadius: 16,
      bottomRadius: portrait ? 16 : 0,
    };
  }
  const top = Math.min(h, Math.max(margin, opts.topBoundary ?? 0));
  return {
    edge,
    width,
    centerX,
    top,
    bottom,
    maximumHeight: Math.max(0, bottom - top),
    topPadding: portrait ? 12 : 16,
    bottomPadding: 14,
    topRadius: 16,
    bottomRadius: 16,
  };
}
