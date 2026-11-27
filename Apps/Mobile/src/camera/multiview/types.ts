import type { JournalCamera, StageLayout } from '@/core/multicam';
import type { CameraSession } from '../session';
import type { CameraModelId, CameraNetworkPath } from '../types';
import type { LutSelection } from '@/state/assists';

export type DemoScene = 'studio' | 'bars' | 'skin' | 'night';

/** A camera a Multiview slot shows. */
export interface MultiviewCamera {
  id: string;
  name: string;
  model: CameraModelId;
  /** Real cameras: the shared network path (station Wi-Fi or this phone's hotspot). */
  path?: Extract<CameraNetworkPath, { kind: 'station' | 'hotspot' }>;
  /** Demo cameras: the test scene. */
  demoScene?: DemoScene;
  experimental?: boolean;
}

/** The shared network the stage's cameras join. The password lives in secure storage. */
export interface MultiviewNetwork {
  ssid: string;
  hotspot: boolean;
}

/** Per-tile monitoring look: the picture effects this camera's tile shows. */
export interface TileLook {
  /** Auto LUT / the chosen look (upstream `lutEnabled`). */
  lut: boolean;
  selection: LutSelection;
  peaking: boolean;
  zebra: boolean;
  falseColor: boolean;
  mono: boolean;
}

export const DEFAULT_LOOK: TileLook = { lut: true, selection: 'auto', peaking: false, zebra: false, falseColor: false, mono: false };

export type TilePhase = 'empty' | 'connecting' | 'live' | 'waiting' | 'reconnecting' | 'failed';

/** One slot as the screen shows it. Live camera values come from the session itself. */
export interface TileSnapshot {
  slot: number;
  camera: MultiviewCamera | null;
  session: CameraSession | null;
  phase: TilePhase;
  /** Short status ("Connecting", "Waiting for video", "Reconnecting…"). */
  status: string;
  /** Failure detail with a suggested fix; Reconnect clears it. */
  failure?: string;
  /** The coordinator is running a bounded repair for this tile. */
  recovering: boolean;
  /** Camera-reported recording (false while unknown or not live). */
  recording: boolean;
  /** A record command on this camera waits for confirmation. */
  recordBusy: boolean;
  recordNote?: string;
  /** Waiting for its turn on the Bluetooth radio. */
  queued: boolean;
}

export interface StageSnapshot {
  tiles: TileSnapshot[];
  groupBusy: boolean;
  closing: boolean;
  /** Number of slots with a camera. */
  members: number;
  anyRecording: boolean;
}

export type { JournalCamera, StageLayout };
