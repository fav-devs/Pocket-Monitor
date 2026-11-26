import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { LiveInputActions } from './actions';
import { postDrive, releaseDrive } from './gimbalDrive';

/** Arrow keys pan/tilt at this share of full throw (keyboard has no analog depth). */
const KEY_THROW = 0.6;
const KEY_ZOOM_RATE = 0.6;

/**
 * Web keyboard controls (README "Keyboard controls"):
 * Space/R record · S still · arrows pan/tilt (combine for diagonals) · C recenter ·
 * +/- zoom · 0 wide · F selfie flip · V cycle gimbal mode · X stop tracking ·
 * [ / ] step resolution / frame rate · G gallery · Z P L M zebra/peaking/cube/mirror ·
 * H hide chrome · Esc close the viewfinder.
 */
export function useKeyboardShortcuts(actions: LiveInputActions, enabled: boolean) {
  const ref = useRef(actions);
  ref.current = actions;

  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled || typeof window === 'undefined') return;
    const arrows = new Set<string>();
    let zoomKey: string | null = null;

    const pushArrows = () => {
      const x = (arrows.has('ArrowRight') ? 1 : 0) - (arrows.has('ArrowLeft') ? 1 : 0);
      const y = (arrows.has('ArrowUp') ? 1 : 0) - (arrows.has('ArrowDown') ? 1 : 0);
      if (x === 0 && y === 0) releaseDrive('keyboard');
      else postDrive('keyboard', x * KEY_THROW, y * KEY_THROW);
    };

    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    };

    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const a = ref.current;
      const k = e.key;
      if (k.startsWith('Arrow')) {
        e.preventDefault();
        if (!arrows.has(k)) {
          arrows.add(k);
          pushArrows();
        }
        return;
      }
      if (e.repeat) {
        if (k === ' ') e.preventDefault();
        return;
      }
      switch (k) {
        case ' ':
        case 'r':
        case 'R':
          e.preventDefault();
          a.toggleRecord();
          break;
        case 's':
        case 'S':
          a.capturePhoto();
          break;
        case 'c':
        case 'C':
          a.recenter();
          break;
        case '+':
        case '=':
          zoomKey = k;
          a.zoomRate(KEY_ZOOM_RATE);
          break;
        case '-':
        case '_':
          zoomKey = k;
          a.zoomRate(-KEY_ZOOM_RATE);
          break;
        case '0':
          a.zoomWide();
          break;
        case 'f':
        case 'F':
          a.flip();
          break;
        case 'v':
        case 'V':
          a.cycleGimbalMode();
          break;
        case 'x':
        case 'X':
          a.stopTracking();
          break;
        case '[':
          a.stepResolution(1);
          break;
        case ']':
          a.stepFrameRate(1);
          break;
        case 'g':
        case 'G':
          a.openGallery();
          break;
        case 'z':
        case 'Z':
          a.toggleAssist('zebra');
          break;
        case 'p':
        case 'P':
          a.toggleAssist('peaking');
          break;
        case 'l':
        case 'L':
          a.toggleAssist('lut');
          break;
        case 'm':
        case 'M':
          a.toggleAssist('mirror');
          break;
        case 'h':
        case 'H':
          a.toggleChrome();
          break;
        case 'Escape':
          a.closeViewfinder();
          break;
      }
    };

    const up = (e: KeyboardEvent) => {
      if (e.key.startsWith('Arrow')) {
        arrows.delete(e.key);
        pushArrows();
        return;
      }
      if (zoomKey && (e.key === zoomKey || ['+', '=', '-', '_'].includes(e.key))) {
        zoomKey = null;
        ref.current.zoomRate(0);
      }
    };

    const blur = () => {
      arrows.clear();
      releaseDrive('keyboard');
      if (zoomKey) {
        zoomKey = null;
        ref.current.zoomRate(0);
      }
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
  }, [enabled]);
}
