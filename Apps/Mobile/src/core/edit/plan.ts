/**
 * Render plans handed to the native editor (`PocketEdit` in modules/pocket-native): what the
 * preview colour stage and the export pipeline do with one clip. Plain data, built here so the
 * same numbers drive iOS, Android, tests and the web demo.
 *
 * Effect pipeline (both platforms, in order):
 *   1. colour   — one baked 3D LUT (custom LUT → look, strengths mixed in), keyed by `lutKey`
 *   2. face     — face retouch; receives per-frame face landmarks (placeholder: passes through)
 *   3. geometry — rotate (cw) → crop (normalized, rotated frame) → flip → scale to output size
 *   4. audio    — gain (0…2), mute drops the track
 * Preview applies 1–2 natively on the player; 3 is React Native transforms over the view.
 */
import { compareSplit, cropRect, outputSize, rotatedSize, type CompareSplit, type NormRect, type Size } from './geometry';
import { editCubeKey } from './looks';
import { hasFace, hasGeometry, type ClipEdit, type FaceParams, type Rotation } from './model';

export interface PreviewPlan {
  /** Registered baked cube (`PocketEdit.setLut`), or null for no colour change. */
  lutKey: string | null;
  /** Before/after compare line, or null. */
  split: CompareSplit | null;
  face: FaceParams;
  /** Tone-map an HDR source to SDR (HDR toggle off). */
  toneMapSdr: boolean;
  /** 0…2; platforms that cannot boost preview at most 1. */
  volume: number;
}

export type ExportQuality = 'original' | 'low-res';

export interface ExportPlan {
  /** Local file URI of the source (downloaded original or low-res copy). */
  sourceUri: string;
  /** File name for the result (no directory). */
  outputName: string;
  lutKey: string | null;
  face: FaceParams;
  /** Clockwise degrees. */
  rotation: Rotation;
  /** Crop in the rotated frame, normalized, top-left origin. */
  crop: NormRect;
  flipH: boolean;
  flipV: boolean;
  /** Output pixels (even). */
  width: number;
  height: number;
  volume: number;
  trim: { start: number; end: number } | null;
  /** Keep HDR when the source is HDR (false: tone-map to SDR). */
  keepHdr: boolean;
  /** Geometry is identity: native may skip the geometry stage. */
  geometryIdentity: boolean;
}

export function previewPlan(edit: ClipEdit, src: Size, options: { compare: boolean; hdrSource: boolean }): PreviewPlan {
  const lutKey = editCubeKey(edit);
  const colour = lutKey != null || hasFace(edit);
  return {
    lutKey,
    split: options.compare && colour ? compareSplit(src, edit.rotation, edit.crop, { h: edit.flipH, v: edit.flipV }) : null,
    face: { ...edit.face },
    toneMapSdr: options.hdrSource && edit.hdr === 'sdr',
    volume: edit.volume,
  };
}

/** Low-res quick export caps the long side here. */
export const LOW_RES_LONG_SIDE = 1280;

export function exportPlan(
  edit: ClipEdit,
  input: { sourceUri: string; sourceSize: Size; fileName: string; quality: ExportQuality; hdrSource: boolean },
): ExportPlan {
  const { sourceSize } = input;
  const out = outputSize(sourceSize, edit.rotation, edit.crop, input.quality === 'low-res' ? LOW_RES_LONG_SIDE : undefined);
  return {
    sourceUri: input.sourceUri,
    outputName: exportFileName(input.fileName),
    lutKey: editCubeKey(edit),
    face: { ...edit.face },
    rotation: edit.rotation,
    crop: cropRect(sourceSize, edit.rotation, edit.crop),
    flipH: edit.flipH,
    flipV: edit.flipV,
    width: out.width,
    height: out.height,
    volume: edit.volume,
    trim: edit.trim ? { ...edit.trim } : null,
    keepHdr: input.hdrSource && edit.hdr === 'keep',
    geometryIdentity: !hasGeometry(edit) && sameSize(out, rotatedSize(sourceSize, edit.rotation)),
  };
}

const sameSize = (a: Size, b: Size) => Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

/** `DJI_0042.MP4` → `DJI_0042_edit.mp4`. */
export function exportFileName(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, '') || 'clip';
  return `${base.replace(/[^\w.-]+/g, '_')}_edit.mp4`;
}
