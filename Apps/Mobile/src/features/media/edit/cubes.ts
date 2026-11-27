import { useEffect, useRef, useState } from 'react';
import { composeEditCube, editCubeKey, EDIT_CUBE_SIZE, lookById, type ClipEdit } from '@/core/edit';
import type { CubeLUT } from '@/core/media';
import { ensureLut, getLut, registerCube, unregisterCube, useLutVersion } from '@/features/picture/lutLibrary';
import { PocketEdit } from '@modules/pocket-native/src/edit';

/**
 * Baking the edit's colour stage (custom LUT → look, with strengths) into one cube, and handing
 * it to whoever draws the picture: `PocketEdit.setLut` for the native player and exporter, the
 * shared LUT library for the web / demo picture (`LivePicture` effects).
 *
 * Baking runs on the JS thread, so while a strength is dragged the preview gets a 17-point cube
 * (cheap) and the full 33-point cube follows once the value settles.
 */

const QUICK_SIZE = 17;
const SETTLE_MS = 280;
const KEEP_NATIVE = 4;

const baked = new Map<string, CubeLUT>();

/** The custom LUT's cube when loaded (`ensureLut` loads it). */
export function customCube(id: string | null): CubeLUT | null {
  return id ? getLut(`custom:${id}`) : null;
}

/** Bake (cached) the edit's cube at `size`, or null without colour / while a custom LUT loads. */
export function bakeEditCube(edit: Pick<ClipEdit, 'look' | 'lookStrength' | 'lut' | 'lutStrength'>, size = EDIT_CUBE_SIZE): { key: string; cube: CubeLUT } | null {
  const base = editCubeKey(edit);
  if (!base) return null;
  const custom = customCube(edit.lut);
  if (edit.lut && edit.lutStrength > 0.001 && !custom) return null;
  const key = `${base}#${size}`;
  const hit = baked.get(key);
  if (hit) return { key, cube: hit };
  const cube = composeEditCube({ look: lookById(edit.look), lookStrength: edit.lookStrength, custom, customStrength: edit.lutStrength, size });
  if (!cube) return null;
  baked.set(key, cube);
  if (baked.size > 24) baked.delete(baked.keys().next().value as string);
  return { key, cube };
}

const nativeKeys: string[] = [];

/** Register a baked cube with the native module (keeps the last few). */
export function registerNativeCube(key: string, cube: CubeLUT) {
  if (!PocketEdit) return;
  const at = nativeKeys.indexOf(key);
  if (at >= 0) {
    nativeKeys.splice(at, 1);
    nativeKeys.push(key);
    return;
  }
  PocketEdit.setLut(key, cube.size, cube.rgb);
  nativeKeys.push(key);
  while (nativeKeys.length > KEEP_NATIVE) {
    const old = nativeKeys.shift()!;
    try {
      PocketEdit.dropLut(old);
    } catch {
      // ignore
    }
  }
}

/**
 * The cube ids to draw the current edit with: `nativeKey` (registered with `PocketEdit`, for the
 * player) and `demoId` (registered with the LUT library, for `LivePicture`). Both null without a
 * colour change.
 */
export function useEditCube(edit: ClipEdit, targets: { native: boolean; demo: boolean }): { nativeKey: string | null; demoId: string | null } {
  useLutVersion();
  const lutId = edit.lut ? `custom:${edit.lut}` : null;
  useEffect(() => {
    if (lutId) void ensureLut(lutId);
  }, [lutId]);

  const base = editCubeKey(edit);
  const [settledBase, setSettledBase] = useState(base);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSettledBase(base), SETTLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [base]);

  const settled = settledBase === base;
  const quick = targets.native || targets.demo ? bakeEditCube(edit, QUICK_SIZE) : null;
  const full = targets.native && settled ? bakeEditCube(edit, EDIT_CUBE_SIZE) : null;
  const nativeCube = full ?? quick;

  if (targets.native && nativeCube) registerNativeCube(nativeCube.key, nativeCube.cube);

  const demoId = targets.demo && quick ? `pm-${quick.key}` : null;
  const lastDemo = useRef<string | null>(null);
  useEffect(() => {
    if (demoId && quick) registerCube(demoId, quick.cube);
    const prev = lastDemo.current;
    lastDemo.current = demoId;
    if (prev && prev !== demoId) unregisterCube(prev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoId]);
  useEffect(() => () => void (lastDemo.current && unregisterCube(lastDemo.current)), []);

  return { nativeKey: targets.native && nativeCube ? nativeCube.key : null, demoId };
}
