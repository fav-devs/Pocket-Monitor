import { describe, expect, it } from 'vitest';
import { WIDE_LAYOUT_MIN_WIDTH, isWideWindow } from './wide';

describe('the wide layout breakpoint', () => {
  it('keeps phones, phones in landscape, portrait tablets and narrow windows on the phone layout', () => {
    expect(isWideWindow(390)).toBe(false);
    expect(isWideWindow(844)).toBe(false);
    expect(isWideWindow(820)).toBe(false);
    expect(isWideWindow(WIDE_LAYOUT_MIN_WIDTH - 1)).toBe(false);
  });

  it('gives desktop windows and landscape tablets the sidebar', () => {
    expect(isWideWindow(WIDE_LAYOUT_MIN_WIDTH)).toBe(true);
    expect(isWideWindow(1180)).toBe(true);
    expect(isWideWindow(1280)).toBe(true);
    expect(isWideWindow(1440)).toBe(true);
  });
});
