/**
 * Decoded on-camera manifest (`MediaFile`, core `MediaManifest`) → UI `CameraMediaItem`. Pure.
 * The session adds what lives on this device (cached thumbnail, proxy, downloaded original) and
 * the `/v2` URLs (`src/core/library/http.ts`).
 */
import { type MediaFile, MediaFiles, MediaManifest } from '@/core/status/mediaManifest';
import type { CameraMediaItem } from '../session';

/** `DJI_20260814125250_0034_D.MP4` or `…_20260916_123456_…` → epoch ms (local time), else 0. */
export function filenameTimestamp(fileName: string): number {
  const packed = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(fileName);
  const split = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/.exec(fileName);
  const m = packed ?? split;
  if (!m) return 0;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return 0;
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

export const mediaItemId = (f: MediaFile) => MediaFiles.pageKey(f);

export function mediaItemOf(f: MediaFile): CameraMediaItem | null {
  const fileName = MediaFiles.filename(f);
  const ext = MediaFiles.extension(f);
  const video = MediaManifest.videoExtensions.has(ext);
  if (!video && !MediaManifest.photoExtensions.has(ext)) return null;
  // Proxies (LRF/XRF) ride with their original; do not list them as separate clips.
  if (ext === 'LRF' || ext === 'XRF' || ext === 'LRV') return null;
  const size = f.resolution ? /^(\d+)x(\d+)$/.exec(f.resolution) : null;
  return {
    id: mediaItemId(f),
    kind: video ? 'video' : 'photo',
    fileName,
    createdAt: filenameTimestamp(fileName),
    durationSec: video ? f.durationSeconds : undefined,
    sizeBytes: f.sizeBytes,
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
    fps: f.fps ?? undefined,
    favorite: f.isStarred,
  };
}

export function mediaItemsOf(files: MediaFile[]): CameraMediaItem[] {
  return files
    .map(mediaItemOf)
    .filter((m): m is CameraMediaItem => m != null)
    .sort((a, b) => b.createdAt - a.createdAt || b.fileName.localeCompare(a.fileName));
}

/** Handle to use for delete / star: the per-file handle, else the command handle. */
export const mediaHandle = (f: MediaFile) => (f.handle !== 0 ? f.handle : f.cmdHandle);
