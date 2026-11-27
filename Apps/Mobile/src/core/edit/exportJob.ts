/**
 * Export job state: fetch the source (download the original when it is not on the phone),
 * render, save to the photo library. A pure reducer so the sheet, the progress pill and tests
 * agree on what each phase means.
 */
import type { ExportQuality } from './plan';

export type ExportPhase = 'idle' | 'downloading' | 'rendering' | 'saving' | 'done' | 'failed' | 'cancelled';

export interface ExportJobState {
  id: string | null;
  itemId: string | null;
  quality: ExportQuality;
  phase: ExportPhase;
  /** 0…1 inside the current phase. */
  fraction: number;
  /** Whether this job had to download its source (weights the overall bar). */
  downloads: boolean;
  error: string | null;
  /** The rendered file once saved. */
  outputUri: string | null;
}

export type ExportAction =
  | { type: 'start'; id: string; itemId: string; quality: ExportQuality; needsDownload: boolean }
  | { type: 'download'; fraction: number }
  | { type: 'render'; fraction: number }
  | { type: 'saving' }
  | { type: 'done'; outputUri: string }
  | { type: 'fail'; error: string }
  | { type: 'cancel' }
  | { type: 'dismiss' };

export const idleExport = (): ExportJobState => ({
  id: null,
  itemId: null,
  quality: 'original',
  phase: 'idle',
  fraction: 0,
  downloads: false,
  error: null,
  outputUri: null,
});

export const exportRunning = (s: ExportJobState) => s.phase === 'downloading' || s.phase === 'rendering' || s.phase === 'saving';

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function exportReducer(s: ExportJobState, a: ExportAction): ExportJobState {
  switch (a.type) {
    case 'start':
      if (exportRunning(s)) return s;
      return {
        ...idleExport(),
        id: a.id,
        itemId: a.itemId,
        quality: a.quality,
        downloads: a.needsDownload,
        phase: a.needsDownload ? 'downloading' : 'rendering',
      };
    case 'download':
      return s.phase === 'downloading' ? { ...s, fraction: Math.max(s.fraction, clamp01(a.fraction)) } : s;
    case 'render':
      if (s.phase === 'downloading') return { ...s, phase: 'rendering', fraction: clamp01(a.fraction) };
      return s.phase === 'rendering' ? { ...s, fraction: Math.max(s.fraction, clamp01(a.fraction)) } : s;
    case 'saving':
      return s.phase === 'rendering' || s.phase === 'downloading' ? { ...s, phase: 'saving', fraction: 0 } : s;
    case 'done':
      return exportRunning(s) ? { ...s, phase: 'done', fraction: 1, outputUri: a.outputUri } : s;
    case 'fail':
      return exportRunning(s) ? { ...s, phase: 'failed', error: a.error } : s;
    case 'cancel':
      return exportRunning(s) ? { ...s, phase: 'cancelled' } : s;
    case 'dismiss':
      return exportRunning(s) ? s : idleExport();
  }
}

/** Overall progress 0…1: download 40 %, render 55 %, save 5 % (no download: render 95 %). */
export function exportOverall(s: ExportJobState): number {
  const dl = s.downloads ? 0.4 : 0;
  const render = s.downloads ? 0.55 : 0.95;
  switch (s.phase) {
    case 'idle':
    case 'cancelled':
    case 'failed':
      return 0;
    case 'downloading':
      return dl * s.fraction;
    case 'rendering':
      return dl + render * s.fraction;
    case 'saving':
      return dl + render + 0.05 * s.fraction;
    case 'done':
      return 1;
  }
}

/** Short status line. */
export function exportLabel(s: ExportJobState): string {
  const pct = `${Math.round(s.fraction * 100)}%`;
  switch (s.phase) {
    case 'idle':
      return '';
    case 'downloading':
      return `Downloading original ${pct}`;
    case 'rendering':
      return `Exporting ${pct}`;
    case 'saving':
      return 'Saving to library';
    case 'done':
      return 'Saved to library';
    case 'failed':
      return s.error ?? 'Export failed';
    case 'cancelled':
      return 'Export cancelled';
  }
}
