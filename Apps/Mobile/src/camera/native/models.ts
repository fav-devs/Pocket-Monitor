/**
 * UI model ids ↔ core `CameraModel`. Pure.
 */
import { type CameraModel, MODELS_BY_ID, resolveModel } from '@/core/status/cameraModel';
import type { CameraModelId } from '../types';

const ID_FOR: Partial<Record<CameraModelId, number>> = {
  'osmo-pocket-3': 0x0020,
  'osmo-pocket-4': 0x0021,
  'osmo-pocket-4-pro': 0x0022,
  'osmo-nano': 0x0019,
  'osmo-action-6': 0x0018,
};

/** The core model for a connect target: the BLE model id when seen, else the UI model, else the name. */
export function coreModelFor(model: CameraModelId, name: string, bleModelId: number | null = null): CameraModel {
  if (bleModelId != null) return resolveModel(bleModelId, name);
  const id = ID_FOR[model];
  if (id != null && MODELS_BY_ID[id]) return MODELS_BY_ID[id];
  return resolveModel(null, name);
}

/** Native decoder hint before parameter sets latch it: Pocket 3 and Nano send AVC. */
export function codecHint(model: CameraModel): 'hevc' | 'avc' {
  const n = model.name.toLowerCase().replace(/ /g, '');
  return model.family === 'nano' || n.includes('pocket3') || n.includes('muse') ? 'avc' : 'hevc';
}
