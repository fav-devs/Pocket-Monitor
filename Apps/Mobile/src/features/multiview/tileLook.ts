import { useMemo } from 'react';
import { useCamera } from '@/camera';
import type { TileLook } from '@/camera/multiview/types';
import { ASSIST_TOOLS, derivePictureEffects, useAssists, type AssistOptions, type AssistTool } from '@/state/assists';
import type { PictureEffects } from '@modules/pocket-native/src/types';

const allOff = () => Object.fromEntries(ASSIST_TOOLS.map((t) => [t, false])) as Record<AssistTool, boolean>;

/**
 * One tile's picture effects: its own look (LUT on/off and choice, peaking, zebra, false colour,
 * mono) over the app's assist options, against that camera's colour mode and ISO (Auto LUT
 * follows each camera's own source). Pure, shared by the hook and tests.
 */
export function tileEffects(look: TileLook, options: AssistOptions, colorMode: Parameters<typeof derivePictureEffects>[0]['colorMode'], iso: number | null | undefined): PictureEffects {
  const on = { ...allOff(), LUT: look.lut, PEAK: look.peaking, ZEBRA: look.zebra, FALSE: look.falseColor };
  const effects = derivePictureEffects({ on, options: { ...options, lut: { ...options.lut, selection: look.selection } }, colorMode, iso });
  return { ...effects, monochrome: look.mono || effects.monochrome };
}

/** Effects for the tile whose session is in scope (`CameraSessionScope`). */
export function useTileEffects(look: TileLook): PictureEffects {
  const options = useAssists((s) => s.options);
  const colorMode = useCamera((s) => s.format.colorMode);
  const iso = useCamera((s) => s.exposure.iso);
  return useMemo(() => tileEffects(look, options, colorMode, iso), [look, options, colorMode, iso]);
}

/** Short tile badge for a look that changes the picture (null for a plain Auto LUT). */
export function lookBadge(look: TileLook): string | null {
  const parts: string[] = [];
  if (look.lut && look.selection !== 'auto') parts.push(look.selection.startsWith('look:') ? look.selection.slice(5) : 'LUT');
  if (!look.lut) parts.push('LUT off');
  if (look.peaking) parts.push('Peak');
  if (look.zebra) parts.push('Zebra');
  if (look.falseColor) parts.push('False');
  if (look.mono) parts.push('Mono');
  return parts.length ? parts.join(' · ') : null;
}
