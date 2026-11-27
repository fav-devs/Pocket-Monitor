import { describe, expect, it } from 'vitest';
import {
  IOS_INSET_OVERLAP,
  LEAD_STRIP,
  MIN_TAP,
  PICTURE_TUCK,
  TRAIL_STRIP,
  quickExtent,
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
  it('landscape phone: the picture keeps full height between two slim black strips (Mimo)', () => {
    const l = computeFieldMonitorLayout({ width: 844, height: 390 });
    expect(l.portrait).toBe(false);
    expect(l.picture.height).toBeCloseTo(390);
    expect(l.picture.width).toBeCloseTo((390 * 16) / 9);
    // The strips own the letterbox: the leading controls and back sit left of the picture.
    expect(l.leadStrip.width).toBe(LEAD_STRIP);
    expect(maxX(l.leading)).toBeLessThanOrEqual(l.picture.x + PICTURE_TUCK);
    expect(maxX(l.back)).toBeLessThanOrEqual(l.picture.x + PICTURE_TUCK);
    // Trailing strip: only the mode rail, against the edge.
    expect(maxX(l.modeRail)).toBe(844);
    expect(l.trailStrip.width).toBe(TRAIL_STRIP);
    // Record and media sit over the picture's trailing edge (Mimo's column), clear of the rail.
    expect(l.record.width).toBe(RECORD_DISC);
    expect(contains(l.picture, l.record.x, l.record.y)).toBe(true);
    expect(maxX(l.record)).toBeLessThanOrEqual(l.trailStrip.x);
    expect(maxX(l.media)).toBeLessThanOrEqual(l.trailStrip.x);
    expect(midY(l.record)).toBeCloseTo(195);
    expect(maxY(l.media)).toBeLessThanOrEqual(390);
    // Quick icons above record, the lock group under it, media at the foot: one column.
    expect(maxY(l.quick)).toBeLessThanOrEqual(l.record.y);
    expect(l.lock.y).toBeGreaterThanOrEqual(maxY(l.record));
    expect(maxY(l.lock)).toBeLessThanOrEqual(l.media.y);
    expect(midX(l.quick)).toBeCloseTo(midX(l.record));
    expect(midX(l.media)).toBeCloseTo(midX(l.record));
  });

  // Phones as they report themselves in landscape (pt), with their safe areas.
  const phones = [
    { name: 'iPhone 15/16 Pro', w: 852, h: 393, safe: { top: 0, leading: 59, bottom: 21, trailing: 59 }, overlap: IOS_INSET_OVERLAP },
    { name: 'iPhone 14', w: 844, h: 390, safe: { top: 0, leading: 47, bottom: 21, trailing: 47 }, overlap: IOS_INSET_OVERLAP },
    { name: 'iPhone SE', w: 667, h: 375, safe: { top: 0, leading: 0, bottom: 0, trailing: 0 }, overlap: IOS_INSET_OVERLAP },
    { name: 'Pixel 8', w: 915, h: 412, safe: { top: 0, leading: 0, bottom: 0, trailing: 0 }, overlap: 0 },
    { name: 'Android cutout', w: 780, h: 360, safe: { top: 0, leading: 32, bottom: 0, trailing: 0 }, overlap: 0 },
  ];

  it.each(phones)('$name: Fit keeps (nearly) the full height, like Mimo; strips stay out of the cutout', ({ w, h, safe, overlap, name }) => {
    const l = computeFieldMonitorLayout({ width: w, height: h, safeArea: safe, insetOverlap: overlap });
    // The SE is too short for a full-height 16:9 picture beside any strip; every other phone gets it.
    expect(l.picture.height).toBeGreaterThanOrEqual(name === 'iPhone SE' ? h * 0.9 : h - 1);
    // Strip controls stay out of the cutout (the inset minus the allowed overlap) and are 44pt.
    expect(l.back.x).toBeGreaterThanOrEqual(safe.leading - overlap);
    expect(l.leading.x).toBeGreaterThanOrEqual(safe.leading - overlap);
    expect(l.leading.width).toBeGreaterThanOrEqual(MIN_TAP);
    expect(maxX(l.modeRail)).toBeLessThanOrEqual(w - safe.trailing + overlap);
    // The column's controls stay above the home indicator.
    expect(maxY(l.media)).toBeLessThanOrEqual(h - safe.bottom);
    expect(maxY(l.lock)).toBeLessThanOrEqual(l.media.y);
    expect(l.lock.height).toBeGreaterThanOrEqual(MIN_TAP);
    expect(l.quick.height).toBeGreaterThanOrEqual(quickExtent(3));
  });

  it('iPhone 15 Pro: the picture is as large as Mimo\'s (full height, ~82 % of the screen)', () => {
    const l = computeFieldMonitorLayout({ width: 852, height: 393, safeArea: phones[0].safe, insetOverlap: IOS_INSET_OVERLAP });
    expect(l.picture.height).toBeGreaterThan(392);
    expect(l.picture.width).toBeGreaterThan(697);
    expect((l.picture.width * l.picture.height) / (852 * 393)).toBeGreaterThan(0.8);
  });

  it('landscape Fill covers everything between the strips at full height', () => {
    for (const p of phones) {
      const fit = computeFieldMonitorLayout({ width: p.w, height: p.h, safeArea: p.safe, insetOverlap: p.overlap });
      const fill = computeFieldMonitorLayout({ width: p.w, height: p.h, safeArea: p.safe, insetOverlap: p.overlap, fill: true });
      expect(fill.fillsPicture).toBe(true);
      expect(fill.picture.height).toBe(p.h);
      expect(fill.picture.width).toBeGreaterThanOrEqual(fit.picture.width - 0.5);
      expect(fill.picture.x).toBeCloseTo(fill.leadStrip.width - PICTURE_TUCK);
      expect(maxX(fill.picture)).toBeCloseTo(fill.trailStrip.x + PICTURE_TUCK);
    }
  });

  it('the stage is the visible picture in landscape and holds every movable rect', () => {
    for (const p of phones) {
      const l = computeFieldMonitorLayout({ width: p.w, height: p.h, safeArea: p.safe, insetOverlap: p.overlap });
      expect(l.stage.x).toBeGreaterThanOrEqual(l.leadStrip.width);
      expect(maxX(l.stage)).toBeLessThanOrEqual(l.trailStrip.x);
      for (const r of [l.quick, l.lock, l.stick, l.zoom, l.gimbal, l.values, l.record, l.media]) {
        expect(contains(l.stage, r.x, r.y, 0.5)).toBe(true);
        expect(contains(l.stage, maxX(r), maxY(r), 0.5)).toBe(true);
      }
      expect(l.fixed).toEqual([l.record, l.media]);
    }
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
      expect(l.sheet.dock!.left).toBeCloseTo(l.leadStrip.width);
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
    expect(l.lock.y).toBe(l.quick.y);
    expect(l.lock.x).toBeGreaterThan(maxX(l.quick));
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
    expect(maxX(l.picture)).toBeLessThanOrEqual(l.modeRail.x);
    expect(contains(l.picture, l.record.x, l.record.y)).toBe(true);
  });
});
