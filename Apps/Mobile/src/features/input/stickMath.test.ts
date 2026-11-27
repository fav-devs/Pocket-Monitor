import { describe, expect, it } from 'vitest';
import { TapSequence, analogCurve, applyStickMapping, expoExponent, mapTouch } from './stickMath';

describe('stick math (GimbalStick port)', () => {
  it('rests inside the deadzone and keeps full throw at 1', () => {
    expect(analogCurve(0.05)).toBe(0);
    expect(analogCurve(1)).toBe(1);
    expect(analogCurve(-1)).toBe(-1);
    expect(analogCurve(0.54)).toBeCloseTo(0.25, 2);
  });

  it('maps the 0.5 expo preference to the standard exponent 2', () => {
    expect(expoExponent(0.5)).toBe(2);
    expect(expoExponent(0)).toBe(1);
  });

  it('inverts pan for picture-relative selfie and locks direction', () => {
    const v = applyStickMapping(1, 0.5, { exponent: 1, invertPan: true, invertTilt: false, directionLock: true });
    expect(v.x).toBe(-1);
    expect(v.y).toBe(0);
  });

  it('maps touch: tap inside slop, command uses 1.35x radius, y up positive', () => {
    expect(mapTouch(2, 2, 100, 42, false).isTap).toBe(true);
    const m = mapTouch(0, -67.5, 100, 42, false);
    expect(m.commandY).toBeCloseTo(1, 5);
    expect(Math.abs(m.visualY)).toBeCloseTo(29, 5);
  });

  it('sequences double and triple taps', () => {
    const t = new TapSequence();
    expect(t.tap(0)).toBe('first');
    expect(t.tap(100)).toBe('second');
    expect(t.tap(200)).toBe('third');
    expect(t.tap(1000)).toBe('first');
    expect(t.tap(1100)).toBe('second');
    expect(t.commitDouble()).toBe(true);
  });
});
