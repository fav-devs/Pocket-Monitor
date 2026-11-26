/**
 * Movable scope panel placement: bounds, fit, clamp with the resize-grip strip, chrome
 * avoidance and normalized stored centres. Port of OpenCine `MonitorScopePanelPlacement`
 * (MonitorUI + MonitorPresentation) and `MonitorScopeChromeAvoidance`.
 */
import type { Rect } from './framing';

export const PANEL = {
  padding: 8,
  gripExtent: 44,
  gripInterior: 12,
  gripBottomExtent: 12,
  gripTopInterior: 44,
};

export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Insets {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Normalized against the full canvas; fitting never rewrites storage. */
export interface StoredCenter {
  xFraction: number;
  yFraction: number;
}

export function panelBounds(canvas: Rect, clearance: Partial<Insets> = {}): Rect {
  const left = canvas.x + Math.max(0, clearance.left ?? 0) + PANEL.padding;
  const top = canvas.y + Math.max(0, clearance.top ?? 0) + PANEL.padding;
  const right = canvas.x + canvas.width - Math.max(0, clearance.right ?? 0) - PANEL.padding;
  const bottom = canvas.y + canvas.height - Math.max(0, clearance.bottom ?? 0) - PANEL.padding;
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export const isUsable = (b: Rect) => b.width >= PANEL.gripExtent + PANEL.gripInterior && b.height >= PANEL.gripExtent + PANEL.gripInterior;

export function fittedSize(preferred: Size, bounds: Rect, resizable = true): Size {
  const s = Math.min(
    1,
    Math.max(1, bounds.width) / Math.max(1, preferred.width),
    Math.max(1, bounds.height - (resizable ? PANEL.gripBottomExtent : 0)) / Math.max(1, preferred.height),
  );
  return { width: Math.max(1, Math.floor(preferred.width * s)), height: Math.max(1, Math.floor(preferred.height * s)) };
}

export function clampCenter(p: Point, size: Size, b: Rect, resizable = true): Point {
  const minX = b.x + size.width / 2;
  const minY = b.y + Math.max(size.height / 2, (resizable ? PANEL.gripTopInterior : 0) - size.height / 2);
  const maxX = b.x + b.width - size.width / 2;
  const maxY = b.y + b.height - size.height / 2 - (resizable ? PANEL.gripBottomExtent : 0);
  return { x: Math.min(Math.max(minX, p.x), Math.max(minX, maxX)), y: Math.min(Math.max(minY, p.y), Math.max(minY, maxY)) };
}

/** Nearest clear centre that keeps `gap` from every chrome rect; clamped centre if none. */
export function avoidChrome(
  center: Point,
  size: Size,
  bottomExtent: number,
  obstacles: Rect[],
  gap: number,
  clamp: (p: Point) => Point,
): Point {
  const start = clamp(center);
  const blocked = obstacles
    .filter((o) => o.width > 0 && o.height > 0)
    .map((o) => ({ x: o.x - gap, y: o.y - gap, width: o.width + 2 * gap, height: o.height + 2 * gap }));
  if (!blocked.length) return start;
  const tol = 0.001;
  const clear = (p: Point) => {
    const l = p.x - size.width / 2;
    const r = p.x + size.width / 2;
    const t = p.y - size.height / 2;
    const bt = p.y + size.height / 2 + bottomExtent;
    return !blocked.some((o) => l < o.x + o.width - tol && r > o.x + tol && t < o.y + o.height - tol && bt > o.y + tol);
  };
  if (clear(start)) return start;
  const far = 1e9;
  const xs = [start.x, clamp({ x: -far, y: start.y }).x, clamp({ x: far, y: start.y }).x];
  const ys = [start.y, clamp({ x: start.x, y: -far }).y, clamp({ x: start.x, y: far }).y];
  for (const o of blocked) {
    xs.push(o.x - size.width / 2, o.x + o.width + size.width / 2);
    ys.push(o.y - size.height / 2 - bottomExtent, o.y + o.height + size.height / 2);
  }
  let best: Point | null = null;
  let nearest = Infinity;
  for (const x of xs)
    for (const y of ys) {
      const c = clamp({ x, y });
      const d = (c.x - start.x) ** 2 + (c.y - start.y) ** 2;
      if (d < nearest && clear(c)) {
        best = c;
        nearest = d;
      }
    }
  return best ?? start;
}

export function clampAvoiding(p: Point, size: Size, b: Rect, resizable: boolean, obstacles: Rect[]): Point {
  const clamp = (q: Point) => clampCenter(q, size, b, resizable);
  if (!obstacles.length) return clamp(p);
  return avoidChrome(p, size, resizable ? PANEL.gripBottomExtent : 0, obstacles, PANEL.padding, clamp);
}

export const storedCenterFrom = (c: Point, b: Rect): StoredCenter => ({
  xFraction: (c.x - b.x) / Math.max(b.width, 1),
  yFraction: (c.y - b.y) / Math.max(b.height, 1),
});
export const centerFromStored = (s: StoredCenter, b: Rect): Point => ({ x: b.x + s.xFraction * b.width, y: b.y + s.yFraction * b.height });

export const panelSize = (base: Size, scale: number): Size => ({ width: Math.round(base.width * scale), height: Math.round(base.height * scale) });

export type CanvasSlot = 'landscape' | 'portrait';
export const canvasSlot = (w: number, h: number): CanvasSlot => (h > w ? 'portrait' : 'landscape');

/** 4pt snap while dragging. */
export const snap4 = (p: Point): Point => ({ x: Math.round(p.x / 4) * 4, y: Math.round(p.y / 4) * 4 });
