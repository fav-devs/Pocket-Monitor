/**
 * `MediaFileStore` on expo-file-system: camera media under `<cache>/media/…` (thumbnails,
 * playback proxies) and `<documents>/media/…` (downloaded originals, which the Phone tab lists).
 *
 * Networking: the GET goes through the platform HTTP stack (URLSession / OkHttp). On Android the
 * Wi-Fi module binds the whole process to the camera network once it joins (`PocketWifiJoiner`
 * → `bindProcessToNetwork`), so `http://192.168.2.1` is reached over the camera Wi-Fi even with
 * mobile data on. Cleartext HTTP needs `usesCleartextTraffic` (Android) and
 * `NSAllowsLocalNetworking` (iOS), both set in app.json.
 */
import { Directory, File, Paths } from 'expo-file-system';
import type { MediaFileArea, MediaFileStore } from './deps';

function root(area: MediaFileArea): Directory {
  return new Directory(area === 'cache' ? Paths.cache : Paths.document, 'media');
}

function fileAt(area: MediaFileArea, path: string): File {
  return new File(root(area), ...path.split('/').filter(Boolean));
}

function ensureParent(file: File): void {
  const parent = file.parentDirectory;
  if (!parent.exists) parent.create({ intermediates: true, idempotent: true });
}

export const expoMediaFileStore: MediaFileStore = {
  existing(area, path) {
    try {
      const f = fileAt(area, path);
      if (!f.exists) return null;
      const size = f.size ?? 0;
      return size > 0 ? { uri: f.uri, size } : null;
    } catch {
      return null;
    }
  },

  async download(url, area, path, options) {
    const dest = fileAt(area, path);
    ensureParent(dest);
    const part = new File(dest.parentDirectory, `${dest.name}.part`);
    try {
      if (part.exists) part.delete();
    } catch {
      // A stale part file that cannot be removed is overwritten below.
    }
    const written = await File.downloadFileAsync(url, part, {
      idempotent: true,
      signal: options?.signal,
      onProgress: options?.onProgress ? ({ bytesWritten, totalBytes }) => options.onProgress?.(bytesWritten, totalBytes > 0 ? totalBytes : 0) : undefined,
    });
    if (dest.exists) dest.delete();
    written.move(dest);
    return { uri: dest.uri, size: dest.size ?? written.size ?? 0 };
  },

  remove(area, path) {
    try {
      const f = fileAt(area, path);
      if (f.exists) f.delete();
    } catch {
      // Already gone.
    }
  },
};
