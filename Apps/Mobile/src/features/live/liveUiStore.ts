import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from '@/state/storage';

/** Which capture drawer is open (`CaptureSheet`). Top-edge: format, color, mode. */
export type CaptureSheetId =
  | 'iso'
  | 'shutter'
  | 'ev'
  | 'exposure'
  | 'wb'
  | 'focus'
  | 'aperture'
  | 'audio'
  | 'format'
  | 'color'
  | 'mode';

export const TOP_EDGE_SHEETS: CaptureSheetId[] = ['format', 'color', 'mode'];

/** `liveGimbalPanel`: none, the controls sheet, the Motion Control editor, or its run pill. */
export type GimbalPanel = 'none' | 'sheet' | 'editor' | 'runPill';

/** DISP 1 = live chrome, DISP 2 = clean picture. */
export type DispMode = 'live' | 'clean';

interface LiveUiState {
  disp: DispMode;
  locked: boolean;
  captureSheet: CaptureSheetId | null;
  gimbalPanel: GimbalPanel;
  zoomDialOpen: boolean;
  stopConfirmOpen: boolean;
  /** The operator holds the on-screen stick (wins over gamepad/keyboard). */
  stickHeld: boolean;
  set: (patch: Partial<Omit<LiveUiState, 'set' | 'reset'>>) => void;
  reset: () => void;
}

const initial = {
  disp: 'live' as DispMode,
  locked: false,
  captureSheet: null,
  gimbalPanel: 'none' as GimbalPanel,
  zoomDialOpen: false,
  stopConfirmOpen: false,
  stickHeld: false,
};

/** Transient live-screen UI state. Not persisted: a new live view starts at DISP 1, unlocked. */
export const useLiveUi = create<LiveUiState>()((set) => ({
  ...initial,
  set: (patch) => set(patch),
  reset: () => set(initial),
}));

/** `MonitorZoomPresets`: three saved zoom amounts and one ramp time. */
export const ZOOM_PRESET_SLOTS = 3;
export const ZOOM_RAMP_CHOICES = [0, ...Array.from({ length: 20 }, (_, i) => (i + 1) / 2)];

interface ZoomPresetState {
  slots: (number | null)[];
  rampSeconds: number;
  save: (index: number, factor: number) => void;
  clear: (index: number) => void;
  setRamp: (seconds: number) => void;
}

export function rampLabel(seconds: number) {
  if (seconds === 0) return 'Off';
  return Number.isInteger(seconds) ? `${seconds} s` : `${seconds} s`;
}

export const useZoomPresets = create<ZoomPresetState>()(
  persist(
    (set) => ({
      slots: [null, null, null],
      rampSeconds: 0,
      save: (index, factor) =>
        set((s) => {
          if (index < 0 || index >= ZOOM_PRESET_SLOTS || !(factor > 0)) return s;
          const slots = [...s.slots];
          slots[index] = Math.max(1, Math.round(factor * 10) / 10);
          return { slots };
        }),
      clear: (index) =>
        set((s) => {
          const slots = [...s.slots];
          slots[index] = null;
          return { slots };
        }),
      setRamp: (seconds) =>
        set({
          rampSeconds: ZOOM_RAMP_CHOICES.reduce((b, c) => (Math.abs(c - seconds) < Math.abs(b - seconds) ? c : b), 0),
        }),
    }),
    { name: 'pm.zoomPresets.v1', storage: persistStorage },
  ),
);
