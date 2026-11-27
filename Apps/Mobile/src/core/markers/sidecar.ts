/**
 * The clip metadata sidecar, format v1 (`docs/clip-metadata.md`, schema
 * `docs/clip-metadata.schema.json`): one JSON file per clip, `<clip basename>.pocketmeta.json`,
 * next to the clip. AI Cut (Sondr) and other tools read it; Pocket Monitor reads it back.
 *
 * Forward compatible: a reader keeps every field it does not know (top level, `clip`, `shoot`,
 * `take` and each marker) and a writer puts them back, so a newer app's additions survive a
 * round trip through an older one. Times are seconds from the clip's first frame plus the frame
 * at the clip's rate; wall-clock times are ISO 8601 UTC.
 *
 * Pure.
 */
import { type ClipIdentity, type ClipMarker, type ClipMeta, type MarkerColor, type Shoot, cleanTag, colorForTag, frameAt, isMarkerColor, sortMarkers } from './model';

export const SIDECAR_FORMAT = 'pocket-monitor.clip-metadata';
export const SIDECAR_VERSION = 1;
export const SIDECAR_SUFFIX = '.pocketmeta.json';
/** Bigger than any real sidecar; a file over this is not one. */
export const SIDECAR_MAX_BYTES = 2_000_000;

export interface SidecarMarkerV1 {
  id: string;
  /** Seconds from the clip's first frame, to the millisecond. */
  time: number;
  /** The frame at `clip.fps` (nearest). */
  frame: number;
  label: string;
  tag: string | null;
  color: MarkerColor;
  /** ISO 8601. */
  createdAt: string;
  source?: string;
  [extra: string]: unknown;
}

export interface SidecarV1 {
  format: typeof SIDECAR_FORMAT;
  version: 1;
  app: { name: string; version: string; platform: string; [extra: string]: unknown };
  /** ISO 8601. */
  writtenAt: string;
  clip: {
    fileName: string;
    /** ISO 8601: the camera file's own time. */
    createdAt: string;
    durationSec: number | null;
    fps: number | null;
    width: number | null;
    height: number | null;
    colorMode: string | null;
    codec: string | null;
    sizeBytes: number | null;
    camera: { model: string | null; name: string | null; serial: string | null };
    /** Set on a clip exported from another (the editor's trim): what it was cut from. */
    derivedFrom?: { fileName: string; trimStart: number; trimEnd: number };
    [extra: string]: unknown;
  };
  markers: SidecarMarkerV1[];
  tags: string[];
  /** 0 unrated, 1–5 stars. */
  rating: number;
  favorite: boolean;
  notes: string;
  shoot: { id: string; name: string; folderPath: string; [extra: string]: unknown } | null;
  take: { id: string; number: number; startedAt: string; timeSource: 'camera' | 'phone'; [extra: string]: unknown } | null;
  [extra: string]: unknown;
}

export interface SidecarInput {
  meta: ClipMeta;
  rating: number;
  favorite: boolean;
  shoot: Shoot | null;
  app: { version: string; platform: string };
  now?: number;
  derivedFrom?: { fileName: string; trimStart: number; trimEnd: number };
}

const KNOWN_TOP = ['format', 'version', 'app', 'writtenAt', 'clip', 'markers', 'tags', 'rating', 'favorite', 'notes', 'shoot', 'take'];
const KNOWN_CLIP = ['fileName', 'createdAt', 'durationSec', 'fps', 'width', 'height', 'colorMode', 'codec', 'sizeBytes', 'camera', 'derivedFrom'];
const KNOWN_MARKER = ['id', 'time', 'frame', 'label', 'tag', 'color', 'createdAt', 'source'];

const iso = (ms: number) => new Date(Number.isFinite(ms) ? ms : 0).toISOString();
const ms3 = (s: number) => Math.round(s * 1000) / 1000;
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** `DJI_0001.MP4` → `DJI_0001.pocketmeta.json`. */
export function sidecarFileName(clipFileName: string): string {
  const base = clipFileName.replace(/[\\/]/g, '_');
  const dot = base.lastIndexOf('.');
  return `${dot > 0 ? base.slice(0, dot) : base}${SIDECAR_SUFFIX}`;
}

/** The sidecar path beside a clip path or file URI. */
export function sidecarPathBeside(clipPath: string): string {
  const slash = Math.max(clipPath.lastIndexOf('/'), clipPath.lastIndexOf('\\'));
  return clipPath.slice(0, slash + 1) + sidecarFileName(clipPath.slice(slash + 1));
}

function withoutKnown(obj: Record<string, unknown> | undefined, known: string[]): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(obj)) {
    if (known.includes(k)) continue;
    out[k] = v;
    any = true;
  }
  return any ? out : undefined;
}

function markerOut(m: ClipMarker, fps: number | undefined): SidecarMarkerV1 {
  return {
    ...(m.extra ?? {}),
    id: m.id,
    time: ms3(m.time),
    frame: frameAt(m.time, fps),
    label: m.label,
    tag: m.tag,
    color: m.color,
    createdAt: iso(m.createdAt),
    ...(m.source ? { source: m.source } : {}),
  };
}

/** The sidecar for a clip's metadata. Unknown fields the metadata carries go back in. */
export function buildSidecar(input: SidecarInput): SidecarV1 {
  const { meta, shoot } = input;
  const id: ClipIdentity = meta.identity;
  const extra = meta.extra ?? {};
  const shootExtra = (extra.__shoot as Record<string, unknown> | undefined) ?? {};
  const takeExtra = (extra.__take as Record<string, unknown> | undefined) ?? {};
  const appExtra = (extra.__app as Record<string, unknown> | undefined) ?? {};
  const top = Object.fromEntries(Object.entries(extra).filter(([k]) => !k.startsWith('__')));
  return {
    ...top,
    format: SIDECAR_FORMAT,
    version: SIDECAR_VERSION,
    app: { ...appExtra, name: 'Pocket Monitor', version: input.app.version, platform: input.app.platform },
    writtenAt: iso(input.now ?? Date.now()),
    clip: {
      ...(meta.clipExtra ?? {}),
      fileName: id.fileName,
      createdAt: iso(id.createdAt),
      durationSec: id.durationSec != null ? ms3(id.durationSec) : null,
      fps: orNull(id.fps),
      width: orNull(id.width),
      height: orNull(id.height),
      colorMode: orNull(id.colorMode),
      codec: orNull(id.codec),
      sizeBytes: orNull(id.sizeBytes),
      camera: { model: orNull(id.cameraModel), name: orNull(id.cameraName), serial: orNull(id.cameraSerial) },
      ...(input.derivedFrom ? { derivedFrom: { fileName: input.derivedFrom.fileName, trimStart: ms3(input.derivedFrom.trimStart), trimEnd: ms3(input.derivedFrom.trimEnd) } } : {}),
    },
    markers: sortMarkers(meta.markers).map((m) => markerOut(m, id.fps)),
    tags: [...meta.tags],
    rating: Math.max(0, Math.min(5, Math.round(input.rating || 0))),
    favorite: !!input.favorite,
    notes: meta.notes,
    shoot: shoot ? { ...shootExtra, id: shoot.id, name: shoot.name, folderPath: shoot.folderPath } : null,
    take: meta.take ? { ...takeExtra, id: meta.take.id, number: meta.take.number, startedAt: iso(meta.take.startedAt), timeSource: meta.take.timeSource } : null,
  };
}

export function sidecarJson(sidecar: SidecarV1): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

export class SidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarError';
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const time = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(t) ? t : 0;
};
const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);

/** What a sidecar says, as this app's metadata, plus the rating, favourite and shoot it names. */
export interface ParsedSidecar {
  meta: ClipMeta;
  rating: number;
  favorite: boolean;
  shoot: Pick<Shoot, 'id' | 'name' | 'folderPath'> | null;
  /** The version the file declared (a newer one is read as far as v1 goes). */
  version: number;
}

/** Reads a sidecar (text or parsed JSON). Throws {@link SidecarError} when it is not one. */
export function parseSidecar(input: string | unknown, now = Date.now()): ParsedSidecar {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (input.length > SIDECAR_MAX_BYTES) throw new SidecarError('Too large for a sidecar.');
    try {
      raw = JSON.parse(input);
    } catch {
      throw new SidecarError('Not JSON.');
    }
  }
  if (!isObj(raw)) throw new SidecarError('Not a sidecar.');
  if (raw.format !== SIDECAR_FORMAT) throw new SidecarError('Not a Pocket Monitor sidecar.');
  const version = num(raw.version) ?? 0;
  if (version < 1) throw new SidecarError('Unknown sidecar version.');
  const clip = isObj(raw.clip) ? raw.clip : {};
  const camera = isObj(clip.camera) ? clip.camera : {};
  const fps = num(clip.fps);
  const identity: ClipIdentity = {
    fileName: str(clip.fileName),
    createdAt: time(clip.createdAt),
    durationSec: num(clip.durationSec),
    sizeBytes: num(clip.sizeBytes),
    fps,
    width: num(clip.width),
    height: num(clip.height),
    colorMode: typeof clip.colorMode === 'string' ? clip.colorMode : undefined,
    codec: typeof clip.codec === 'string' ? clip.codec : undefined,
    cameraModel: typeof camera.model === 'string' ? camera.model : undefined,
    cameraName: typeof camera.name === 'string' ? camera.name : undefined,
    cameraSerial: typeof camera.serial === 'string' ? camera.serial : undefined,
  };
  for (const k of Object.keys(identity) as (keyof ClipIdentity)[]) if (identity[k] === undefined) delete identity[k];
  if (!identity.fileName) throw new SidecarError('The sidecar names no clip.');
  const markers: ClipMarker[] = [];
  for (const m of Array.isArray(raw.markers) ? raw.markers : []) {
    if (!isObj(m)) continue;
    const t = num(m.time) ?? (num(m.frame) != null && fps ? num(m.frame)! / fps : undefined);
    if (t == null || t < 0) continue;
    const tag = typeof m.tag === 'string' && cleanTag(m.tag) ? cleanTag(m.tag) : null;
    const marker: ClipMarker = {
      id: str(m.id) || `m${markers.length}`,
      time: t,
      label: str(m.label),
      tag,
      color: isMarkerColor(m.color) ? m.color : colorForTag(tag),
      createdAt: time(m.createdAt) || now,
    };
    if (typeof m.source === 'string') marker.source = m.source as ClipMarker['source'];
    const extra = withoutKnown(m, KNOWN_MARKER);
    if (extra) marker.extra = extra;
    markers.push(marker);
  }
  const tags: string[] = [];
  for (const t of Array.isArray(raw.tags) ? raw.tags : []) if (typeof t === 'string' && cleanTag(t)) tags.push(cleanTag(t));
  const shootRaw = isObj(raw.shoot) ? raw.shoot : null;
  const takeRaw = isObj(raw.take) ? raw.take : null;
  const extra: Record<string, unknown> = { ...(withoutKnown(raw, KNOWN_TOP) ?? {}) };
  const appRest = isObj(raw.app) ? withoutKnown(raw.app, ['name', 'version', 'platform']) : undefined;
  if (appRest) extra.__app = appRest;
  const shootRest = shootRaw ? withoutKnown(shootRaw, ['id', 'name', 'folderPath']) : undefined;
  if (shootRest) extra.__shoot = shootRest;
  const takeRest = takeRaw ? withoutKnown(takeRaw, ['id', 'number', 'startedAt', 'timeSource']) : undefined;
  if (takeRest) extra.__take = takeRest;
  const meta: ClipMeta = {
    identity,
    markers: sortMarkers(markers),
    tags,
    notes: str(raw.notes),
    shootId: shootRaw && str(shootRaw.id) ? str(shootRaw.id) : null,
    updatedAt: now,
  };
  if (takeRaw && str(takeRaw.id)) {
    meta.take = {
      id: str(takeRaw.id),
      number: Math.max(1, Math.round(num(takeRaw.number) ?? 1)),
      startedAt: time(takeRaw.startedAt),
      timeSource: takeRaw.timeSource === 'phone' ? 'phone' : 'camera',
    };
  }
  if (Object.keys(extra).length) meta.extra = extra;
  const clipExtra = withoutKnown(clip, KNOWN_CLIP);
  if (clipExtra) meta.clipExtra = clipExtra;
  return {
    meta,
    rating: Math.max(0, Math.min(5, Math.round(num(raw.rating) ?? 0))),
    favorite: raw.favorite === true,
    shoot: shootRaw && str(shootRaw.id) ? { id: str(shootRaw.id), name: str(shootRaw.name, 'Shoot'), folderPath: str(shootRaw.folderPath) } : null,
    version,
  };
}
