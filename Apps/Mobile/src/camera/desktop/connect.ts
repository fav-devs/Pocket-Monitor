/**
 * Getting to a camera inside the desktop app: the Rust commands of
 * `Apps/Desktop/crates/pm-desktop/src/{connect,station,known,prefs,diagnostics,launch}.rs`
 * as typed calls, plus the pieces `DesktopCameraSession` uses for `startScan` and `connect`
 * (`docs/desktop-expo-port.md` §1.A–§1.D, §1.X, §1.Y).
 *
 * - Scan: `ble_scan_start` / `ble_scan_stop`, sightings on `ble://adverts`.
 * - First pair over the camera's own Wi-Fi: `ble_pair` (the backend keeps the password the
 *   camera hands over) then `camera_open {kind: 'paired'}`, which writes the Windows WLAN
 *   profile, joins and links.
 * - First pair onto the operator's Wi-Fi: `station_join` (the password goes to the camera
 *   over Bluetooth and nowhere else), then `camera_open {kind: 'station'}`.
 * - Remembered cameras live in the backend's files (the old viewfinder's);
 *   `features/pairing/desktop/desktopSync.ts` mirrors them into the saved-camera store with
 *   `desktop-*` ids so the Cameras page shows them.
 *
 * This file imports no persisted store, so the session (and its tests) stay free of storage.
 *
 * Nothing here runs outside Tauri: every caller checks `isTauri()` (or `desktopCameraEnabled`).
 */
import { usePendingConnect } from '@/features/pairing/pairingStore';
import type { ConnectOptions, Unsubscribe } from '../session';
import type { CameraModelId, ConnectionPhase, ConnectionState, DiscoveredCamera, SavedCamera } from '../types';
import { invoke, isTauri, listen, type Unlisten } from './tauri';

// ───────────── Shapes the backend speaks ─────────────

export type DesktopRoute = 'home' | 'viewfinder' | 'setup' | 'watch' | 'demo';

/** `launch_args`: what the command line asked for (B1–B8). */
export interface DesktopLaunchArgs {
  route: DesktopRoute;
  camera?: string | null;
  model?: number | null;
  look?: string | null;
  lut?: string | null;
  still?: string | null;
  phone?: string | null;
  phoneAt?: string | null;
  hasPasscode?: boolean;
  gestures?: boolean;
  demo?: boolean;
}

/** `known_cameras`: one remembered camera. */
export interface KnownCamera {
  id: 'desktop-lan' | 'desktop-station' | 'desktop-softap';
  kind: 'lan' | 'station' | 'softap';
  name: string;
  modelId?: number | null;
  ssid?: string | null;
  host?: string | null;
}

/** `app_settings_get/set` (`desktop-app-v1.txt`). Send back what `get` returned, with
 * changes laid over it: a field left out goes back to its default. */
export interface DesktopAppSettings {
  gestures: boolean;
  openCameraAtLaunch: boolean;
  /** Gesture key (`swipe_left`, `palm`, `two`, …) to action key (`nothing`, `recenter`,
   * `flip`, `next_preset`, `previous_preset`, `stop`, `record`, `face_track`). */
  gestureMap?: Record<string, string>;
  gestureSource?: 'cameraFeed' | 'webcam';
  handControl?: boolean;
  stickIsRight?: boolean;
  autoFaceTrack?: boolean;
}

/** `diagnostics_paths`. */
export interface DesktopPaths {
  log?: string | null;
  logsFolder?: string | null;
  dataFolder: string;
  lutFolder: string;
}

export type OpenTarget =
  | { kind: 'auto'; model?: number; setup?: boolean }
  | { kind: 'address'; host: string; model?: number }
  | { kind: 'lan' }
  | { kind: 'station' }
  | { kind: 'softap'; ssid?: string; model?: number }
  | { kind: 'paired'; model?: number }
  | { kind: 'direct'; model?: number };

/** `camera_open`'s answer. `pair` means nothing remembered answered. */
export interface Opened {
  connected: boolean;
  host?: string | null;
  modelId?: number | null;
  pair: boolean;
}

interface Advert {
  id: string;
  name: string;
  modelId?: number | null;
  rssi: number;
  pairable: boolean;
}

/** `pair://step`, `station://step`. */
export interface ConnectStep {
  phase: ConnectionPhase;
  detail: string;
}

interface Paired {
  ssid: string;
  modelId?: number | null;
}

interface StationReady {
  host: string;
  modelId?: number | null;
  confirmed: boolean;
}

// ───────────── Models and ids ─────────────

/** `CameraModelId` → the body's model id the backend's status decoder wants. */
export const MODEL_IDS: Partial<Record<CameraModelId, number>> = {
  'osmo-pocket-3': 0x20,
  'osmo-pocket-4': 0x21,
  'osmo-pocket-4-pro': 0x22,
  'osmo-nano': 0x19,
};

export function cameraModelFor(modelId: number | null | undefined): CameraModelId {
  const hit = (Object.entries(MODEL_IDS) as [CameraModelId, number][]).find(([, id]) => id === modelId);
  return hit ? hit[0] : 'unknown';
}

const modelOf = (model: CameraModelId): number | undefined => MODEL_IDS[model];

/** Ids of cameras the backend remembers, and of the two one-off targets. */
export const DESKTOP_IDS = {
  lan: 'desktop-lan',
  station: 'desktop-station',
  softap: 'desktop-softap',
  /** *Already on camera Wi-Fi*: link 192.168.2.1 with no Bluetooth (C3). */
  direct: 'desktop-direct',
  /** *Connect by address* before it is remembered. */
  address: 'desktop-address',
} as const;

export const isDesktopCameraId = (id: string) => id.startsWith('desktop-');

/** A remembered camera as a saved-camera record. */
export function knownToSaved(known: KnownCamera, previous?: SavedCamera): SavedCamera {
  const path: SavedCamera['path'] =
    known.kind === 'softap'
      ? { kind: 'softap', ssid: known.ssid ?? '' }
      : known.kind === 'station'
        ? { kind: 'station', ssid: known.ssid ?? '', ...(known.host ? { host: known.host } : {}) }
        : // A LAN camera is known by its address: show it where the network name would go.
          { kind: 'station', ssid: known.host ?? '', ...(known.host ? { host: known.host } : {}) };
  return {
    id: known.id,
    name: previous?.name ?? known.name,
    model: cameraModelFor(known.modelId),
    path,
    ...(previous?.lastConnectedAt ? { lastConnectedAt: previous.lastConnectedAt } : {}),
    ...(previous?.favorite ? { favorite: previous.favorite } : {}),
  };
}

/** The target an address typed on the home screen connects. */
export function addressTarget(host: string): SavedCamera {
  return { id: DESKTOP_IDS.address, name: host, model: 'unknown', path: { kind: 'station', ssid: host, host } };
}

/** The target *Already on camera Wi-Fi* connects. */
export const directTarget: SavedCamera = {
  id: DESKTOP_IDS.direct,
  name: 'Camera Wi-Fi',
  model: 'unknown',
  path: { kind: 'softap', ssid: '' },
};

/** How a saved camera is opened. */
export function openTargetForSaved(camera: SavedCamera): OpenTarget {
  const model = modelOf(camera.model);
  switch (camera.id) {
    case DESKTOP_IDS.lan:
      return { kind: 'lan' };
    case DESKTOP_IDS.station:
      return { kind: 'station' };
    case DESKTOP_IDS.softap:
      return { kind: 'softap', ...(model != null ? { model } : {}) };
    case DESKTOP_IDS.direct:
      return { kind: 'direct', ...(model != null ? { model } : {}) };
    default:
      break;
  }
  if (camera.path.kind !== 'softap' && 'host' in camera.path && camera.path.host) {
    return { kind: 'address', host: camera.path.host, ...(model != null ? { model } : {}) };
  }
  if (camera.path.kind === 'softap') {
    return { kind: 'softap', ...(camera.path.ssid ? { ssid: camera.path.ssid } : {}), ...(model != null ? { model } : {}) };
  }
  return { kind: 'station' };
}

// ───────────── Scan (C1) ─────────────

let scanners = 0;

/** Bluetooth scan in ≥ 3 s windows. Several screens may scan; the radio stops with the last. */
export function startDesktopScan(onFound: (cameras: DiscoveredCamera[]) => void): Unsubscribe {
  if (!isTauri()) {
    onFound([]);
    return () => {};
  }
  const stop = listen<Advert[]>('ble://adverts', (adverts) => {
    onFound(
      (adverts ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        model: cameraModelFor(a.modelId),
        rssi: a.rssi,
        pairable: a.pairable,
        // The screens mark saved cameras from their own list.
        saved: false,
      })),
    );
  });
  scanners += 1;
  invoke('ble_scan_start').catch(() => onFound([]));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    stop();
    scanners = Math.max(0, scanners - 1);
    if (scanners === 0) invoke('ble_scan_stop').catch(() => {});
  };
}

// ───────────── Connect ─────────────

/** Patches the session lays over its connection state until the link takes over. */
export type ConnectReport = (patch: Partial<ConnectionState> | null) => void;

const errorText = (error: unknown) =>
  typeof error === 'string' ? error : error instanceof Error ? error.message : 'The camera did not answer.';

/** True when the backend refused because the operator cancelled. */
export const isCancelled = (error: unknown) => errorText(error) === 'cancelled';

/**
 * Runs everything before the datalink: Bluetooth pairing, the Wi-Fi join or the station
 * provisioning, the LAN search, and then `camera_open`. Phases go to `report` as they
 * happen; `report(null)` hands the connection state back to the backend's link.
 */
export async function desktopConnect(
  target: DiscoveredCamera | SavedCamera,
  options: ConnectOptions | undefined,
  report: ConnectReport,
): Promise<Opened> {
  const onStep = (step: ConnectStep) => {
    if (step?.phase) report({ phase: step.phase, detail: step.detail, error: undefined });
  };
  const stops: Unlisten[] = [listen<ConnectStep>('pair://step', onStep), listen<ConnectStep>('station://step', onStep)];
  try {
    let opened: Opened;
    if ('path' in target) {
      const open = openTargetForSaved(target);
      const joins = open.kind === 'softap' || open.kind === 'station';
      report({
        phase: joins ? 'joining-wifi' : 'datalink',
        detail: open.kind === 'station' ? 'Finding the camera on your Wi-Fi…' : joins ? 'Joining camera Wi-Fi…' : 'Wi-Fi datalink',
        error: undefined,
        transport: target.path.kind === 'softap' ? 'softap' : 'station',
      });
      opened = await invoke<Opened>('camera_open', { target: open });
    } else {
      // A first pair: the setup the operator chose is on the pending connect.
      const pending = usePendingConnect.getState().target;
      const path = pending && pending.id === target.id ? pending.path : ({ kind: 'softap', ssid: '' } as const);
      const model = modelOf(target.model);
      report({
        phase: 'bluetooth',
        detail: 'Connecting over Bluetooth…',
        error: undefined,
        transport: path.kind === 'softap' ? 'softap' : 'station',
      });
      if (path.kind === 'softap') {
        const paired = await invoke<Paired>('ble_pair', { address: target.id, ...(model != null ? { model } : {}) });
        report({ phase: 'joining-wifi', detail: `Joining ${paired.ssid}…` });
        opened = await invoke<Opened>('camera_open', { target: { kind: 'paired', ...(model != null ? { model } : {}) } });
      } else {
        await invoke<StationReady>('station_join', {
          address: target.id,
          ssid: path.ssid,
          password: options?.wifiPassword ?? '',
          ...(model != null ? { model } : {}),
        });
        opened = await invoke<Opened>('camera_open', { target: { kind: 'station' } });
      }
    }
    if (opened?.pair) throw new Error('No remembered camera answered. Pair it again.');
    report(null);
    return opened;
  } catch (error) {
    if (isCancelled(error)) {
      report({ phase: 'disconnected', detail: undefined, error: undefined });
    } else {
      report({ phase: 'failed', detail: undefined, error: errorText(error) });
    }
    throw error;
  } finally {
    stops.forEach((stop) => stop());
  }
}

/** Stops a pairing or station exchange in flight. */
export const cancelDesktopConnect = () => invoke('ble_cancel').catch(() => {});

// ───────────── Remembered cameras (A1, X5–X7) ─────────────

export const knownCameras = () => invoke<KnownCamera[]>('known_cameras');
export const forgetDesktopCamera = (id: string) => invoke('forget_camera', { id });
export const probeCamera = (host: string) => invoke<boolean>('probe_camera', { host });
/** `host:port` for a typed address, or the operator copy for something that is not one. */
export const checkCameraAddress = (text: string) => invoke<string>('camera_address_check', { text });

// ───────────── Home network (D-1…D-4) ─────────────

export const currentPcSsid = () => invoke<string | null>('station_current_ssid');
export const findStationCamera = () => invoke<string>('station_find');
export const returnCameraToOwnWifi = (address: string) => invoke('station_reset', { address });

// ───────────── Launch, settings, diagnostics ─────────────

export const launchArgs = () => invoke<DesktopLaunchArgs>('launch_args');
export const keyboardShortcuts = () => invoke<string>('keyboard_shortcuts');
export const onLaunchArgs = (handler: (args: DesktopLaunchArgs) => void) => listen<DesktopLaunchArgs>('launch://args', handler);
export const openCamera = (target: OpenTarget) => invoke<Opened>('camera_open', { target });
export const appSettingsGet = () => invoke<DesktopAppSettings>('app_settings_get');
export const appSettingsSet = (settings: DesktopAppSettings) => invoke<DesktopAppSettings>('app_settings_set', { settings });
export const desktopPrefsGet = () => invoke<Record<string, unknown>>('prefs_get');
export const desktopPrefsSet = (patch: Record<string, unknown>) => invoke<Record<string, unknown>>('prefs_set', { patch });
export const diagnosticsPaths = () => invoke<DesktopPaths>('diagnostics_paths');
export const writeDiagnostics = (report?: string) => invoke<string>('diagnostics_write', report ? { report } : {});
export const logTail = (lines?: number) => invoke<string>('log_tail', lines ? { lines } : {});
export const openDesktopFolder = (which: 'logs' | 'data' | 'luts') => invoke('open_folder', { which });
