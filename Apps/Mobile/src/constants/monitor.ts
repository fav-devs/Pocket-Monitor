/**
 * Monitor-only colours that are not part of the Sondr theme (`theme.ts` is verbatim from Sondr and
 * is not edited here). Recording uses the logo's red, like field monitors and DJI Mimo; `dotPink`
 * stays the section-title dot only.
 */

/** Recording only: record button core, REC dot, recording border, Multiview tile REC, Live Activity. */
export const recordRed = '#e5273a';

/** The record ring while recording (ai-cut's 0.45 ring, recoloured). */
export const recordRedRing = 'rgba(229,39,58,0.45)';

/** A soft wash behind REC text on video. */
export const recordRedSoft = 'rgba(229,39,58,0.28)';

/** `recordRed` at any alpha. */
export function recordRedAlpha(alpha: number) {
  return `rgba(229,39,58,${alpha})`;
}

/**
 * The live view's letterbox strips (Mimo): solid black down each side of a landscape picture,
 * holding the chrome so the picture stays clean.
 */
export const monitorStrip = '#000000';

/**
 * The live view's docked panels (exposure, format, camera settings, gimbal, assists). The
 * monitor is dark whatever the app theme, so panels use these fixed values, not the theme.
 */
export const monitorPanel = {
  fill: 'rgba(20,20,20,0.92)',
  /** A row's hairline and a value button's outline. */
  hairline: 'rgba(255,255,255,0.09)',
  outline: 'rgba(255,255,255,0.78)',
  /** A cell or well inside the panel (resolution grid, segmented track). */
  well: 'rgba(255,255,255,0.07)',
  wellStrong: 'rgba(255,255,255,0.14)',
  text: '#ffffff',
  muted: 'rgba(255,255,255,0.56)',
  faint: 'rgba(255,255,255,0.3)',
  /** Text on a white (chosen) fill. */
  dark: '#111111',
  /** The chosen value in grids and drums, and switch tracks (the theme's primary). */
  chosen: '#17a9f3',
  switchOff: 'rgba(255,255,255,0.22)',
  radius: 12,
} as const;
