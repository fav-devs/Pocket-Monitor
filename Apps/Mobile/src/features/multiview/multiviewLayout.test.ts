import { describe, expect, it } from 'vitest';
import { intersects, isEmptyRect, maxX, maxY, type Rect } from '@/features/live/layout/fieldMonitorLayout';
import { addChoices } from './addChoices';
import { computeMultiviewLayout, type Arrangement } from './multiviewLayout';

const VIEWPORTS = [
  { name: 'phone landscape', width: 844, height: 390, safeArea: { top: 0, leading: 47, bottom: 21, trailing: 47 } },
  { name: 'phone portrait', width: 390, height: 844, safeArea: { top: 47, leading: 0, bottom: 34, trailing: 0 } },
  { name: 'tablet landscape', width: 1366, height: 1024, safeArea: { top: 24, leading: 0, bottom: 20, trailing: 0 } },
  { name: 'tablet portrait', width: 1024, height: 1366, safeArea: { top: 24, leading: 0, bottom: 20, trailing: 0 } },
];

const inside = (r: Rect, w: number, h: number) => r.x >= -0.5 && r.y >= -0.5 && maxX(r) <= w + 0.5 && maxY(r) <= h + 0.5;

describe('computeMultiviewLayout', () => {
  for (const vp of VIEWPORTS) {
    for (const arrangement of ['grid', 'center'] as Arrangement[]) {
      for (const selected of [0, 2]) {
        it(`${vp.name} ${arrangement} selected ${selected}: four separate tiles clear of the chrome`, () => {
          const l = computeMultiviewLayout({ ...vp, arrangement, selected, valueCount: 7 });
          expect(l.tiles).toHaveLength(4);
          l.tiles.forEach((t) => {
            expect(isEmptyRect(t)).toBe(false);
            expect(inside(t, vp.width, vp.height)).toBe(true);
          });
          for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) expect(intersects(l.tiles[a], l.tiles[b])).toBe(false);
          const chrome = [l.record, l.exit, l.layoutButton, l.fitButton, l.cameraButton, l.addButton];
          chrome.forEach((c) => {
            expect(inside(c, vp.width, vp.height)).toBe(true);
            l.tiles.forEach((t) => expect(intersects(c, t)).toBe(false));
          });
          if (arrangement === 'center') {
            expect(l.main).toBe(selected);
            const main = l.tiles[selected];
            // The selected camera is the large one, and keeps 16:9.
            l.tiles.forEach((t, i) => i !== selected && expect(t.width * t.height).toBeLessThan(main.width * main.height));
            expect(main.width / main.height).toBeCloseTo(16 / 9, 3);
            // Its readouts sit clear of every picture.
            expect(isEmptyRect(l.values)).toBe(false);
            l.tiles.forEach((t) => expect(intersects(l.values, t)).toBe(false));
            expect(isEmptyRect(l.zoom)).toBe(false);
          } else {
            expect(l.main).toBeNull();
            expect(isEmptyRect(l.values)).toBe(true);
          }
        });
      }
    }
  }

  it('phone portrait grid is four full-width rows; tablets use 2 × 2', () => {
    const phone = computeMultiviewLayout({ width: 390, height: 844, arrangement: 'grid', selected: 0 });
    expect(new Set(phone.tiles.map((t) => Math.round(t.x))).size).toBe(1);
    expect(phone.tiles[0].width).toBeCloseTo(358, 0);
    const tablet = computeMultiviewLayout({ width: 1024, height: 1366, arrangement: 'grid', selected: 0 });
    expect(new Set(tablet.tiles.map((t) => Math.round(t.x))).size).toBe(2);
    const landscape = computeMultiviewLayout({ width: 844, height: 390, arrangement: 'grid', selected: 0 });
    expect(landscape.tiles[0].width / landscape.tiles[0].height).toBeCloseTo(16 / 9, 3);
  });

  it('docks sheets beside the picture in landscape and under it in portrait', () => {
    expect(computeMultiviewLayout({ width: 844, height: 390, arrangement: 'center', selected: 0 }).sheet.dock).not.toBeNull();
    const p = computeMultiviewLayout({ width: 390, height: 844, arrangement: 'center', selected: 0 });
    expect(p.sheet.dock).toBeNull();
    expect(p.sheet.topInset).toBeGreaterThanOrEqual(maxY(p.tiles[0]));
  });
});


describe('addChoices', () => {
  it('lists saved cameras on the network first, then cameras to move, skipping the stage', () => {
    const groups = addChoices(
      [
        { id: 'a', name: 'A', model: 'osmo-pocket-3', path: { kind: 'station', ssid: 'Studio', host: '10.0.0.4' } },
        { id: 'b', name: 'B', model: 'osmo-nano', path: { kind: 'softap', ssid: 'OsmoNano-1' } },
        { id: 'c', name: 'C', model: 'osmo-pocket-4', path: { kind: 'station', ssid: 'Studio' } },
      ],
      [
        { id: 'b', name: 'B', model: 'osmo-nano', rssi: -50, pairable: true, saved: true },
        { id: 'd', name: 'D', model: 'osmo-pocket-4-pro', rssi: -60, pairable: true, saved: false },
      ],
      { ssid: 'Studio', hotspot: false },
      ['c'],
    );
    expect(groups.onNetwork.map((g) => [g.camera.id, g.camera.path])).toEqual([['a', { kind: 'station', ssid: 'Studio', host: '10.0.0.4' }]]);
    expect(groups.toMove.map((g) => g.camera.id)).toEqual(['b', 'd']);
    expect(groups.toMove[0].camera.path).toEqual({ kind: 'station', ssid: 'Studio' });
  });
});
