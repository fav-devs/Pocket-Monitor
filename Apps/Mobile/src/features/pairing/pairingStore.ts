import { create } from 'zustand';
import type { SavedCamera } from '@/camera/types';

/**
 * The connect the operator just started, so the connect screen knows what it is connecting
 * and can remember a first pair once the camera is live. Not persisted: a pair that never
 * reached live view is not saved (OpenCine saves the record when the connect succeeds).
 */
interface PendingConnectState {
  /** Camera being connected, with the network path chosen in the pair flow. */
  target: SavedCamera | null;
  /** True when this is a first pair from the wizard (vs. reconnecting a saved camera). */
  firstPair: boolean;
  /** Demo camera started from "Try the demo camera". */
  demo: boolean;
  begin: (target: SavedCamera, options?: { firstPair?: boolean; demo?: boolean }) => void;
  clear: () => void;
}

export const usePendingConnect = create<PendingConnectState>()((set) => ({
  target: null,
  firstPair: false,
  demo: false,
  begin: (target, options) => set({ target, firstPair: !!options?.firstPair, demo: !!options?.demo }),
  clear: () => set({ target: null, firstPair: false, demo: false }),
}));
