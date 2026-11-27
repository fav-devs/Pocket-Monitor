/**
 * The persisted Multiview stage as pure values and reducers: presentation (layout, selected
 * tile, Fit/Fill), the shared network, the last stage's cameras (the journal), cameras still
 * owed a return to their own Wi-Fi, and each camera's tile look. Sessions never enter it.
 * Values and rules after OpenCine `MultiviewStageState` + `MultiviewStageJournal`.
 */
import { MULTIVIEW_TILE_COUNT, cleanupTargets, validateStage, type JournalCamera, type JournalStage, type StageLayout } from '@/core/multicam';
import type { CameraModelId } from '../types';
import { DEFAULT_LOOK, type MultiviewCamera, type MultiviewNetwork, type TileLook } from './types';

export interface StageValues {
  layout: StageLayout;
  selected: number;
  fill: boolean;
  network: MultiviewNetwork | null;
  /** The current (or last closed) stage's cameras by slot. */
  cameras: JournalCamera[];
  /** Cameras moved onto the shared network that have not returned to their own Wi-Fi. */
  pendingReset: JournalCamera[];
  /** Tile look per camera id; a camera keeps its look across stages. */
  looks: Record<string, TileLook>;
}

export const initialStage = (): StageValues => ({
  layout: 'grid',
  selected: 0,
  fill: false,
  network: null,
  cameras: [],
  pendingReset: [],
  looks: {},
});

const clampSlot = (n: number) => Math.min(MULTIVIEW_TILE_COUNT - 1, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

export function journalCamera(camera: MultiviewCamera, slot: number, look?: TileLook): JournalCamera {
  return {
    slot,
    id: camera.id,
    name: camera.name,
    model: camera.model,
    host: camera.path?.kind === 'station' || camera.path?.kind === 'hotspot' ? camera.path.host : undefined,
    experimental: !!camera.experimental,
    lutEnabled: (look ?? DEFAULT_LOOK).lut,
    demoScene: camera.demoScene,
  };
}

/** A journal camera back as a tile camera on `network` (demo cameras need none). */
export function cameraFromJournal(j: JournalCamera, network: MultiviewNetwork | null): MultiviewCamera {
  const camera: MultiviewCamera = { id: j.id, name: j.name, model: j.model as CameraModelId, experimental: j.experimental };
  if (j.demoScene) return { ...camera, demoScene: j.demoScene as MultiviewCamera['demoScene'] };
  if (network) camera.path = { kind: network.hotspot ? 'hotspot' : 'station', ssid: network.ssid, ...(j.host ? { host: j.host } : {}) };
  return camera;
}

export const StageReducers = {
  setLayout: (s: StageValues, layout: StageLayout): StageValues => (s.layout === layout ? s : { ...s, layout }),
  toggleLayout: (s: StageValues): StageValues => ({ ...s, layout: s.layout === 'grid' ? 'center' : 'grid' }),
  select: (s: StageValues, slot: number): StageValues => {
    const selected = clampSlot(slot);
    return s.selected === selected ? s : { ...s, selected };
  },
  /** Tap a tile: it becomes the selected camera and the stage shows it large (Center stage). */
  focus: (s: StageValues, slot: number): StageValues => ({ ...s, selected: clampSlot(slot), layout: 'center' }),
  toggleFill: (s: StageValues): StageValues => ({ ...s, fill: !s.fill }),
  setNetwork: (s: StageValues, network: MultiviewNetwork | null): StageValues => ({ ...s, network }),

  /**
   * Membership changed: the journal follows the stage. Every camera that joined a shared network
   * is also owed a return to its own Wi-Fi until Close confirms it.
   */
  members: (s: StageValues, cameras: (MultiviewCamera | null)[]): StageValues => {
    const list = cameras.flatMap((c, slot) => (c ? [journalCamera(c, slot, s.looks[c.id])] : []));
    const owed = list.filter((c) => !c.demoScene && cameras[c.slot]?.path);
    const selected = cameras[s.selected] || !list.length ? s.selected : list[0].slot;
    return { ...s, cameras: list, pendingReset: cleanupTargets(s.pendingReset, owed), selected };
  },
  /** Cameras confirmed back on their own Wi-Fi leave the cleanup ledger; the rest stay owed. */
  returned: (s: StageValues, returnedIds: string[]): StageValues => ({
    ...s,
    pendingReset: s.pendingReset.filter((c) => !returnedIds.includes(c.id)),
  }),
  setLook: (s: StageValues, cameraId: string, patch: Partial<TileLook>): StageValues => ({
    ...s,
    looks: { ...s.looks, [cameraId]: { ...(s.looks[cameraId] ?? DEFAULT_LOOK), ...patch } },
  }),
};

export const lookFor = (s: Pick<StageValues, 'looks'>, cameraId: string | undefined): TileLook => (cameraId && s.looks[cameraId]) || DEFAULT_LOOK;

/** The journal value written for a relaunch (`MultiviewStageJournal.Stage`). */
export function toJournal(s: StageValues): JournalStage {
  return {
    version: 1,
    ssid: s.network?.ssid ?? '',
    hotspot: !!s.network?.hotspot,
    layout: s.layout,
    focusedIndex: clampSlot(s.selected),
    fill: s.fill,
    cameras: s.cameras,
    pendingReset: s.pendingReset,
  };
}

/** A stored value back, dropping whatever does not validate (presentation survives). */
export function fromStored(raw: unknown): StageValues {
  const base = initialStage();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<StageValues>;
  const journal = validateStage({
    version: 1,
    ssid: r.network?.ssid ?? '',
    hotspot: !!r.network?.hotspot,
    layout: r.layout,
    focusedIndex: r.selected,
    fill: r.fill,
    cameras: r.cameras ?? [],
    pendingReset: r.pendingReset ?? [],
  });
  const looks = r.looks && typeof r.looks === 'object' ? r.looks : {};
  if (!journal) {
    return {
      ...base,
      layout: r.layout === 'center' ? 'center' : 'grid',
      fill: !!r.fill,
      looks,
    };
  }
  return {
    layout: journal.layout,
    selected: journal.focusedIndex,
    fill: journal.fill,
    network: r.network && typeof r.network.ssid === 'string' && r.network.ssid ? { ssid: r.network.ssid, hotspot: !!r.network.hotspot } : null,
    cameras: journal.cameras,
    pendingReset: journal.pendingReset,
    looks,
  };
}
