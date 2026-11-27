/**
 * The saved Multiview stage: what the app writes so a relaunch restores the operator's layout and
 * finishes a pending camera network cleanup. Values and rules only; storage stays in the app.
 * Network credentials never belong here.
 * Source of truth: OpenCine `OpenCineAppKit/MultiviewStageJournal.swift`, `MultiviewStageState`
 * (presentation) and `MultiviewCoordinator.restoreStage` (a saved stage supplies presentation and
 * cleanup obligations; it never reconnects cameras by itself).
 */
export type StageLayout = 'grid' | 'center';

export interface JournalCamera {
  slot: number;
  id: string;
  name: string;
  /** UI model id (`CameraModelId`). */
  model: string;
  /** Last address the camera answered at on the shared network. */
  host?: string;
  experimental: boolean;
  lutEnabled: boolean;
  /** Demo cameras: the scene they show. */
  demoScene?: string;
}

export interface JournalStage {
  version: 1;
  /** Shared network; empty for a demo-only stage or a cleanup-only ledger. */
  ssid: string;
  hotspot: boolean;
  layout: StageLayout;
  focusedIndex: number;
  fill: boolean;
  cameras: JournalCamera[];
  /** Cameras moved onto the shared network that still have to return to their own Wi-Fi. */
  pendingReset: JournalCamera[];
}

export const MULTIVIEW_TILE_COUNT = 4;

/** The stage when it is safe to restore with `tileCount` tiles, else null. */
export function validateStage(stage: unknown, tileCount = MULTIVIEW_TILE_COUNT): JournalStage | null {
  if (!stage || typeof stage !== 'object') return null;
  const s = stage as Partial<JournalStage>;
  const cameras = Array.isArray(s.cameras) ? s.cameras : null;
  const cleanup = Array.isArray(s.pendingReset) ? s.pendingReset : [];
  if (s.version !== 1 || !cameras || typeof s.ssid !== 'string') return null;
  if (s.layout !== 'grid' && s.layout !== 'center') return null;
  const focused = s.focusedIndex;
  if (typeof focused !== 'number' || !Number.isInteger(focused) || focused < 0 || focused >= tileCount) return null;
  if (cameras.length > tileCount) return null;
  const validCamera = (c: JournalCamera) => !!c && typeof c.id === 'string' && !!c.id && typeof c.name === 'string' && !!c.name;
  if (!cameras.every((c) => validCamera(c) && Number.isInteger(c.slot) && c.slot >= 0 && c.slot < tileCount)) return null;
  if (new Set(cameras.map((c) => c.slot)).size !== cameras.length) return null;
  if (new Set(cameras.map((c) => c.id)).size !== cameras.length) return null;
  if (!cleanup.every(validCamera) || new Set(cleanup.map((c) => c.id)).size !== cleanup.length) return null;
  return { version: 1, ssid: s.ssid, hotspot: !!s.hotspot, layout: s.layout, focusedIndex: focused, fill: !!s.fill, cameras, pendingReset: cleanup };
}

/** `pending` with each of `cameras` replacing the entry of the same id, or appended when new. */
export function cleanupTargets(pending: JournalCamera[], including: JournalCamera[]): JournalCamera[] {
  const out = [...pending];
  for (const c of including) {
    const i = out.findIndex((p) => p.id === c.id);
    if (i >= 0) out[i] = c;
    else out.push(c);
  }
  return out;
}

/** Operator copy for the stage (`MultiviewCopy`, `MultiviewNetworkRestore`). */
export const MultiviewCopy = {
  addCamera: 'Add camera',
  approveOnCamera: 'Connecting · approve on camera',
  connectingPreview: 'Connecting',
  waitingForVideo: 'Waiting for video',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  restoring: 'Restoring picture…',
  couldNotConnect: 'Could not connect',
  connectionFailed: 'Connection failed',
  couldNotRestore: 'Could not restore preview. Tap Reconnect to try again.',
  duplicate: 'This camera is already in Multiview.',
  full: 'Multiview shows up to four cameras.',
  notFound:
    'Could not find this camera on the shared Wi-Fi. Check that both devices use the same network and that client isolation is off, then tap Reconnect.',
  checkNetwork: 'Check the network name and password.',
  closeCleanupFailed: 'Some cameras could not return to their own Wi-Fi. Keep them powered on and close Multiview again to retry.',
  closeQuestion: (restore: boolean) => (restore ? 'Cameras return to their own Wi-Fi. Recording continues.' : 'Recording continues.'),
  closingProgress: (restore: boolean) => (restore ? 'Returning cameras to their Wi-Fi…' : 'Closing Multiview…'),
  pickerFooter: (network: string) => `Each camera joins ${network}. Approve on the camera if asked.`,
};

export type RestoreResult = 'restored' | 'deferred' | 'failed';

/**
 * One Exit handles the post-session `00 06` (pairing deferred) reply: at most three attempts,
 * waiting between them only after a deferred pairing. Any other failure ends at once.
 * Source: OpenCine `OpenCineDJI/MultiviewExit.swift` (`restoreCameraWiFiWithRetry`).
 */
export async function restoreWithRetry(attempt: () => Promise<RestoreResult>, waitBetween: () => Promise<void>): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    let result: RestoreResult;
    try {
      result = await attempt();
    } catch {
      return false;
    }
    if (result === 'restored') return true;
    if (result !== 'deferred' || i === 2) return false;
    await waitBetween();
  }
  return false;
}
