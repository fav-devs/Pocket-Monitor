import { colors } from '@/theme';

/**
 * Pocket Monitor launch identity (`AppBrand` / `MonitorBrandIdentity`): DJI Sky Blue on black.
 * Values only; the splash and page headings read them.
 */
export const appBrand = {
  name: 'Pocket Monitor',
  monogram: 'PM',
  accent: colors.accent,
  glow: colors.accentGlow,
  supportUrl: 'https://github.com/fav-devs/Pocket-Monitor/issues',
  sourceUrl: 'https://github.com/fav-devs/Pocket-Monitor',
} as const;

/** Cold-start launch timing shared by the splash (`MonitorLaunchTiming`). */
export const launchTiming = {
  visibleMs: 2250,
  fadeOutMs: 350,
} as const;

/** Launch layout mechanics (`MonitorLaunchLayout`). */
export function launchLayout(width: number, height: number, compact = false) {
  const landscape = width >= height;
  return {
    landscape,
    logoSize: Math.min(width * (landscape ? 0.16 : 0.28), compact ? 72 : 96),
    wordmarkSize: landscape ? (compact ? 28 : 34) : 30,
    spacing: landscape ? Math.max(32, width * 0.06) : 24,
    horizontalInset: landscape ? Math.max(32, width * 0.08) : 0,
  };
}
