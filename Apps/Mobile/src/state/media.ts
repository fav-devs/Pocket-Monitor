import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './storage';

/**
 * Media library, playback and delivery preferences (Settings → Media). Additive changes only:
 * add a field with a default, never rename one (persisted data would be lost).
 *
 * Secrets never live here: Frame.io tokens go to expo-secure-store (src/features/media/frameio.ts).
 * The Frame.io client id and redirect URI are user-supplied app identifiers, not secrets.
 */
export type MediaLayout = 'grid' | 'list';
export type MediaThumbnailSize = 'small' | 'medium' | 'large';
export type MediaSort = 'newest' | 'oldest' | 'largest' | 'longest';
/** What happens after an export: the system share sheet or a save to the photo library. */
export type MediaPostExportAction = 'system-share' | 'save-to-photos';
/** Container/codec of a delivered file. Anything but `original` needs the native exporter. */
export type MediaShareFormat = 'original' | 'h264' | 'hevc';
/** Output curve when converting log footage. */
export type MediaOutputCurve = 'rec709' | 'hlg';

export interface MediaPreferences {
  // Gallery
  layout: MediaLayout;
  thumbnailSize: MediaThumbnailSize;
  sort: MediaSort;
  /** Collapse bursts and panorama groups into one stacked card. */
  stackBursts: boolean;
  /** Group the gallery under day headers. */
  groupByDay: boolean;
  // Playback
  loopPlayback: boolean;
  mutePlayback: boolean;
  /** Show the clock as HH:MM:SS:FF instead of m:ss. */
  playbackTimecode: boolean;
  /** Open playback with the assists overlay shown. */
  playbackAssists: boolean;
  playbackAudioMeters: boolean;
  // Delivery
  postExportAction: MediaPostExportAction;
  shareFormat: MediaShareFormat;
  /** Keep downloaded originals in the local cache after a delivery. */
  keepOriginals: boolean;
  convertLog: boolean;
  outputCurve: MediaOutputCurve;
  bakeLUT: boolean;
  bakeExposure: boolean;
  includeMetadata: boolean;
  // Frame.io (non-secret configuration only)
  frameioEnabled: boolean;
  frameioClientId: string;
  frameioRedirectUri: string;
  frameioProjectId: string | null;
  frameioProjectName: string | null;
  frameioRootFolderId: string | null;
  frameioAccountId: string | null;
  /** Upload even when the same clip was uploaded before. */
  frameioReupload: boolean;
  /** Clip keys already uploaded (cameraId/fileName/size). */
  frameioUploaded: string[];
  // Per-clip operator state the camera does not keep
  /** Star ratings 1–5 keyed by media id; absent means unrated. */
  ratings: Record<string, number>;
}

export const defaultMediaPreferences: MediaPreferences = {
  layout: 'grid',
  thumbnailSize: 'medium',
  sort: 'newest',
  stackBursts: true,
  groupByDay: true,
  loopPlayback: false,
  mutePlayback: false,
  playbackTimecode: false,
  playbackAssists: false,
  playbackAudioMeters: true,
  postExportAction: 'system-share',
  shareFormat: 'original',
  keepOriginals: true,
  convertLog: false,
  outputCurve: 'rec709',
  bakeLUT: false,
  bakeExposure: false,
  includeMetadata: true,
  frameioEnabled: false,
  frameioClientId: '',
  frameioRedirectUri: '',
  frameioProjectId: null,
  frameioProjectName: null,
  frameioRootFolderId: null,
  frameioAccountId: null,
  frameioReupload: false,
  frameioUploaded: [],
  ratings: {},
};

interface MediaPreferencesStore extends MediaPreferences {
  set: <K extends keyof MediaPreferences>(key: K, value: MediaPreferences[K]) => void;
  setRating: (id: string, stars: number) => void;
  markUploaded: (key: string) => void;
  reset: () => void;
}

export const useMediaPreferences = create<MediaPreferencesStore>()(
  persist(
    (set) => ({
      ...defaultMediaPreferences,
      set: (key, value) => set({ [key]: value } as Partial<MediaPreferences>),
      setRating: (id, stars) =>
        set((s) => {
          const ratings = { ...s.ratings };
          if (stars <= 0) delete ratings[id];
          else ratings[id] = Math.min(5, Math.round(stars));
          return { ratings };
        }),
      markUploaded: (key) =>
        set((s) => (s.frameioUploaded.includes(key) ? s : { frameioUploaded: [...s.frameioUploaded.slice(-499), key] })),
      reset: () => set(defaultMediaPreferences),
    }),
    { name: 'pm.media.v1', storage: persistStorage },
  ),
);
