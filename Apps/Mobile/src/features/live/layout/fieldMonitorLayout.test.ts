import { describe, expect, it } from 'vitest';
import {
  LEAD_STRIP,
  RECORD_DISC,
  STATUS_ROW,
  computeFieldMonitorLayout,
  contains,
  intersects,
  maxX,
  maxY,
  midX,
  midY,
} from './fieldMonitorLayout';

describe('FieldMonitorLayout', () => {
  it('landscape phone: the picture keeps full height between two black strips (Mimo)', () => {
    const l = computeFieldMonitorLayout({ width: 844, height: 390 });
    expect(l.portrait).toBe(false);
    expect(l.picture.height).toBeCloseTo(390);
    expect(l.picture.width).toBeCloseTo((390 * 16) / 9);
    // The strips own the letterbox: the leading controls and back sit left of the picture.
    expect(l.leadStrip.width).toBe(LEAD_STRIP);
    expect(maxX(l.leading)).toBeLessThanOrEqual(l.picture.x + 6);
    expect(maxX(l.back)).toBeLessThanOrEqual(l.picture.x);
    // Trailing strip: record and media right of the picture, the mode rail against the edge.
    expect(l.record.width).toBe(RECORD_DISC);
    expect(l.record.x).toBeGreaterThanOrEqual(maxX(l.picture));
    expect(l.media.x).toBeGreaterThanOrEqual(maxX(l.picture));
    expect(maxX(l.modeRail)).toBe(844);
    expect(maxX(l.record)).toBeLessThanOrEqual(l.modeRail.x);
    expect(midY(l.record)).toBeCloseTo(195);
    expect(maxY(l.media)).toBeLessThanOrEqual(390);
  });

  it('landscape: only status, quick icons, the gimbal cluster and the readout sit over the picture', () => {
    const l = computeFieldMonitorLayout({ width: 844, height: 390 });
    for (const r of [l.quick, l.status, l.statusLead, l.stick, l.zoom, l.gimbal, l.values]) {
      expect(contains(l.picture, r.x, r.y)).toBe(true);
      expect(contains(l.picture, maxX(r), maxY(r))).toBe(true);
    }
    // Quick icons run down the picture's trailing edge; status sits leading of them.
    expect(maxX(l.status)).toBeLessThanOrEqual(l.quick.x);
    expect(intersects(l.values, l.stick)).toBe(false);
    expect(midX(l.values)).toBeCloseTo(midX(l.picture));
  });

  it('landscape: panels dock against the leading strip and cover at most ~45% of the width', () => {
    for (const [w, h] of [
      [844, 390],
      [932, 430],
      [1366, 1024],
    ]) {
      const l = computeFieldMonitorLayout({ width: w, height: h });
      expect(l.sheet.dock).not.toBeNull();
      expect(l.sheet.dock!.left).toBeCloseTo(l.picture.x);
      expect(l.sheet.dock!.width).toBeLessThanOrEqual(w * 0.45);
    }
  });

  it('status is one row in every orientation, clear of record', () => {
    for (const [w, h] of [
      [844, 390],
      [390, 844],
      [1366, 1024],
      [1024, 1366],
    ]) {
      const l = computeFieldMonitorLayout({ width: w, height: h });
      expect(l.statusRows).toBe(1);
      expect(l.status.height).toBeLessThanOrEqual(STATUS_ROW);
      expect(intersects(l.status, l.record)).toBe(false);
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

  it('portrait phone: picture on top, then readout, quick icons and leading rows, mode rail above record', () => {
    const l = computeFieldMonitorLayout({ width: 390, height: 844 });
    expect(l.portrait).toBe(true);
    expect(l.axis).toBe('horizontal');
    expect(l.picture.width).toBe(390);
    expect(l.picture.y).toBeGreaterThanOrEqual(maxY(l.status));
    expect(l.values.y).toBeGreaterThanOrEqual(maxY(l.picture));
    expect(l.quick.y).toBeGreaterThanOrEqual(maxY(l.values));
    expect(l.leading.y).toBeGreaterThanOrEqual(maxY(l.quick));
    expect(maxY(l.leading)).toBeLessThanOrEqual(l.zoom.y);
    expect(maxY(l.modeRail)).toBeLessThanOrEqual(l.record.y);
    expect(maxY(l.stick)).toBeLessThanOrEqual(l.modeRail.y);
    expect(l.record.x).toBe((390 - l.record.width) / 2);
    expect(maxY(l.record)).toBeLessThanOrEqual(844);
    expect(l.media.x).toBeGreaterThan(maxX(l.record));
    expect(maxX(l.aspectToggle)).toBeLessThan(l.record.x);
    expect(l.sheet.topInset).toBeGreaterThanOrEqual(maxY(l.picture));
  });

  it('tablet landscape: the same strips with larger targets, picture letterboxed between them', () => {
    const l = computeFieldMonitorLayout({ width: 1366, height: 1024 });
    expect(l.tablet).toBe(true);
    expect(l.record.width).toBeGreaterThan(RECORD_DISC);
    expect(l.picture.x).toBeGreaterThanOrEqual(maxX(l.leading) - 1);
    expect(maxX(l.picture)).toBeLessThanOrEqual(l.record.x);
  });
});
