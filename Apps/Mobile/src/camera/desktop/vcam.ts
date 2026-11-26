/**
 * The virtual camera (Settings › Media › Output) inside the desktop app (§1.W).
 *
 * Rust (`pm-desktop/src/vcam.rs`) owns the backends, the 30 fps feed from the native picture
 * (never the web view), the platform component and the setting in `desktop-prefs.txt`. This is
 * the typed bridge: `vcam://status` once a second when the readout changes,
 * `component://report` after a probe, install or remove.
 */
import { invoke, listen, type Unlisten } from './tauri';

export type VcamMode = 'off' | 'device' | 'stream';
export type ComponentStateName = 'installed' | 'not-installed' | 'unsupported' | 'busy' | 'unknown';

export interface VcamComponent {
  platform: string;
  state: ComponentStateName;
  /** "Installed", "Not installed", "Not available here", "Working…", "Checking…". */
  label: string;
  detail: string;
  canInstall: boolean;
  canRemove: boolean;
}

export interface VcamStatus {
  mode: VcamMode;
  /** Clean: the LUT stays, zebra, peaking and false colour go. */
  clean: boolean;
  port: number;
  streamUrl: string;
  /** "Stream · http://127.0.0.1:8890/stream · 1,204 frames", an error, or "Off". */
  output: string;
  component: VcamComponent;
}

export const vcam = {
  get: () => invoke<VcamStatus>('vcam_get'),
  set: (change: { mode?: VcamMode; clean?: boolean; port?: number }) => invoke<VcamStatus>('vcam_set', { change }),
  probe: () => invoke<boolean>('vcam_component_probe'),
  install: () => invoke<boolean>('vcam_component_install'),
  remove: () => invoke<boolean>('vcam_component_remove'),
  openUrl: (url: string) => invoke('open_url', { url }),
  onStatus: (handler: (status: VcamStatus) => void): Unlisten => listen<VcamStatus>('vcam://status', handler),
  onComponent: (handler: (component: VcamComponent) => void): Unlisten => listen<VcamComponent>('component://report', handler),
};

/** The OBS recipe for the stream, as the old Output tab gave it. */
export const OBS_RECIPE = 'Media Source · Local File off · format mjpeg · then Start Virtual Camera';
