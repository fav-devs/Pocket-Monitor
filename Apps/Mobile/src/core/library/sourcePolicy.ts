/**
 * Storage observations the integration resolves, never the gallery UI.
 *
 * Source of truth: OpenCine `OpenCineDJI/DJIMediaSourcePolicy.swift`.
 */
import type { CameraModel } from '../status/cameraModel';

export interface MediaSourcePolicy {
  /** Nano keeps stars on the body; others are written through `0x00/0x2a` as well. Null: unknown model. */
  sourceOwnsFavorites: boolean | null;
  /** Every `/v2` is `storage=0`. Null: not known yet (in playback the internal block reads zero). */
  singleSdStorage: boolean | null;
}

export function mediaSourcePolicy(model: Pick<CameraModel, 'name' | 'family'> | null, inPlayback: boolean, internalTotalMb: number): MediaSourcePolicy {
  const sourceOwnsFavorites = model ? model.family === 'nano' : null;
  let singleSdStorage: boolean | null;
  // Playback can report one zeroed storage block while both stores remain reachable.
  if (model && model.name.toLowerCase().includes('pocket 3')) singleSdStorage = true;
  else if (!inPlayback && internalTotalMb >= 0) singleSdStorage = internalTotalMb === 0;
  else singleSdStorage = null;
  return { sourceOwnsFavorites, singleSdStorage };
}
