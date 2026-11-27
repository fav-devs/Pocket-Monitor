import { useEffect, useRef, useState } from 'react';
import { LOOKS, bmpDataUri, coverResize, mapLook, swatchFrame } from '@/core/edit';
import { mapCube, type CubeLUT } from '@/core/media';
import { getFrameSample, useFrameSample } from '@/features/picture/frameSample';
import { PocketEdit } from '@modules/pocket-native/src/edit';

/** Thumbnail edge in pixels (cards are 60 pt; the picture under a look is what matters). */
export const THUMB_PX = 72;

export interface ThumbFrame {
  width: number;
  height: number;
  rgba: ArrayLike<number>;
  /** Identifies the frame (cache key). */
  key: string;
}

/**
 * The clip's current frame for the filter cards: a native grab of the playing file, the web /
 * demo picture's sample, else a stand-in swatch. Re-read when `refreshKey` changes (panel open).
 */
export function useThumbFrame(options: { enabled: boolean; uri: string | null; seconds: number; refreshKey: string; demo: boolean }): ThumbFrame | null {
  const { enabled, uri, seconds, refreshKey, demo } = options;
  const sample = useFrameSample('playback', enabled && demo);
  const [grabbed, setGrabbed] = useState<ThumbFrame | null>(null);
  const secondsRef = useRef(seconds);
  secondsRef.current = seconds;

  useEffect(() => {
    if (!enabled || !uri || !PocketEdit) return;
    let live = true;
    PocketEdit.grabFrame(uri, secondsRef.current, 192)
      .then((f) => {
        if (live && f && f.width > 0) setGrabbed({ width: f.width, height: f.height, rgba: f.rgba, key: `${uri}@${refreshKey}` });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled, uri, refreshKey]);

  // The demo picture's sample: keep the first one after opening (cards should not flicker).
  const [demoFrame, setDemoFrame] = useState<ThumbFrame | null>(null);
  useEffect(() => setDemoFrame(null), [refreshKey]);
  useEffect(() => {
    if (!enabled || !demo || demoFrame) return;
    const s = sample ?? getFrameSample('playback');
    if (s) setDemoFrame({ width: s.width, height: s.height, rgba: s.rgba, key: `demo@${refreshKey}` });
  }, [enabled, demo, sample, demoFrame, refreshKey]);

  if (!enabled) return null;
  if (uri && grabbed) return grabbed;
  if (demo && demoFrame) return demoFrame;
  return SWATCH;
}

const SWATCH: ThumbFrame = { width: THUMB_PX, height: THUMB_PX, rgba: swatchFrame(THUMB_PX, THUMB_PX), key: 'swatch' };

const cache = new Map<string, string>();

/**
 * Data URIs of the frame under every built-in look (plus the original and an optional custom
 * cube), computed a few at a time so the panel stays responsive.
 */
export function useLookThumbnails(frame: ThumbFrame | null, custom?: { id: string; cube: CubeLUT } | null): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const customKey = custom ? custom.id : '';
  useEffect(() => {
    if (!frame) return;
    let live = true;
    const base = coverResize(frame, THUMB_PX, THUMB_PX);
    const jobs: { id: string; map: (r: number, g: number, b: number) => [number, number, number] }[] = [
      { id: 'original', map: (r, g, b) => [r, g, b] },
      ...LOOKS.map((l) => ({ id: l.id, map: (r: number, g: number, b: number) => mapLook(l.params, r, g, b) })),
    ];
    if (custom) jobs.push({ id: `custom:${custom.id}`, map: (r, g, b) => mapCube(custom.cube, r, g, b) });
    const out: Record<string, string> = {};
    for (const j of jobs) {
      const hit = cache.get(`${frame.key}|${j.id}`);
      if (hit) out[j.id] = hit;
    }
    setThumbs({ ...out });
    const todo = jobs.filter((j) => !out[j.id]);
    let i = 0;
    const step = () => {
      if (!live) return;
      const started = Date.now();
      while (i < todo.length && Date.now() - started < 12) {
        const j = todo[i++];
        const px = new Uint8ClampedArray(base.length);
        for (let p = 0; p < base.length; p += 4) {
          const m = j.map(base[p] / 255, base[p + 1] / 255, base[p + 2] / 255);
          px[p] = m[0] * 255;
          px[p + 1] = m[1] * 255;
          px[p + 2] = m[2] * 255;
          px[p + 3] = 255;
        }
        const uri = bmpDataUri(THUMB_PX, THUMB_PX, px);
        cache.set(`${frame.key}|${j.id}`, uri);
        out[j.id] = uri;
      }
      setThumbs({ ...out });
      if (i < todo.length) setTimeout(step, 16);
    };
    if (todo.length) setTimeout(step, 0);
    if (cache.size > 400) cache.clear();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.key, customKey]);
  return thumbs;
}
