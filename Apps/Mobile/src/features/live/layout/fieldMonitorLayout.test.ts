import { describe, expect, it } from 'vitest';
import { computeFieldMonitorLayout, maxX, maxY } from './fieldMonitorLayout';

describe('FieldMonitorLayout port', () => {
  it('landscape phone: record trailing-bottom, DISP above it, settings/media stacked', () => {
    const l = computeFieldMonitorLayout({ width: 844, height: 390 });
    expect(l.portrait).toBe(false);
    expect(l.record).toMatchObject({ x: 844 - 10 - 70, y: 390 - 12 - 70, width: 70 });
    expect(maxY(l.display)).toBe(l.record.y - 8);
    expect(l.media.y).toBe(maxY(l.settings) + 12);
  });

  it('gimbal cluster: zoom above the stick, controls button leading of zoom… trailing-aligned', () => {
    for (const [w, h] of [
      [844, 390],
      [390, 844],
    ]) {
      const l = computeFieldMonitorLayout({ width: w, height: h });
      expect(maxX(l.gimbal)).toBe(maxX(l.stick));
      expect(maxY(l.gimbal)).toBe(l.stick.y - 8);
      expect(maxX(l.zoom)).toBe(l.gimbal.x - 8);
      expect(l.zoom.y).toBe(l.gimbal.y);
    }
  });

  it('portrait phone: values above the system bar, picture full width', () => {
    const l = computeFieldMonitorLayout({ width: 390, height: 844, valueCount: 6 });
    expect(l.portrait).toBe(true);
    expect(l.picture.width).toBe(390);
    expect(maxY(l.values)).toBeLessThanOrEqual(l.system.y);
    expect(l.record.x).toBe((390 - 70) / 2);
  });
});
