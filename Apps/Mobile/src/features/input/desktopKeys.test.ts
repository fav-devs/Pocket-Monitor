import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-router', () => ({ router: { back: vi.fn(), push: vi.fn() } }));
vi.mock('@/features/live/liveUiStore', () => ({ useLiveUi: { getState: () => ({ set: vi.fn() }) } }));

const { isDesktopKey, runDesktopKeyAction } = await import('./desktopKeys');
const { useDesktopGestures } = await import('@/camera/desktop/gestures');

const actions = {} as Parameters<typeof runDesktopKeyAction>[1];

afterEach(() => useDesktopGestures.setState({ handView: false, overlay: null }));

describe('the desktop keys', () => {
  it('sends Y and J to Rust, whatever the case', () => {
    for (const key of ['y', 'Y', 'j', 'J']) expect(isDesktopKey(key)).toBe(true);
    expect(isDesktopKey('q')).toBe(false);
  });

  it('Y shows and hides the hand view', () => {
    runDesktopKeyAction('toggle-hand-view', actions);
    expect(useDesktopGestures.getState().handView).toBe(true);
    runDesktopKeyAction('toggle-hand-view', actions);
    expect(useDesktopGestures.getState().handView).toBe(false);
  });

  it('J is already done in Rust', () => {
    expect(() => runDesktopKeyAction('toggle-gestures', actions)).not.toThrow();
    expect(useDesktopGestures.getState().handView).toBe(false);
  });
});
