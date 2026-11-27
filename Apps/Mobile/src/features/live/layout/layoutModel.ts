/**
 * Saved live-view layouts: where the movable chrome over the picture (quick icons, lock, status,
 * readout, zoom, gimbal button, stick, Motion Control pill) and the floating panels (scopes,
 * meters) sit. Pure TypeScript (no React) so it can be unit tested; the drag maths is marked
 * `'worklet'` so gestures run it on the UI thread.
 *
 * Positions are box centres normalized to a reference rect: movable items to the layout's
 * `stage` (the visible picture in landscape), panels to their bounds (the picture in the live
 * view). A layout keeps one set per slot (landscape, portrait, wide / desktop); a missing entry
 * means "the default position", so the shipped "Default" layout is simply empty.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Movable chrome over the picture. Strip controls, record, media and Fit/Fill stay fixed. */
export type MovableId = 'quick' | 'lock' | 'status' | 'statusLead' | 'values' | 'zoom' | 'gimbal' | 'stick' | 'runPill';

export const MOVABLE_IDS: MovableId[] = ['quick', 'lock', 'status', 'statusLead', 'values', 'zoom', 'gimbal', 'stick', 'runPill'];

export const MOVABLE_LABEL: Record<MovableId, string> = {
  quick: 'Quick icons',
  lock: 'Lock',
  status: 'Status',
  statusLead: 'Recording time',
  values: 'Exposure',
  zoom: 'Zoom',
  gimbal: 'Gimbal button',
  stick: 'Stick',
  runPill: 'Motion Control',
};

export type ItemSize = 'S' | 'M' | 'L';
export const SIZE_SCALE: Record<ItemSize, number> = { S: 0.85, M: 1, L: 1.2 };

/** Sizes an item offers. Buttons never shrink below their 44pt target. */
export const ITEM_SIZES: Record<MovableId, ItemSize[]> = {
  quick: ['M', 'L'],
  lock: ['M', 'L'],
  status: ['S', 'M', 'L'],
  statusLead: ['S', 'M', 'L'],
  values: ['S', 'M', 'L'],
  zoom: ['M', 'L'],
  gimbal: ['M', 'L'],
  stick: ['S', 'M', 'L'],
  runPill: [],
};

export type LayoutSlot = 'landscape' | 'portrait' | 'wide';
export const LAYOUT_SLOTS: LayoutSlot[] = ['landscape', 'portrait', 'wide'];

/** Portrait when taller than wide; wide from the desktop breakpoint (`WIDE_LAYOUT_MIN_WIDTH`). */
export function layoutSlot(width: number, height: number, wideMin = 960): LayoutSlot {
  if (height > width) return 'portrait';
  return width >= wideMin ? 'wide' : 'landscape';
}

export interface ItemPlacement {
  /** Centre, normalized to the stage (0…1). Absent: the default position. */
  cx?: number;
  cy?: number;
  size?: ItemSize;
}

export interface PanelPlacement {
  /** Centre, normalized to the panel's bounds (0…1). Absent: the panel's default spot. */
  cx?: number;
  cy?: number;
  /** Scopes: 0.6…1.6. */
  scale?: number;
}

export interface SlotLayout {
  items: Partial<Record<MovableId, ItemPlacement>>;
  panels: Partial<Record<string, PanelPlacement>>;
}

export interface SavedLayout {
  id: string;
  name: string;
  slots: Partial<Record<LayoutSlot, SlotLayout>>;
}

export interface LayoutsState {
  version: 1;
  layouts: SavedLayout[];
  activeId: string;
}

export const DEFAULT_LAYOUT_ID = 'default';
export const DEFAULT_LAYOUT_NAME = 'Default';

export const emptySlot = (): SlotLayout => ({ items: {}, panels: {} });

export function defaultLayouts(): LayoutsState {
  return { version: 1, layouts: [{ id: DEFAULT_LAYOUT_ID, name: DEFAULT_LAYOUT_NAME, slots: {} }], activeId: DEFAULT_LAYOUT_ID };
}

export function activeLayout(state: LayoutsState): SavedLayout {
  return state.layouts.find((l) => l.id === state.activeId) ?? state.layouts[0];
}

/** Shared (never mutated) so selectors return a stable value for a slot nobody has edited. */
const EMPTY_SLOT: SlotLayout = Object.freeze({ items: Object.freeze({}), panels: Object.freeze({}) }) as SlotLayout;

export function slotOf(layout: SavedLayout, slot: LayoutSlot): SlotLayout {
  return layout.slots[slot] ?? EMPTY_SLOT;
}

// ───────────────────────────── Geometry ─────────────────────────────

const clampNum = (v: number, lo: number, hi: number) => {
  'worklet';
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
};

export function boxCenter(b: Box): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** A box's centre as fractions of `ref` (what layouts store). */
export function normalizeCenter(b: Box, ref: Box): { cx: number; cy: number } {
  const c = boxCenter(b);
  return { cx: round4((c.x - ref.x) / Math.max(1, ref.width)), cy: round4((c.y - ref.y) / Math.max(1, ref.height)) };
}

/** A `size` box centred on a stored point in `ref`. */
export function boxFromNormalized(p: { cx: number; cy: number }, size: { width: number; height: number }, ref: Box): Box {
  const x = ref.x + p.cx * ref.width;
  const y = ref.y + p.cy * ref.height;
  return { x: x - size.width / 2, y: y - size.height / 2, width: size.width, height: size.height };
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Keeps a box inside `stage` (a box larger than the stage pins to its top-left). */
export function clampBox(b: Box, stage: Box): Box {
  'worklet';
  return {
    x: clampNum(b.x, stage.x, stage.x + stage.width - b.width),
    y: clampNum(b.y, stage.y, stage.y + stage.height - b.height),
    width: b.width,
    height: b.height,
  };
}

/** Where a box may snap: vertical lines (`xs`) and horizontal lines (`ys`). */
export interface SnapTargets {
  xs: number[];
  ys: number[];
}

export const SNAP_GRID = 8;
export const SNAP_DISTANCE = 8;
/** Inset from the stage edges an item snaps to. */
export const EDGE_MARGIN = 8;

/** Stage edges (inset), its centre lines and every other item's edges and centres. */
export function snapTargets(stage: Box, others: Box[], margin = EDGE_MARGIN): SnapTargets {
  const xs = [stage.x + margin, stage.x + stage.width / 2, stage.x + stage.width - margin];
  const ys = [stage.y + margin, stage.y + stage.height / 2, stage.y + stage.height - margin];
  for (const o of others) {
    if (o.width < 1 || o.height < 1) continue;
    xs.push(o.x, o.x + o.width / 2, o.x + o.width);
    ys.push(o.y, o.y + o.height / 2, o.y + o.height);
  }
  return { xs, ys };
}

export interface SnapResult {
  x: number;
  y: number;
  /** The line it snapped to on each axis (to draw a guide), or -1 for the grid. */
  guideX: number;
  guideY: number;
}

/** Best of a box's start / centre / end against `lines`; `-1` when nothing is close. */
function snapAxis(start: number, size: number, lines: number[], distance: number): { offset: number; line: number } {
  'worklet';
  let best = distance + 1;
  let offset = 0;
  let line = -1;
  const probes = [start, start + size / 2, start + size];
  for (let i = 0; i < lines.length; i++) {
    for (let k = 0; k < 3; k++) {
      const d = lines[i] - probes[k];
      if (Math.abs(d) < best) {
        best = Math.abs(d);
        offset = d;
        line = lines[i];
      }
    }
  }
  return best <= distance ? { offset, line } : { offset: 0, line: -1 };
}

/**
 * Snaps a dragged box: to the stage edges and centre lines and to other items' edges and centres
 * when within `distance`, otherwise to an 8pt grid from the stage's origin; then keeps it inside
 * the stage.
 */
export function snapBox(b: Box, stage: Box, targets: SnapTargets, distance = SNAP_DISTANCE, grid = SNAP_GRID): SnapResult {
  'worklet';
  const sx = snapAxis(b.x, b.width, targets.xs, distance);
  const sy = snapAxis(b.y, b.height, targets.ys, distance);
  const x = sx.line >= 0 ? b.x + sx.offset : stage.x + Math.round((b.x - stage.x) / grid) * grid;
  const y = sy.line >= 0 ? b.y + sy.offset : stage.y + Math.round((b.y - stage.y) / grid) * grid;
  const c = clampBox({ x, y, width: b.width, height: b.height }, stage);
  return { x: c.x, y: c.y, guideX: c.x === x ? sx.line : -1, guideY: c.y === y ? sy.line : -1 };
}

export function overlaps(a: Box, b: Box, gap = 0) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

/**
 * The nearest spot inside `stage` where `b` overlaps none of `obstacles` (keeping `gap`); the
 * clamped box when it is already clear or nothing fits.
 */
export function resolveOverlap(b: Box, stage: Box, obstacles: Box[], gap = 4): Box {
  const start = clampBox(b, stage);
  const blocked = obstacles.filter((o) => o.width >= 1 && o.height >= 1);
  const clear = (c: Box) => !blocked.some((o) => overlaps(c, o, gap));
  if (clear(start)) return start;
  const xs = [start.x, stage.x, stage.x + stage.width - b.width];
  const ys = [start.y, stage.y, stage.y + stage.height - b.height];
  for (const o of blocked) {
    xs.push(o.x - gap - b.width, o.x + o.width + gap);
    ys.push(o.y - gap - b.height, o.y + o.height + gap);
  }
  let best: Box | null = null;
  let nearest = Infinity;
  for (const x of xs)
    for (const y of ys) {
      const c = clampBox({ x, y, width: b.width, height: b.height }, stage);
      const d = (c.x - start.x) ** 2 + (c.y - start.y) ** 2;
      if (d < nearest && clear(c)) {
        best = c;
        nearest = d;
      }
    }
  return best ?? start;
}

/** Corners and edge midpoints of `bounds` a panel snaps to when its centre comes within `distance`. */
export function panelSnap(center: Point, size: { width: number; height: number }, bounds: Box, distance = 24): Point {
  'worklet';
  const minX = bounds.x + size.width / 2;
  const maxX = bounds.x + bounds.width - size.width / 2;
  const minY = bounds.y + size.height / 2;
  const maxY = bounds.y + bounds.height - size.height / 2;
  let x = clampNum(center.x, minX, maxX);
  let y = clampNum(center.y, minY, maxY);
  const midX = bounds.x + bounds.width / 2;
  const midY = bounds.y + bounds.height / 2;
  if (x - minX < distance) x = minX;
  else if (maxX - x < distance) x = maxX;
  else if (Math.abs(x - midX) < distance / 2) x = clampNum(midX, minX, maxX);
  if (y - minY < distance) y = minY;
  else if (maxY - y < distance) y = maxY;
  else if (Math.abs(y - midY) < distance / 2) y = clampNum(midY, minY, maxY);
  return { x, y };
}

// ───────────────────────────── Layout CRUD ─────────────────────────────

/** "Layout 2", or `base 2`, `base 3`… so names stay unique. */
export function uniqueName(names: string[], base = 'Layout'): string {
  const taken = new Set(names.map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base.trim();
  for (let i = 2; ; i++) {
    const n = `${base.trim()} ${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

let counter = 0;
export function newLayoutId(now = Date.now()): string {
  counter = (counter + 1) % 1000;
  return `l${now.toString(36)}${counter.toString(36)}`;
}

const cloneSlots = (slots: SavedLayout['slots']): SavedLayout['slots'] => JSON.parse(JSON.stringify(slots ?? {}));

/** Saves the active layout's placements as a new layout and makes it active. */
export function saveAsNew(state: LayoutsState, name?: string, id = newLayoutId()): LayoutsState {
  const from = activeLayout(state);
  const n = cleanName(name) ?? uniqueName(state.layouts.map((l) => l.name), 'Layout');
  return { ...state, layouts: [...state.layouts, { id, name: uniqueName(state.layouts.map((l) => l.name), n), slots: cloneSlots(from.slots) }], activeId: id };
}

/** A copy of `sourceId` ("Name copy"), placed after it and made active. */
export function duplicateLayout(state: LayoutsState, sourceId: string, id = newLayoutId()): LayoutsState {
  const i = state.layouts.findIndex((l) => l.id === sourceId);
  if (i < 0) return state;
  const src = state.layouts[i];
  const copy: SavedLayout = { id, name: uniqueName(state.layouts.map((l) => l.name), `${src.name} copy`), slots: cloneSlots(src.slots) };
  const layouts = [...state.layouts];
  layouts.splice(i + 1, 0, copy);
  return { ...state, layouts, activeId: id };
}

const cleanName = (name?: string) => {
  const n = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
  return n.length ? n : undefined;
};

export function renameLayout(state: LayoutsState, id: string, name: string): LayoutsState {
  const n = cleanName(name);
  if (!n) return state;
  const others = state.layouts.filter((l) => l.id !== id).map((l) => l.name);
  return { ...state, layouts: state.layouts.map((l) => (l.id === id ? { ...l, name: uniqueName(others, n) } : l)) };
}

/** Removes a layout; the last one never goes. Deleting the active one activates its neighbour. */
export function deleteLayout(state: LayoutsState, id: string): LayoutsState {
  if (state.layouts.length <= 1) return state;
  const i = state.layouts.findIndex((l) => l.id === id);
  if (i < 0) return state;
  const layouts = state.layouts.filter((l) => l.id !== id);
  const activeId = state.activeId === id ? layouts[Math.max(0, i - 1)].id : state.activeId;
  return { ...state, layouts, activeId };
}

export function switchLayout(state: LayoutsState, id: string): LayoutsState {
  return state.layouts.some((l) => l.id === id) ? { ...state, activeId: id } : state;
}

function updateActiveSlot(state: LayoutsState, slot: LayoutSlot, fn: (s: SlotLayout) => SlotLayout): LayoutsState {
  const active = activeLayout(state);
  const next = fn(slotOf(active, slot));
  return { ...state, layouts: state.layouts.map((l) => (l.id === active.id ? { ...l, slots: { ...l.slots, [slot]: next } } : l)) };
}

export function setItem(state: LayoutsState, slot: LayoutSlot, id: MovableId, patch: ItemPlacement): LayoutsState {
  return updateActiveSlot(state, slot, (s) => ({ ...s, items: { ...s.items, [id]: { ...s.items[id], ...patch } } }));
}

/** Back to the default position (and size). */
export function resetItem(state: LayoutsState, slot: LayoutSlot, id: MovableId): LayoutsState {
  return updateActiveSlot(state, slot, (s) => {
    const items = { ...s.items };
    delete items[id];
    return { ...s, items };
  });
}

export function setPanel(state: LayoutsState, slot: LayoutSlot, id: string, patch: PanelPlacement): LayoutsState {
  return updateActiveSlot(state, slot, (s) => ({ ...s, panels: { ...s.panels, [id]: { ...s.panels[id], ...patch } } }));
}

/** Every item and panel in one slot back to default. */
export function resetSlot(state: LayoutsState, slot: LayoutSlot): LayoutsState {
  return updateActiveSlot(state, slot, () => emptySlot());
}

/** Restores one slot of the active layout (undo). */
export function replaceSlot(state: LayoutsState, slot: LayoutSlot, value: SlotLayout): LayoutsState {
  return updateActiveSlot(state, slot, () => value);
}

/** One panel back to its default spot and size in every slot of the active layout. */
export function resetPanel(state: LayoutsState, id: string): LayoutsState {
  const active = activeLayout(state);
  const slots: SavedLayout['slots'] = {};
  for (const k of LAYOUT_SLOTS) {
    const s = active.slots[k];
    if (!s) continue;
    const panels = { ...s.panels };
    delete panels[id];
    slots[k] = { ...s, panels };
  }
  return { ...state, layouts: state.layouts.map((l) => (l.id === active.id ? { ...l, slots } : l)) };
}

/** Panels back to default in every slot of the active layout (items stay). */
export function resetPanels(state: LayoutsState): LayoutsState {
  const active = activeLayout(state);
  const slots: SavedLayout['slots'] = {};
  for (const k of LAYOUT_SLOTS) {
    const s = active.slots[k];
    if (s) slots[k] = { ...s, panels: {} };
  }
  return { ...state, layouts: state.layouts.map((l) => (l.id === active.id ? { ...l, slots } : l)) };
}

// ───────────────────────────── Migration ─────────────────────────────

/** The assists store's old per-orientation panel placements (`pm.assists.v1` → `panels`). */
export type LegacyPanels = Partial<
  Record<string, Partial<Record<'landscape' | 'portrait', { center?: { xFraction: number; yFraction: number }; scale?: number }>>>
>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unit = (v: unknown) => (isNum(v) ? Math.min(1, Math.max(0, v)) : undefined);

function sanitizeSlot(raw: unknown): SlotLayout {
  const out = emptySlot();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as { items?: Record<string, unknown>; panels?: Record<string, unknown> };
  for (const id of MOVABLE_IDS) {
    const p = r.items?.[id] as ItemPlacement | undefined;
    if (!p || typeof p !== 'object') continue;
    const item: ItemPlacement = {};
    const cx = unit(p.cx);
    const cy = unit(p.cy);
    if (cx != null && cy != null) Object.assign(item, { cx, cy });
    if (p.size && ITEM_SIZES[id].includes(p.size)) item.size = p.size;
    if (Object.keys(item).length) out.items[id] = item;
  }
  for (const [id, v] of Object.entries(r.panels ?? {})) {
    const p = v as PanelPlacement;
    if (!p || typeof p !== 'object') continue;
    const panel: PanelPlacement = {};
    const cx = unit(p.cx);
    const cy = unit(p.cy);
    if (cx != null && cy != null) Object.assign(panel, { cx, cy });
    if (isNum(p.scale)) panel.scale = Math.min(1.6, Math.max(0.6, p.scale));
    if (Object.keys(panel).length) out.panels[id] = panel;
  }
  return out;
}

/** Old assists panel placements as panel entries for one slot. */
export function panelsFromLegacy(legacy: LegacyPanels | undefined, slot: 'landscape' | 'portrait'): SlotLayout['panels'] {
  const out: SlotLayout['panels'] = {};
  for (const [id, slots] of Object.entries(legacy ?? {})) {
    const p = slots?.[slot];
    if (!p) continue;
    const panel: PanelPlacement = {};
    const cx = unit(p.center?.xFraction);
    const cy = unit(p.center?.yFraction);
    if (cx != null && cy != null) Object.assign(panel, { cx, cy });
    if (isNum(p.scale)) panel.scale = Math.min(1.6, Math.max(0.6, p.scale));
    if (Object.keys(panel).length) out[id] = panel;
  }
  return out;
}

/**
 * Whatever was saved (or nothing) → a valid state. No saved layouts gives the Default layout;
 * old scope positions from the assists store move into it when it has none of its own.
 */
export function migrateLayouts(persisted: unknown, legacyPanels?: LegacyPanels): LayoutsState {
  const base = defaultLayouts();
  const p = persisted as Partial<LayoutsState> | null | undefined;
  const seen = new Set<string>();
  const layouts: SavedLayout[] = [];
  for (const raw of Array.isArray(p?.layouts) ? p!.layouts : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const slots: SavedLayout['slots'] = {};
    for (const k of LAYOUT_SLOTS) if (raw.slots?.[k]) slots[k] = sanitizeSlot(raw.slots[k]);
    layouts.push({ id: raw.id, name: cleanName(raw.name) ?? uniqueName(layouts.map((l) => l.name)), slots });
  }
  if (!layouts.length) layouts.push(base.layouts[0]);
  const activeId = layouts.some((l) => l.id === p?.activeId) ? (p!.activeId as string) : layouts[0].id;
  let state: LayoutsState = { version: 1, layouts, activeId };
  if (legacyPanels) state = importLegacyPanels(state, legacyPanels);
  return state;
}

/** Copies old scope placements into the Default layout's slots that have no panels yet. */
export function importLegacyPanels(state: LayoutsState, legacy: LegacyPanels): LayoutsState {
  const target = state.layouts.find((l) => l.id === DEFAULT_LAYOUT_ID) ?? state.layouts[0];
  const slots = { ...target.slots };
  const map: [LayoutSlot, 'landscape' | 'portrait'][] = [
    ['landscape', 'landscape'],
    ['wide', 'landscape'],
    ['portrait', 'portrait'],
  ];
  let changed = false;
  for (const [slot, from] of map) {
    const current = slots[slot] ?? emptySlot();
    if (Object.keys(current.panels).length) continue;
    const panels = panelsFromLegacy(legacy, from);
    if (!Object.keys(panels).length) continue;
    slots[slot] = { ...current, panels };
    changed = true;
  }
  if (!changed) return state;
  return { ...state, layouts: state.layouts.map((l) => (l.id === target.id ? { ...l, slots } : l)) };
}
