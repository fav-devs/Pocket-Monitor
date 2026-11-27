/**
 * Keeps the desktop's native glass views (`glass_controls`, macOS 26+) under the web controls
 * that asked for them. No React and no real DOM: the window, the frame clock, the timers and
 * the IPC come in as `GlassSyncDeps`, so the rules are tested.
 *
 * - Every change (a control mounting or unmounting, scroll, theme, route) schedules one
 *   measurement on the next animation frame; any number of changes in a frame send at most one
 *   list, and an unchanged list is not sent again.
 * - A control is drawn natively only while it is wholly visible inside its clipping ancestors
 *   (a half-scrolled card keeps the web glass; a cut glass shape would not match).
 * - The web keeps drawing a control's own glass until the native view is in place: the
 *   `data-pocket-glass-native` attribute (which makes the web background transparent) is set
 *   only after the desktop answered, and removed at once when a control leaves native.
 * - A window resize hides every native view at its first event (the web glass shows) and
 *   measures again once the window has been still for `RESIZE_SETTLE_MS`.
 * - Rects are CSS px of the viewport, snapped to device pixels; Rust turns them into points
 *   with the window's backing scale.
 * - The native glass is under the web view, so a control's ancestors must not paint over it:
 *   `reveal` clears their backgrounds while the control is native (the desktop paints the page
 *   colour under the whole page meanwhile, so nothing else changes) and is undone with it.
 */

export const NATIVE_ATTRIBUTE = 'data-pocket-glass-native';
export const RESIZE_SETTLE_MS = 160;

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GlassNode {
  getBoundingClientRect(): RectLike;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface GlassOptions {
  /** Corner radius, CSS px. */
  radius: number;
  /** `#rrggbb[aa]` over the glass (the primary button's ink). */
  tint?: string | null;
  style?: 'regular' | 'clear';
}

/** What `glass_controls` takes per control. */
export interface NativeGlassItem {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  tint: string | null;
  style: 'regular' | 'clear';
  /** A fill under this glass alone; unused by the web (the desktop's page fill covers it). */
  underlay: string | null;
  /** Pinned to the trailing edge while the window resizes. */
  trailing: boolean;
}

export interface GlassSyncConfig {
  /** Native glass is wanted (the shell is showing and the operator chose Native). */
  enabled: boolean;
}

export interface GlassSyncDeps {
  send(items: NativeGlassItem[], dpr: number): Promise<unknown>;
  requestFrame(run: () => void): void;
  viewport(): { width: number; height: number };
  dpr(): number;
  /** The visible part of the node's clipping ancestors (scroll views), if any. */
  clipOf?(node: GlassNode): RectLike | null;
  /** Clears the backgrounds above the native glass (the node's ancestors); returns the undo. */
  reveal?(node: GlassNode): () => void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface GlassSync {
  register(node: GlassNode, options: GlassOptions): () => void;
  update(node: GlassNode, options: GlassOptions): void;
  configure(config: GlassSyncConfig): void;
  /** Something moved (scroll, layout, route). */
  schedule(): void;
  /** The window is being resized. */
  resizeStarted(): void;
  /** Hides everything and stops (the shell unmounted). */
  dispose(): void;
  /** For tests and diagnostics. */
  inspect(): { suspended: boolean; native: number; targets: number; sent: number };
}

type Rect = { x: number; y: number; width: number; height: number };

/** Rounds a CSS rect to device pixels, so native frames land on the web's pixel grid. */
export function snapRect(rect: RectLike, dpr: number): Rect {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const snap = (v: number) => Math.round(v * scale) / scale;
  const x = snap(rect.left);
  const y = snap(rect.top);
  return { x, y, width: snap(rect.left + rect.width) - x, height: snap(rect.top + rect.height) - y };
}

export function intersect(a: RectLike, b: RectLike): RectLike {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** `rect` lies wholly inside `clip` (half a CSS px of slack for subpixel layout). */
export function isWhollyInside(rect: RectLike, clip: RectLike, slack = 0.5): boolean {
  return (
    rect.left >= clip.left - slack &&
    rect.top >= clip.top - slack &&
    rect.left + rect.width <= clip.left + clip.width + slack &&
    rect.top + rect.height <= clip.top + clip.height + slack
  );
}

function sameOptions(a: GlassOptions, b: GlassOptions) {
  return a.radius === b.radius && (a.tint ?? null) === (b.tint ?? null) && (a.style ?? 'regular') === (b.style ?? 'regular');
}

const EMPTY = '[]';

export function createGlassSync(deps: GlassSyncDeps): GlassSync {
  const targets = new Map<GlassNode, GlassOptions>();
  const native = new Map<GlassNode, () => void>();
  let config: GlassSyncConfig = { enabled: false };
  let pending = false;
  let suspended = false;
  let settle: unknown = null;
  // What the desktop is showing now ('[]' = nothing), and which answer is the latest.
  let shown = EMPTY;
  let generation = 0;
  let sent = 0;

  const mark = (node: GlassNode, on: boolean) => {
    if (on) {
      if (native.has(node)) return;
      node.setAttribute(NATIVE_ATTRIBUTE, '');
      native.set(node, deps.reveal?.(node) ?? (() => {}));
    } else {
      node.removeAttribute(NATIVE_ATTRIBUTE);
      native.get(node)?.();
      native.delete(node);
    }
  };
  const unmarkAll = () => {
    for (const node of [...native.keys()]) mark(node, false);
  };

  const push = (items: NativeGlassItem[], dpr: number, nodes: GlassNode[]) => {
    const key = items.length ? JSON.stringify([items, dpr]) : EMPTY;
    if (key === shown) {
      // Already on screen (a remounted control at the same place): the web can step aside now.
      for (const node of nodes) if (!native.has(node)) mark(node, true);
      return;
    }
    shown = key;
    const ticket = ++generation;
    sent += 1;
    deps.send(items, dpr).then(
      () => {
        if (ticket !== generation || suspended) return;
        for (const node of nodes) if (targets.has(node)) mark(node, true);
      },
      () => {
        // The desktop could not draw them: the web glass stays, and the next change retries.
        if (ticket === generation) shown = '';
      },
    );
  };

  const measure = (): { items: NativeGlassItem[]; nodes: GlassNode[] } => {
    const items: NativeGlassItem[] = [];
    const nodes: GlassNode[] = [];
    const view = deps.viewport();
    const viewport: RectLike = { left: 0, top: 0, width: view.width, height: view.height };
    const dpr = deps.dpr();
    for (const [node, options] of targets) {
      const box = node.getBoundingClientRect();
      if (!(box.width >= 1 && box.height >= 1)) continue;
      const clipped = deps.clipOf?.(node);
      const clip = clipped ? intersect(viewport, clipped) : viewport;
      if (!isWhollyInside(box, clip)) continue;
      const rect = snapRect(box, dpr);
      items.push({
        ...rect,
        radius: Math.max(0, Math.min(options.radius, rect.width / 2, rect.height / 2)),
        tint: options.tint ?? null,
        style: options.style ?? 'regular',
        underlay: null,
        trailing: rect.x + rect.width / 2 > view.width / 2,
      });
      nodes.push(node);
    }
    return { items, nodes };
  };

  const flush = () => {
    pending = false;
    if (suspended) return;
    const { items, nodes } = config.enabled ? measure() : { items: [], nodes: [] };
    const wanted = new Set(nodes);
    // Controls leaving native show their web glass at once, before the native view goes.
    for (const node of [...native.keys()]) if (!wanted.has(node)) mark(node, false);
    push(items, deps.dpr(), nodes);
  };

  const schedule = () => {
    if (pending || suspended) return;
    pending = true;
    deps.requestFrame(flush);
  };

  const hideNow = () => {
    unmarkAll();
    generation += 1;
    if (shown !== EMPTY) {
      shown = EMPTY;
      sent += 1;
      deps.send([], deps.dpr()).catch(() => {});
    }
  };

  return {
    register(node, options) {
      targets.set(node, options);
      schedule();
      return () => {
        if (!targets.delete(node)) return;
        if (native.has(node)) mark(node, false);
        schedule();
      };
    },
    update(node, options) {
      const old = targets.get(node);
      if (!old || sameOptions(old, options)) return;
      targets.set(node, options);
      schedule();
    },
    configure(next) {
      const changed = next.enabled !== config.enabled;
      config = next;
      if (!next.enabled) unmarkAll();
      if (changed) schedule();
    },
    schedule,
    resizeStarted() {
      if (!suspended) {
        suspended = true;
        hideNow();
      }
      if (settle !== null) deps.clearTimer(settle);
      settle = deps.setTimer(() => {
        settle = null;
        suspended = false;
        schedule();
      }, RESIZE_SETTLE_MS);
    },
    dispose() {
      if (settle !== null) deps.clearTimer(settle);
      settle = null;
      targets.clear();
      hideNow();
    },
    inspect: () => ({ suspended, native: native.size, targets: targets.size, sent }),
  };
}
