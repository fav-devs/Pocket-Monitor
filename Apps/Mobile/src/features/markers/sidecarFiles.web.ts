/**
 * Sidecar and export files on web and in the desktop app (one web bundle). Phones:
 * `sidecarFiles.ts`.
 *
 * - Desktop app: Rust writes the sidecar beside the cached original (`media_sidecar`, which
 *   also writes it when a download that is still running lands) and saves exports to
 *   `Videos/Pocket Monitor/Markers` (`markers_save`).
 * - Browser: there is no file system; sidecars and exports are browser downloads, and the app's
 *   storage (localStorage) is the library copy.
 */
import { invoke, isTauri } from '@/camera/desktop/tauri';

export interface SharedFile {
  uri: string;
  fileName: string;
  mimeType: string;
}

export async function writeSidecarBeside(itemId: string, _localUri: string, json: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('media_sidecar', { id: itemId, json });
    return true;
  } catch {
    return false;
  }
}

export async function writeLibrarySidecar(_fileName: string, _json: string): Promise<void> {}

export async function sidecarShareFile(fileName: string, json: string): Promise<SharedFile> {
  return { uri: `data:application/json;charset=utf-8,${encodeURIComponent(json)}`, fileName, mimeType: 'application/json' };
}

function download(fileName: string, text: string, mimeType: string) {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function saveExport(fileName: string, text: string, mimeType: string): Promise<string> {
  if (isTauri()) {
    const path = await invoke<string>('markers_save', { fileName, contents: text });
    const name = path.split(/[\\/]/).pop() ?? fileName;
    return `Saved ${name} to Videos`;
  }
  download(fileName, text, mimeType);
  return 'Markers downloaded';
}

export async function readSidecarBeside(_localUri: string): Promise<string | null> {
  return null;
}
