import { router } from 'expo-router';
import { toggleHandView } from '@/camera/desktop/gestures';
import { controlKey, type DesktopKeyAction } from '@/camera/desktop/input';
import { invoke } from '@/camera/desktop/tauri';
import { useLiveUi } from '@/features/live/liveUiStore';
import type { LiveInputActions } from './actions';

/** Held arrows are repeated to Rust this often; it rests the gimbal after 250 ms of silence. */
export const KEY_HEARTBEAT_MS = 100;

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
/** Keys the web view would otherwise act on itself (focus, scroll, browser fullscreen). */
const SWALLOW = new Set([' ', 'Tab', 'F11', ...ARROWS]);
/** Every key the desktop viewfinder listens for (`pm_controller::keys`). */
const DESKTOP_KEYS = new Set([
  ' ', 'Escape', 'Tab', 'F11', ...ARROWS,
  'r', 't', 's', 'c', '+', '=', '-', '_', '0', 'f', 'v', 'g', 'x', '[', ']', 'h', 'e', 'k', 'a', 'z', 'p', 'l', 'm',
  'j', 'y', '1', '2', '3', '4', '5', '6',
]);

export function isDesktopKey(key: string): boolean {
  return DESKTOP_KEYS.has(key.length === 1 ? key.toLowerCase() : key);
}

/** Carries out the web's part of a key Rust routed back. */
export function runDesktopKeyAction(action: DesktopKeyAction, a: LiveInputActions) {
  const ui = useLiveUi.getState();
  switch (action) {
    case 'toggle-settings': {
      const here = typeof window !== 'undefined' ? window.location?.pathname ?? '' : '';
      if (here.endsWith('/settings')) router.back();
      else router.push('/settings');
      break;
    }
    case 'toggle-exposure':
      ui.set({ captureSheet: ui.captureSheet === 'exposure' ? null : 'exposure', gimbalPanel: 'none', zoomDialOpen: false });
      break;
    case 'toggle-moves':
      ui.set({ gimbalPanel: ui.gimbalPanel === 'editor' ? 'none' : 'editor', captureSheet: null, zoomDialOpen: false });
      break;
    case 'toggle-assists':
      ui.set({ captureSheet: ui.captureSheet === 'assists' ? null : 'assists', gimbalPanel: 'none', zoomDialOpen: false });
      break;
    case 'toggle-zebra':
      a.toggleAssist('zebra');
      break;
    case 'toggle-peaking':
      a.toggleAssist('peaking');
      break;
    case 'toggle-grade':
      a.toggleAssist('lut');
      break;
    case 'toggle-mirror':
      a.toggleAssist('mirror');
      break;
    case 'toggle-chrome':
      a.toggleChrome();
      break;
    case 'library':
      a.openGallery();
      break;
    case 'still':
      // The desktop's S is a graded PNG of the picture (the render thread's still).
      invoke('still_capture').catch(() => a.notice('Still not available', 'warning'));
      break;
    case 'escape':
      a.closeViewfinder();
      break;
    case 'fullscreen':
      // Already toggled in Rust.
      break;
    case 'toggle-hand-view':
      toggleHandView();
      break;
    case 'toggle-gestures':
      // Switched and saved in Rust; `gestures://state` and a notice follow.
      break;
  }
}

/**
 * The desktop keyboard (§1.R): every key goes to Rust (`control_key`), which keeps the desktop
 * semantics — Space starts, R stops, +/- step the body's stops, T counts down, 1–6 recall
 * presets, arrows are a held stick. Rust hands back what the web should do for the rest.
 * Held arrows get a 100 ms heartbeat; blur releases them (Rust also rests on focus loss).
 */
export function attachDesktopKeys(getActions: () => LiveInputActions): () => void {
  const held = new Set<string>();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  };

  const beat = () => {
    if (held.size === 0) {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      return;
    }
    const [first] = held;
    void controlKey(first, true, true);
  };

  const down = (e: KeyboardEvent) => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (!isDesktopKey(k)) return;
    if (SWALLOW.has(k)) e.preventDefault();
    if (ARROWS.has(k)) {
      if (held.has(k)) return;
      held.add(k);
      void controlKey(k, true);
      if (!heartbeat) heartbeat = setInterval(beat, KEY_HEARTBEAT_MS);
      return;
    }
    if (e.repeat) return;
    void controlKey(k, true).then((action) => {
      if (action) runDesktopKeyAction(action, getActions());
    });
  };

  const up = (e: KeyboardEvent) => {
    if (!ARROWS.has(e.key)) return;
    if (held.delete(e.key)) void controlKey(e.key, false);
    if (held.size === 0) beat();
  };

  const blur = () => {
    held.forEach((k) => void controlKey(k, false));
    held.clear();
    beat();
  };

  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
    blur();
  };
}
