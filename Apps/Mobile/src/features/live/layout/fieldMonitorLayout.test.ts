import { describe, expect, it } from 'vitest';
import { RECORD_SIZE, computeFieldMonitorLayout, intersects, maxX, maxY } from './fieldMonitorLayout';

describe('FieldMonitorLayout', () => {
  it('landscape phone: record centred in the trailing column, settings/media above, DISP/lock below', () => {
    const l = computeFieldMonitorLayout({ width: 844, height: 390 });
    expect(l.portrait).toBe(false);
    expect(l.record.width).toBe(RECORD_SIZE);
    expect(maxX(l.record)).toBe(844 - 12);
    expect(l.record.y + l.record.height / 2).toBeCloseTo((8 + 380) / 2);
    expect(maxY(l.settings)).toBeLessThan(l.media.y);
    expect(maxY(l.media)).toBeLessThan(l.record.y);
    expect(l.display.y).toBeGreaterThan(maxY(l.record));
    expect(l.lock.y).toBeGreaterThan(maxY(l.display));
    expect(maxY(l.lock)).toBeLessThanOrEqual(390);
    expect(l.settings.y).toBeGreaterThanOrEqual(0);
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

  it('landscape: the readout strip clears the assists and the stick', () => {
    const l = computeFieldMonitorLayout({ width: 844, height: 390, valueCount: 7 });
    expect(intersects(l.values, l.stick)).toBe(false);
    expect(intersects(l.values, l.assists)).toBe(false);
    expect(l.values.width).toBeGreaterThan(7 * 50);
  });

  it('portrait phone: strip above the bottom rail, picture full width, record centred', () => {
    const l = computeFieldMonitorLayout({ width: 390, height: 844, valueCount: 7 });
    expect(l.portrait).toBe(true);
    expect(l.picture.width).toBe(390);
    expect(maxY(l.values)).toBeLessThanOrEqual(l.system.y);
    expect(l.record.x).toBe((390 - RECORD_SIZE) / 2);
    expect(maxX(l.display)).toBeLessThan(l.record.x);
    expect(l.media.x).toBeGreaterThan(maxX(l.record));
    expect(l.sheet.topInset).toBeGreaterThanOrEqual(maxY(l.picture));
  });
});
