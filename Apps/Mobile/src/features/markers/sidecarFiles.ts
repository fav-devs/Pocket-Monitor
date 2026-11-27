/**
 * Sidecar and export files on phones (expo-file-system, expo-sharing). Web and the desktop app:
 * `sidecarFiles.web.ts`.
 *
 * - Beside a downloaded original (`<clip basename>.pocketmeta.json` in the same folder).
 * - In the app's library folder (`Documents/Sidecars/`), which keeps a copy for clips that left
 *   the app (saved to Photos, exported from the editor, the original cache cleared).
 * - In the cache, to hand to the share sheet with the clip.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { sidecarPathBeside } from '@/core/markers';

export interface SharedFile {
  uri: string;
  fileName: string;
  mimeType: string;
}

function write(file: File, text: string) {
  if (file.exists) file.delete();
  file.create({ overwrite: true });
  file.write(text);
}

/** Writes the sidecar beside a local clip file. False when the folder is not ours to write. */
export async function writeSidecarBeside(_itemId: string, localUri: string, json: string): Promise<boolean> {
  if (!localUri || !/^file:/.test(localUri)) return false;
  try {
    write(new File(sidecarPathBeside(localUri)), json);
    return true;
  } catch {
    return false;
  }
}

function libraryFolder(): Directory {
  const dir = new Directory(Paths.document, 'Sidecars');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Keeps a copy in the app's library folder. */
export async function writeLibrarySidecar(fileName: string, json: string): Promise<void> {
  try {
    write(new File(libraryFolder(), fileName), json);
  } catch {
    // The library copy is a convenience; the metadata itself is in app storage.
  }
}

/** A sidecar file in the cache to share with its clip. */
export async function sidecarShareFile(fileName: string, json: string): Promise<SharedFile> {
  const file = new File(Paths.cache, fileName);
  write(file, json);
  return { uri: file.uri, fileName, mimeType: 'application/json' };
}

/** Hands an export (FCPXML, EDL, CSV) to the share sheet. Returns a notice line. */
export async function saveExport(fileName: string, text: string, mimeType: string): Promise<string> {
  const file = new File(Paths.cache, fileName);
  write(file, text);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName });
  return 'Markers exported';
}

/** Reads a sidecar beside a local clip, when there is one (import on download). */
export async function readSidecarBeside(localUri: string): Promise<string | null> {
  if (!localUri || !/^file:/.test(localUri)) return null;
  try {
    const f = new File(sidecarPathBeside(localUri));
    return f.exists ? await f.text() : null;
  } catch {
    return null;
  }
}
