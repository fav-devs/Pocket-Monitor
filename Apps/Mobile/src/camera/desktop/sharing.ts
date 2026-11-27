/**
 * Sharing this PC's camera preview (`docs/desktop-expo-port.md` §1.E, main af91c5b) inside
 * the desktop app. Rust (`pm-desktop/src/sharing.rs`) runs the view-only host on the camera's
 * own HEVC, advertised as `_pocket-mon._tcp` and the legacy `_opc-mon._tcp`, up to four
 * watchers, no passcode, off at every launch. Frames never reach JS.
 *
 * - `sharing_set {on}` answers with the readout: running, or why not ("Open a live HEVC camera
 *   feed to share it").
 * - `sharing://status` follows the host; `stopped` marks a stop the operator did not ask for
 *   (the camera reconnected, playback, the relay fell behind), which Rust also raises as a
 *   live-view notice.
 */
import { invoke, listen, type Unlisten } from './tauri';

/** `pm_controller::sharing::SharingStatus`. */
export interface DesktopSharingStatus {
  active: boolean;
  /** "On · View only", "Off", or why it is not running. */
  status: string;
  watchers: number;
  stopped: boolean;
}

export const desktopSharing = {
  set: (on: boolean) => invoke<DesktopSharingStatus>('sharing_set', { on }),
  state: () => invoke<DesktopSharingStatus>('sharing_state'),
  onStatus: (handler: (status: DesktopSharingStatus) => void): Unlisten => listen<DesktopSharingStatus>('sharing://status', handler),
};

/** The mobile `FeedSharingStatus` fields the Settings rows read. */
export interface SharingRowsStatus {
  available: boolean;
  active: boolean;
  state: 'stopped' | 'starting' | 'advertising' | 'failed';
  watchers: number;
  holder: string;
  joinable: boolean;
  video?: 'reencode' | 'forward';
  error: string | null;
}

/**
 * The desktop host's status as the mobile sharing status. The PC forwards the camera's own
 * HEVC, so a new watcher may wait for the next camera keyframe (`video: 'forward'`). A reason
 * other than Off is the error line.
 */
export function sharingRowsStatus(status: DesktopSharingStatus | null): SharingRowsStatus {
  const active = !!status?.active;
  const reason = status && !status.active && status.status !== 'Off' ? status.status : null;
  return {
    available: true,
    active,
    state: active ? 'advertising' : reason ? 'failed' : 'stopped',
    watchers: active ? (status?.watchers ?? 0) : 0,
    holder: 'Host',
    joinable: active,
    video: 'forward',
    error: reason,
  };
}

/** The line under the Share group on the desktop. */
export function desktopShareNote(live: boolean, status: SharingRowsStatus): string | undefined {
  if (status.state === 'failed' && status.error) return status.error;
  if (!status.active) return live ? undefined : 'Connect a camera to share its feed.';
  const watchers = status.watchers === 0 ? 'No watchers' : `${status.watchers} ${status.watchers === 1 ? 'watcher' : 'watchers'}`;
  return `Sharing · ${watchers} · View only`;
}
