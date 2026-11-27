import { Platform } from 'react-native';
import { create } from 'zustand';
import { invoke, isTauri } from '@/camera/desktop/tauri';
import { parseCaps, previewCaps, type GlassCaps } from './state';
import { installPreviewBackdrop } from './styles';

/**
 * What the glass depends on outside React: the desktop's capabilities (asked once), the
 * system's reduced-transparency setting, and how many live picture holes are on screen.
 */
interface GlassEnv {
  /** Null until known, and always outside the desktop app (unless previewing). */
  caps: GlassCaps | null;
  reducedTransparency: boolean;
  pictureHoles: number;
}

export const useGlassEnv = create<GlassEnv>(() => ({ caps: null, reducedTransparency: false, pictureHoles: 0 }));

let booted = false;

/** Asks the desktop what it supports and starts following reduced transparency. Once. */
export function bootGlass() {
  if (booted || Platform.OS !== 'web' || typeof window === 'undefined') return;
  booted = true;
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-transparency: reduce)') : null;
  if (media) {
    useGlassEnv.setState({ reducedTransparency: media.matches });
    media.addEventListener?.('change', (e) => useGlassEnv.setState({ reducedTransparency: e.matches }));
  }
  const preview = previewCaps(window.location?.search ?? '');
  if (preview && !isTauri()) {
    installPreviewBackdrop();
    useGlassEnv.setState({ caps: preview });
    return;
  }
  if (!isTauri()) return;
  invoke('glass_caps')
    .then((raw) => useGlassEnv.setState({ caps: parseCaps(raw) }))
    // An older desktop build without the command: web glass, no material.
    .catch(() => useGlassEnv.setState({ caps: parseCaps(null) }));
}

/** `DesktopPictureHole` mounting (+1) and unmounting (−1). */
export function notePictureHole(delta: 1 | -1) {
  useGlassEnv.setState((s) => ({ pictureHoles: Math.max(0, s.pictureHoles + delta) }));
}
