/**
 * The camera's media library inside the desktop app (`docs/desktop-expo-port.md` §1.U).
 *
 * The Rust backend (`pm-desktop/src/media.rs`) lists the card over the camera datalink (the
 * core decodes every page), keeps the list and the stars cached per camera, fetches over the
 * camera's `/v2` HTTP from its real address (station or SoftAP), and only ever sends a delete
 * for a handle the core vouched for. This file is the `CameraMediaService` over that:
 *
 * - `list()` answers at once with the cached list when there is one (the library opens
 *   instantly), and a fresh listing runs behind it; `media://list` brings every page, which
 *   `subscribeList` hands to the screen. With nothing cached it waits for the first page.
 * - thumbnails are `pm://thumb/<path>` image URLs, answered by Rust from its cache or the
 *   camera; they never cross JSON.
 * - `download()` resolves when `media://ready` says the original is on disk.
 * - playback and stills open in the native player (`player.ts`), never a web `<video>`.
 */
import type { CameraMediaItem, CameraMediaService, MediaTransferProgress } from '../session';
import { invoke, listen, type Unlisten } from './tauri';

/** A desktop record: the phones' item plus what Rust knows about this machine's copies. */
export interface DesktopMediaItem extends CameraMediaItem {
  /** The core vouched for its handle; DELETE can go out. */
  deletable?: boolean;
  /** The original is in this computer's cache. */
  cached?: boolean;
  /** The 720p proxy is in this computer's cache. */
  proxyCached?: boolean;
}

/** `media://list`, and the answer to `media_list`. */
export interface DesktopMediaList {
  items: DesktopMediaItem[];
  listing: boolean;
  status: string;
}

interface Progress {
  id: string;
  done: number;
  total: number | null;
}

interface Ready {
  id: string;
  local: string;
  proxy: boolean;
}

interface Failed {
  id: string;
  reason: string;
}

/** The answer to `media_delete`. */
interface DeleteResult {
  deleted: string[];
  refused: string[];
}

/** How long a listing with nothing cached may take before `list()` gives up waiting. */
const FIRST_PAGE_TIMEOUT_MS = 30_000;

function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent ?? '');
}

/**
 * A `pm://` URL for the web view. WebView2 serves custom schemes as `http://<scheme>.localhost`;
 * WKWebView and WebKitGTK as `<scheme>://localhost`.
 */
export function pmUrl(kind: 'thumb' | 'file' | 'strip', path: string, windows = isWindows()): string {
  const base = windows ? 'http://pm.localhost/' : 'pm://localhost/';
  const tail = kind === 'strip' ? path : encodeURIComponent(path);
  return `${base}${kind}/${tail}`;
}

/** The Rust record with its thumbnail URL filled in. */
export function withUrls(item: DesktopMediaItem, windows = isWindows()): DesktopMediaItem {
  return { ...item, thumbnailUrl: pmUrl('thumb', item.id, windows) };
}

function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export class DesktopMediaService implements CameraMediaService {
  private lastList: DesktopMediaList | null = null;
  private listListeners = new Set<(list: DesktopMediaList) => void>();
  private stop: Unlisten[] = [];

  constructor() {
    this.stop.push(
      listen<DesktopMediaList>('media://list', (list) => {
        const next = { ...list, items: list.items.map((item) => withUrls(item)) };
        this.lastList = next;
        this.listListeners.forEach((l) => l(next));
      }),
    );
  }

  dispose() {
    this.stop.forEach((s) => s());
    this.stop = [];
    this.listListeners.clear();
  }

  /** Every page of a listing as it arrives, and after a star or a delete. */
  subscribeList(listener: (list: DesktopMediaList) => void): () => void {
    this.listListeners.add(listener);
    return () => this.listListeners.delete(listener);
  }

  /** The last list Rust sent, if any. */
  current(): DesktopMediaList | null {
    return this.lastList;
  }

  async list(): Promise<CameraMediaItem[]> {
    const first = await invoke<DesktopMediaList>('media_list', { refresh: false });
    const cached = first.items.map((item) => withUrls(item));
    this.lastList = { ...first, items: cached };
    if (cached.length || !first.listing) {
      if (!cached.length && first.status) throw new Error(first.status);
      return cached;
    }
    // Nothing cached: wait for the first page (or the end of the listing).
    return new Promise<CameraMediaItem[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        resolve(this.lastList?.items ?? []);
      }, FIRST_PAGE_TIMEOUT_MS);
      const off = this.subscribeList((list) => {
        if (!list.items.length && list.listing) return;
        clearTimeout(timer);
        off();
        if (!list.items.length && list.status) reject(new Error(list.status));
        else resolve(list.items);
      });
    });
  }

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    await invoke('media_favorite', { id, favorite });
  }

  async delete(ids: string[]): Promise<void> {
    const result = await invoke<DeleteResult>('media_delete', { ids });
    if (result.refused.length) {
      const kept = result.refused.length;
      throw new Error(
        kept === ids.length
          ? "The camera can't delete that safely. Refresh, then try again."
          : `${kept} of ${ids.length} can't be deleted safely. Refresh, then try again.`,
      );
    }
  }

  download(id: string, onProgress?: (p: MediaTransferProgress) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const stops: Unlisten[] = [];
      const done = () => stops.forEach((s) => s());
      stops.push(
        listen<Progress>('media://progress', (p) => {
          if (p.id !== id) return;
          onProgress?.({ itemId: id, bytesDone: p.done, bytesTotal: p.total ?? 0, rate: 0 });
        }),
      );
      stops.push(
        listen<Ready>('media://ready', (r) => {
          if (r.id !== id || r.proxy) return;
          done();
          resolve(pmUrl('file', id));
        }),
      );
      stops.push(
        listen<Failed>('media://failed', (f) => {
          if (f.id !== id) return;
          done();
          reject(new Error(f.reason || 'The download did not finish.'));
        }),
      );
      invoke('media_download', { id }).catch((error) => {
        done();
        reject(new Error(errorText(error, 'The download did not start.')));
      });
    });
  }

  async resumeLive(): Promise<void> {
    await invoke('media_resume_live');
  }

  /** The Storage section: bytes in this camera's media cache. */
  cacheSize(): Promise<number> {
    return invoke<number>('media_cache_size');
  }

  clearCache(): Promise<void> {
    return invoke('media_cache_clear');
  }
}

/** True for the desktop media service (the screens use its extras when present). */
export function isDesktopMedia(service: CameraMediaService): service is DesktopMediaService {
  return service instanceof DesktopMediaService;
}
