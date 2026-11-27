import { Platform } from 'react-native';
import { invoke, isTauri } from '@/camera/desktop/tauri';
import { punchThrough } from '@/features/picture/desktop/hole';
import { createGlassSync, type GlassNode, type GlassSync, type NativeGlassItem, type RectLike } from './sync';

/**
 * The page's one `GlassSync`, wired to the real window: animation frames, `resize` (hides the
 * native glass until the window is still), scroll anywhere (capture), a resize observer on
 * every control and a slow safety poll. It sends to `glass_controls` in the desktop app, and in
 * the web preview (`?glassPreview=native`) draws dashed outlines where native glass would go.
 */

let sync: GlassSync | null = null;

function clipOf(node: GlassNode): RectLike | null {
  let clip: RectLike | null = null;
  for (let el = (node as unknown as HTMLElement).parentElement; el && el !== document.body; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const r = el.getBoundingClientRect();
    const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    clip = clip ? intersectRect(clip, rect) : rect;
  }
  return clip;
}

function intersectRect(a: RectLike, b: RectLike): RectLike {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  return {
    left,
    top,
    width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
    height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top),
  };
}

function previewLayer(id: string): HTMLElement {
  let layer = document.getElementById(id);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = id;
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * The web preview's stand-ins for `glass_material`: the sidebar material (a CSS blur of the fake
 * desktop) left of `leading` and the page fill right of it, under the web page in the same order
 * as the native views, with the glass outlines above them.
 */
export function previewMaterial({ on, leading, page }: { on: boolean; leading: number; page: string | null }) {
  if (typeof document === 'undefined') return;
  const material = previewLayer('pm-glass-preview-material');
  const fill = previewLayer('pm-glass-preview-page');
  const glass = previewLayer('pm-glass-preview');
  document.body.append(material, fill, glass);
  material.style.width = `${leading}px`;
  material.style.display = on ? 'block' : 'none';
  fill.style.left = `${leading}px`;
  fill.style.background = page ?? 'transparent';
}

function previewSend(items: NativeGlassItem[]): Promise<void> {
  const layer = previewLayer('pm-glass-preview');
  layer.replaceChildren(
    ...items.map((item) => {
      const box = document.createElement('div');
      Object.assign(box.style, {
        left: `${item.x}px`,
        top: `${item.y}px`,
        width: `${item.width}px`,
        height: `${item.height}px`,
        borderRadius: `${item.radius}px`,
        // The tint stands in for tinted native glass, so a label on it stays readable.
        background: item.tint ?? 'transparent',
      });
      return box;
    }),
  );
  return Promise.resolve();
}

/** The page's glass sync, created on first use (web only; null on native). */
export function glassSync(): GlassSync | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  if (sync) return sync;
  const desktop = isTauri();
  const created = createGlassSync({
    send: (items, dpr) => (desktop ? invoke('glass_controls', { items, dpr }) : previewSend(items)),
    requestFrame: (run) => {
      window.requestAnimationFrame(() => run());
    },
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    dpr: () => window.devicePixelRatio || 1,
    clipOf,
    // The control itself is cleared by the glass CSS; its ancestors by the picture hole's rule.
    reveal: (node) => {
      const parent = (node as unknown as HTMLElement).parentElement;
      return parent ? punchThrough(parent) : () => {};
    },
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (timer) => window.clearTimeout(timer as number),
  });
  window.addEventListener('resize', () => created.resizeStarted());
  document.addEventListener('scroll', () => created.schedule(), { capture: true, passive: true });
  window.setInterval(() => {
    if (created.inspect().targets) created.schedule();
  }, 1000);
  sync = created;
  return sync;
}

/** Registers `node` for native glass; returns the undo. */
export function watchGlassNode(node: GlassNode, options: Parameters<GlassSync['register']>[1]): () => void {
  const s = glassSync();
  if (!s) return () => {};
  const stop = s.register(node, options);
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => s.schedule());
    observer.observe(node as unknown as Element);
  }
  return () => {
    observer?.disconnect();
    stop();
  };
}
