import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CameraIdentity, CameraMediaItem } from '@/camera';
import {
  type ClipIdentity,
  type ClipMarker,
  type ClipMeta,
  type PendingTake,
  type Shoot,
  type TakeMatch,
  cleanFolderPath,
  cleanShootName,
  cleanTag,
  createShoot,
  emptyMeta,
  identityKey,
  isEmptyMeta,
  metaForMatch,
  sortMarkers,
  tagKey,
  takeCounterKey,
  toggleTag,
} from '@/core/markers';
import { persistStorage } from './storage';

/**
 * Clip metadata (markers, tags, notes, shoot, take) keyed by the media item id, which is the same
 * for a clip on the camera and its copy on this phone, so the metadata follows the clip. Each
 * entry also carries the camera file's identity (name, size, time, format), so a clip listed
 * under another id (the desktop app, a re-paired camera) is still found: {@link metaOf}.
 *
 * Also the takes this app saw recorded and is waiting to match with their files
 * (`core/markers/takes.ts`), the shoots, and the operator's own tags. Persisted (AsyncStorage:
 * the app's storage on iOS/Android, localStorage on web and in the desktop app's web view).
 * Additive changes only. Nothing here is logged or sent anywhere; it leaves the device only in
 * a sidecar or export the operator makes.
 */

/** Where a marker lives: a take still recording / waiting for its file, or a clip. */
export type MarkerRef = { kind: 'take'; takeId: string } | { kind: 'clip'; itemId: string };

const MAX_CLIPS = 5000;
const MAX_TAKES = 100;
const MAX_USER_TAGS = 24;

export function identityOf(item: CameraMediaItem, camera?: Pick<CameraIdentity, 'model' | 'name' | 'serial'> | null, codec?: string): ClipIdentity {
  const out: ClipIdentity = { fileName: item.fileName, createdAt: item.createdAt, sizeBytes: item.sizeBytes };
  if (item.durationSec != null) out.durationSec = item.durationSec;
  if (item.fps) out.fps = item.fps;
  if (item.width) out.width = item.width;
  if (item.height) out.height = item.height;
  if (item.colorMode) out.colorMode = item.colorMode;
  if (codec) out.codec = codec;
  if (camera?.model && camera.model !== 'unknown') out.cameraModel = camera.model;
  if (camera?.name) out.cameraName = camera.name;
  if (camera?.serial) out.cameraSerial = camera.serial;
  return out;
}

interface ClipMetaData {
  clips: Record<string, ClipMeta>;
  takes: PendingTake[];
  shoots: Shoot[];
  activeShootId: string | null;
  userTags: string[];
  takeCounters: Record<string, number>;
}

interface ClipMetaStore extends ClipMetaData {
  // Markers
  addMarker: (ref: MarkerRef, marker: ClipMarker, item?: CameraMediaItem) => void;
  updateMarker: (ref: MarkerRef, id: string, patch: Partial<Omit<ClipMarker, 'id'>>) => void;
  removeMarker: (ref: MarkerRef, id: string) => void;
  // Per clip
  setTags: (item: CameraMediaItem, tags: string[]) => void;
  toggleClipTag: (item: CameraMediaItem, tag: string) => void;
  setNotes: (item: CameraMediaItem, notes: string) => void;
  /** Moves clips into a shoot (null: out of any). */
  setShoot: (items: CameraMediaItem[], shootId: string | null) => void;
  /** Adds what a sidecar says to a clip (markers merged by id; tags merged; notes kept when set). */
  mergeImported: (item: CameraMediaItem, meta: ClipMeta) => void;
  // Takes
  beginTake: (take: Omit<PendingTake, 'number'>) => PendingTake;
  finishTake: (takeId: string, stoppedAt: number, durationSec: number | undefined) => void;
  applyMatches: (matches: TakeMatch[], items: Map<string, ClipIdentity>) => void;
  dropTake: (takeId: string) => void;
  // Shoots
  /** A new shoot; active unless `activate` is false. */
  startShoot: (name: string, folderPath: string, activate?: boolean) => Shoot;
  editShoot: (id: string, change: { name?: string; folderPath?: string }) => void;
  setActiveShoot: (id: string | null) => void;
  endShoot: (id: string) => void;
  // Tags
  addUserTag: (tag: string) => void;
  removeUserTag: (tag: string) => void;
}

const initial: ClipMetaData = { clips: {}, takes: [], shoots: [], activeShootId: null, userTags: [], takeCounters: {} };

/** The clip's entry, by id, else by its file identity. */
export function metaOf(clips: Record<string, ClipMeta>, item: Pick<CameraMediaItem, 'id' | 'fileName' | 'sizeBytes'>): ClipMeta | undefined {
  const direct = clips[item.id];
  if (direct) return direct;
  const key = identityKey(item);
  for (const m of Object.values(clips)) if (identityKey(m.identity) === key) return m;
  return undefined;
}

/** The id an item's entry is stored under (its own, or the one its identity matched). */
export function metaKeyOf(clips: Record<string, ClipMeta>, item: CameraMediaItem): string {
  return keyFor(clips, item);
}

function keyFor(clips: Record<string, ClipMeta>, item: CameraMediaItem): string {
  if (clips[item.id]) return item.id;
  const key = identityKey(item);
  for (const [id, m] of Object.entries(clips)) if (identityKey(m.identity) === key) return id;
  return item.id;
}

function prune(clips: Record<string, ClipMeta>): Record<string, ClipMeta> {
  const keys = Object.keys(clips);
  if (keys.length <= MAX_CLIPS) return clips;
  keys.sort((a, b) => clips[a].updatedAt - clips[b].updatedAt);
  const out = { ...clips };
  for (const k of keys.slice(0, keys.length - MAX_CLIPS)) delete out[k];
  return out;
}

function putClip(clips: Record<string, ClipMeta>, id: string, meta: ClipMeta): Record<string, ClipMeta> {
  const next = { ...clips };
  if (isEmptyMeta(meta)) delete next[id];
  else next[id] = meta;
  return prune(next);
}

export const useClipMeta = create<ClipMetaStore>()(
  persist(
    (set, get) => {
      const editClip = (item: CameraMediaItem, change: (m: ClipMeta) => ClipMeta) =>
        set((s) => {
          const id = keyFor(s.clips, item);
          const before = s.clips[id] ?? emptyMeta(identityOf(item));
          return { clips: putClip(s.clips, id, { ...change(before), updatedAt: Date.now() }) };
        });

      const editMarkers = (ref: MarkerRef, change: (markers: ClipMarker[]) => ClipMarker[], item?: CameraMediaItem) =>
        set((s) => {
          if (ref.kind === 'take') return { takes: s.takes.map((t) => (t.id === ref.takeId ? { ...t, markers: sortMarkers(change(t.markers)) } : t)) };
          const before = s.clips[ref.itemId] ?? (item ? emptyMeta(identityOf(item)) : undefined);
          if (!before) return s;
          return { clips: putClip(s.clips, ref.itemId, { ...before, markers: sortMarkers(change(before.markers)), updatedAt: Date.now() }) };
        });

      return {
        ...initial,

        addMarker: (ref, marker, item) => editMarkers(ref, (ms) => [...ms, marker], item),
        updateMarker: (ref, id, patch) => editMarkers(ref, (ms) => ms.map((m) => (m.id === id ? { ...m, ...patch, label: (patch.label ?? m.label).slice(0, 200) } : m))),
        removeMarker: (ref, id) => editMarkers(ref, (ms) => ms.filter((m) => m.id !== id)),

        setTags: (item, tags) => editClip(item, (m) => ({ ...m, tags: tags.map(cleanTag).filter(Boolean) })),
        toggleClipTag: (item, tag) => editClip(item, (m) => ({ ...m, tags: toggleTag(m.tags, tag) })),
        setNotes: (item, notes) => editClip(item, (m) => ({ ...m, notes: notes.slice(0, 4000) })),
        setShoot: (items, shootId) =>
          set((s) => {
            let clips = s.clips;
            for (const item of items) {
              const id = keyFor(clips, item);
              const before = clips[id] ?? emptyMeta(identityOf(item));
              clips = putClip(clips, id, { ...before, shootId, updatedAt: Date.now() });
            }
            return { clips };
          }),
        mergeImported: (item, meta) =>
          editClip(item, (m) => {
            const ids = new Set(m.markers.map((x) => x.id));
            let tags = m.tags;
            for (const t of meta.tags) if (!tags.some((x) => tagKey(x) === tagKey(t))) tags = [...tags, t];
            return {
              ...m,
              markers: sortMarkers([...m.markers, ...meta.markers.filter((x) => !ids.has(x.id))]),
              tags,
              notes: m.notes.trim() ? m.notes : meta.notes,
              take: m.take ?? meta.take,
              shootId: m.shootId ?? meta.shootId,
              extra: meta.extra ? { ...meta.extra, ...(m.extra ?? {}) } : m.extra,
              clipExtra: meta.clipExtra ? { ...meta.clipExtra, ...(m.clipExtra ?? {}) } : m.clipExtra,
            };
          }),

        beginTake: (draft) => {
          const key = takeCounterKey(draft.shootId, draft.startedAt);
          const number = (get().takeCounters[key] ?? 0) + 1;
          const take: PendingTake = { ...draft, number };
          set((s) => ({ takes: [...s.takes.filter((t) => t.id !== take.id), take].slice(-MAX_TAKES), takeCounters: { ...s.takeCounters, [key]: number } }));
          return take;
        },
        finishTake: (takeId, stoppedAt, durationSec) =>
          set((s) => ({ takes: s.takes.map((t) => (t.id === takeId && t.stoppedAt == null ? { ...t, stoppedAt, durationSec } : t)) })),
        applyMatches: (matches, items) =>
          set((s) => {
            if (!matches.length) return s;
            let clips = s.clips;
            const done = new Set<string>();
            for (const m of matches) {
              const take = s.takes.find((t) => t.id === m.takeId);
              const identity = items.get(m.itemId);
              if (!take || !identity) continue;
              clips = putClip(clips, m.itemId, metaForMatch(clips[m.itemId], take, identity));
              done.add(take.id);
            }
            return { clips, takes: s.takes.filter((t) => !done.has(t.id)) };
          }),
        dropTake: (takeId) => set((s) => ({ takes: s.takes.filter((t) => t.id !== takeId) })),

        startShoot: (name, folderPath, activate = true) => {
          const shoot = createShoot(get().shoots, name, folderPath);
          set((s) => ({ shoots: [...s.shoots, shoot].slice(-200), activeShootId: activate ? shoot.id : s.activeShootId }));
          return shoot;
        },
        editShoot: (id, change) =>
          set((s) => ({
            shoots: s.shoots.map((x) =>
              x.id === id
                ? {
                    ...x,
                    name: change.name != null ? cleanShootName(change.name) || x.name : x.name,
                    folderPath: change.folderPath != null ? cleanFolderPath(change.folderPath) : x.folderPath,
                  }
                : x,
            ),
          })),
        setActiveShoot: (id) =>
          set((s) => ({
            activeShootId: id && s.shoots.some((x) => x.id === id) ? id : null,
            shoots: id ? s.shoots.map((x) => (x.id === id ? { ...x, endedAt: undefined } : x)) : s.shoots,
          })),
        endShoot: (id) =>
          set((s) => ({
            shoots: s.shoots.map((x) => (x.id === id ? { ...x, endedAt: Date.now() } : x)),
            activeShootId: s.activeShootId === id ? null : s.activeShootId,
          })),

        addUserTag: (tag) =>
          set((s) => {
            const t = cleanTag(tag);
            if (!t || s.userTags.some((x) => tagKey(x) === tagKey(t))) return s;
            return { userTags: [...s.userTags, t].slice(-MAX_USER_TAGS) };
          }),
        removeUserTag: (tag) => set((s) => ({ userTags: s.userTags.filter((x) => tagKey(x) !== tagKey(tag)) })),
      };
    },
    {
      name: 'pm.clipMeta.v1',
      storage: persistStorage,
      version: 1,
      partialize: (s) => ({
        clips: s.clips,
        takes: s.takes,
        shoots: s.shoots,
        activeShootId: s.activeShootId,
        userTags: s.userTags,
        takeCounters: s.takeCounters,
      }),
      // Whatever an older or damaged copy holds is read as far as it goes; nothing throws.
      migrate: (persisted) => sanitize(persisted) as unknown as ClipMetaStore,
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
    },
  ),
);

/** A persisted copy as clean data (drops anything malformed). */
export function sanitize(persisted: unknown): ClipMetaData {
  const p = (persisted ?? {}) as Partial<ClipMetaData>;
  const clips: Record<string, ClipMeta> = {};
  if (p.clips && typeof p.clips === 'object') {
    for (const [id, m] of Object.entries(p.clips)) {
      if (!m || typeof m !== 'object' || !m.identity || typeof m.identity.fileName !== 'string') continue;
      clips[id] = {
        ...m,
        markers: Array.isArray(m.markers) ? m.markers.filter((x) => x && typeof x.time === 'number' && typeof x.id === 'string') : [],
        tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string') : [],
        notes: typeof m.notes === 'string' ? m.notes : '',
        shootId: typeof m.shootId === 'string' ? m.shootId : null,
        updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : 0,
      };
    }
  }
  const shoots = Array.isArray(p.shoots) ? p.shoots.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string').map((s) => ({ ...s, folderPath: s.folderPath ?? '' })) : [];
  return {
    clips,
    takes: Array.isArray(p.takes) ? p.takes.filter((t) => t && typeof t.id === 'string' && typeof t.startedAt === 'number').map((t) => ({ ...t, markers: Array.isArray(t.markers) ? t.markers : [], knownIds: Array.isArray(t.knownIds) ? t.knownIds : [] })) : [],
    shoots,
    activeShootId: typeof p.activeShootId === 'string' && shoots.some((s) => s.id === p.activeShootId) ? p.activeShootId : null,
    userTags: Array.isArray(p.userTags) ? p.userTags.filter((t) => typeof t === 'string') : [],
    takeCounters: p.takeCounters && typeof p.takeCounters === 'object' ? p.takeCounters : {},
  };
}

/** A clip's metadata (by id, else its file identity), or undefined. */
export function useClipMetaFor(item: Pick<CameraMediaItem, 'id' | 'fileName' | 'sizeBytes'> | undefined): ClipMeta | undefined {
  const clips = useClipMeta((s) => s.clips);
  return useMemo(() => (item ? metaOf(clips, item) : undefined), [clips, item?.id, item?.fileName, item?.sizeBytes]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The active shoot, or null. */
export function useActiveShoot(): Shoot | null {
  const id = useClipMeta((s) => s.activeShootId);
  const shoots = useClipMeta((s) => s.shoots);
  return useMemo(() => shoots.find((x) => x.id === id) ?? null, [id, shoots]);
}

/** The take being recorded now (started, not stopped), if any. */
export function currentTake(takes: PendingTake[]): PendingTake | undefined {
  for (let i = takes.length - 1; i >= 0; i--) if (takes[i].stoppedAt == null) return takes[i];
  return undefined;
}
