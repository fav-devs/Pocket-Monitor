import { DemoCameraSession } from '../demo/DemoCameraSession';
import type { CameraSession } from '../session';
import type { MultiviewCamera } from './types';

/** Four believable demo cameras, each with its own test scene (web preview, demo mode). */
export const DEMO_MULTIVIEW_CAMERAS: MultiviewCamera[] = [
  { id: 'demo-mv-pocket-4-pro', name: 'Pocket 4 Pro', model: 'osmo-pocket-4-pro', demoScene: 'studio' },
  { id: 'demo-mv-pocket-3', name: 'Pocket 3', model: 'osmo-pocket-3', demoScene: 'skin' },
  { id: 'demo-mv-nano', name: 'Nano', model: 'osmo-nano', demoScene: 'night' },
  { id: 'demo-mv-pocket-4', name: 'Pocket 4', model: 'osmo-pocket-4', demoScene: 'bars' },
];

export function createDemoTileSession(camera: MultiviewCamera): CameraSession {
  return new DemoCameraSession(camera.model, { scene: camera.demoScene ?? 'studio' });
}
