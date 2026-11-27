import { describe, expect, it } from 'vitest';
import { MODE_RAIL_W, RECORD_SIZE, STATUS_ROW, computeFieldMonitorLayout, intersects, maxX, maxY } from './fieldMonitorLayout';

describe('FieldMonitorLayout', () => {
  it('landscape phone: mode rail on the trailing edge, record beside it, settings/media above, DISP/lock below', () => {
    const l = computeFieldMonitorLayout({ width: 844, height: 390 });
    expect(l.portrait).toBe(false);
    expect(l.record.width).toBe(RECORD_SIZE);
    expect(maxX(l.modeRail)).toBe(844 - 12);
    expect(l.modeRail.width).toBe(MODE_RAIL_W);
    expect(maxX(l.record)).toBeLessThanOrEqual(l.modeRail.x);
    expect(l.record.y + l.record.height / 2).toBeCloseTo((8 + 380) / 2);
    expect(maxY(l.settings)).toBeLessThan(l.media.y);
    expect(maxY(l.media)).toBeLessThan(l.record.y);
    expect(l.display.y).toBeGreaterThan(maxY(l.record));
    expect(l.lock.y).toBeGreaterThan(maxY(l.display));
    expect(maxY(l.lock)).toBeLessThanOrEqual(390);
    expect(l.settings.y).toBeGreaterThanOrEqual(0);
    // Picture first: the frame keeps full height and stays clear of the mode rail.
    expect(l.picture.height).toBeCloseTo(390);
    expect(maxX(l.picture)).toBeLessThanOrEqual(l.modeRail.x);
  });

  it('status is one row in every orientation, clear of the record column', () => {
    for (const [w, h] of [
      [844, 390],
      [390, 844],
      [1366, 1024],
      [1024, 1366],
    ]) {
      const l = computeFieldMonitorLayout({ width: w, height: h });
      expect(l.statusRows).toBe(1);
      expect(l.status.height).toBe(STATUS_ROW);
      expect(intersects(l.status, l.record)).toBe(false);
      expect(intersects(l.status, l.settings)).toBe(false);
    }
  });

  it('gimbal cluster: zoom above the stick trailing-aligned, controls button leading of zoom', () => {
    for (const [w, h] of [
      [844, 390],
      [390, 844],
      [1366, 1024],
    ]) {
      const l = computeFieldMonitorLayout({ width: w, height: h });
      expect(maxX(l.zoom)).toBe(maxX(l.stick));
      expect(maxY(l.zoom)).toBe(l.stick.y - 8);
      expect(maxX(l.gimbal)).toBe(l.zoom.x - 8);
      expect(l.gimbal.y).toBe(l.zoom.y);
      expect(l.gimbal.width).toBe(l.zoom.width);
    }
  });

  it('landscape: the readout text clears the assists and the stick', () => {
    const l = computeFieldMonitorLayout({ width: 844, height: 390 });
    expect(intersects(l.values, l.stick)).toBe(false);
    expect(intersects(l.values, l.assists)).toBe(false);
    expect(l.values.height).toBeLessThanOrEqual(32);
  });

  it('portrait phone: readout above the bottom rail, mode rail under record, picture full width', () => {
    const l = computeFieldMonitorLayout({ width: 390, height: 844 });
    expect(l.portrait).toBe(true);
    expect(l.picture.width).toBe(390);
    expect(maxY(l.values)).toBeLessThanOrEqual(l.system.y);
    expect(l.record.x).toBe((390 - RECORD_SIZE) / 2);
    expect(l.modeRail.y).toBeGreaterThanOrEqual(maxY(l.record));
    expect(maxY(l.modeRail)).toBeLessThanOrEqual(844);
    expect(maxX(l.display)).toBeLessThan(l.record.x);
    expect(l.media.x).toBeGreaterThan(maxX(l.record));
    expect(l.sheet.topInset).toBeGreaterThanOrEqual(maxY(l.picture));
  });
});
