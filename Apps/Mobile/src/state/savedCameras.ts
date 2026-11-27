import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SavedCamera } from '@/camera/types';
import { persistStorage } from './storage';

interface SavedCamerasState {
  cameras: SavedCamera[];
  upsert: (camera: SavedCamera) => void;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  markConnected: (id: string) => void;
}

/** Cameras remembered on this device. Wi-Fi passwords go to secure storage (src/camera/credentials). */
export const useSavedCameras = create<SavedCamerasState>()(
  persist(
    (set) => ({
      cameras: [],
      upsert: (camera) =>
        set((s) => ({ cameras: [camera, ...s.cameras.filter((c) => c.id !== camera.id)] })),
      remove: (id) => set((s) => ({ cameras: s.cameras.filter((c) => c.id !== id) })),
      rename: (id, name) => set((s) => ({ cameras: s.cameras.map((c) => (c.id === id ? { ...c, name } : c)) })),
      markConnected: (id) =>
        set((s) => ({ cameras: s.cameras.map((c) => (c.id === id ? { ...c, lastConnectedAt: Date.now() } : c)) })),
    }),
    { name: 'pm.savedCameras.v1', storage: persistStorage },
  ),
);
