/**
 * BLE adverts → the scan list (`DiscoveredCamera[]`). Pure. Decode is core `BleAdvert`,
 * identity merge is core `FoundCameraIdentity`, model resolution is core `resolveModel`.
 */
import type { BluetoothAdvert } from '@modules/pocket-native/src/types';
import { BleAdvert } from '@/core/ble/advert';
import { FoundCameraIdentity } from '@/core/ble/savedCamera';
import { brandOf, type CameraBrand, resolveModel } from '@/core/status/cameraModel';
import { modelIdOf } from '@/core/mapping';
import type { DiscoveredCamera } from '../types';

export interface Sighting {
  id: string;
  name: string;
  modelId: number | null;
  brand: CameraBrand;
  rssi: number;
  lastSeen: number;
}

/** iOS reports `127` for peripherals it already holds (no live RSSI). */
export const UNKNOWN_RSSI = 127;
const UNKNOWN_RSSI_STANDIN = -70;

/** Decode one advert; null when it is not a DJI camera. */
export function sightingOf(advert: BluetoothAdvert, now: number): Sighting | null {
  const decoded = advert.manufacturerData ? BleAdvert.decodeManufacturerData(advert.manufacturerData) : null;
  const name = (advert.name ?? '').trim();
  const brand = brandOf(advert.id, name, decoded != null);
  if (!decoded && brand === 'unknown') return null;
  if (!decoded && !name) return null;
  const modelId = decoded?.modelId ?? null;
  const model = resolveModel(modelId, name, brand);
  if (model.isDrone) return null;
  return {
    id: advert.id,
    // Raw advert name ('' when nameless): a synthesized name would beat the real one in the merge.
    name,
    modelId,
    brand,
    rssi: advert.rssi === UNKNOWN_RSSI ? UNKNOWN_RSSI_STANDIN : advert.rssi,
    lastSeen: now,
  };
}

/** Merge a sighting into the running list (nameless / generic adverts do not erase a name). */
export function mergeSighting(list: Map<string, Sighting>, s: Sighting): boolean {
  const existing = list.get(s.id);
  if (!existing) {
    list.set(s.id, s);
    return true;
  }
  const replace = FoundCameraIdentity.shouldReplace(existing.name, existing.modelId, s.name, s.modelId);
  const next: Sighting = {
    ...existing,
    name: replace ? s.name : existing.name,
    modelId: existing.modelId ?? s.modelId,
    brand: existing.brand === 'unknown' ? s.brand : existing.brand,
    rssi: s.rssi,
    lastSeen: s.lastSeen,
  };
  const changed = next.name !== existing.name || next.modelId !== existing.modelId || Math.abs(next.rssi - existing.rssi) >= 4;
  list.set(s.id, next);
  return changed;
}

export function discoveredCamera(s: Sighting, savedIds: Set<string>): DiscoveredCamera {
  const model = resolveModel(s.modelId, s.name, s.brand);
  return {
    id: s.id,
    name: FoundCameraIdentity.listTitle(s.name, model.name),
    model: modelIdOf(model),
    rssi: s.rssi,
    // Core BleAdvert does not decode a pairing-mode flag, so every DJI camera is offered;
    // the camera itself asks for approval when it is not ready.
    pairable: true,
    saved: savedIds.has(s.id),
  };
}

/** Strongest first, then name. */
export function sortedCameras(list: Iterable<Sighting>, savedIds: Set<string>): DiscoveredCamera[] {
  return [...list]
    .map((s) => discoveredCamera(s, savedIds))
    .sort((a, b) => (a.saved !== b.saved ? (a.saved ? -1 : 1) : b.rssi - a.rssi || a.name.localeCompare(b.name)));
}
