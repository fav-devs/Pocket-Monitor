/**
 * The camera's media library as the screens see it: the listed items, the gallery's category,
 * filters and selection, running downloads with their speed, and originals cached on this
 * device. Not persisted (the camera card is the source of truth); preferences live in
 * `src/state/media.ts`.
 *
 * Every camera operation takes the session's `CameraMediaService`, so a swapped session
 * (demo → native) simply lists again.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { CameraMediaItem, CameraMediaService, ColorMode } from '@/camera';
import { useCameraSession } from '@/camera';
import { transferCaption } from './format';
import { rateReadingLabel, TransferRateEstimator } from './transferRate';

export type MediaCategory = 'all' | 'video' | 'photo' | 'favorites';

export interface MediaFilters {
  resolutions: string[];
  frameRates: number[];
  colors: ColorMode[];
}

export const emptyFilters: MediaFilters = { resolutions: [], frameRates: [], colors: [] };

export function activeFilterCount(f: MediaFilters): number {
  return f.resolutions.length + f.frameRates.length + f.colors.length;
}

export interface MediaTransfer {
  bytesDone: number;
  bytesTotal: number;
  fraction: number;
  /** "42 MB/s", "Stalled", or null while measuring. */
  rate: string | null;
}

interface MediaLibraryState {
  service: CameraMediaService | null;
  items: CameraMediaItem[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  refreshing: boolean;
  category: MediaCategory;
  filters: MediaFilters;
  selecting: boolean;
  /** Selected gallery entry ids (a stack is selected by its cover id). */
  selected: string[];
  transfers: Record<string, MediaTransfer>;
  /** Originals downloaded to this device, by media id. */
  localFiles: Record<string, string>;
  /** Short-lived operator notice ("Deleted 3 items"). */
  notice: string | null;
  /** Ids being deleted (shows the deletion overlay). */
  deleting: string[];

  load: (service: CameraMediaService, options?: { refresh?: boolean }) => Promise<void>;
  setCategory: (category: MediaCategory) => void;
  setFilters: (filters: MediaFilters) => void;
  beginSelection: (id?: string) => void;
  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  endSelection: () => void;
  toggleFavorite: (service: CameraMediaService, id: string) => Promise<void>;
  setFavorite: (service: CameraMediaService, ids: string[], favorite: boolean) => Promise<void>;
  deleteItems: (service: CameraMediaService, ids: string[]) => Promise<boolean>;
  /** Download (cache) an original; concurrent calls for one id share the transfer. */
  download: (service: CameraMediaService, id: string) => Promise<string>;
  forgetLocal: (id: string) => void;
  showNotice: (message: string) => void;
}

const inflight = new Map<string, Promise<string>>();
const estimators = new Map<string, TransferRateEstimator>();
let ticker: ReturnType<typeof setInterval> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let loadToken = 0;

function message(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The camera did not answer. Check the connection, then pull to refresh.';
}

export const useMediaLibrary = create<MediaLibraryState>()((set, get) => {
  /** Re-reads running downloads so a stall shows without a new byte. */
  const tick = () => {
    if (estimators.size === 0) {
      if (ticker) clearInterval(ticker);
      ticker = null;
      return;
    }
    const now = Date.now();
    const transfers = { ...get().transfers };
    let changed = false;
    estimators.forEach((estimator, id) => {
      const current = transfers[id];
      if (!current) return;
      const rate = rateReadingLabel(estimator.rate(now));
      if (rate !== current.rate) {
        transfers[id] = { ...current, rate };
        changed = true;
      }
    });
    if (changed) set({ transfers });
  };

  return {
    service: null,
    items: [],
    status: 'idle',
    error: null,
    refreshing: false,
    category: 'all',
    filters: emptyFilters,
    selecting: false,
    selected: [],
    transfers: {},
    localFiles: {},
    notice: null,
    deleting: [],

    load: async (service, options) => {
      const token = ++loadToken;
      const swapped = get().service !== service;
      if (swapped) {
        set({ service, items: [], status: 'loading', error: null, selected: [], selecting: false, localFiles: {} });
      } else if (options?.refresh || get().status !== 'ready') {
        set(get().status === 'ready' ? { refreshing: true } : { status: 'loading', error: null });
      } else {
        // Already listed for this session: refresh quietly in the background.
        set({ refreshing: true });
      }
      try {
        const items = await service.list();
        if (token !== loadToken) return;
        const ids = new Set(items.map((i) => i.id));
        set((s) => ({
          items,
          status: 'ready',
          error: null,
          refreshing: false,
          selected: s.selected.filter((id) => ids.has(id)),
        }));
      } catch (error) {
        if (token !== loadToken) return;
        set((s) => ({
          status: s.items.length ? 'ready' : 'error',
          error: message(error),
          refreshing: false,
        }));
        if (get().items.length) get().showNotice(message(error));
      }
    },

    setCategory: (category) => set({ category, selected: [], selecting: false }),
    setFilters: (filters) => set({ filters }),
    beginSelection: (id) => set((s) => ({ selecting: true, selected: id && !s.selected.includes(id) ? [...s.selected, id] : s.selected })),
    toggleSelected: (id) =>
      set((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] })),
    setSelected: (ids) => set({ selected: ids }),
    endSelection: () => set({ selecting: false, selected: [] }),

    toggleFavorite: async (service, id) => {
      const item = get().items.find((i) => i.id === id);
      if (!item) return;
      await get().setFavorite(service, [id], !item.favorite);
    },

    setFavorite: async (service, ids, favorite) => {
      const before = get().items;
      // Optimistic: the star answers the tap; a failure puts it back.
      set({ items: before.map((i) => (ids.includes(i.id) ? { ...i, favorite } : i)) });
      try {
        await Promise.all(ids.map((id) => service.setFavorite(id, favorite)));
      } catch (error) {
        set((s) => ({
          items: s.items.map((i) => {
            const prior = before.find((b) => b.id === i.id);
            return ids.includes(i.id) && prior ? { ...i, favorite: prior.favorite } : i;
          }),
        }));
        get().showNotice(`Couldn't update favorite. ${message(error)}`);
      }
    },

    deleteItems: async (service, ids) => {
      if (!ids.length) return false;
      set({ deleting: ids });
      try {
        await service.delete(ids);
        set((s) => {
          const localFiles = { ...s.localFiles };
          ids.forEach((id) => delete localFiles[id]);
          return {
            items: s.items.filter((i) => !ids.includes(i.id)),
            selected: s.selected.filter((id) => !ids.includes(id)),
            selecting: false,
            localFiles,
            deleting: [],
          };
        });
        get().showNotice(ids.length === 1 ? 'Deleted 1 item from the camera' : `Deleted ${ids.length} items from the camera`);
        return true;
      } catch (error) {
        set({ deleting: [] });
        get().showNotice(`Delete failed. ${message(error)}`);
        return false;
      }
    },

    download: (service, id) => {
      const cached = get().localFiles[id];
      if (cached) return Promise.resolve(cached);
      const running = inflight.get(id);
      if (running) return running;
      const item = get().items.find((i) => i.id === id);
      const total = item?.sizeBytes ?? 0;
      const estimator = new TransferRateEstimator(Date.now());
      estimators.set(id, estimator);
      set((s) => ({ transfers: { ...s.transfers, [id]: { bytesDone: 0, bytesTotal: total, fraction: 0, rate: null } } }));
      if (!ticker) ticker = setInterval(tick, 500);
      const promise = service
        .download(id, (p) => {
          const now = Date.now();
          estimator.record(p.bytesDone, now);
          const bytesTotal = p.bytesTotal || total;
          const fraction = bytesTotal > 0 ? Math.min(1, p.bytesDone / bytesTotal) : 0;
          set((s) => ({
            transfers: {
              ...s.transfers,
              [id]: { bytesDone: p.bytesDone, bytesTotal, fraction, rate: rateReadingLabel(estimator.rate(now)) },
            },
          }));
        })
        .then((uri) => {
          set((s) => ({ localFiles: uri ? { ...s.localFiles, [id]: uri } : s.localFiles }));
          return uri;
        })
        .finally(() => {
          inflight.delete(id);
          estimators.delete(id);
          set((s) => {
            const transfers = { ...s.transfers };
            delete transfers[id];
            return { transfers };
          });
        });
      inflight.set(id, promise);
      return promise;
    },

    forgetLocal: (id) =>
      set((s) => {
        const localFiles = { ...s.localFiles };
        delete localFiles[id];
        return { localFiles };
      }),

    showNotice: (notice) => {
      if (noticeTimer) clearTimeout(noticeTimer);
      set({ notice });
      noticeTimer = setTimeout(() => set({ notice: null }), 2600);
    },
  };
});

/** The cell's download readout: "18% · 42 MB/s". */
export function transferReadout(t: MediaTransfer | undefined, withRate = true): string | null {
  if (!t) return null;
  return transferCaption(t.fraction, withRate ? t.rate : null);
}

/**
 * Live view is paused while browsing media on the camera. Screens that browse call this hook;
 * when the last one unmounts (and no other media screen takes over within a beat, e.g. going
 * from the gallery into playback and back), live view is resumed.
 */
let browsers = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

export function useMediaBrowsing() {
  const session = useCameraSession();
  useEffect(() => {
    browsers += 1;
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    return () => {
      browsers -= 1;
      if (browsers > 0) return;
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (browsers === 0) session.media.resumeLive().catch(() => {});
      }, 300);
    };
  }, [session]);
}
