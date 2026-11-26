/**
 * Clip export seam (OpenCine `MonitorDeliveryExportService` / `MonitorMediaExporter`).
 *
 * Today only pass-through exports exist: the camera original is delivered byte for byte.
 * Converting log footage, baking a LUT or exposure, or re-encoding to another container needs
 * a native exporter, which this build does not have yet. The delivery UI shows those options,
 * marks them as needing the native exporter, and delivers originals when they cannot run.
 *
 * TODO(native exporter): implement `NativeMediaExporter` in `modules/opc-native`:
 *  - iOS: AVAssetReader → CIFilter chain (log → Rec.709/HLG transfer, CIColorCubeWithColorSpace for
 *    the LUT, exposure gain) → AVAssetWriter (HEVC/H.264, keep the source frame rate and audio,
 *    copy metadata when `includeMetadata`). Port `MonitorLogDisplayTransform`,
 *    `LUTExposureCompensation` and `CubeLUTPacking` from OpenCineMedia.
 *  - Android: Media3 Transformer with a GL effect carrying the same transform and packed LUT.
 *  - Report progress 0…1 through `onProgress`, honour `signal` for cancel, write into the
 *    app cache and return the file URI. Then set `available: true` for that platform below.
 */
import type { CameraMediaItem } from '@/camera';
import type { MediaOutputCurve, MediaShareFormat } from '@/state/media';
import { isLogColor } from './format';

export interface ExportOptions {
  convertLog: boolean;
  outputCurve: MediaOutputCurve;
  bakeLUT: boolean;
  bakeExposure: boolean;
  format: MediaShareFormat;
  includeMetadata: boolean;
}

export interface ExportRequest {
  item: CameraMediaItem;
  /** Local URI of the downloaded original. */
  sourceUri: string;
  options: ExportOptions;
  /** Display LUT to bake (id from the LUT library), when `bakeLUT`. */
  lutId?: string;
  /** Exposure offset in stops to bake, when `bakeExposure`. */
  exposureOffsetEv?: number;
}

export interface ExportResult {
  uri: string;
  fileName: string;
  mimeType: string;
  /** True when the original was delivered unchanged. */
  passthrough: boolean;
}

export interface MediaExporter {
  /** True when transforms (convert log, bake LUT/exposure, re-encode) can run on this device. */
  readonly available: boolean;
  export(request: ExportRequest, onProgress?: (fraction: number) => void, signal?: { cancelled: boolean }): Promise<ExportResult>;
}

export class ExportUnavailableError extends Error {
  constructor() {
    super('Convert log, Bake LUT and re-encoding need the native exporter, which is not in this build.');
    this.name = 'ExportUnavailableError';
  }
}

export function mimeTypeFor(item: CameraMediaItem): string {
  const ext = item.fileName.split('.').pop()?.toLowerCase();
  if (item.kind === 'photo') return ext === 'dng' ? 'image/x-adobe-dng' : 'image/jpeg';
  return ext === 'mov' ? 'video/quicktime' : 'video/mp4';
}

/** The transforms a request asks for that a pass-through export cannot do. */
export function requestedTransforms(item: CameraMediaItem, options: ExportOptions): string[] {
  const out: string[] = [];
  if (options.convertLog && item.kind === 'video' && isLogColor(item.colorMode)) out.push('Convert log');
  if (options.bakeLUT && item.kind === 'video') out.push('Bake LUT');
  if (options.bakeExposure && item.kind === 'video') out.push('Bake exposure');
  if (options.format !== 'original' && item.kind === 'video') out.push(options.format === 'h264' ? 'H.264' : 'HEVC');
  return out;
}

/** Pass-through exporter: delivers originals; refuses transforms until the native side lands. */
export const mediaExporter: MediaExporter = {
  available: false,
  async export(request, onProgress) {
    if (requestedTransforms(request.item, request.options).length) throw new ExportUnavailableError();
    onProgress?.(1);
    return {
      uri: request.sourceUri,
      fileName: request.item.fileName,
      mimeType: mimeTypeFor(request.item),
      passthrough: true,
    };
  },
};
