/**
 * The camera's media HTTP server: `/v2?storage=<0|1>&path=<path>` on port 80 at the camera's
 * address (the SoftAP `192.168.2.1`, or the address a station-mode camera was found at).
 *
 * Source of truth: OpenCine `OpenCineCameraVocabulary/MediaManifest.swift` (`MediaHTTP`) and
 * `OpenCineDJI/DJIMediaHTTPSource.swift` (store order, winners, retry rule). The desktop shell
 * transcribed the same rules in `Apps/Desktop/crates/opc-media/src/{model,http}.rs`; where the
 * two differ, upstream wins (`VID_*` → `.lrv` proxies, the 4xx/proxy retry rule).
 *
 * Pure: builds URLs and decides store order. Byte I/O lives in the session (expo-file-system).
 */
import { CameraSoftAP } from '../connection/cameraSoftAP';
import { type MediaFile, MEDIA_INTERNAL_BIT } from '../status/mediaManifest';

export const MEDIA_HTTP_PORT = 80;

/** Where one camera serves its media. Per session, never process-wide. */
export interface MediaRoute {
  host: string;
  /** `/v2?storage=&path=` query addressing, or each file at its own path. */
  addressing: 'storageQuery' | 'directPath';
}

export const softAPRoute: MediaRoute = { host: CameraSoftAP.host, addressing: 'storageQuery' };

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
};
const filenameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * `http://192.168.2.1/v2?storage=N&path=DCIM/…`. The separators inside `path=` stay as they are:
 * the camera answers `404` to a percent-encoded slash. Anything else outside the unreserved set is
 * percent-encoded (camera paths are `[A-Z0-9_./]`, so in practice nothing is).
 */
export function mediaPathURL(storage: number, path: string, route: MediaRoute = softAPRoute): string {
  if (route.addressing === 'directPath') return `http://${route.host}${path.startsWith('/') ? '' : '/'}${encodePath(path)}`;
  return `http://${route.host}/v2?storage=${storage}&path=${encodeQueryValue(path)}`;
}

const encodeKeepingSlashes = (value: string) => encodeURIComponent(value).replace(/%2F/gi, '/');
const encodeQueryValue = encodeKeepingSlashes;
const encodePath = encodeKeepingSlashes;

/** `/v2?storage=` from the delete handle's internal bit. Pocket 3 (single microSD) is always 0. */
export function storageGuess(handle: number, singleSdStorage: boolean): 0 | 1 {
  if (singleSdStorage) return 0;
  return ((handle >>> 0) & MEDIA_INTERNAL_BIT) !== 0 ? 1 : 0;
}

/**
 * The store to ask first for a listed clip. A single-card body is always 0, even when the
 * manifest stamped 1 from the handle bit or a previous GET remembered 1 (a 200 from the empty
 * internal mount must not stick).
 */
export function resolvedStorage(stamped: number, handle: number, winner: number | null | undefined, singleSdStorage: boolean): 0 | 1 {
  if (singleSdStorage) return 0;
  if (winner === 0 || winner === 1) return winner;
  if (stamped === 0 || stamped === 1) return stamped;
  return storageGuess(handle, false);
}

export const originalPath = (f: Pick<MediaFile, 'path'>) => f.path;
/** Clip delivery / export: the original camera file, never the LRF/XRF proxy. */
export const deliveryPath = originalPath;
export const thumbnailPath = (f: Pick<MediaFile, 'thumbPath'>) => f.thumbPath;

export function derivedProxyExtension(filename: string): string | null {
  if (filename.startsWith('VID_') && filename.toLowerCase().endsWith('.mp4')) return 'lrv';
  if (filename.startsWith('CAM_')) return 'XRF';
  if (filename.startsWith('DJI_')) return 'LRF';
  return null;
}

/** Reads the prefix, not the kind (exactly like upstream): a still never asks for a proxy. */
export function derivedProxyPath(f: Pick<MediaFile, 'path'>): string | null {
  const ext = derivedProxyExtension(filenameOf(f.path));
  if (!ext) return null;
  const slash = f.path.lastIndexOf('/');
  const dot = f.path.lastIndexOf('.');
  const base = dot > slash ? f.path.slice(0, dot) : f.path;
  return `${base}.${ext}`;
}

export function isProxyPath(path: string): boolean {
  const ext = extensionOf(path).toUpperCase();
  return ext === 'LRF' || ext === 'LRV' || ext === 'XRF';
}

/** Preview chain: listed proxy, derived `.LRF` (DJI) / `.XRF` (CAM_) / `.lrv` (VID_), then original. */
export function previewPaths(f: Pick<MediaFile, 'path' | 'proxyPath'>): string[] {
  const out: string[] = [];
  const add = (p: string | null) => {
    if (p && !out.includes(p)) out.push(p);
  };
  add(f.proxyPath);
  add(derivedProxyPath(f));
  add(f.path);
  return out;
}

/** LRF/XRF sidecars only. Empty for clips with no proxy. */
export const proxyPaths = (f: Pick<MediaFile, 'path' | 'proxyPath'>) => previewPaths(f).filter(isProxyPath);

/**
 * Ordered `(storage, path)` pairs to try when opening a clip: winner store first, then the other
 * mount; proxy first, original last.
 */
export function playbackCandidates(f: Pick<MediaFile, 'path' | 'proxyPath'>, firstStorage: number): { storage: 0 | 1; path: string }[] {
  const stores: (0 | 1)[] = firstStorage === 0 ? [0, 1] : [1, 0];
  const out: { storage: 0 | 1; path: string }[] = [];
  for (const path of previewPaths(f)) for (const storage of stores) if (!out.some((c) => c.storage === storage && c.path === path)) out.push({ storage, path });
  return out;
}

/** `/v2` carries no extension, so the type travels out of band. Sidecar proxies are MP4. */
export function playbackMimeType(path: string): string {
  switch (extensionOf(path).toUpperCase()) {
    case 'JPG':
    case 'JPEG':
      return 'image/jpeg';
    case 'DNG':
      return 'image/x-adobe-dng';
    case 'HEIC':
      return 'image/heic';
    default:
      return 'video/mp4';
  }
}

/** On-disk name for a camera path: separators flattened, a proxy renamed `.mp4` so players open it. */
export function playbackCacheFileName(path: string): string {
  const raw = path.replace(/\//g, '_');
  const ext = extensionOf(raw).toUpperCase();
  if (ext === 'MP4' || ext === 'MOV') return raw;
  const dot = raw.lastIndexOf('.');
  return `${dot > 0 ? raw.slice(0, dot) : raw}.mp4`;
}

/** `thumbs/<path with / → _>.jpg` and `files/<path with / → _>` (desktop `MediaCache`, iOS `CameraMedia`). */
export const thumbnailCacheFileName = (f: Pick<MediaFile, 'path'>) => `${f.path.replace(/\//g, '_')}.jpg`;
export const originalCacheFileName = (f: Pick<MediaFile, 'path'>) => f.path.replace(/\//g, '_');

/** A filesystem-safe folder name for one camera's cache (`model-XXXX`, a BLE id, …). */
export function cameraCacheFolder(cameraId: string): string {
  const safe = cameraId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'camera';
}

/**
 * A short write (error page, cut transfer) must not count as the original: 90 % of the listed
 * size or more (iOS `CameraSession.isDownloaded`). Unknown size: any non-empty file.
 */
export function isCompleteOriginal(bytesOnDisk: number, listedBytes: number): boolean {
  if (bytesOnDisk <= 0) return false;
  if (listedBytes <= 0) return true;
  return bytesOnDisk >= Math.floor((listedBytes * 9) / 10);
}

/** One `/v2` resource to try. */
export interface MediaHTTPResource {
  storage: 0 | 1;
  url: string;
}

/** Why a transfer attempt failed, as far as the retry rule cares. */
export type MediaTransferFailure = { kind: 'status'; status: number } | { kind: 'cancelled' } | { kind: 'retired' } | { kind: 'transport' };

/**
 * One camera's storage routing (`DJIMediaHTTPSource`): which store answered each path, the
 * resources to try for a path, and whether a failed attempt may fall through to the next one.
 */
export class MediaStorageMemo {
  private winners = new Map<string, 0 | 1>();
  constructor(public route: MediaRoute = softAPRoute) {}

  reset(): void {
    this.winners.clear();
  }
  winner(path: string): 0 | 1 | null {
    return this.winners.get(path) ?? null;
  }
  remember(storage: 0 | 1, path: string): void {
    this.winners.set(path, storage);
  }

  /** Keyed on the listed file's path (an accepted proxy also teaches its original's store). */
  resolvedStorage(f: Pick<MediaFile, 'path' | 'storage' | 'handle' | 'cmdHandle'>, singleSdStorage: boolean): 0 | 1 {
    return resolvedStorage(f.storage, f.handle !== 0 ? f.handle : f.cmdHandle, this.winners.get(f.path), singleSdStorage);
  }

  /** First store, then the other. A single-card body still offers both (the second answers 404). */
  resources(path: string, firstStorage: number): MediaHTTPResource[] {
    const stores: (0 | 1)[] = firstStorage === 0 ? [0, 1] : [1, 0];
    return stores.map((storage) => ({ storage, url: mediaPathURL(storage, path, this.route) }));
  }

  resourcesFor(f: Pick<MediaFile, 'path' | 'storage' | 'handle' | 'cmdHandle'>, path: string, singleSdStorage: boolean): MediaHTTPResource[] {
    return this.resources(path, this.resolvedStorage(f, singleSdStorage));
  }

  /** Bytes the transfer must reach: the listed size for the original only, never for a proxy. */
  static expectedBytes(f: Pick<MediaFile, 'path' | 'sizeBytes'>, path: string): number | null {
    return path === f.path && f.sizeBytes > 0 ? f.sizeBytes : null;
  }

  /**
   * After an attempt failed: try the next store? Never after a cancel or a retired session; a 4xx
   * (the file is not on that mount) always; a server error or a transport error only for a proxy
   * (upstream Swift keeps the proxy fallback; the original is not fetched twice).
   */
  static shouldRetry(failure: MediaTransferFailure, path: string): boolean {
    if (failure.kind === 'cancelled' || failure.kind === 'retired') return false;
    if (failure.kind === 'status') return (failure.status >= 400 && failure.status <= 499) || isProxyPath(path);
    return isProxyPath(path);
  }
}

/** `UnableToDownload … 404` → 404. Null when the message names no HTTP status. */
export function httpStatusOf(message: string): number | null {
  const m = /\b([1-5]\d\d)\b/.exec(message);
  return m ? Number(m[1]) : null;
}
