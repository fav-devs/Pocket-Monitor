/**
 * Shoots, take numbers and what a matched take gives its clip. Pure.
 */
import { type ClipIdentity, type ClipMeta, type Shoot, emptyMeta, newId, sortMarkers } from './model';
import type { PendingTake } from './takes';

/** "Vlog / Tokyo//Day 2/" → "Vlog/Tokyo/Day 2": folders split by / or \, trimmed, no empties. */
export function cleanFolderPath(path: string): string {
  return path
    .split(/[\\/]+/)
    .map((p) => p.trim().replace(/\s+/g, ' ').replace(/[<>:"|?*\u0000-\u001f]/g, ''))
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/')
    .slice(0, 200);
}

export function cleanShootName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 60);
}

/** "Shoot 3": the next free default name. */
export function nextShootName(shoots: Shoot[], base = 'Shoot'): string {
  const names = new Set(shoots.map((s) => s.name.toLowerCase()));
  for (let n = shoots.length + 1; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

export function createShoot(shoots: Shoot[], name: string, folderPath: string, now = Date.now()): Shoot {
  return { id: newId('s', now), name: cleanShootName(name) || nextShootName(shoots), folderPath: cleanFolderPath(folderPath), createdAt: now };
}

/** The folder a shoot's clips go in: its path, else its name. */
export function shootFolder(shoot: Pick<Shoot, 'name' | 'folderPath'>): string {
  return cleanFolderPath(shoot.folderPath) || cleanFolderPath(shoot.name);
}

/** Shoots newest first, the active one leading. */
export function orderedShoots(shoots: Shoot[], activeId: string | null): Shoot[] {
  return [...shoots].sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : b.createdAt - a.createdAt));
}

/** The day key take numbers restart on without a shoot. */
export const takeDay = (ms: number) => {
  const d = new Date(ms);
  return `day:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** The counter a take number comes from: its shoot, else its day. */
export const takeCounterKey = (shootId: string | null, startedAt: number) => shootId ?? takeDay(startedAt);

/** What a matched take gives the clip: its markers (merged), its shoot, its take and identity. */
export function metaForMatch(existing: ClipMeta | undefined, take: PendingTake, identity: ClipIdentity, now = Date.now()): ClipMeta {
  const base = existing ?? emptyMeta(identity, now);
  const ids = new Set(base.markers.map((m) => m.id));
  const markers = sortMarkers([...base.markers, ...take.markers.filter((m) => !ids.has(m.id))]);
  return {
    ...base,
    identity: {
      ...identity,
      fps: identity.fps ?? take.fps,
      width: identity.width ?? take.width,
      height: identity.height ?? take.height,
      colorMode: identity.colorMode ?? take.colorMode,
      codec: identity.codec ?? take.codec,
      cameraModel: identity.cameraModel ?? take.cameraModel,
      cameraName: identity.cameraName ?? take.cameraName,
      cameraSerial: identity.cameraSerial ?? take.cameraSerial,
    },
    markers,
    shootId: base.shootId ?? take.shootId,
    take: base.take ?? { id: take.id, number: take.number, startedAt: take.startedAt, timeSource: take.timeSource },
    updatedAt: now,
  };
}
