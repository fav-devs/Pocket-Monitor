/**
 * What keyboard shortcuts and the gamepad can ask of the live screen. The live screen owns
 * the implementations (it knows about confirmation sheets, DISP, routing and notices).
 */
export interface LiveInputActions {
  /** Toggle record. `skipConfirm` for the gamepad (Cross/A skips the stop-confirm sheet). */
  toggleRecord: (opts?: { skipConfirm?: boolean }) => void;
  capturePhoto: () => void;
  recenter: () => void;
  flip: () => void;
  cycleGimbalMode: () => void;
  /** Continuous zoom rate −1…1; 0 stops. */
  zoomRate: (rate: number) => void;
  zoomWide: () => void;
  /** Jump the zoom chip one stop. Out does not wrap to tele. */
  zoomStep: (direction: 1 | -1) => void;
  /** Track a face (centre of frame) or cancel tracking when one runs. */
  toggleFaceTrack: () => void;
  stopTracking: () => void;
  stepResolution: (direction: 1 | -1) => void;
  stepFrameRate: (direction: 1 | -1) => void;
  stepIso: (direction: 1 | -1) => void;
  /** +1 closes (faster), −1 opens (slower). */
  stepShutter: (direction: 1 | -1) => void;
  openGallery: () => void;
  toggleAssist: (assist: 'zebra' | 'peaking' | 'lut' | 'mirror') => void;
  toggleChrome: () => void;
  closeViewfinder: () => void;
  notice: (message: string, tone?: 'info' | 'warning' | 'error' | 'success') => void;
}
