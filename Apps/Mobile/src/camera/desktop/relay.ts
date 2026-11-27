/**
 * Watching a phone's shared feed inside the desktop app (§1.E).
 *
 * Rust (`pm-desktop/src/relay.rs`) browses `_opc-mon._tcp`, joins with the core's relay rules,
 * decodes the phone's HEVC into the native picture and emits the phone's readouts as
 * `camera://state` (`transport: 'watcher'`), so the live screen works on it unchanged. While
 * watching, `DesktopCameraSession` sends controller calls to `relay_command`, which proxies
 * what the relay wire carries once the phone has granted control.
 */
import { invoke, listen, type Unlisten } from './tauri';

export interface RelayHost {
  name: string;
  camera: string;
  addresses: string[];
  port: number;
}

export interface RelayHosts {
  hosts: RelayHost[];
  browsing: boolean;
  error: string | null;
}

export type RelayPhase = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'failed';
export type RelayControl = 'not-offered' | 'available' | 'requested' | 'held' | 'held-by';

export interface RelayInfo {
  phase: RelayPhase;
  detail: string;
  host: string;
  camera: string;
  format: string;
  color: string;
  liveFps: string;
  control: RelayControl;
  holder: string;
  controlLabel: string;
  recording: boolean;
}

export const relay = {
  browse: (on: boolean) => invoke<RelayHosts>('relay_browse', { on }),
  info: () => invoke<RelayInfo>('relay_info'),
  join: (target: { name: string; passcode?: string; addresses?: string[]; port?: number }) => invoke('relay_join', { target }),
  leave: () => invoke('relay_leave'),
  control: (want: boolean) => invoke('relay_control', { want }),
  onHosts: (handler: (hosts: RelayHosts) => void): Unlisten => listen<RelayHosts>('relay://hosts', handler),
  onInfo: (handler: (info: RelayInfo) => void): Unlisten => listen<RelayInfo>('relay://info', handler),
};

/** The lease in the Link tab's words. */
export function controlCopy(info: Pick<RelayInfo, 'control' | 'holder'>): string {
  switch (info.control) {
    case 'held':
      return 'You have control';
    case 'requested':
      return 'Requested · grant it on the phone';
    case 'held-by':
      return `${info.holder} has control`;
    case 'available':
      return 'Not requested';
    default:
      return 'Not offered';
  }
}
