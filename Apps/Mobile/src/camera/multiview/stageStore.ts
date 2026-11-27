import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from '@/state/storage';
import type { StageLayout } from '@/core/multicam';
import { StageReducers, fromStored, initialStage, type StageValues } from './stage';
import type { MultiviewCamera, MultiviewNetwork, TileLook } from './types';

interface StageStore extends StageValues {
  setLayout(layout: StageLayout): void;
  toggleLayout(): void;
  select(slot: number): void;
  focus(slot: number): void;
  toggleFill(): void;
  setNetwork(network: MultiviewNetwork | null): void;
  members(cameras: (MultiviewCamera | null)[]): void;
  returned(returnedIds: string[]): void;
  setLook(cameraId: string, patch: Partial<TileLook>): void;
}

/**
 * The persisted Multiview stage (device only; the network password lives in secure storage).
 * Reducers are in `./stage` so they are tested without React or storage.
 */
export const useMultiviewStage = create<StageStore>()(
  persist(
    (set) => {
      const apply =
        <A extends unknown[]>(fn: (s: StageValues, ...a: A) => StageValues) =>
        (...a: A) =>
          set((s) => fn(s, ...a));
      return {
        ...initialStage(),
        setLayout: apply(StageReducers.setLayout),
        toggleLayout: apply(StageReducers.toggleLayout),
        select: apply(StageReducers.select),
        focus: apply(StageReducers.focus),
        toggleFill: apply(StageReducers.toggleFill),
        setNetwork: apply(StageReducers.setNetwork),
        members: apply(StageReducers.members),
        returned: apply(StageReducers.returned),
        setLook: apply(StageReducers.setLook),
      };
    },
    {
      name: 'pm.multiview.v1',
      storage: persistStorage,
      partialize: (s): StageValues => ({
        layout: s.layout,
        selected: s.selected,
        fill: s.fill,
        network: s.network,
        cameras: s.cameras,
        pendingReset: s.pendingReset,
        looks: s.looks,
      }),
      merge: (persisted, current) => ({ ...current, ...fromStored(persisted) }),
    },
  ),
);
