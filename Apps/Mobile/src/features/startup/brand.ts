/**
 * Pocket Monitor launch identity (`AppBrand` / `MonitorBrandIdentity`).
 * Values only; the splash, the Cameras header and Settings › About read them.
 */
export const appBrand = {
  name: 'Pocket Monitor',
  monogram: 'PM',
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
    logoSize: Math.min(width * (landscape ? 0.16 : 0.28), compact ? 72 : 88),
    wordmarkSize: landscape ? (compact ? 26 : 30) : 28,
    spacing: landscape ? Math.max(24, width * 0.04) : 20,
    horizontalInset: landscape ? Math.max(32, width * 0.08) : 0,
  };
}
