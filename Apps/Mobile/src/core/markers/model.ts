/**
 * Clip metadata the operator adds on this device: markers made while recording (or later in
 * playback), tags, notes, the shoot a clip belongs to and its take. The camera keeps none of
 * this; the app stores it per media item (`src/state/clipMeta.ts`) and writes it next to a clip
 * as a sidecar (`./sidecar.ts`, spec in `docs/clip-metadata.md`).
 *
 * Pure TypeScript: no React / React Native imports. Additive changes only (persisted and written
 * into sidecars other apps read).
 */

/** Marker colours. The names are DaVinci Resolve's marker colours, so exports map one to one. */
export type MarkerColor = 'blue' | 'cyan' | 'green' | 'yellow' | 'red' | 'pink' | 'purple' | 'cream';

export const MARKER_COLORS: MarkerColor[] = ['blue', 'cyan', 'green', 'yellow', 'red', 'pink', 'purple', 'cream'];

/** On-screen swatch for each colour. */
export const MARKER_SWATCH: Record<MarkerColor, string> = {
  blue: '#3d8bff',
  cyan: '#2fd3e0',
  green: '#3fc96b',
  yellow: '#fedb2e',
  red: '#ff4d5a',
  pink: '#ff6fb5',
  purple: '#a46bff',
  cream: '#f2e6c9',
};

/** How a marker was made. */
export type MarkerSource = 'button' | 'key' | 'gamepad' | 'gesture' | 'playback' | 'import';

export interface ClipMarker {
  id: string;
  /** Seconds from the clip's first frame. */
  time: number;
  /** Operator's words; empty for none. */
  label: string;
  /** One tag (a built-in or one of the operator's), or null. */
  tag: string | null;
  color: MarkerColor;
  /** When it was made (ms epoch). */
  createdAt: number;
  source?: MarkerSource;
  /** Fields from a newer sidecar this build does not know; written back unchanged. */
  extra?: Record<string, unknown>;
}

/** What identifies the camera file a clip is, so its metadata follows it camera → phone → PC. */
export interface ClipIdentity {
  fileName: string;
  /** ms epoch. */
  createdAt: number;
  durationSec?: number;
  sizeBytes?: number;
  fps?: number;
  width?: number;
  height?: number;
  colorMode?: string;
  codec?: string;
  cameraModel?: string;
  cameraName?: string;
  cameraSerial?: string;
}

/** Which take a clip was, as this app saw it being recorded. */
export interface TakeInfo {
  id: string;
  /** 1-based within its shoot (or the day, without a shoot). */
  number: number;
  /** When the camera's first frame was, by this phone's clock (ms epoch). */
  startedAt: number;
  /** `camera`: marker times come from the camera's own elapsed time; `phone`: the phone's clock. */
  timeSource: 'camera' | 'phone';
}

export interface ClipMeta {
  identity: ClipIdentity;
  markers: ClipMarker[];
  tags: string[];
  notes: string;
  shootId: string | null;
  take?: TakeInfo;
  /** Unknown sidecar fields (top level), written back unchanged. */
  extra?: Record<string, unknown>;
  /** Unknown fields of the sidecar's `clip` object. */
  clipExtra?: Record<string, unknown>;
  updatedAt: number;
}

/** A shoot: a name and an optional folder path ("Vlog/Tokyo/Day 2") for the editor's media folders. */
export interface Shoot {
  id: string;
  name: string;
  folderPath: string;
  createdAt: number;
  /** Set when the operator ended it; it stays listed for grouping and moving clips. */
  endedAt?: number;
}

/** Tags offered on every marker toast before the operator's own. */
export const BUILT_IN_TAGS = ['Good', 'Bad', 'Hook', 'B-roll', 'Retake'] as const;

const TAG_COLOR: Record<string, MarkerColor> = { good: 'green', bad: 'red', hook: 'yellow', 'b-roll': 'cyan', retake: 'purple' };

/** A marker's colour for a tag: built-ins have their own, the operator's tags are pink, none is blue. */
export function colorForTag(tag: string | null | undefined): MarkerColor {
  if (!tag) return 'blue';
  return TAG_COLOR[tag.trim().toLowerCase()] ?? 'pink';
}

export const isMarkerColor = (v: unknown): v is MarkerColor => typeof v === 'string' && (MARKER_COLORS as string[]).includes(v);

/** Tags compare without case or surrounding space. */
export const tagKey = (tag: string) => tag.trim().toLowerCase();

/** A tag as stored: trimmed, inner space collapsed, at most 32 characters. Empty is no tag. */
export function cleanTag(tag: string): string {
  return tag.trim().replace(/\s+/g, ' ').slice(0, 32);
}

/** Adds or removes `tag` (case-insensitive), keeping the first spelling. */
export function toggleTag(tags: string[], tag: string): string[] {
  const t = cleanTag(tag);
  if (!t) return tags;
  const k = tagKey(t);
  return tags.some((x) => tagKey(x) === k) ? tags.filter((x) => tagKey(x) !== k) : [...tags, t];
}

/** The tags a marker toast offers: the built-ins, then the operator's own, no duplicates. */
export function toastTags(userTags: string[]): string[] {
  const out: string[] = [...BUILT_IN_TAGS];
  for (const t of userTags) if (!out.some((x) => tagKey(x) === tagKey(t))) out.push(t);
  return out;
}

/** A clip's tags plus every marker's tag (what the library's tag filter and search see). */
export function allTags(meta: Pick<ClipMeta, 'tags' | 'markers'> | undefined): string[] {
  if (!meta) return [];
  const out: string[] = [];
  for (const t of [...meta.tags, ...meta.markers.map((m) => m.tag).filter((t): t is string => !!t)]) {
    if (!out.some((x) => tagKey(x) === tagKey(t))) out.push(t);
  }
  return out;
}

export function emptyMeta(identity: ClipIdentity, now = Date.now()): ClipMeta {
  return { identity, markers: [], tags: [], notes: '', shootId: null, updatedAt: now };
}

/** True when there is nothing worth keeping or writing. */
export function isEmptyMeta(m: ClipMeta | undefined): boolean {
  return !m || (m.markers.length === 0 && m.tags.length === 0 && !m.notes.trim() && !m.shootId && !m.take && !m.extra);
}

export function sortMarkers(markers: ClipMarker[]): ClipMarker[] {
  return [...markers].sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);
}

/** A short unique id ("m" + time + random). */
export function newId(prefix: string, now = Date.now(), random: () => number = Math.random): string {
  return `${prefix}${now.toString(36)}${Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')}`;
}

/** The frame a time lands on at `fps` (nearest). */
export function frameAt(time: number, fps: number | undefined): number {
  const f = fps && fps > 0 ? fps : 30;
  return Math.max(0, Math.round(time * f));
}

/** "00:41" (or "1:02:03" past an hour): the toast's and the list's clock. */
export function markerClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

/** A marker's shown name: its label, else its tag, else "Marker N". */
export function markerTitle(m: ClipMarker, index: number): string {
  return m.label.trim() || m.tag || `Marker ${index + 1}`;
}

/** The identity key used to find a clip's metadata when its media id differs between apps. */
export function identityKey(i: Pick<ClipIdentity, 'fileName' | 'sizeBytes'>): string {
  return `${i.fileName.toUpperCase()}|${i.sizeBytes ?? 0}`;
}
