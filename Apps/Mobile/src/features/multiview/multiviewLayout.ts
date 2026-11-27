/**
 * Multiview stage geometry after OpenCine `MonitorPresentation/MultiviewPresentationLayout`:
 * four persistent slots in a grid (four rows on a portrait phone, 2 × 2 elsewhere) or Center
 * stage (the selected camera large, the others in a strip). Layout changes move the existing
 * pictures; they never create another camera or decoder. The system rail (record ring, round
 * rail buttons) follows this app's live monitor (`fieldMonitorLayout`). Pure geometry, tested.
 */
import {
  CLUSTER_GAP,
  RAIL_H,
  RAIL_W,
  READOUT_PAD,
  READOUT_TILE_H,
  RECORD_SIZE,
  STICK_SIDE,
  ZOOM_SIZE,
  maxX,
  maxY,
  readoutRows,
  rect,
  type MonitorSheetPlacement,
  type Rect,
  type SafeArea,
} from '@/features/live/layout/fieldMonitorLayout';

export type Arrangement = 'grid' | 'center';

export interface MultiviewLayoutInput {
  width: number;
  height: number;
  safeArea?: SafeArea;
  arrangement: Arrangement;
  selected: number;
  /** Capture readouts the selected camera shows (Center stage). */
  valueCount?: number;
}

export interface MultiviewLayout {
  viewport: Rect;
  portrait: boolean;
  tablet: boolean;
  arrangement: Arrangement;
  /** One rect per slot, in slot order. */
  tiles: Rect[];
  /** Center stage: the selected (large) slot. */
  main: number | null;
  /** Where the stage lives (empty state, notices). */
  stage: Rect;
  exit: Rect;
  network: Rect;
  record: Rect;
  layoutButton: Rect;
  fitButton: Rect;
  cameraButton: Rect;
  addButton: Rect;
  /** Center stage: the selected camera's capture readouts and gimbal cluster. Empty in grid. */
  values: Rect;
  valuesPerRow: number;
  zoom: Rect;
  gimbal: Rect;
  stick: Rect;
  sheet: MonitorSheetPlacement;
  safeArea: SafeArea;
}

const SLOTS = 4;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const empty = () => rect();

/** Fit `count` tiles of 16:9 into a `cols` × `rows` grid inside `area`, centred. */
function gridTiles(area: Rect, cols: number, rows: number, gap: number): Rect[] {
  let tileW = (area.width - gap * (cols - 1)) / cols;
  let tileH = (area.height - gap * (rows - 1)) / rows;
  // Phone portrait rows are wider than 16:9 on purpose (four rows); elsewhere keep 16:9.
  if (cols > 1 || rows === 1) {
    if (tileW / tileH > 16 / 9) tileW = tileH * (16 / 9);
    else tileH = tileW * (9 / 16);
  } else {
    tileH = Math.min(tileH, tileW * (9 / 16));
  }
  const totalW = tileW * cols + gap * (cols - 1);
  const totalH = tileH * rows + gap * (rows - 1);
  const x0 = area.x + (area.width - totalW) / 2;
  const y0 = area.y + Math.max(0, (area.height - totalH) / 2);
  return Array.from({ length: SLOTS }, (_, i) => rect(x0 + (i % cols) * (tileW + gap), y0 + Math.floor(i / cols) * (tileH + gap), tileW, tileH));
}

export function computeMultiviewLayout(input: MultiviewLayoutInput): MultiviewLayout {
  const safeArea = input.safeArea ?? { top: 0, leading: 0, bottom: 0, trailing: 0 };
  const w = Math.max(1, Number.isFinite(input.width) ? input.width : 1);
  const h = Math.max(1, Number.isFinite(input.height) ? input.height : 1);
  const portrait = h > w;
  const tablet = Math.min(w, h) >= 600;
  const selected = clamp(Math.round(input.selected || 0), 0, SLOTS - 1);
  const center = input.arrangement === 'center';
  const gap = tablet ? 12 : 8;
  const edge = tablet ? 20 : portrait ? 16 : 12;
  const lead = safeArea.leading + edge;
  const trail = w - safeArea.trailing - edge;
  const rec = RECORD_SIZE;

  let tiles: Rect[];
  let stage: Rect;
  let exit: Rect, network: Rect, record: Rect, layoutButton: Rect, fitButton: Rect, cameraButton: Rect, addButton: Rect;
  let values = empty();
  let valuesPerRow = 1;
  let zoom = empty();
  let gimbal = empty();
  let stick = empty();
  let sheet: MonitorSheetPlacement;

  if (portrait) {
    const top = Math.max(12, safeArea.top);
    exit = rect(lead - 6, top, RAIL_W, RAIL_H);
    network = rect(lead + RAIL_W, top + 4, trail - lead - RAIL_W * 2, 32);
    // Bottom rail (live monitor): layout · fit · record · camera · add.
    const systemH = rec + 16;
    const systemY = Math.max(0, h - Math.max(12, safeArea.bottom - 14) - systemH);
    const cy = systemY + systemH / 2;
    record = rect((w - rec) / 2, cy - rec / 2, rec, rec);
    const railY = cy - RAIL_H / 2;
    const leftMid = Math.max((lead + record.x - 8) / 2, record.x - 96);
    const rightMid = Math.min((maxX(record) + 8 + trail) / 2, maxX(record) + 96);
    layoutButton = rect(leftMid - RAIL_W - 4, railY, RAIL_W, RAIL_H);
    fitButton = rect(leftMid + 4, railY, RAIL_W, RAIL_H);
    cameraButton = rect(rightMid - RAIL_W - 4, railY, RAIL_W, RAIL_H);
    addButton = rect(rightMid + 4, railY, RAIL_W, RAIL_H);
    const stageTop = top + RAIL_H + 6;
    stage = rect(lead, stageTop, trail - lead, Math.max(1, systemY - 8 - stageTop));
    if (!center) {
      tiles = tablet ? gridTiles(stage, 2, 2, gap) : gridTiles(stage, 1, 4, gap);
      sheet = { dock: null, topInset: h * 0.5 };
    } else {
      const strip = readoutRows(input.valueCount, stage.width);
      valuesPerRow = strip.perRow;
      const valuesH = READOUT_PAD * 2 + strip.rows * READOUT_TILE_H;
      values = rect(lead, systemY - 4 - valuesH, stage.width, valuesH);
      const mainW = stage.width;
      const mainH = Math.min(mainW * (9 / 16), Math.max(1, values.y - stage.y - 200));
      const main = rect(lead + (stage.width - mainH * (16 / 9)) / 2, stage.y, mainH * (16 / 9), mainH);
      const thumbW = (stage.width - gap * 2) / 3;
      const thumbH = thumbW * (9 / 16);
      const thumbY = maxY(main) + gap;
      tiles = Array.from({ length: SLOTS }, () => empty());
      tiles[selected] = main;
      const others = [0, 1, 2, 3].filter((i) => i !== selected);
      others.forEach((slot, k) => (tiles[slot] = rect(lead + k * (thumbW + gap), thumbY, thumbW, thumbH)));
      const stickSide = STICK_SIDE;
      stick = rect(trail - stickSide, values.y - 12 - stickSide, stickSide, stickSide);
      zoom = rect(maxX(stick) - ZOOM_SIZE, stick.y - CLUSTER_GAP - ZOOM_SIZE, ZOOM_SIZE, ZOOM_SIZE);
      gimbal = rect(zoom.x - CLUSTER_GAP - ZOOM_SIZE, zoom.y, ZOOM_SIZE, ZOOM_SIZE);
      // The strip must not run under the cluster: push the cluster below it when it fits.
      if (zoom.y < thumbY + thumbH + gap) {
        zoom = rect(maxX(main) - 8 - ZOOM_SIZE, maxY(main) - 8 - ZOOM_SIZE, ZOOM_SIZE, ZOOM_SIZE);
        gimbal = rect(zoom.x - CLUSTER_GAP - ZOOM_SIZE, zoom.y, ZOOM_SIZE, ZOOM_SIZE);
      }
      sheet = { dock: null, topInset: clamp(maxY(main) + 10, h * 0.3, h * 0.68) };
    }
  } else {
    const top = Math.max(8, safeArea.top + 6);
    const bottom = h - (safeArea.bottom > 0 ? safeArea.bottom + 4 : 10);
    // Trailing column (live monitor): add · camera · record · layout · fit.
    const colX = trail - rec;
    const colMid = colX + rec / 2;
    const vgap = clamp((bottom - top - RAIL_H * 4 - rec) / 4, 4, tablet ? 28 : 18);
    record = rect(colX, (top + bottom) / 2 - rec / 2, rec, rec);
    cameraButton = rect(colMid - RAIL_W / 2, record.y - vgap - RAIL_H, RAIL_W, RAIL_H);
    addButton = rect(cameraButton.x, cameraButton.y - vgap - RAIL_H, RAIL_W, RAIL_H);
    layoutButton = rect(cameraButton.x, maxY(record) + vgap, RAIL_W, RAIL_H);
    fitButton = rect(cameraButton.x, maxY(layoutButton) + vgap, RAIL_W, RAIL_H);
    // Leading column: exit, and the network under it.
    exit = rect(lead - 6, top, RAIL_W, RAIL_H);
    network = rect(lead - 6, maxY(exit) + 8, RAIL_W, RAIL_H);
    const stageLeft = lead - 6 + RAIL_W + (tablet ? 16 : 10);
    const stageRight = colX - (tablet ? 20 : 14);
    stage = rect(stageLeft, top, Math.max(1, stageRight - stageLeft), Math.max(1, bottom - top));
    if (!center) {
      tiles = gridTiles(stage, 2, 2, gap);
      sheet = { dock: { left: stage.x, width: clamp(w * 0.42, 300, 400), top: stage.y, bottom: maxY(stage) }, topInset: 0 };
    } else {
      const valuesH = READOUT_PAD * 2 + READOUT_TILE_H;
      valuesPerRow = Math.max(1, input.valueCount ?? 7);
      const minThumb = Math.max(1, Math.min(tablet ? 200 : 140, (stage.width - gap) * 0.26));
      const mainW = Math.max(1, Math.min((stage.height - valuesH - gap) * (16 / 9), stage.width - minThumb - gap));
      const mainH = mainW * (9 / 16);
      const contentH = mainH + gap + valuesH;
      const y0 = stage.y + Math.max(0, (stage.height - contentH) / 2);
      const main = rect(stage.x, y0, mainW, mainH);
      values = rect(stage.x, maxY(main) + gap, mainW, valuesH);
      const thumbX = maxX(main) + gap;
      const thumbW = Math.max(1, stage.x + stage.width - thumbX);
      const thumbH = thumbW * (9 / 16);
      const stripGap = tablet ? 14 : gap;
      tiles = Array.from({ length: SLOTS }, () => empty());
      tiles[selected] = main;
      [0, 1, 2, 3]
        .filter((i) => i !== selected)
        .forEach((slot, k) => (tiles[slot] = rect(thumbX, y0 + k * (thumbH + stripGap), thumbW, thumbH)));
      const stripBottom = y0 + 3 * thumbH + 2 * stripGap;
      const stickSide = Math.min(STICK_SIDE, thumbW);
      const stickRoom = maxY(stage) - stripBottom - gap;
      if (stickRoom >= stickSide) stick = rect(maxX(stage) - stickSide, maxY(stage) - stickSide, stickSide, stickSide);
      zoom = rect(maxX(main) - 8 - ZOOM_SIZE, maxY(main) - 8 - ZOOM_SIZE, ZOOM_SIZE, ZOOM_SIZE);
      gimbal = rect(zoom.x - CLUSTER_GAP - ZOOM_SIZE, zoom.y, ZOOM_SIZE, ZOOM_SIZE);
      sheet = { dock: { left: stage.x, width: Math.min(clamp(w * 0.42, 300, 400), mainW), top: stage.y, bottom: maxY(stage) }, topInset: 0 };
    }
  }

  return {
    viewport: rect(0, 0, w, h),
    portrait,
    tablet,
    arrangement: center ? 'center' : 'grid',
    tiles,
    main: center ? selected : null,
    stage,
    exit,
    network,
    record,
    layoutButton,
    fitButton,
    cameraButton,
    addButton,
    values,
    valuesPerRow,
    zoom,
    gimbal,
    stick,
    sheet,
    safeArea,
  };
}
