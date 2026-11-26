/**
 * Field Monitor visual language (ported from OpenCine `MonitorTheme`).
 * Pages are solid; floating chrome uses translucent material.
 */
export const colors = {
  background: '#111213',
  canvas: '#08090A',
  surface: '#1A1B1C',
  raised: '#222425',
  accent: '#00A3E6',
  accentGlow: '#2D6FA0',
  onAccent: '#FFFFFF',
  text: '#FFFFFF',
  secondary: '#CFD4D4',
  muted: '#8D9293',
  faint: '#5E6262',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.16)',
  recording: '#D13034',
  digitalCrop: '#F0B23C',
  linkPoor: '#D13034',
  linkWatch: '#F5851F',
  linkStable: '#2EC76B',
  glass: 'rgba(17,18,19,0.62)',
  glassStrong: 'rgba(17,18,19,0.82)',
  scrim: 'rgba(0,0,0,0.55)',
  transparent: 'transparent',
} as const;

export type ColorToken = keyof typeof colors;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Every interactive control has at least a 44pt target even if it draws smaller. */
export const minTouch = 44;

export const fonts = {
  regular: 'Sora-Regular',
  medium: 'Sora-Medium',
  semibold: 'Sora-SemiBold',
  bold: 'Sora-Bold',
} as const;

export type FontWeight = keyof typeof fonts;

/** Motion constants (ported from `MonitorMotion`). */
export const motion = {
  pressOpacity: 0.72,
  pressScale: 0.96,
  quickMs: 140,
  standardMs: 220,
  slowMs: 360,
} as const;

export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export type LinkHealthBand = 'poor' | 'watch' | 'stable';

export function linkHealthColor(band: LinkHealthBand): string {
  switch (band) {
    case 'poor':
      return colors.linkPoor;
    case 'watch':
      return colors.linkWatch;
    case 'stable':
      return colors.linkStable;
  }
}
