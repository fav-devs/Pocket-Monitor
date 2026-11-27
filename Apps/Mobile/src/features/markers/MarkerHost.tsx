/**
 * App-wide marker plumbing, mounted once in the root layout:
 * - follows REC on the session (takes and their clock, `capture.ts`);
 * - matches stopped takes with their camera files whenever the library lists, so markers,
 *   shoot and take land on the clip (and wait, persisted, until the file is listed);
 * - keeps each clip on this device's sidecar current beside the file and in the app's library
 *   folder (desktop: beside the cached original, through Rust);
 * - takes the desktop's Rust-side marker requests (the `M` key, the pad's Menu button, the
 *   "Add marker" gesture) as `input://marker`.
 */
import { useEffect } from 'react';
import { useCameraSession } from '@/camera';
import { isTauri, listen } from '@/camera/desktop/tauri';
import { type ClipIdentity, type MarkerSource, matchTakes, parseSidecar } from '@/core/markers';
import { useMediaLibrary } from '@/features/media/libraryStore';
import { identityOf, metaOf, useClipMeta } from '@/state/clipMeta';
import { phoneClipItem, useMediaPreferences, usePhoneMedia } from '@/state/media';
import { setMarkerHandler } from './bridge';
import { addMarker, trackRecording } from './capture';
import { hasMetadata, sidecarFileFor } from './sidecarFor';
import { readSidecarBeside, writeLibrarySidecar, writeSidecarBeside } from './sidecarFiles';

const written = new Map<string, string>();
const importTried = new Set<string>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

/** Writes the sidecars of clips on this device whose metadata changed since the last write. */
async function syncSidecars() {
  for (const clip of usePhoneMedia.getState().clips) {
    if (!clip.localUri) continue;
    const item = phoneClipItem(clip);
    if (!hasMetadata(item)) continue;
    const { fileName, json } = sidecarFileFor(item);
    // `writtenAt` changes every time; compare the rest.
    const body = json.replace(/"writtenAt": "[^"]*",?/, '');
    if (written.get(clip.id) === body) continue;
    const beside = await writeSidecarBeside(clip.id, clip.localUri, json);
    await writeLibrarySidecar(fileName, json);
    // The desktop writes through the camera's listing: try again later when it could not.
    if (beside || !isTauri()) written.set(clip.id, body);
  }
}

function scheduleSync() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void syncSidecars();
  }, 800);
}

/** A clip that arrived with a sidecar beside it (copied in from another device) takes its metadata. */
async function importBeside() {
  for (const clip of usePhoneMedia.getState().clips) {
    if (!clip.localUri || importTried.has(clip.id)) continue;
    importTried.add(clip.id);
    const item = phoneClipItem(clip);
    if (metaOf(useClipMeta.getState().clips, item)) continue;
    const text = await readSidecarBeside(clip.localUri);
    if (!text) continue;
    try {
      const parsed = parseSidecar(text);
      if (parsed.meta.identity.fileName.toUpperCase() !== item.fileName.toUpperCase()) continue;
      useClipMeta.getState().mergeImported(item, parsed.meta);
      if (parsed.rating && !useMediaPreferences.getState().ratings[item.id]) useMediaPreferences.getState().setRating(item.id, parsed.rating);
    } catch {
      // Not ours, or damaged: leave the clip as it is.
    }
  }
}

function runMatching(cameraId: string | null) {
  const lib = useMediaLibrary.getState();
  const meta = useClipMeta.getState();
  const waiting = meta.takes.filter((t) => t.stoppedAt != null);
  if (!waiting.length || lib.status !== 'ready' || !lib.items.length) return;
  const claimed = new Set<string>();
  for (const [id, m] of Object.entries(meta.clips)) if (m.take) claimed.add(id);
  const matches = matchTakes(waiting, lib.items, claimed, cameraId);
  if (!matches.length) return;
  const identities = new Map<string, ClipIdentity>();
  for (const m of matches) {
    const item = lib.items.find((i) => i.id === m.itemId);
    if (item) identities.set(item.id, identityOf(item));
  }
  meta.applyMatches(matches, identities);
}

export function MarkerHost() {
  const session = useCameraSession();

  useEffect(() => trackRecording(session), [session]);

  useEffect(() => {
    setMarkerHandler((source) => void addMarker(source));
    return () => setMarkerHandler(null);
  }, []);

  useEffect(() => {
    const cameraId = () => session.getState().identity?.id ?? null;
    const run = () => {
      if (useMediaLibrary.getState().service === session.media) runMatching(cameraId());
    };
    run();
    const a = useMediaLibrary.subscribe((s, prev) => {
      if (s.items !== prev.items || s.status !== prev.status) run();
    });
    const b = useClipMeta.subscribe((s, prev) => {
      if (s.takes !== prev.takes) run();
    });
    return () => {
      a();
      b();
    };
  }, [session]);

  useEffect(() => {
    scheduleSync();
    void importBeside();
    const a = useClipMeta.subscribe((s, prev) => {
      if (s.clips !== prev.clips || s.shoots !== prev.shoots) scheduleSync();
    });
    const b = usePhoneMedia.subscribe((s, prev) => {
      if (s.clips !== prev.clips) {
        scheduleSync();
        void importBeside();
      }
    });
    const c = useMediaPreferences.subscribe((s, prev) => {
      if (s.ratings !== prev.ratings) scheduleSync();
    });
    return () => {
      a();
      b();
      c();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    return listen<{ source?: MarkerSource }>('input://marker', (p) => {
      addMarker(p?.source ?? 'key');
    });
  }, []);

  return null;
}
