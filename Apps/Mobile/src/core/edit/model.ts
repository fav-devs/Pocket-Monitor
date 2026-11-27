/**
 * Non-destructive per-clip edit (the playback editor). One `ClipEdit` per media item, kept in app
 * storage; nothing here touches the camera original. Preview and export both read this model:
 * the colour stage (look + custom LUT, baked into one cube), the face stage (`face.ts`), the
 * geometry stage (rotate → crop → flip) and the audio stage (volume).
 *
 * Pure TypeScript: no React / React Native imports. Additive changes only (persisted).
 */

export type Rotation = 0 | 90 | 180 | 270;

/** Output frame shape. `original` keeps the (rotated) source shape. */
export type AspectId = 'original' | '16:9' | '9:16' | '4:3' | '3:4' | '1:1';

export const ASPECTS: { id: AspectId; label: string; ratio: number | null }[] = [
  { id: 'original', label: 'Original', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '1:1', label: '1:1', ratio: 1 },
];

export interface CropState {
  aspect: AspectId;
  /** 1…MAX_ZOOM; 1 is the largest crop of `aspect` that fits. */
  zoom: number;
  /** −1…1 along the room the crop has to move in (0 = centred). */
  panX: number;
  panY: number;
}

/** Face retouch strengths 0…1, rendered by the face stage (`face.ts`). All 0 = no face stage. */
export interface FaceParams {
  auto: number;
  smooth: number;
  brighten: number;
  slim: number;
  eyes: number;
}

export type FaceKey = keyof FaceParams;
export const FACE_KEYS: FaceKey[] = ['auto', 'smooth', 'brighten', 'slim', 'eyes'];

export interface ClipEdit {
  /** Built-in look id (`looks.ts`), or null for none. */
  look: string | null;
  /** 0…1. */
  lookStrength: number;
  /** Imported LUT (LUT Hub entry id, without the `custom:` prefix), or null. */
  lut: string | null;
  lutStrength: number;
  crop: CropState;
  /** Clockwise, in 90° steps. */
  rotation: Rotation;
  flipH: boolean;
  flipV: boolean;
  /** 0…2 (0 = mute, 1 = as recorded, 2 = +6 dB). */
  volume: number;
  face: FaceParams;
  /** Seconds into the clip; null = whole clip. */
  trim: { start: number; end: number } | null;
  /** HDR sources: keep HDR in the export (and preview) or tone-map to SDR. */
  hdr: 'keep' | 'sdr';
  /** Last change (ms epoch), for sorting / sync. */
  updatedAt?: number;
}

export const MAX_ZOOM = 4;
export const MAX_VOLUME = 2;
/** Shortest trimmed clip, seconds. */
export const MIN_TRIM = 0.5;

export const defaultFace = (): FaceParams => ({ auto: 0, smooth: 0, brighten: 0, slim: 0, eyes: 0 });
export const defaultCrop = (aspect: AspectId = 'original'): CropState => ({ aspect, zoom: 1, panX: 0, panY: 0 });

export const defaultEdit = (): ClipEdit => ({
  look: null,
  lookStrength: 1,
  lut: null,
  lutStrength: 1,
  crop: defaultCrop(),
  rotation: 0,
  flipH: false,
  flipV: false,
  volume: 1,
  face: defaultFace(),
  trim: null,
  hdr: 'keep',
});

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const isAspect = (a: unknown): a is AspectId => ASPECTS.some((x) => x.id === a);

/** A stored (possibly older or partial) edit as a complete, clamped `ClipEdit`. */
export function normalizeEdit(input: Partial<ClipEdit> | null | undefined, durationSec?: number): ClipEdit {
  const d = defaultEdit();
  if (!input) return d;
  const rot = Number(input.rotation);
  const crop = input.crop ?? d.crop;
  const face = { ...d.face, ...(input.face ?? {}) };
  for (const k of FACE_KEYS) face[k] = clamp(face[k], 0, 1);
  let trim = input.trim ?? null;
  if (trim) {
    let start = Math.max(0, Number(trim.start) || 0);
    let end = Number(trim.end) || 0;
    if (durationSec && durationSec > 0) {
      start = Math.min(start, durationSec);
      end = Math.min(end, durationSec);
    }
    if (end - start < MIN_TRIM) trim = null;
    else if (durationSec && start <= 0.01 && end >= durationSec - 0.01) trim = null;
    else trim = { start, end };
  }
  return {
    look: typeof input.look === 'string' && input.look ? input.look : null,
    lookStrength: clamp(input.lookStrength ?? 1, 0, 1),
    lut: typeof input.lut === 'string' && input.lut ? input.lut : null,
    lutStrength: clamp(input.lutStrength ?? 1, 0, 1),
    crop: {
      aspect: isAspect(crop.aspect) ? crop.aspect : 'original',
      zoom: clamp(crop.zoom ?? 1, 1, MAX_ZOOM),
      panX: clamp(crop.panX ?? 0, -1, 1),
      panY: clamp(crop.panY ?? 0, -1, 1),
    },
    rotation: rot === 90 || rot === 180 || rot === 270 ? rot : 0,
    flipH: !!input.flipH,
    flipV: !!input.flipV,
    volume: clamp(input.volume ?? 1, 0, MAX_VOLUME),
    face,
    trim,
    hdr: input.hdr === 'sdr' ? 'sdr' : 'keep',
    updatedAt: input.updatedAt,
  };
}

// ───────────────────────────── Questions ─────────────────────────────

export const hasLook = (e: ClipEdit) => (!!e.look && e.lookStrength > 0.001) || (!!e.lut && e.lutStrength > 0.001);
export const hasFace = (e: ClipEdit) => FACE_KEYS.some((k) => e.face[k] > 0.001);
/** Anything per-pixel (colour or face). */
export const hasColor = (e: ClipEdit) => hasLook(e) || hasFace(e);
export const hasCrop = (e: ClipEdit) => e.crop.aspect !== 'original' || e.crop.zoom > 1.001;
export const hasGeometry = (e: ClipEdit) => hasCrop(e) || e.rotation !== 0 || e.flipH || e.flipV;
export const hasAudio = (e: ClipEdit) => Math.abs(e.volume - 1) > 0.001;
export const hasTrim = (e: ClipEdit) => e.trim != null;
export const hasHdrChange = (e: ClipEdit) => e.hdr !== 'keep';

/** True when the edit changes nothing (the export would equal the original). */
export function isIdentity(e: ClipEdit): boolean {
  return !hasColor(e) && !hasGeometry(e) && !hasAudio(e) && !hasTrim(e) && !hasHdrChange(e);
}

// ───────────────────────────── Tools / panels ─────────────────────────────

export type EditTool = 'filter' | 'aspect' | 'rotate' | 'volume' | 'face' | 'trim';

/** What a tool's ✕ puts back and its Reset clears: the fields that tool owns. */
export function toolFields(tool: EditTool): (keyof ClipEdit)[] {
  switch (tool) {
    case 'filter':
      return ['look', 'lookStrength', 'lut', 'lutStrength'];
    case 'aspect':
      return ['crop'];
    case 'rotate':
      return ['rotation', 'flipH', 'flipV'];
    case 'volume':
      return ['volume'];
    case 'face':
      return ['face'];
    case 'trim':
      return ['trim'];
  }
}

/** The tool's fields from `from` over `onto` (✕ = revert to the snapshot taken on open). */
export function revertTool(onto: ClipEdit, from: ClipEdit, tool: EditTool): ClipEdit {
  const next = { ...onto } as Record<keyof ClipEdit, unknown>;
  for (const f of toolFields(tool)) next[f] = structuredCloneish(from[f]);
  return next as unknown as ClipEdit;
}

/** The tool's fields back to defaults (Reset). */
export function resetTool(edit: ClipEdit, tool: EditTool): ClipEdit {
  return revertTool(edit, defaultEdit(), tool);
}

/** True when the tool's fields differ from the defaults (the "edited" dot on its well). */
export function toolEdited(edit: ClipEdit, tool: EditTool): boolean {
  switch (tool) {
    case 'filter':
      return hasLook(edit);
    case 'aspect':
      return hasCrop(edit);
    case 'rotate':
      return edit.rotation !== 0 || edit.flipH || edit.flipV;
    case 'volume':
      return hasAudio(edit);
    case 'face':
      return hasFace(edit);
    case 'trim':
      return hasTrim(edit);
  }
}

function structuredCloneish<T>(v: T): T {
  return v && typeof v === 'object' ? (JSON.parse(JSON.stringify(v)) as T) : v;
}

// ───────────────────────────── Edits ─────────────────────────────

export const rotateClockwise = (e: ClipEdit): ClipEdit => ({ ...e, rotation: (((e.rotation + 90) % 360) as Rotation) });

/** Rotating by 90° swaps a portrait/landscape crop so the framing keeps its orientation. */
export function rotateKeepingFrame(e: ClipEdit): ClipEdit {
  const next = rotateClockwise(e);
  const swap: Partial<Record<AspectId, AspectId>> = { '16:9': '9:16', '9:16': '16:9', '4:3': '3:4', '3:4': '4:3' };
  const aspect = swap[e.crop.aspect];
  // The crop centre turns with the picture: (u, v) → (1 − v, u).
  const turned = { ...next.crop, panX: next.crop.panY === 0 ? 0 : -next.crop.panY, panY: next.crop.panX };
  return { ...next, crop: aspect ? { ...turned, aspect } : turned };
}

export function setTrimPoint(e: ClipEdit, which: 'start' | 'end', seconds: number, durationSec: number): ClipEdit {
  const cur = e.trim ?? { start: 0, end: durationSec };
  let { start, end } = cur;
  if (which === 'start') start = Math.min(Math.max(0, seconds), end - MIN_TRIM);
  else end = Math.max(Math.min(durationSec, seconds), start + MIN_TRIM);
  return normalizeEdit({ ...e, trim: { start: Math.max(0, start), end: Math.min(durationSec, end) } }, durationSec);
}

// ───────────────────────────── Presets ─────────────────────────────

/** "Editing Preset": a named look/aspect/rotation/volume/face to apply to other clips. */
export interface EditPreset {
  id: string;
  name: string;
  createdAt: number;
  look: string | null;
  lookStrength: number;
  lut: string | null;
  lutStrength: number;
  aspect: AspectId;
  rotation: Rotation;
  flipH: boolean;
  flipV: boolean;
  volume: number;
  face: FaceParams;
  hdr: 'keep' | 'sdr';
}

/** A preset from an edit. Trim and crop position are per-clip and stay behind. */
export function presetFrom(edit: ClipEdit, name: string, id: string, now = Date.now()): EditPreset {
  return {
    id,
    name: name.trim() || 'Preset',
    createdAt: now,
    look: edit.look,
    lookStrength: edit.lookStrength,
    lut: edit.lut,
    lutStrength: edit.lutStrength,
    aspect: edit.crop.aspect,
    rotation: edit.rotation,
    flipH: edit.flipH,
    flipV: edit.flipV,
    volume: edit.volume,
    face: { ...edit.face },
    hdr: edit.hdr,
  };
}

/** Apply a preset over a clip's edit: keeps the clip's trim; the crop recentres. */
export function applyPreset(edit: ClipEdit, preset: EditPreset): ClipEdit {
  return normalizeEdit({
    ...edit,
    look: preset.look,
    lookStrength: preset.lookStrength,
    lut: preset.lut,
    lutStrength: preset.lutStrength,
    crop: defaultCrop(preset.aspect),
    rotation: preset.rotation,
    flipH: preset.flipH,
    flipV: preset.flipV,
    volume: preset.volume,
    face: { ...preset.face },
    hdr: preset.hdr,
  });
}

/** Preset CRUD on a plain list (the store wraps these). */
export const presetList = {
  add(list: EditPreset[], preset: EditPreset): EditPreset[] {
    return [preset, ...list.filter((p) => p.id !== preset.id)].slice(0, 100);
  },
  rename(list: EditPreset[], id: string, name: string): EditPreset[] {
    const trimmed = name.trim();
    if (!trimmed) return list;
    return list.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
  },
  remove(list: EditPreset[], id: string): EditPreset[] {
    return list.filter((p) => p.id !== id);
  },
  /** A name not yet used: "Preset 3". */
  nextName(list: EditPreset[], base = 'Preset'): string {
    const used = new Set(list.map((p) => p.name));
    for (let i = list.length + 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
  },
};
