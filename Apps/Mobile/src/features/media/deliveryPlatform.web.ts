/**
 * Web delivery: there is no share sheet or photo library, so every destination becomes a
 * browser download (an `<a download>` link). Native twin: `deliveryPlatform.ts`.
 */
import type { CameraMediaItem } from '@/camera';

export interface DeliverableFile {
  uri: string;
  fileName: string;
  mimeType: string;
}

export class PhotosPermissionError extends Error {
  constructor() {
    super('Photos access is off.');
    this.name = 'PhotosPermissionError';
  }
}

function triggerDownload(f: DeliverableFile) {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = f.uri;
  a.download = f.fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const deliveryPlatform = {
  photosTitle: 'Download',

  /** The demo camera has no footage: its thumbnail stands in for the file. */
  async materialize(item: CameraMediaItem, localUri: string): Promise<string> {
    return localUri || item.originalUrl || item.previewUrl || item.thumbnailUrl || 'data:text/plain,demo';
  },

  async share(files: DeliverableFile[]): Promise<void> {
    files.forEach(triggerDownload);
  },

  async saveToPhotos(files: DeliverableFile[]): Promise<number> {
    files.forEach(triggerDownload);
    return files.length;
  },

  async discard(_uri: string): Promise<void> {},
};
