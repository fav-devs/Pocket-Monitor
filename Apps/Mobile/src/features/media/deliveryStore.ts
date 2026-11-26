/**
 * The delivery queue: one batch per accepted share/save/upload request, run one after another
 * (OpenCine `MonitorDeliveryBatch` / `MonitorDeliveryBatchProgress`). Each clip is cached from
 * the camera (with progress and speed), exported (pass-through until the native exporter lands,
 * see export.ts), then handed to its destination.
 */
import { create } from 'zustand';
import type { CameraMediaItem, CameraMediaService } from '@/camera';
import { useMediaPreferences } from '@/state/media';
import { byteLabel } from './format';
import { deliveryPlatform, type DeliverableFile } from './deliveryPlatform';
import { type ExportOptions, ExportUnavailableError, mediaExporter, mimeTypeFor, requestedTransforms } from './export';
import { frameioClient, sharedDemoFrameioClient, type FrameioProject } from './frameio';
import { useMediaLibrary } from './libraryStore';

export type DeliveryDestination = 'share' | 'photos' | 'frameio';
export type DeliveryStage =
  | 'queued'
  | 'preparing'
  | 'caching'
  | 'exporting'
  | 'uploading'
  | 'saving'
  | 'sharing'
  | 'awaitingPhotosAccess';
export type DeliveryStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface DeliveryBatch {
  id: string;
  destination: DeliveryDestination;
  items: CameraMediaItem[];
  totalBytes: number;
  options: ExportOptions;
  project?: FrameioProject;
  demo: boolean;
  createdAt: number;
  status: DeliveryStatus;
  stage: DeliveryStage;
  /** 1-based clip being worked on. */
  clipIndex: number;
  clipFraction: number;
  filename: string | null;
  /** Camera download speed while caching. */
  transferRate: string | null;
  /** Outcome or failure copy. */
  message: string | null;
  /** Per-clip notes, e.g. transforms skipped for want of the native exporter. */
  notes: string[];
}

export function destinationTitle(d: DeliveryDestination): string {
  return d === 'share' ? 'Share' : d === 'photos' ? deliveryPlatform.photosTitle : 'Frame.io upload';
}

export function batchFraction(b: DeliveryBatch): number {
  if (b.status === 'done') return 1;
  const total = b.items.length;
  if (!total) return 0;
  return Math.min(1, (Math.max(0, b.clipIndex - 1) + b.clipFraction) / total);
}

/** `MonitorDeliveryBatchProgress.statusLine`. */
export function batchStatusLine(b: DeliveryBatch): string {
  if (b.status === 'queued') return 'Waiting…';
  if (b.status === 'done') return b.message ?? 'Done';
  if (b.status === 'failed') return b.message ?? 'Failed';
  if (b.status === 'cancelled') return 'Cancelled';
  const preparing = b.clipFraction <= 0;
  const percent = `${Math.round(batchFraction(b) * 100)}%`;
  switch (b.stage) {
    case 'awaitingPhotosAccess':
      return 'Waiting for Photos access…';
    case 'saving':
      return deliveryPlatform.photosTitle === 'Download' ? 'Downloading…' : 'Saving to Photos…';
    case 'sharing':
      return 'Opening share sheet…';
    case 'caching':
      if (preparing) return b.transferRate ? `Caching from camera · ${b.transferRate}` : 'Caching from camera…';
      return b.transferRate ? `Caching from camera ${percent} · ${b.transferRate}` : `Caching from camera ${percent}`;
    case 'exporting':
      return preparing ? 'Preparing…' : `Exporting ${percent}`;
    case 'uploading':
      return preparing ? 'Preparing…' : `Uploading ${percent}`;
    default:
      return 'Preparing…';
  }
}

/** "Clip 2 of 5 · 412 MB". */
export function batchCaption(b: DeliveryBatch): string {
  const count = b.items.length;
  const clip = b.status === 'running' && count > 1 ? `Clip ${b.clipIndex} of ${count}` : count === 1 ? '1 item' : `${count} items`;
  return `${clip} · ${byteLabel(b.totalBytes)}`;
}

interface DeliveryState {
  batches: DeliveryBatch[];
  /** Expanded queue panel shown over the gallery/player. */
  panelOpen: boolean;
  enqueue: (
    service: CameraMediaService,
    request: { destination: DeliveryDestination; items: CameraMediaItem[]; options: ExportOptions; project?: FrameioProject; demo: boolean },
  ) => string;
  cancel: (id: string) => void;
  clearFinished: () => void;
  setPanelOpen: (open: boolean) => void;
}

const cancelled = new Set<string>();
let running = false;
const services = new Map<string, CameraMediaService>();

export const useDelivery = create<DeliveryState>()((set, get) => {
  const patch = (id: string, change: Partial<DeliveryBatch>) =>
    set((s) => ({ batches: s.batches.map((b) => (b.id === id ? { ...b, ...change } : b)) }));

  const runNext = async () => {
    if (running) return;
    const next = get().batches.find((b) => b.status === 'queued');
    if (!next) return;
    running = true;
    try {
      await runBatch(next, patch);
    } finally {
      running = false;
      services.delete(next.id);
      void runNext();
    }
  };

  const runBatch = async (batch: DeliveryBatch, update: (id: string, c: Partial<DeliveryBatch>) => void) => {
    const service = services.get(batch.id);
    if (!service) return update(batch.id, { status: 'failed', message: 'The camera session ended.' });
    const prefs = useMediaPreferences.getState();
    const library = useMediaLibrary.getState();
    const isCancelled = () => cancelled.has(batch.id);
    const signal = {
      get cancelled() {
        return isCancelled();
      },
    };
    update(batch.id, { status: 'running', stage: 'preparing', clipIndex: 1, clipFraction: 0 });
    const files: DeliverableFile[] = [];
    const notes: string[] = [];
    const downloaded: string[] = [];
    try {
      for (let index = 0; index < batch.items.length; index++) {
        if (isCancelled()) throw new CancelledError();
        const item = batch.items[index];
        update(batch.id, { clipIndex: index + 1, clipFraction: 0, stage: 'caching', filename: item.fileName, transferRate: null });
        // Mirror the library's transfer (it owns the download and its speed estimator).
        const mirror = setInterval(() => {
          const t = useMediaLibrary.getState().transfers[item.id];
          if (t) update(batch.id, { clipFraction: t.fraction * 0.98, transferRate: t.rate });
        }, 200);
        let local: string;
        try {
          local = await library.download(service, item.id);
        } finally {
          clearInterval(mirror);
        }
        if (isCancelled()) throw new CancelledError();
        const source = await deliveryPlatform.materialize(item, local);
        if (local) downloaded.push(local);
        update(batch.id, { stage: 'exporting', clipFraction: 0.01, transferRate: null });
        let file: DeliverableFile;
        try {
          const result = await mediaExporter.export({ item, sourceUri: source, options: batch.options }, (f) =>
            update(batch.id, { clipFraction: Math.max(0.01, f) }),
          );
          file = { uri: result.uri, fileName: result.fileName, mimeType: result.mimeType };
        } catch (e) {
          if (!(e instanceof ExportUnavailableError)) throw e;
          const skipped = requestedTransforms(item, batch.options);
          notes.push(`${item.fileName}: ${skipped.join(', ')} skipped (needs the native exporter); original delivered.`);
          file = { uri: source, fileName: item.fileName, mimeType: mimeTypeFor(item) };
        }
        if (batch.destination === 'frameio') {
          if (!batch.project) throw new Error('Choose a Frame.io project first.');
          const key = `${item.id}/${item.fileName}/${item.sizeBytes}`;
          if (!prefs.frameioReupload && useMediaPreferences.getState().frameioUploaded.includes(key)) {
            notes.push(`${item.fileName}: already on Frame.io, skipped.`);
          } else {
            update(batch.id, { stage: 'uploading', clipFraction: 0.01 });
            const client = batch.demo ? sharedDemoFrameioClient() : frameioClient(false);
            await client.upload(
              batch.project,
              { uri: file.uri, fileName: file.fileName, sizeBytes: item.sizeBytes, mimeType: file.mimeType },
              (f) => update(batch.id, { clipFraction: Math.max(0.01, f) }),
              signal,
            );
            useMediaPreferences.getState().markUploaded(key);
          }
        }
        files.push(file);
        update(batch.id, { clipFraction: 1, notes: [...notes] });
      }
      if (isCancelled()) throw new CancelledError();
      let message: string;
      if (batch.destination === 'share') {
        update(batch.id, { stage: 'sharing' });
        await deliveryPlatform.share(files);
        message = files.length === 1 ? 'Shared 1 item' : `Shared ${files.length} items`;
      } else if (batch.destination === 'photos') {
        update(batch.id, { stage: 'saving' });
        const saved = await deliveryPlatform.saveToPhotos(files, () => update(batch.id, { stage: 'awaitingPhotosAccess' }));
        message = deliveryPlatform.photosTitle === 'Download' ? `Downloaded ${saved} item${saved === 1 ? '' : 's'}` : `Saved ${saved} to Photos`;
      } else {
        message = `Uploaded to ${batch.project?.name ?? 'Frame.io'}`;
      }
      if (!prefs.keepOriginals) {
        for (const uri of downloaded) await deliveryPlatform.discard(uri);
        batch.items.forEach((i) => useMediaLibrary.getState().forgetLocal(i.id));
      }
      update(batch.id, { status: 'done', message, notes, clipIndex: batch.items.length, clipFraction: 1 });
    } catch (e) {
      if (e instanceof CancelledError || isCancelled()) update(batch.id, { status: 'cancelled', notes });
      else update(batch.id, { status: 'failed', message: (e as Error).message || 'Delivery failed.', notes });
    } finally {
      cancelled.delete(batch.id);
    }
  };

  return {
    batches: [],
    panelOpen: false,
    enqueue: (service, request) => {
      const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      services.set(id, service);
      const batch: DeliveryBatch = {
        id,
        destination: request.destination,
        items: request.items,
        totalBytes: request.items.reduce((n, i) => n + i.sizeBytes, 0),
        options: request.options,
        project: request.project,
        demo: request.demo,
        createdAt: Date.now(),
        status: 'queued',
        stage: 'queued',
        clipIndex: 0,
        clipFraction: 0,
        filename: null,
        transferRate: null,
        message: null,
        notes: [],
      };
      set((s) => ({ batches: [...s.batches.slice(-19), batch] }));
      void runNext();
      return id;
    },
    cancel: (id) => {
      const b = get().batches.find((x) => x.id === id);
      if (!b) return;
      if (b.status === 'queued') {
        patch(id, { status: 'cancelled' });
        services.delete(id);
      } else if (b.status === 'running') cancelled.add(id);
    },
    clearFinished: () => set((s) => ({ batches: s.batches.filter((b) => b.status === 'queued' || b.status === 'running') })),
    setPanelOpen: (panelOpen) => set({ panelOpen }),
  };
});

class CancelledError extends Error {}

export function activeBatch(batches: DeliveryBatch[]): DeliveryBatch | undefined {
  return batches.find((b) => b.status === 'running') ?? batches.find((b) => b.status === 'queued');
}
