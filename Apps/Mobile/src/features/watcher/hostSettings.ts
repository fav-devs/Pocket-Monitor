/**
 * Settings → Feed sharing as relay host options, for every starter of the host (the Share switch
 * via `useFeedSharing`, and server mode via `src/camera/server/relayHost.ts`).
 */
import { useSettingsLocal, type BroadcastPriority } from '@/features/settings/settingsStore';

/** Video sends in flight per watcher. Deeper rides out radio hiccups at the cost of delay. */
export function windowFor(priority: BroadcastPriority): number {
  return priority === 'Lowest delay' ? 1 : priority === 'Steadier picture' ? 4 : 2;
}

export interface FeedSharingHostSettings {
  /** Empty = open feed. */
  passcode: string;
  allowsControl: boolean;
  window: number;
}

export function feedSharingHostSettings(): FeedSharingHostSettings {
  const s = useSettingsLocal.getState();
  return { passcode: s.watcherPasscode, allowsControl: s.controlRequests, window: windowFor(s.broadcastPriority) };
}
