import { create } from 'zustand';
import type { CameraMediaItem } from '@/camera';
import {
  EDIT_CUBE_SIZE,
  exportPlan,
  exportReducer,
  exportRunning,
  idleExport,
  type ClipEdit,
  type ExportAction,
  type ExportJobState,
  type ExportQuality,
  type Size,
} from '@/core/edit';
import { ensureLut } from '@/features/picture/lutLibrary';
import { PocketEdit } from '@modules/pocket-native/src/edit';
import { deliveryPlatform } from '../deliveryPlatform';
import { useMediaLibrary } from '../libraryStore';
import { bakeEditCube, registerNativeCube } from './cubes';
import { exportSidecarFor } from '@/features/markers/sidecarFor';
import { writeLibrarySidecar } from '@/features/markers/sidecarFiles';

export interface ExportRequest {
  item: CameraMediaItem;
  edit: ClipEdit;
  quality: ExportQuality;
  /** The original on this phone, if any. */
  originalUri: string | null;
  /** The low-res copy on this phone, if any. */
  lowResUri: string | null;
  /** Fetch the original (the library's download path). */
  downloadOriginal: () => Promise<string>;
  sourceSize: Size;
  hdrSource: boolean;
  /** No real footage (demo camera, web): the job runs through its phases without a file. */
  simulate: boolean;
}

interface ExportStore extends ExportJobState {
  dispatch: (a: ExportAction) => void;
  start: (req: ExportRequest) => Promise<void>;
  cancel: () => void;
  dismiss: () => void;
}

class Cancelled extends Error {}

/**
 * The export runner: source (download the original when it is not on the phone) → render
 * (`PocketEdit.startExport`) → save to the photo library. One job at a time; state via the pure
 * reducer in core/edit/exportJob.
 */
export const useEditExport = create<ExportStore>()((set, get) => {
  const dispatch = (a: ExportAction) => set((s) => exportReducer(s, a));
  const alive = (id: string) => {
    const s = get();
    if (s.id !== id || !exportRunning(s)) throw new Cancelled();
  };

  return {
    ...idleExport(),
    dispatch,
    dismiss: () => dispatch({ type: 'dismiss' }),
    cancel: () => {
      const s = get();
      if (!exportRunning(s) || !s.id) return;
      if (s.phase === 'rendering' && PocketEdit) {
        try {
          PocketEdit.cancelExport(s.id);
        } catch {
          // Already finished.
        }
      }
      dispatch({ type: 'cancel' });
    },
    start: async (req) => {
      if (exportRunning(get())) return;
      const id = `export-${Date.now().toString(36)}`;
      const lowRes = req.quality === 'low-res';
      const needsDownload = !req.simulate && !lowRes && !req.originalUri;
      dispatch({ type: 'start', id, itemId: req.item.id, quality: req.quality, needsDownload });
      try {
        // 1. Source.
        let sourceUri = lowRes ? req.lowResUri : req.originalUri;
        if (needsDownload) {
          const unsub = useMediaLibrary.subscribe((s) => {
            const t = s.transfers[req.item.id];
            if (t) dispatch({ type: 'download', fraction: t.fraction });
          });
          try {
            sourceUri = await req.downloadOriginal();
          } finally {
            unsub();
          }
          alive(id);
        }
        if (!req.simulate && !sourceUri) throw new Error(lowRes ? 'No low-res copy on this phone yet.' : 'The original is not on this phone.');
        dispatch({ type: 'render', fraction: 0 });

        // 2. Render.
        let outputUri: string | null = null;
        if (req.simulate || !PocketEdit) {
          for (let i = 1; i <= 20; i++) {
            await new Promise((r) => setTimeout(r, 90));
            alive(id);
            dispatch({ type: 'render', fraction: i / 20 });
          }
        } else {
          if (req.edit.lut) await ensureLut(`custom:${req.edit.lut}`);
          const baked = bakeEditCube(req.edit, EDIT_CUBE_SIZE);
          if (baked) registerNativeCube(baked.key, baked.cube);
          const plan = exportPlan(req.edit, {
            sourceUri: sourceUri!,
            sourceSize: req.sourceSize,
            fileName: req.item.fileName,
            quality: req.quality,
            hdrSource: req.hdrSource,
          });
          const sub = PocketEdit.addListener('onExportProgress', (e) => {
            if (e.jobId === id) dispatch({ type: 'render', fraction: e.fraction });
          });
          try {
            outputUri = await PocketEdit.startExport(id, { ...plan, lutKey: baked ? baked.key : null });
          } finally {
            sub.remove();
          }
          alive(id);
        }

        // 3. Save.
        dispatch({ type: 'saving' });
        if (outputUri) {
          await deliveryPlatform.saveToPhotos([{ uri: outputUri, fileName: outputUri.split('/').pop() ?? 'edit.mp4', mimeType: 'video/mp4' }]);
          // Its markers, moved by the trim, stay in the app's library (Photos takes no sidecar).
          const sidecar = exportSidecarFor(req.item, req.edit.trim, outputUri.split('/').pop() ?? 'edit.mp4');
          await writeLibrarySidecar(sidecar.fileName, sidecar.json);
          // The library holds its own copy now.
          void deliveryPlatform.discard(outputUri);
        }
        alive(id);
        dispatch({ type: 'done', outputUri: outputUri ?? '' });
      } catch (e) {
        if (e instanceof Cancelled || get().phase === 'cancelled') return;
        const message = e instanceof Error ? e.message : String(e);
        if (/cancel/i.test(message)) dispatch({ type: 'cancel' });
        else dispatch({ type: 'fail', error: message || 'Export failed' });
      }
    },
  };
});
