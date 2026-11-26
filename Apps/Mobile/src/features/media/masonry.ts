/**
 * Staggered (masonry) placement, ported from OpenCine `MonitorMediaMasonry`. Items keep the
 * displayed order; each goes into the shortest column so far (leftmost on a tie). A card's
 * height comes from metadata known before a thumbnail loads, so loading never moves a card.
 */
export interface MasonryFrame {
  column: number;
  x: number;
  y: number;
  width: number;
  /** Whole card: picture plus caption. */
  height: number;
  /** Width over height of the picture. */
  aspect: number;
}

export interface MasonryLayout {
  columns: number[][];
  frames: MasonryFrame[];
  height: number;
}

export const defaultAspect = 16 / 9;
const aspectMin = 0.5;
const aspectMax = 2.5;

export function clampAspect(value?: number | null): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return defaultAspect;
  return Math.min(aspectMax, Math.max(aspectMin, value));
}

export function uprightAspect(width?: number, height?: number): number | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
}

export function layoutMasonry(
  aspects: (number | null | undefined)[],
  columnCount: number,
  width: number,
  spacing: number,
  captionHeight: number,
): MasonryLayout {
  const count = Math.max(1, columnCount);
  const columnWidth = Math.max(0, (width - spacing * (count - 1)) / count);
  const bottoms = new Array<number>(count).fill(0);
  const columns: number[][] = Array.from({ length: count }, () => []);
  const frames: MasonryFrame[] = [];
  aspects.forEach((value, index) => {
    let column = 0;
    for (let c = 1; c < count; c++) if (bottoms[c] < bottoms[column]) column = c;
    const aspect = clampAspect(value);
    const height = columnWidth / aspect + captionHeight;
    frames.push({ column, x: column * (columnWidth + spacing), y: bottoms[column], width: columnWidth, height, aspect });
    columns[column].push(index);
    bottoms[column] += height + spacing;
  });
  const height = Math.max(0, ...bottoms.map((b) => b - spacing));
  return { columns, frames, height };
}

/** The card under a point in the layout's coordinates; null between cards. */
export function masonryIndexAt(layout: MasonryLayout, x: number, y: number): number | null {
  const frame = layout.frames.find((f) => x >= f.x && x < f.x + f.width);
  if (!frame) return null;
  const hit = layout.columns[frame.column].find((i) => {
    const f = layout.frames[i];
    return y >= f.y && y < f.y + f.height;
  });
  return hit ?? null;
}
