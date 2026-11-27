import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isIdentity, normalizeEdit, presetFrom, presetList, type ClipEdit, type EditPreset } from '@/core/edit';
import { persistStorage } from './storage';

/**
 * Per-clip edits (the playback editor) and Editing Presets. Keyed by the media item id, which is
 * the same for a clip on the camera and its downloaded copy on this phone, so an edit follows
 * the clip. Identity edits are not stored. Additive changes only (persisted).
 */
interface ClipEditStore {
  edits: Record<string, ClipEdit>;
  presets: EditPreset[];
  /** Replace a clip's edit (identity removes it). */
  setEdit: (itemId: string, edit: ClipEdit) => void;
  clearEdit: (itemId: string) => void;
  savePreset: (name: string, edit: ClipEdit) => EditPreset;
  renamePreset: (id: string, name: string) => void;
  deletePreset: (id: string) => void;
}

const MAX_EDITS = 2000;

export const useClipEdits = create<ClipEditStore>()(
  persist(
    (set, get) => ({
      edits: {},
      presets: [],
      setEdit: (itemId, edit) =>
        set((s) => {
          const edits = { ...s.edits };
          if (isIdentity(edit)) delete edits[itemId];
          else edits[itemId] = { ...edit, updatedAt: Date.now() };
          const keys = Object.keys(edits);
          if (keys.length > MAX_EDITS) {
            keys.sort((a, b) => (edits[a].updatedAt ?? 0) - (edits[b].updatedAt ?? 0));
            for (const k of keys.slice(0, keys.length - MAX_EDITS)) delete edits[k];
          }
          return { edits };
        }),
      clearEdit: (itemId) =>
        set((s) => {
          if (!s.edits[itemId]) return s;
          const edits = { ...s.edits };
          delete edits[itemId];
          return { edits };
        }),
      savePreset: (name, edit) => {
        const preset = presetFrom(edit, name || presetList.nextName(get().presets), `preset-${Date.now().toString(36)}`);
        set((s) => ({ presets: presetList.add(s.presets, preset) }));
        return preset;
      },
      renamePreset: (id, name) => set((s) => ({ presets: presetList.rename(s.presets, id, name) })),
      deletePreset: (id) => set((s) => ({ presets: presetList.remove(s.presets, id) })),
    }),
    { name: 'pm.clipEdits.v1', storage: persistStorage },
  ),
);

/** The stored edit for a clip, normalized (defaults when none). */
export function useClipEdit(itemId: string | undefined, durationSec?: number): ClipEdit {
  const stored = useClipEdits((s) => (itemId ? s.edits[itemId] : undefined));
  return useMemo(() => normalizeEdit(stored, durationSec), [stored, durationSec]);
}
