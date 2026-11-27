/**
 * The server notification's content from camera state (pure). Strings are operator copy.
 */
import type { ServerNotificationStatus } from '@modules/pocket-native/src/types';
import type { ConnectionPhase } from '../types';

export interface ServerSnapshot {
  cameraName: string;
  phase: ConnectionPhase;
  recording: boolean;
  elapsedSec: number;
  watchers: number;
  openUrl: string | null;
}

export function linkLabel(phase: ConnectionPhase): string {
  switch (phase) {
    case 'live':
      return 'Live';
    case 'live-start':
      return 'Starting picture';
    case 'recovering':
      return 'Reconnecting';
    case 'failed':
      return 'Camera lost';
    case 'idle':
    case 'disconnected':
      return 'No camera';
    default:
      return 'Connecting';
  }
}

export function watchersLabel(count: number): string {
  if (count <= 0) return 'No watchers';
  return count === 1 ? '1 watcher' : `${count} watchers`;
}

export function serverNotification(s: ServerSnapshot): ServerNotificationStatus {
  const live = s.phase === 'live' || s.phase === 'recovering';
  return {
    title: s.cameraName || 'Camera',
    text: `${linkLabel(s.phase)} · ${watchersLabel(s.watchers)}`,
    live,
    recording: live && s.recording,
    recordingElapsedSec: live && s.recording ? Math.max(0, s.elapsedSec) : null,
    openUrl: s.openUrl,
  };
}

/**
 * True when the notification must be re-posted. The REC time is a native chronometer, so the
 * per-second elapsed value alone is not a change (Android also drops > ~5 updates / s).
 */
export function notificationChanged(a: ServerNotificationStatus | null, b: ServerNotificationStatus): boolean {
  if (!a) return true;
  return a.title !== b.title || a.text !== b.text || a.live !== b.live || a.recording !== b.recording || a.openUrl !== b.openUrl;
}
