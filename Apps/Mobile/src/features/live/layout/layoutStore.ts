import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useAssists } from '@/state/assists';
import { persistStorage } from '@/state/storage';
import {
  activeLayout,
  defaultLayouts,
  deleteLayout,
  duplicateLayout,
  importLegacyPanels,
  migrateLayouts,
  renameLayout,
  replaceSlot,
  resetItem,
  resetPanel,
  resetPanels,
  resetSlot,
  saveAsNew,
  setItem,
  setPanel,
  slotOf,
  switchLayout,
  type ItemPlacement,
  type LayoutSlot,
  type LayoutsState,
  type LegacyPanels,
  type MovableId,
  type PanelPlacement,
  type SlotLayout,
} from './layoutModel';

interface LayoutStore extends LayoutsState {
  /** Old assists panel positions were copied into Default (once). */
  legacyImported: boolean;
  saveAsNew: (name?: string) => void;
  duplicate: (id: string) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  switchTo: (id: string) => void;
  setItem: (slot: LayoutSlot, id: MovableId, patch: ItemPlacement) => void;
  resetItem: (slot: LayoutSlot, id: MovableId) => void;
  setPanel: (slot: LayoutSlot, id: string, patch: PanelPlacement) => void;
  resetSlot: (slot: LayoutSlot) => void;
  replaceSlot: (slot: LayoutSlot, value: SlotLayout) => void;
  resetPanels: () => void;
  resetPanel: (id: string) => void;
  importLegacy: (legacy: LegacyPanels) => void;
}

const pick = (s: LayoutsState): LayoutsState => ({ version: 1, layouts: s.layouts, activeId: s.activeId });

/**
 * Saved live-view layouts (`layoutModel.ts`), persisted with the app's other preferences
 * (AsyncStorage: native storage on iOS / Android, localStorage on web and in the desktop app).
 */
export const useLiveLayouts = create<LayoutStore>()(
  persist(
    (set) => {
      const apply = (fn: (s: LayoutsState) => LayoutsState) => set((s) => pick(fn(pick(s))));
      return {
        ...defaultLayouts(),
        legacyImported: false,
        saveAsNew: (name) => apply((s) => saveAsNew(s, name)),
        duplicate: (id) => apply((s) => duplicateLayout(s, id)),
        rename: (id, name) => apply((s) => renameLayout(s, id, name)),
        remove: (id) => apply((s) => deleteLayout(s, id)),
        switchTo: (id) => apply((s) => switchLayout(s, id)),
        setItem: (slot, id, patch) => apply((s) => setItem(s, slot, id, patch)),
        resetItem: (slot, id) => apply((s) => resetItem(s, slot, id)),
        setPanel: (slot, id, patch) => apply((s) => setPanel(s, slot, id, patch)),
        resetSlot: (slot) => apply((s) => resetSlot(s, slot)),
        replaceSlot: (slot, value) => apply((s) => replaceSlot(s, slot, value)),
        resetPanels: () => apply(resetPanels),
        resetPanel: (id) => apply((s) => resetPanel(s, id)),
        importLegacy: (legacy) => set((s) => ({ ...pick(importLegacyPanels(pick(s), legacy)), legacyImported: true })),
      };
    },
    {
      name: 'pm.liveLayouts.v1',
      storage: persistStorage,
      version: 1,
      partialize: (s) => ({ ...pick(s), legacyImported: s.legacyImported }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<LayoutsState> & { legacyImported?: boolean };
        return { ...current, ...migrateLayouts(p), legacyImported: !!p.legacyImported };
      },
    },
  ),
);

/** The active layout's placements for one slot. */
export function useSlotLayout(slot: LayoutSlot): SlotLayout {
  return useLiveLayouts((s) => slotOf(activeLayout(s), slot));
}

export function useActiveLayoutName(): string {
  return useLiveLayouts((s) => activeLayout(s).name);
}

// Once both stores have loaded, old scope positions (assists store) move into Default.
function whenHydrated(store: { persist?: { hasHydrated: () => boolean; onFinishHydration: (fn: () => void) => () => void } }) {
  return new Promise<void>((resolve) => {
    if (!store.persist || store.persist.hasHydrated()) resolve();
    else store.persist.onFinishHydration(() => resolve());
  });
}
Promise.all([whenHydrated(useLiveLayouts), whenHydrated(useAssists)])
  .then(() => {
    if (useLiveLayouts.getState().legacyImported) return;
    useLiveLayouts.getState().importLegacy(useAssists.getState().panels as LegacyPanels);
  })
  .catch(() => {});

// ───────────────────────────── Edit mode (not persisted) ─────────────────────────────

interface LayoutEditorState {
  editing: boolean;
  selected: MovableId | null;
  /** Earlier versions of the slot being edited, newest last. */
  undo: { slot: LayoutSlot; value: SlotLayout }[];
  begin: () => void;
  end: () => void;
  select: (id: MovableId | null) => void;
  /** Saves the slot as it is now so the next change can be undone. */
  checkpoint: (slot: LayoutSlot) => void;
  undoLast: () => void;
}

const UNDO_LIMIT = 40;

export const useLayoutEditor = create<LayoutEditorState>()((set, get) => ({
  editing: false,
  selected: null,
  undo: [],
  begin: () => set({ editing: true, selected: null, undo: [] }),
  end: () => set({ editing: false, selected: null, undo: [] }),
  select: (id) => set({ selected: id }),
  checkpoint: (slot) => {
    const value = slotOf(activeLayout(useLiveLayouts.getState()), slot);
    set((s) => ({ undo: [...s.undo, { slot, value: JSON.parse(JSON.stringify(value)) }].slice(-UNDO_LIMIT) }));
  },
  undoLast: () => {
    const stack = get().undo;
    const last = stack[stack.length - 1];
    if (!last) return;
    useLiveLayouts.getState().replaceSlot(last.slot, last.value);
    set({ undo: stack.slice(0, -1) });
  },
}));
