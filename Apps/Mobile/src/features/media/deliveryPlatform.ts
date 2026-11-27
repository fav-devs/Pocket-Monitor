/**
 * Native delivery endpoints: the system share sheet (expo-sharing), the photo library
 * (expo-media-library) and the local original cache (expo-file-system).
 * Web twin: `deliveryPlatform.web.ts`.
 */
import { File, Paths } from 'expo-file-system';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import type { CameraMediaItem } from '@/camera';

export interface DeliverableFile {
  uri: string;
  fileName: string;
  mimeType: string;
}

export class PhotosPermissionError extends Error {
  constructor() {
    super('Photos access is off. Allow adding to Photos in Settings, then try again.');
    this.name = 'PhotosPermissionError';
  }
}

export const deliveryPlatform = {
  /** What the "save" destination is called here. */
  photosTitle: 'Save to Photos',

  /**
   * A file URI to hand to the system. A real camera always returns a downloaded file; the demo
   * camera has no footage, so it gets a small placeholder file instead.
   */
  async materialize(item: CameraMediaItem, localUri: string): Promise<string> {
    if (localUri) return localUri;
    const remote = item.originalUrl ?? item.previewUrl;
    if (remote && /^https?:/.test(remote)) {
      const file = await File.downloadFileAsync(remote, new File(Paths.cache, item.fileName), { idempotent: true });
      return file.uri;
    }
    const placeholder = new File(Paths.cache, `${item.fileName}.txt`);
    if (!placeholder.exists) placeholder.create({ overwrite: true });
    placeholder.write(`Pocket Monitor demo placeholder for ${item.fileName}. Connect a camera to deliver real originals.\n`);
    return placeholder.uri;
  },

  async share(files: DeliverableFile[]): Promise<void> {
    if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
    // expo-sharing presents one file per sheet; present them in order.
    for (const f of files) {
      await Sharing.shareAsync(f.uri, { mimeType: f.mimeType, dialogTitle: f.fileName });
    }
  },

  /** Saves to the photo library, asking for add-only access first. */
  async saveToPhotos(files: DeliverableFile[], onAwaitingAccess?: () => void): Promise<number> {
    onAwaitingAccess?.();
    const permission = await requestPermissionsAsync(true);
    if (!permission.granted) throw new PhotosPermissionError();
    let saved = 0;
    for (const f of files) {
      if (!/^(image|video)\//.test(f.mimeType) || f.uri.endsWith('.txt')) continue;
      await Asset.create(f.uri);
      saved += 1;
    }
    if (saved === 0) throw new Error('Nothing to save: Photos takes pictures and movies only.');
    return saved;
  },

  /** Removes a cached original (when "Keep originals" is off). */
  async discard(uri: string): Promise<void> {
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // A cache file that is already gone is fine.
    }
  },
};
