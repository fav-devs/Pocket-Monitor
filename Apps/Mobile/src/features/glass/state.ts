/**
 * Glass in the desktop app's wide layout: which window material is behind the sidebar and how
 * the shell's controls (toolbar buttons, the selected sidebar item, status cards) are drawn.
 * Pure (no React, no DOM) so the rules are tested. `docs/desktop-expo-port.md` §5.14.
 *
 * - `native`: macOS 26+ draws the controls on real `NSGlassEffectView`s under the web view; the
 *   web draws their backgrounds transparent. Elsewhere it falls back to the web glass.
 * - `web`: CSS glass (`backdrop-filter`), the same look in WKWebView and WebView2.
 * - `off`: today's flat look, no window material.
 */

import { SETTINGS_LIST_WIDTH, SIDEBAR_WIDTH } from '@/constants/wide';

export type GlassMode = 'native' | 'web' | 'off';

/** What the desktop reports (`glass_caps`): `vibrancy` on macOS, `mica` on Windows 11. */
export type MaterialKind = 'vibrancy' | 'mica' | 'none';

export interface GlassCaps {
  material: MaterialKind;
  /** Native `NSGlassEffectView` controls (macOS 26+). */
  glassControls: boolean;
  /** The web preview (`?glassPreview=1`): a fake desktop behind a simulated material. */
  preview?: boolean;
}

export type ControlGlass = 'native' | 'css' | 'none';

export interface GlassResolution {
  /** The sidebar (and the settings column) are drawn translucent over a native material. */
  material: boolean;
  /** How glass controls draw. */
  controls: ControlGlass;
}

export const flatGlass: GlassResolution = { material: false, controls: 'none' };

/** The choice a fresh install starts with: native where this machine has it. */
export function defaultGlassMode(caps: GlassCaps | null): GlassMode {
  return caps?.glassControls ? 'native' : 'web';
}

/** The setting's options; Native is offered only where it exists. */
export function glassModeOptions(caps: GlassCaps | null): { value: GlassMode; label: string }[] {
  const options: { value: GlassMode; label: string }[] = [];
  if (caps?.glassControls) options.push({ value: 'native', label: 'Native' });
  options.push({ value: 'web', label: 'Web' }, { value: 'off', label: 'Off' });
  return options;
}

export interface GlassInputs {
  /** Null outside the desktop app (phones, tablets, a plain browser): nothing changes there. */
  caps: GlassCaps | null;
  /** The operator's choice; undefined is the default for this machine. */
  mode: GlassMode | undefined;
  /** The wide layout's shell (sidebar) is on screen; false on full-bleed picture pages. */
  shell: boolean;
  /** `prefers-reduced-transparency: reduce`: solid surfaces, no material. */
  reducedTransparency: boolean;
  /** A live picture hole is on screen inside the shell (the watcher's picture). */
  pictureOnScreen: boolean;
}

export function resolveGlass({ caps, mode, shell, reducedTransparency, pictureOnScreen }: GlassInputs): GlassResolution {
  if (!caps || !shell || reducedTransparency) return flatGlass;
  const chosen = mode ?? defaultGlassMode(caps);
  if (chosen === 'off') return flatGlass;
  // Windows: Mica shows only where the picture's child window has slid off the sidebar, which
  // it must not do while a picture is on screen; the sidebar stays solid then.
  const material = caps.material !== 'none' && !(caps.material === 'mica' && pictureOnScreen);
  const controls: ControlGlass = chosen === 'native' && caps.glassControls ? 'native' : 'css';
  return { material, controls };
}

/** How far from the window's leading edge the material shows: the sidebar, plus Settings' list. */
export function materialStripWidth(settingsSplit: boolean): number {
  return SIDEBAR_WIDTH + (settingsSplit ? SETTINGS_LIST_WIDTH : 0);
}

/** `?glassPreview=1` (web only): caps for the preview, or null. `=native` previews the rect sync. */
export function previewCaps(search: string): GlassCaps | null {
  const match = /(?:^|[?&])glassPreview=([^&]*)/.exec(search);
  if (!match) return null;
  const value = decodeURIComponent(match[1] ?? '');
  if (value === '0' || value === 'false') return null;
  return { material: 'vibrancy', glassControls: value === 'native', preview: true };
}

/** Reads `glass_caps`' answer leniently (an older desktop build answers nothing). */
export function parseCaps(raw: unknown): GlassCaps {
  const value = (raw ?? {}) as { material?: unknown; glassControls?: unknown };
  const material: MaterialKind = value.material === 'vibrancy' || value.material === 'mica' ? value.material : 'none';
  return { material, glassControls: value.glassControls === true };
}
