import { useMemo } from 'react';
import type { CameraMediaItem } from '@/camera';
import { Sheet } from '@/components/sheet';
import { MARKER_SWATCH, markerTitle } from '@/core/markers';
import { metaKeyOf, useClipMeta, useClipMetaFor } from '@/state/clipMeta';
import { ClipMetaBody, MarkerEditSheet } from './MetaSheets';

/** The clip's markers as filmstrip pins. */
export function useMarkerPins(item: CameraMediaItem | undefined) {
  const meta = useClipMetaFor(item);
  return useMemo(
    () => (meta?.markers ?? []).map((m, i) => ({ id: m.id, time: m.time, color: MARKER_SWATCH[m.color], label: markerTitle(m, i) })),
    [meta?.markers],
  );
}

/**
 * Playback's metadata sheets: the Markers sheet (markers, tags, notes, shoot) and the marker
 * editor a long press on a filmstrip pin opens.
 */
export function PlaybackMetaSheets({
  item,
  position,
  onSeek,
  open,
  onClose,
  editId,
  onEditClose,
}: {
  item: CameraMediaItem;
  position: number;
  onSeek: (seconds: number) => void;
  open: boolean;
  onClose: () => void;
  editId: string | null;
  onEditClose: () => void;
}) {
  const meta = useClipMetaFor(item);
  const markers = meta?.markers ?? [];
  const index = markers.findIndex((m) => m.id === editId);
  const ref = () => ({ kind: 'clip' as const, itemId: metaKeyOf(useClipMeta.getState().clips, item) });
  return (
    <>
      <Sheet visible={open} title="Markers" onClose={onClose} passthrough>
        <ClipMetaBody item={item} position={position} onSeek={onSeek} />
      </Sheet>
      <MarkerEditSheet
        visible={editId != null && index >= 0}
        marker={index >= 0 ? markers[index] : null}
        index={Math.max(0, index)}
        onClose={onEditClose}
        onChange={(patch) => editId && useClipMeta.getState().updateMarker(ref(), editId, patch)}
        onDelete={() => editId && useClipMeta.getState().removeMarker(ref(), editId)}
      />
    </>
  );
}
