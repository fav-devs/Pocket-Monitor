import type { DiscoveredCamera, SavedCamera } from '@/camera';
import type { MultiviewCamera, MultiviewNetwork } from '@/camera/multiview/types';
import { modelDisplayName } from '@/camera/defaults';

export interface AddChoice {
  camera: MultiviewCamera;
  /** Shown under the name: the model, or where the camera is. */
  detail: string;
}

export interface AddGroups {
  /** Saved cameras already on the stage's network: they connect where they are. */
  onNetwork: AddChoice[];
  /** Saved or nearby cameras that will be moved onto the network (station join over BLE). */
  toMove: AddChoice[];
}

const pathFor = (network: MultiviewNetwork, host?: string): NonNullable<MultiviewCamera['path']> =>
  network.hotspot ? { kind: 'hotspot', ssid: network.ssid, ...(host ? { host } : {}) } : { kind: 'station', ssid: network.ssid, ...(host ? { host } : {}) };

/**
 * The Add list for a real-camera stage: saved cameras on this network first, then saved and
 * nearby cameras to move onto it. Cameras already on the stage are left out.
 */
export function addChoices(saved: SavedCamera[], nearby: DiscoveredCamera[], network: MultiviewNetwork, onStage: string[]): AddGroups {
  const taken = new Set(onStage);
  const onNetwork: AddChoice[] = [];
  const toMove: AddChoice[] = [];
  for (const c of saved) {
    if (taken.has(c.id)) continue;
    taken.add(c.id);
    const here = (c.path.kind === 'station' || c.path.kind === 'hotspot') && c.path.ssid === network.ssid;
    const host = here && 'host' in c.path ? c.path.host : undefined;
    const camera: MultiviewCamera = { id: c.id, name: c.name, model: c.model, path: pathFor(network, host) };
    (here ? onNetwork : toMove).push({ camera, detail: modelDisplayName(c.model) });
  }
  for (const d of nearby) {
    if (taken.has(d.id)) continue;
    taken.add(d.id);
    toMove.push({ camera: { id: d.id, name: d.name, model: d.model, path: pathFor(network) }, detail: modelDisplayName(d.model) });
  }
  return { onNetwork, toMove };
}
