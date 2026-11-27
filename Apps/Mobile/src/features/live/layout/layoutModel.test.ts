import { describe, expect, it } from 'vitest';
import { computeFieldMonitorLayout } from './fieldMonitorLayout';
import {
  DEFAULT_LAYOUT_ID,
  activeLayout,
  boxFromNormalized,
  clampBox,
  defaultLayouts,
  deleteLayout,
  duplicateLayout,
  importLegacyPanels,
  layoutSlot,
  migrateLayouts,
  normalizeCenter,
  overlaps,
  panelSnap,
  renameLayout,
  replaceSlot,
  resetItem,
  resetPanel,
  resetPanels,
  resetSlot,
  resolveOverlap,
  saveAsNew,
  setItem,
  setPanel,
  slotOf,
  snapBox,
  snapTargets,
  switchLayout,
  uniqueName,
  type Box,
} from './layoutModel';

const stage: Box = { x: 100, y: 0, width: 600, height: 400 };

describe('layout slots', () => {
  it('portrait, phone landscape and wide (desktop / tablet landscape)', () => {
    expect(layoutSlot(393, 852)).toBe('portrait');
    expect(layoutSlot(852, 393)).toBe('landscape');
    expect(layoutSlot(915, 412)).toBe('landscape');
    expect(layoutSlot(1440, 900)).toBe('wide');
    expect(layoutSlot(1366, 1024)).toBe('wide');
  });
});

describe('normalized storage', () => {
  it('round-trips a box through its normalized centre', () => {
    const b = { x: 420, y: 230, width: 44, height: 132 };
    const n = normalizeCenter(b, stage);
    expect(n.cx).toBeCloseTo((442 - 100) / 600, 4);
    expect(n.cy).toBeCloseTo(296 / 400, 4);
    const back = boxFromNormalized(n, b, stage);
    expect(back.x).toBeCloseTo(b.x, 1);
    expect(back.y).toBeCloseTo(b.y, 1);
  });

  it('scales with the picture: the same spot on a bigger picture', () => {
    const b = { x: 640, y: 20, width: 44, height: 44 };
    const n = normalizeCenter(b, stage);
    const big = { x: 0, y: 0, width: 1200, height: 800 };
    const moved = boxFromNormalized(n, b, big);
    expect(moved.x + 22).toBeCloseTo(((662 - 100) / 600) * 1200, 0);
    expect(moved.y + 22).toBeCloseTo((42 / 400) * 800, 0);
  });
});

describe('clamping', () => {
  it('keeps a box inside the stage', () => {
    expect(clampBox({ x: 50, y: -20, width: 44, height: 44 }, stage)).toMatchObject({ x: 100, y: 0 });
    expect(clampBox({ x: 690, y: 390, width: 44, height: 44 }, stage)).toMatchObject({ x: 656, y: 356 });
    // Larger than the stage: pinned to its origin rather than flipping.
    expect(clampBox({ x: 300, y: 380, width: 800, height: 40 }, stage)).toMatchObject({ x: 100, y: 360 });
  });
});

describe('snapping', () => {
  const targets = snapTargets(stage, [{ x: 400, y: 100, width: 60, height: 44 }]);

  it('snaps an edge to the stage edge margin', () => {
    const r = snapBox({ x: 113, y: 203, width: 44, height: 44 }, stage, targets);
    expect(r.x).toBe(108);
    expect(r.guideX).toBe(108);
  });

  it('snaps centres to the stage centre line', () => {
    const r = snapBox({ x: 375, y: 57, width: 44, height: 44 }, stage, targets);
    expect(r.x + 22).toBe(400);
  });

  it('aligns with another item’s edge or centre', () => {
    // Its left edge 3pt from the other item's right edge.
    const r = snapBox({ x: 463, y: 300, width: 44, height: 44 }, stage, targets);
    expect(r.x).toBe(460);
    const t = snapBox({ x: 200, y: 103, width: 44, height: 44 }, stage, targets);
    expect(t.y).toBe(100);
    expect(t.guideY).toBe(100);
  });

  it('falls back to the 8pt grid from the stage origin', () => {
    const r = snapBox({ x: 251, y: 261, width: 30, height: 30 }, stage, { xs: [], ys: [] });
    expect((r.x - stage.x) % 8).toBe(0);
    expect(r.y % 8).toBe(0);
    expect(r.guideX).toBe(-1);
    expect(r.guideY).toBe(-1);
  });

  it('never snaps out of the stage', () => {
    const r = snapBox({ x: 690, y: 395, width: 44, height: 44 }, stage, targets);
    expect(r.x + 44).toBeLessThanOrEqual(700);
    expect(r.y + 44).toBeLessThanOrEqual(400);
  });

  it('panels snap to corners, edges and centre lines of their bounds', () => {
    const size = { width: 200, height: 120 };
    expect(panelSnap({ x: 115, y: 75 }, size, stage)).toEqual({ x: 200, y: 60 });
    expect(panelSnap({ x: 590, y: 330 }, size, stage)).toEqual({ x: 600, y: 340 });
    expect(panelSnap({ x: 405, y: 205 }, size, stage)).toEqual({ x: 400, y: 200 });
    expect(panelSnap({ x: 340, y: 150 }, size, stage)).toEqual({ x: 340, y: 150 });
    // Dragged off screen: clamped back on.
    expect(panelSnap({ x: -500, y: 900 }, size, stage)).toEqual({ x: 200, y: 340 });
  });
});

describe('overlap', () => {
  it('moves a dropped box to the nearest clear spot', () => {
    const record = { x: 600, y: 172, width: 56, height: 56 };
    const dropped = { x: 610, y: 180, width: 44, height: 44 };
    const r = resolveOverlap(dropped, stage, [record]);
    expect(overlaps(r, record, 4)).toBe(false);
    expect(Math.hypot(r.x - dropped.x, r.y - dropped.y)).toBeLessThan(80);
  });

  it('leaves a clear box alone', () => {
    const b = { x: 200, y: 200, width: 44, height: 44 };
    expect(resolveOverlap(b, stage, [{ x: 400, y: 0, width: 40, height: 40 }])).toEqual(b);
  });

  it('default live positions do not overlap each other or the fixed controls', () => {
    for (const [w, h] of [
      [852, 393],
      [667, 375],
      [915, 412],
      [393, 852],
      [1440, 900],
    ]) {
      const l = computeFieldMonitorLayout({ width: w, height: h, quickCount: 3, lockCount: 2 });
      const items = [l.quick, l.lock, l.stick, l.zoom, l.gimbal, l.values, ...l.fixed];
      for (let i = 0; i < items.length; i++)
        for (let k = i + 1; k < items.length; k++) expect(overlaps(items[i], items[k]), `${w}x${h} ${i}/${k}`).toBe(false);
    }
  });
});

describe('layout CRUD', () => {
  it('starts with one active Default layout', () => {
    const s = defaultLayouts();
    expect(s.layouts).toHaveLength(1);
    expect(activeLayout(s).name).toBe('Default');
    expect(slotOf(activeLayout(s), 'landscape')).toEqual({ items: {}, panels: {} });
  });

  it('save as new copies the active placements and activates the copy', () => {
    let s = setItem(defaultLayouts(), 'landscape', 'zoom', { cx: 0.2, cy: 0.8 });
    s = saveAsNew(s, 'Handheld', 'a');
    expect(s.activeId).toBe('a');
    expect(activeLayout(s).name).toBe('Handheld');
    expect(slotOf(activeLayout(s), 'landscape').items.zoom).toEqual({ cx: 0.2, cy: 0.8 });
    // Editing the copy leaves Default alone.
    s = setItem(s, 'landscape', 'zoom', { cx: 0.5 });
    expect(slotOf(s.layouts[0], 'landscape').items.zoom).toEqual({ cx: 0.2, cy: 0.8 });
    expect(slotOf(activeLayout(s), 'landscape').items.zoom).toEqual({ cx: 0.5, cy: 0.8 });
  });

  it('names stay unique and non-empty', () => {
    expect(uniqueName(['Default', 'Layout'], 'Layout')).toBe('Layout 2');
    let s = saveAsNew(defaultLayouts(), 'default', 'a');
    expect(activeLayout(s).name).toBe('default 2');
    s = renameLayout(s, 'a', '   ');
    expect(activeLayout(s).name).toBe('default 2');
    s = renameLayout(s, 'a', '  Tripod   rig ');
    expect(activeLayout(s).name).toBe('Tripod rig');
  });

  it('duplicate, switch and delete', () => {
    let s = duplicateLayout(defaultLayouts(), DEFAULT_LAYOUT_ID, 'b');
    expect(s.layouts.map((l) => l.name)).toEqual(['Default', 'Default copy']);
    expect(s.activeId).toBe('b');
    s = switchLayout(s, DEFAULT_LAYOUT_ID);
    expect(s.activeId).toBe(DEFAULT_LAYOUT_ID);
    expect(switchLayout(s, 'nope')).toBe(s);
    s = switchLayout(s, 'b');
    s = deleteLayout(s, 'b');
    expect(s.layouts).toHaveLength(1);
    expect(s.activeId).toBe(DEFAULT_LAYOUT_ID);
    // The last layout never goes.
    expect(deleteLayout(s, DEFAULT_LAYOUT_ID)).toBe(s);
  });

  it('reset an item, a slot, the panels; undo restores a slot', () => {
    let s = setItem(defaultLayouts(), 'portrait', 'stick', { cx: 0.1, cy: 0.1, size: 'L' });
    s = setItem(s, 'portrait', 'quick', { cx: 0.3, cy: 0.3 });
    s = setPanel(s, 'portrait', 'histogram', { cx: 0.5, cy: 0.5, scale: 1.2 });
    const before = slotOf(activeLayout(s), 'portrait');
    s = resetItem(s, 'portrait', 'stick');
    expect(slotOf(activeLayout(s), 'portrait').items.stick).toBeUndefined();
    expect(slotOf(activeLayout(s), 'portrait').items.quick).toBeDefined();
    s = setPanel(s, 'landscape', 'histogram', { cx: 0.2, cy: 0.2 });
    s = setPanel(s, 'landscape', 'waveform', { cx: 0.8, cy: 0.8 });
    s = setItem(s, 'landscape', 'lock', { cx: 0.9, cy: 0.9 });
    s = resetPanel(s, 'histogram');
    expect(slotOf(activeLayout(s), 'landscape').panels).toEqual({ waveform: { cx: 0.8, cy: 0.8 } });
    expect(slotOf(activeLayout(s), 'portrait').panels.histogram).toBeUndefined();
    s = resetPanels(s);
    expect(slotOf(activeLayout(s), 'portrait').panels).toEqual({});
    s = resetSlot(s, 'portrait');
    expect(slotOf(activeLayout(s), 'portrait')).toEqual({ items: {}, panels: {} });
    s = replaceSlot(s, 'portrait', before);
    expect(slotOf(activeLayout(s), 'portrait')).toEqual(before);
    // Resetting portrait leaves landscape alone.
    expect(slotOf(activeLayout(s), 'landscape').items.lock).toEqual({ cx: 0.9, cy: 0.9 });
  });
});

describe('migration', () => {
  it('nothing saved → Default', () => {
    expect(migrateLayouts(undefined)).toEqual(defaultLayouts());
    expect(migrateLayouts({})).toEqual(defaultLayouts());
    expect(migrateLayouts({ layouts: [] })).toEqual(defaultLayouts());
  });

  it('round-trips through JSON (what AsyncStorage keeps)', () => {
    let s = setItem(defaultLayouts(), 'landscape', 'values', { cx: 0.5, cy: 0.9, size: 'S' });
    s = saveAsNew(s, 'Gimbal', 'g');
    s = setPanel(s, 'wide', 'waveform', { cx: 0.1, cy: 0.9, scale: 1.1 });
    expect(migrateLayouts(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('drops junk, clamps fractions, repairs a missing active id', () => {
    const m = migrateLayouts({
      activeId: 'gone',
      layouts: [
        { id: 'x', name: '', slots: { landscape: { items: { zoom: { cx: 2, cy: -1, size: 'XL' }, nope: { cx: 0.5, cy: 0.5 } }, panels: { histogram: { scale: 9 } } } } },
        { id: 'x', name: 'Dup', slots: {} },
        null,
      ],
    });
    expect(m.layouts).toHaveLength(1);
    expect(m.activeId).toBe('x');
    expect(m.layouts[0].name).toBe('Layout');
    expect(m.layouts[0].slots.landscape!.items).toEqual({ zoom: { cx: 1, cy: 0 } });
    expect(m.layouts[0].slots.landscape!.panels).toEqual({ histogram: { scale: 1.6 } });
  });

  it('old scope positions (assists store) move into Default once', () => {
    const legacy = {
      histogram: { landscape: { center: { xFraction: 0.9, yFraction: 0.1 }, scale: 1.2 }, portrait: {} },
      waveform: { landscape: {}, portrait: { center: { xFraction: 0.2, yFraction: 0.7 } } },
    };
    const s = migrateLayouts(undefined, legacy);
    const d = activeLayout(s);
    expect(d.slots.landscape!.panels.histogram).toEqual({ cx: 0.9, cy: 0.1, scale: 1.2 });
    expect(d.slots.wide!.panels.histogram).toEqual({ cx: 0.9, cy: 0.1, scale: 1.2 });
    expect(d.slots.portrait!.panels.waveform).toEqual({ cx: 0.2, cy: 0.7 });
    // A slot that already has panels keeps them.
    const kept = setPanel(defaultLayouts(), 'landscape', 'histogram', { cx: 0.5, cy: 0.5 });
    expect(slotOf(activeLayout(importLegacyPanels(kept, legacy)), 'landscape').panels.histogram).toEqual({ cx: 0.5, cy: 0.5 });
  });
});
