/**
 * The sidecar for a library item from the stores: its metadata, rating (`useMediaPreferences`),
 * favourite (the camera's star, or the phone record's) and shoot.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { CameraMediaItem } from '@/camera';
import { isTauri } from '@/camera/desktop/tauri';
import { type ClipMeta, type SidecarV1, buildSidecar, emptyMeta, isEmptyMeta, shiftMarkersForTrim, sidecarFileName, sidecarJson } from '@/core/markers';
import { identityOf, metaOf, useClipMeta } from '@/state/clipMeta';
import { useMediaPreferences, usePhoneMedia } from '@/state/media';

export function appInfo() {
  return { version: Constants.expoConfig?.version ?? '0.0.0', platform: isTauri() ? 'desktop' : Platform.OS };
}

/** True when the item has anything a sidecar would carry beyond its identity. */
export function hasMetadata(item: CameraMediaItem): boolean {
  const meta = metaOf(useClipMeta.getState().clips, item);
  const rating = useMediaPreferences.getState().ratings[item.id] ?? 0;
  return !isEmptyMeta(meta) || rating > 0 || item.favorite;
}

/** The clip's metadata, or an empty entry with its identity. */
export function metaForItem(item: CameraMediaItem): ClipMeta {
  return metaOf(useClipMeta.getState().clips, item) ?? emptyMeta(identityOf(item));
}

export function sidecarForItem(item: CameraMediaItem, now = Date.now()): SidecarV1 {
  const store = useClipMeta.getState();
  const stored = metaOf(store.clips, item);
  // The listing's identity is current; the camera and codec the take saw stay.
  const fresh = identityOf(item);
  const meta: ClipMeta = stored ? { ...stored, identity: { ...stored.identity, ...fresh } } : emptyMeta(fresh);
  const phone = usePhoneMedia.getState().clips.find((c) => c.id === item.id);
  if (!meta.identity.cameraName && phone?.cameraName) meta.identity.cameraName = phone.cameraName;
  return buildSidecar({
    meta,
    rating: useMediaPreferences.getState().ratings[item.id] ?? 0,
    favorite: phone ? phone.favorite : item.favorite,
    shoot: store.shoots.find((s) => s.id === meta.shootId) ?? null,
    app: appInfo(),
    now,
  });
}

/** The sidecar text and file name for an item. */
export function sidecarFileFor(item: CameraMediaItem): { fileName: string; json: string } {
  return { fileName: sidecarFileName(item.fileName), json: sidecarJson(sidecarForItem(item)) };
}

/**
 * The sidecar for a clip exported from the editor: markers moved by the trim (those outside it
 * dropped), the new file's name and length, and what it was cut from.
 */
export function exportSidecarFor(item: CameraMediaItem, trim: { start: number; end: number } | null, exportedName: string): { fileName: string; json: string } {
  const base = sidecarForItem(item);
  const meta = metaForItem(item);
  const markers = shiftMarkersForTrim(meta.markers, trim);
  const duration = trim ? trim.end - trim.start : item.durationSec;
  const sidecar = buildSidecar({
    meta: { ...meta, markers, identity: { ...meta.identity, ...identityOf(item), fileName: exportedName, durationSec: duration, sizeBytes: undefined } },
    rating: base.rating,
    favorite: base.favorite,
    shoot: useClipMeta.getState().shoots.find((s) => s.id === meta.shootId) ?? null,
    app: appInfo(),
    derivedFrom: { fileName: item.fileName, trimStart: trim?.start ?? 0, trimEnd: trim?.end ?? item.durationSec ?? 0 },
  });
  return { fileName: sidecarFileName(exportedName), json: sidecarJson(sidecar) };
}
