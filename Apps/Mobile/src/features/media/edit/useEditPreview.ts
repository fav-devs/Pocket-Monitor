import { useEffect, useMemo, useRef } from 'react';
import type { VideoPlayer } from 'expo-video';
import { hasColor, previewPlan, type ClipEdit } from '@/core/edit';
import type { Size } from '@/core/edit';
import { usePictureEffects } from '@/state/assists';
import { PocketEdit } from '@modules/pocket-native/src/edit';
import type { PictureEffects } from '@modules/pocket-native/src/types';
import { useEditCube } from './cubes';

/**
 * Live preview of the edit's per-pixel stages on whatever plays the clip:
 * - expo-video (a real clip): `PocketEdit.attachPreview` puts the colour stage on the player
 *   natively (Core Image on the AVPlayerItem / a Media3 GL effect on the ExoPlayer), so 4K
 *   proxies stay on the hardware decode → GPU path with no frame copies through JS.
 * - the demo picture (web, demo camera): the baked cube goes to `LivePicture` as its LUT.
 * Geometry is not here: `EditedPicture` lays the view out with transforms.
 */
export function useEditPreview(options: {
  edit: ClipEdit;
  engineKind: 'video' | 'simulated' | 'desktop';
  player: VideoPlayer | null;
  ready: boolean;
  compare: boolean;
  source: Size;
  hdrSource: boolean;
  /** Changes when the player's item changes (re-attach). */
  itemKey: string;
}): { demoEffects: PictureEffects | undefined; nativePreview: boolean } {
  const { edit, engineKind, player, ready, compare, source, hdrSource, itemKey } = options;
  const video = engineKind === 'video' && !!player;
  const nativePreview = video && !!PocketEdit;
  const demo = engineKind === 'simulated';
  const { nativeKey, demoId } = useEditCube(edit, { native: nativePreview, demo });
  const base = usePictureEffects('playback');

  // Native colour stage on the player.
  const plan = useMemo(() => {
    const p = previewPlan(edit, source, { compare, hdrSource });
    return { ...p, lutKey: nativeKey };
  }, [edit, source, compare, hdrSource, nativeKey]);
  const planJson = JSON.stringify(plan);
  const attached = useRef<VideoPlayer | null>(null);
  useEffect(() => {
    if (!nativePreview || !player || !ready) return;
    const needed = plan.lutKey != null || plan.toneMapSdr || plan.volume > 1.001 || hasColor(edit);
    try {
      if (needed) {
        PocketEdit!.attachPreview(player, plan);
        attached.current = player;
      } else if (attached.current) {
        PocketEdit!.detachPreview(attached.current);
        attached.current = null;
      }
    } catch {
      // Older native build without the module: the picture plays unedited.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativePreview, player, ready, planJson, itemKey]);
  useEffect(
    () => () => {
      if (attached.current && PocketEdit) {
        try {
          PocketEdit.detachPreview(attached.current);
        } catch {
          // Player already released.
        }
      }
      attached.current = null;
    },
    [],
  );

  // Volume: the player itself goes 0…1 (boost above 100 % is the native audio stage's job).
  useEffect(() => {
    if (!video || !player) return;
    try {
      player.volume = Math.min(1, Math.max(0, edit.volume));
    } catch {
      // Player released.
    }
  }, [video, player, edit.volume, itemKey]);

  const demoEffects = useMemo<PictureEffects | undefined>(() => {
    if (!demo) return undefined;
    if (!demoId) return base;
    return { ...base, lutId: demoId, lutIntensity: 1, lutExposureStops: 0 };
  }, [demo, demoId, base]);

  return { demoEffects, nativePreview };
}
