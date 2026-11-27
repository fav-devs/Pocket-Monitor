import { requireOptionalNativeModule } from 'expo';
import type { VideoPlayer } from 'expo-video';

/**
 * `PocketEdit`: the playback editor's GPU colour and face stages on the expo-video player (preview)
 * and the clip exporter. iOS: AVVideoComposition with a Core Image handler on the player item, and
 * AVAssetExportSession with the same handler plus crop/rotate and an audio mix. Android: a Media3
 * GL effect on the player (`ExoPlayer.setVideoEffects`) and Media3 Transformer for export.
 * Null on web and in builds without the module (the web demo draws looks with WebGL instead).
 *
 * Plans are built in `src/core/edit/plan.ts`; see that file for the pipeline stages.
 */

export interface EditSplitRecord {
  axis: 'x' | 'y';
  at: number;
  originalLow: boolean;
}

export interface EditFaceRecord {
  auto: number;
  smooth: number;
  brighten: number;
  slim: number;
  eyes: number;
}

export interface EditPreviewRecord {
  lutKey: string | null;
  split: EditSplitRecord | null;
  face: EditFaceRecord;
  toneMapSdr: boolean;
  volume: number;
  /** Look for faces even at strength 0 (the Face panel is open). */
  faceProbe?: boolean;
}

export interface EditExportRecord {
  sourceUri: string;
  outputName: string;
  lutKey: string | null;
  face: EditFaceRecord;
  rotation: number;
  crop: { x: number; y: number; w: number; h: number };
  flipH: boolean;
  flipV: boolean;
  width: number;
  height: number;
  volume: number;
  trim: { start: number; end: number } | null;
  keepHdr: boolean;
  geometryIdentity: boolean;
}

export interface EditFrame {
  width: number;
  height: number;
  /** Top-down RGBA8. */
  rgba: Uint8Array;
}

export interface EditExportProgressEvent {
  jobId: string;
  fraction: number;
}

/** The preview's face stage: faces it sees in the current frame (sent when the count changes). */
export interface EditFaceCountEvent {
  count: number;
}

export interface PocketEditNativeModule {
  /** Register a baked colour cube: `rgb` is size³ RGB float triplets, red fastest. */
  setLut(key: string, size: number, rgb: Float32Array): void;
  dropLut(key: string): void;
  /** Attach or update the colour stage on an expo-video player (the player keeps it per item). */
  attachPreview(player: VideoPlayer, plan: EditPreviewRecord): void;
  detachPreview(player: VideoPlayer): void;
  /** A small RGBA frame of a local or remote clip at `seconds` (look thumbnails). */
  grabFrame(uri: string, seconds: number, maxWidth: number): Promise<EditFrame | null>;
  /** Render the export; resolves with the output file URI. Progress arrives as `onExportProgress`. */
  startExport(jobId: string, plan: EditExportRecord): Promise<string>;
  cancelExport(jobId: string): void;
  addListener(event: 'onExportProgress', listener: (e: EditExportProgressEvent) => void): { remove(): void };
  addListener(event: 'onFaceCount', listener: (e: EditFaceCountEvent) => void): { remove(): void };
}

const native = requireOptionalNativeModule<PocketEditNativeModule>('PocketEdit');

/** Swift `Data` arrives as `Uint8Array`, Kotlin `ByteArray` as `ArrayBuffer`. */
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return new Uint8Array(0);
}

/** Every call goes to the module object itself (bound), so `this` is never a wrapper. */
export const PocketEdit: PocketEditNativeModule | null = native
  ? {
      setLut: (key, size, rgb) => native.setLut(key, size, rgb),
      dropLut: (key) => native.dropLut(key),
      attachPreview: (player, plan) => native.attachPreview(player, plan),
      detachPreview: (player) => native.detachPreview(player),
      grabFrame: async (uri, seconds, maxWidth) => {
        const f = await native.grabFrame(uri, seconds, maxWidth);
        return f ? { width: f.width, height: f.height, rgba: bytes(f.rgba) } : null;
      },
      startExport: (jobId, plan) => native.startExport(jobId, plan),
      cancelExport: (jobId) => native.cancelExport(jobId),
      addListener: ((event: string, listener: (e: never) => void) =>
        (native.addListener as unknown as (e: string, l: (e: never) => void) => { remove(): void }).call(native, event, listener)) as PocketEditNativeModule['addListener'],
    }
  : null;
