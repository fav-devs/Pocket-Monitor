/**
 * Keeps the library store in step with the desktop listing (§1.U U5): every page Rust decodes,
 * and every star or delete it carries out, arrives as `media://list` and replaces the store's
 * items, so the grid fills in as the card is walked. A no-op outside the desktop app.
 */
import { useEffect } from 'react';
import { useCameraSession } from '@/camera';
import { isDesktopMedia, type DesktopMediaList } from '@/camera/desktop/media';
import { useMediaLibrary } from '../libraryStore';

export function applyDesktopList(list: DesktopMediaList) {
  const store = useMediaLibrary.getState();
  const ids = new Set(list.items.map((i) => i.id));
  useMediaLibrary.setState({
    items: list.items,
    status: list.items.length || !list.listing ? (list.items.length || !list.status ? 'ready' : 'error') : store.status,
    error: !list.items.length && !list.listing && list.status ? list.status : null,
    refreshing: list.listing && list.items.length > 0,
    selected: store.selected.filter((id) => ids.has(id)),
  });
}

export function useDesktopMediaSync() {
  const session = useCameraSession();
  const service = session.media;
  useEffect(() => {
    if (!isDesktopMedia(service)) return;
    return service.subscribeList((list) => {
      // Only while the store lists this session's media.
      if (useMediaLibrary.getState().service !== service) return;
      applyDesktopList(list);
    });
  }, [service]);
}
