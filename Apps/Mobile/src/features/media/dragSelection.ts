/**
 * A reversible selection sweep over the displayed order (OpenCine `MonitorMediaDragSelection`).
 * Only newly crossed indices change; selections outside the sweep keep their prior state.
 */
export class DragSelection {
  private readonly ids: string[];
  private readonly original: Set<string>;
  private readonly origin: number;
  private readonly selects: boolean;
  private endpoint: number;
  selected: Set<string>;

  static begin(orderedIds: string[], originId: string, selected: Set<string>): DragSelection | null {
    const index = orderedIds.indexOf(originId);
    return index < 0 ? null : new DragSelection(orderedIds, index, selected);
  }

  private constructor(ids: string[], origin: number, selected: Set<string>) {
    this.ids = ids;
    this.original = new Set(selected);
    this.selected = new Set(selected);
    this.origin = origin;
    this.endpoint = origin;
    this.selects = !selected.has(ids[origin]);
    this.apply(origin, true);
  }

  /** Returns false when the pointer stays on the same item. */
  move(index: number): boolean {
    const next = Math.min(this.ids.length - 1, Math.max(0, index));
    if (next === this.endpoint) return false;
    const oldLow = Math.min(this.origin, this.endpoint);
    const oldHigh = Math.max(this.origin, this.endpoint);
    const newLow = Math.min(this.origin, next);
    const newHigh = Math.max(this.origin, next);
    for (let i = oldLow; i < newLow; i++) this.apply(i, false);
    for (let i = newHigh + 1; i <= oldHigh; i++) this.apply(i, false);
    for (let i = newLow; i < oldLow; i++) this.apply(i, true);
    for (let i = oldHigh + 1; i <= newHigh; i++) this.apply(i, true);
    this.endpoint = next;
    return true;
  }

  private apply(index: number, sweeping: boolean) {
    const id = this.ids[index];
    if (sweeping ? this.selects : this.original.has(id)) this.selected.add(id);
    else this.selected.delete(id);
  }
}
