import { describe, expect, it } from 'vitest';
import { SETTINGS_LIST_WIDTH, SIDEBAR_WIDTH } from '@/constants/wide';
import {
  defaultGlassMode,
  flatGlass,
  glassModeOptions,
  materialStripWidth,
  parseCaps,
  previewCaps,
  resolveGlass,
  type GlassCaps,
  type GlassInputs,
} from './state';
import {
  NATIVE_ATTRIBUTE,
  RESIZE_SETTLE_MS,
  createGlassSync,
  intersect,
  isWhollyInside,
  snapRect,
  type GlassNode,
  type NativeGlassItem,
  type RectLike,
} from './sync';

const tahoe: GlassCaps = { material: 'vibrancy', glassControls: true };
const sequoia: GlassCaps = { material: 'vibrancy', glassControls: false };
const windows11: GlassCaps = { material: 'mica', glassControls: false };
const windows10: GlassCaps = { material: 'none', glassControls: false };

const inputs = (over: Partial<GlassInputs>): GlassInputs => ({
  caps: tahoe,
  mode: undefined,
  shell: true,
  reducedTransparency: false,
  pictureOnScreen: false,
  ...over,
});

describe('which glass the shell gets', () => {
  it('changes nothing outside the desktop app (phones, tablets, a browser)', () => {
    expect(resolveGlass(inputs({ caps: null }))).toEqual(flatGlass);
    expect(resolveGlass(inputs({ caps: null, mode: 'native' }))).toEqual(flatGlass);
  });

  it('is native glass over vibrancy on macOS 26, web glass on older macOS', () => {
    expect(resolveGlass(inputs({}))).toEqual({ material: true, controls: 'native' });
    expect(resolveGlass(inputs({ caps: sequoia }))).toEqual({ material: true, controls: 'css' });
    // Native chosen on a Mac without it (a settings file copied across) falls back to the web.
    expect(resolveGlass(inputs({ caps: sequoia, mode: 'native' }))).toEqual({ material: true, controls: 'css' });
  });

  it('follows the setting', () => {
    expect(resolveGlass(inputs({ mode: 'web' }))).toEqual({ material: true, controls: 'css' });
    expect(resolveGlass(inputs({ mode: 'off' }))).toEqual(flatGlass);
  });

  it('turns everything off on full-bleed picture pages', () => {
    expect(resolveGlass(inputs({ shell: false }))).toEqual(flatGlass);
    expect(resolveGlass(inputs({ caps: windows11, shell: false }))).toEqual(flatGlass);
  });

  it('is solid with reduced transparency', () => {
    expect(resolveGlass(inputs({ reducedTransparency: true }))).toEqual(flatGlass);
  });

  it('puts Mica behind the sidebar on Windows 11, except while a picture is on screen', () => {
    expect(resolveGlass(inputs({ caps: windows11 }))).toEqual({ material: true, controls: 'css' });
    expect(resolveGlass(inputs({ caps: windows11, pictureOnScreen: true }))).toEqual({ material: false, controls: 'css' });
    // macOS layers its material above the picture, so it stays; native controls need the page
    // fill under the web view, which would cover the picture, so they fall back to the web glass.
    expect(resolveGlass(inputs({ pictureOnScreen: true }))).toEqual({ material: true, controls: 'css' });
  });

  it('keeps the sidebar solid without a material (Windows 10, Linux)', () => {
    expect(resolveGlass(inputs({ caps: windows10 }))).toEqual({ material: false, controls: 'css' });
  });

  it('defaults to native where it exists and offers it only there', () => {
    expect(defaultGlassMode(tahoe)).toBe('native');
    expect(defaultGlassMode(sequoia)).toBe('web');
    expect(defaultGlassMode(null)).toBe('web');
    expect(glassModeOptions(tahoe).map((o) => o.value)).toEqual(['native', 'web', 'off']);
    expect(glassModeOptions(windows11).map((o) => o.value)).toEqual(['web', 'off']);
  });

  it('covers the sidebar, and Settings’ list beside it', () => {
    expect(materialStripWidth(false)).toBe(SIDEBAR_WIDTH);
    expect(materialStripWidth(true)).toBe(SIDEBAR_WIDTH + SETTINGS_LIST_WIDTH);
  });

  it('reads the desktop’s answer and the preview flag leniently', () => {
    expect(parseCaps({ material: 'mica', glassControls: false })).toEqual(windows11);
    expect(parseCaps({ material: 'vibrancy', glassControls: true })).toEqual(tahoe);
    expect(parseCaps(null)).toEqual(windows10);
    expect(parseCaps({ material: 'acrylic', glassControls: 'yes' })).toEqual(windows10);
    expect(previewCaps('?glassPreview=1')).toEqual({ material: 'vibrancy', glassControls: false, preview: true });
    expect(previewCaps('?x=2&glassPreview=native')).toEqual({ material: 'vibrancy', glassControls: true, preview: true });
    expect(previewCaps('?glassPreview=0')).toBeNull();
    expect(previewCaps('?macChrome=1')).toBeNull();
  });
});

describe('rect helpers', () => {
  it('snaps to device pixels', () => {
    expect(snapRect({ left: 10.3, top: 5.26, width: 32.2, height: 32 }, 2)).toEqual({ x: 10.5, y: 5.5, width: 32, height: 32 });
    expect(snapRect({ left: 10.3, top: 5.6, width: 32.2, height: 32 }, 1)).toEqual({ x: 10, y: 6, width: 33, height: 32 });
    expect(snapRect({ left: 1, top: 1, width: 2, height: 2 }, 0)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });

  it('knows when a control is wholly visible', () => {
    const clip = { left: 0, top: 100, width: 240, height: 500 };
    expect(isWhollyInside({ left: 10, top: 120, width: 220, height: 38 }, clip)).toBe(true);
    expect(isWhollyInside({ left: 10, top: 80, width: 220, height: 38 }, clip)).toBe(false);
    expect(isWhollyInside({ left: 10, top: 99.7, width: 220, height: 38 }, clip)).toBe(true);
    expect(intersect({ left: 0, top: 0, width: 100, height: 100 }, { left: 50, top: 150, width: 10, height: 10 }).height).toBe(0);
  });
});

class FakeNode implements GlassNode {
  attributes = new Set<string>();
  constructor(public rect: RectLike) {}
  getBoundingClientRect() {
    return this.rect;
  }
  setAttribute(name: string) {
    this.attributes.add(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  get native() {
    return this.attributes.has(NATIVE_ATTRIBUTE);
  }
}

function harness(
  opts: { dpr?: number; width?: number; fail?: boolean; clip?: (n: GlassNode) => RectLike | null; reveal?: (n: GlassNode) => () => void } = {},
) {
  const frames: (() => void)[] = [];
  const timers = new Map<number, { run: () => void; at: number }>();
  let clock = 0;
  let nextTimer = 1;
  const sends: { items: NativeGlassItem[]; dpr: number }[] = [];
  const answers: (() => void)[] = [];
  let dpr = opts.dpr ?? 2;
  const sync = createGlassSync({
    send(items, d) {
      sends.push({ items, dpr: d });
      return new Promise<void>((resolve, reject) => answers.push(opts.fail ? () => reject(new Error('no')) : resolve));
    },
    requestFrame: (run) => frames.push(run),
    viewport: () => ({ width: opts.width ?? 1440, height: 900 }),
    dpr: () => dpr,
    clipOf: opts.clip,
    reveal: opts.reveal,
    setTimer(run, ms) {
      const id = nextTimer++;
      timers.set(id, { run, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  return {
    sync,
    sends,
    /** Runs the pending animation frames. */
    frame() {
      const run = frames.splice(0);
      run.forEach((f) => f());
      return run.length;
    },
    /** Lets the desktop answer every send so far. */
    async answer() {
      answers.splice(0).forEach((a) => a());
      await Promise.resolve();
      await Promise.resolve();
    },
    advance(ms: number) {
      clock += ms;
      for (const [id, t] of [...timers]) if (t.at <= clock) {
        timers.delete(id);
        t.run();
      }
    },
    setDpr(v: number) {
      dpr = v;
    },
  };
}

const enabled = { enabled: true };

describe('keeping native glass under the web controls', () => {
  it('coalesces every change in a frame into one send, and skips an unchanged list', async () => {
    const h = harness();
    h.sync.configure(enabled);
    const a = new FakeNode({ left: 1300, top: 10, width: 120, height: 32 });
    const b = new FakeNode({ left: 1260, top: 10, width: 32, height: 32 });
    h.sync.register(a, { radius: 16, tint: '#1c1c1cd9' });
    h.sync.register(b, { radius: 16 });
    h.sync.schedule();
    h.sync.schedule();
    expect(h.frame()).toBe(1);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].items.map((i) => i.x)).toEqual([1300, 1260]);
    h.sync.schedule();
    h.frame();
    expect(h.sends).toHaveLength(1);
  });

  it('marks controls native only once the desktop has drawn them', async () => {
    const h = harness();
    h.sync.configure(enabled);
    const a = new FakeNode({ left: 1300, top: 10, width: 120, height: 32 });
    h.sync.register(a, { radius: 16 });
    h.frame();
    expect(a.native).toBe(false);
    await h.answer();
    expect(a.native).toBe(true);
  });

  it('describes each control for Rust: radius, tint, underlay, trailing edge, device pixels', () => {
    const h = harness({ dpr: 2 });
    h.sync.configure(enabled);
    h.sync.register(new FakeNode({ left: 1300.3, top: 10, width: 120, height: 32 }), { radius: 99, tint: '#1c1c1cd9' });
    h.sync.register(new FakeNode({ left: 10, top: 60, width: 220, height: 38 }), { radius: 10, style: 'clear' });
    h.frame();
    const [button, item] = h.sends[0].items;
    expect(h.sends[0].dpr).toBe(2);
    expect(button).toEqual({ x: 1300.5, y: 10, width: 120, height: 32, radius: 16, tint: '#1c1c1cd9', style: 'regular', underlay: null, trailing: true });
    // In the sidebar: pinned to the leading edge.
    expect(item).toMatchObject({ trailing: false, style: 'clear', radius: 10 });
  });

  it('resends when the device pixel ratio changes (the window moved to another screen)', () => {
    const h = harness({ dpr: 2 });
    h.sync.configure(enabled);
    h.sync.register(new FakeNode({ left: 1300, top: 10, width: 120, height: 32 }), { radius: 16 });
    h.frame();
    h.setDpr(1);
    h.sync.schedule();
    h.frame();
    expect(h.sends.map((s) => s.dpr)).toEqual([2, 1]);
  });

  it('clears the backgrounds above a control only while it is native', async () => {
    const revealed = new Set<GlassNode>();
    const h = harness({
      reveal: (node) => {
        revealed.add(node);
        return () => revealed.delete(node);
      },
    });
    h.sync.configure(enabled);
    const a = new FakeNode({ left: 1300, top: 10, width: 120, height: 32 });
    const stop = h.sync.register(a, { radius: 16 });
    h.frame();
    expect(revealed.has(a)).toBe(false);
    await h.answer();
    expect(revealed.has(a)).toBe(true);
    h.sync.schedule();
    h.frame();
    await h.answer();
    expect(revealed.size).toBe(1);
    h.sync.resizeStarted();
    expect(revealed.has(a)).toBe(false);
    h.advance(RESIZE_SETTLE_MS);
    h.frame();
    await h.answer();
    expect(revealed.has(a)).toBe(true);
    stop();
    expect(revealed.size).toBe(0);
  });

  it('follows a control through an option change (the ink tint in dark mode)', () => {
    const h = harness();
    h.sync.configure(enabled);
    const a = new FakeNode({ left: 1300, top: 10, width: 120, height: 32 });
    h.sync.register(a, { radius: 16, tint: '#1c1c1cd9' });
    h.frame();
    h.sync.update(a, { radius: 16, tint: '#1c1c1cd9' });
    expect(h.frame()).toBe(0);
    h.sync.update(a, { radius: 16, tint: '#f4f4f4d9' });
    h.frame();
    expect(h.sends[1].items[0].tint).toBe('#f4f4f4d9');
  });

  it('removes a control at once when it unmounts, then hides its native view', async () => {
    const h = harness();
    h.sync.configure(enabled);
    const a = new FakeNode({ left: 1300, top: 10, width: 120, height: 32 });
    const stop = h.sync.register(a, { radius: 16 });
    h.frame();
    await h.answer();
    expect(a.native).toBe(true);
    stop();
    expect(a.native).toBe(false);
    h.frame();
    expect(h.sends.at(-1)?.items).toEqual([]);
    expect(h.sync.inspect()).toMatchObject({ targets: 0, native: 0 });
    stop();
    expect(h.frame()).toBe(0);
  });

  it('keeps the web glass for a control scrolled half out of its list', () => {
    const clipRect = { left: 0, top: 52, width: 248, height: 600 };
    const inList = new FakeNode({ left: 10, top: 40, width: 228, height: 60 });
    const h = harness({ clip: (n) => (n === inList ? clipRect : null) });
    h.sync.configure(enabled);
    h.sync.register(inList, { radius: 12 });
    h.frame();
    expect(h.sends).toHaveLength(0);
    inList.rect = { ...inList.rect, top: 70 };
    h.sync.schedule();
    h.frame();
    expect(h.sends[0].items).toHaveLength(1);
  });

  it('ignores hidden controls', () => {
    const h = harness();
    h.sync.configure(enabled);
    h.sync.register(new FakeNode({ left: 0, top: 0, width: 0, height: 0 }), { radius: 16 });
    h.frame();
    expect(h.sends).toHaveLength(0);
  });

  it('hides everything at the first resize event and measures once the window is still', async () => {
    const h = harness();
    h.sync.configure(enabled);
    const a = new FakeNode({ left: 1300, top: 10, width: 120, height: 32 });
    h.sync.register(a, { radius: 16 });
    h.frame();
    await h.answer();
    expect(a.native).toBe(true);

    h.sync.resizeStarted();
    expect(a.native).toBe(false);
    expect(h.sends.at(-1)?.items).toEqual([]);
    a.rect = { ...a.rect, left: 1100 };
    h.advance(100);
    h.sync.resizeStarted();
    h.sync.schedule();
    expect(h.frame()).toBe(0);
    expect(h.sends).toHaveLength(2);
    h.advance(RESIZE_SETTLE_MS - 1);
    expect(h.frame()).toBe(0);
    h.advance(1);
    h.frame();
    expect(h.sends.at(-1)?.items[0].x).toBe(1100);
    await h.answer();
    expect(a.native).toBe(true);
  });

  it('never marks a control from an answer that a newer send overtook', async () => {
    const h = harness();
    h.sync.configure(enabled);
    const a = new FakeNode({ left: 1300, top: 10, width: 120, height: 32 });
    h.sync.register(a, { radius: 16 });
    h.frame();
    h.sync.resizeStarted();
    await h.answer();
    expect(a.native).toBe(false);
  });

  it('stays on the web glass when the desktop fails, and retries on the next change', async () => {
    const h = harness({ fail: true });
    h.sync.configure(enabled);
    const a = new FakeNode({ left: 1300, top: 10, width: 120, height: 32 });
    h.sync.register(a, { radius: 16 });
    h.frame();
    await h.answer();
    expect(a.native).toBe(false);
    h.sync.schedule();
    h.frame();
    expect(h.sends).toHaveLength(2);
  });

  it('sends nothing native while disabled (full-bleed page, Web or Off chosen)', async () => {
    const h = harness();
    const a = new FakeNode({ left: 1300, top: 10, width: 120, height: 32 });
    h.sync.register(a, { radius: 16 });
    h.frame();
    expect(h.sends).toHaveLength(0);
    h.sync.configure(enabled);
    h.frame();
    await h.answer();
    expect(a.native).toBe(true);
    h.sync.configure({ enabled: false });
    expect(a.native).toBe(false);
    h.frame();
    expect(h.sends.at(-1)?.items).toEqual([]);
  });

  it('clears the desktop when the shell goes away', async () => {
    const h = harness();
    h.sync.configure(enabled);
    h.sync.register(new FakeNode({ left: 1300, top: 10, width: 120, height: 32 }), { radius: 16 });
    h.frame();
    h.sync.dispose();
    expect(h.sends.at(-1)?.items).toEqual([]);
    expect(h.sync.inspect().targets).toBe(0);
  });
});
