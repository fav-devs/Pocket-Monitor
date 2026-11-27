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
