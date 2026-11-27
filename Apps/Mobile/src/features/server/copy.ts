/** Server screen copy. Labels, not explanations. */
import type { ServerSetup } from '@/camera/server';

export const ServerScreenCopy = {
  title: 'Server',
  androidOnly: 'Server mode is Android-only.',
  start: 'Start server',
  stop: 'Stop server',
  camera: 'Camera',
  network: 'Network',
  status: 'Status',
  pairCamera: 'Pair a camera',
  setUpCamera: 'Set up camera',
  recommended: 'Recommended',
  notSetUp: 'Not set up',
  /** The one step Android cannot do for us. */
  hotspotStep: 'Turn on Hotspot in Settings first.',
  joinFirst: (ssid: string) => `Join ${ssid} on this phone first.`,
  rows: {
    link: 'Camera link',
    network: 'Network',
    watchers: 'Watchers',
    uptime: 'Uptime',
    phone: 'Phone',
  },
} as const;

export const SetupCopy: Record<ServerSetup, { title: string }> = {
  station: { title: 'Camera on your Wi-Fi' },
  dual: { title: 'Phone on both networks' },
  hotspot: { title: 'Phone hotspot' },
};

export function uptimeLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function phoneLabel(d: { batteryPercent: number | null; charging: boolean; thermal: string } | null): string {
  if (!d) return '—';
  const parts: string[] = [];
  if (d.batteryPercent != null) parts.push(`${Math.round(d.batteryPercent)}%`);
  if (d.charging) parts.push('Charging');
  const heat: Record<string, string> = { light: 'Warm', moderate: 'Hot', severe: 'Very hot', critical: 'Overheating', emergency: 'Overheating' };
  if (heat[d.thermal]) parts.push(heat[d.thermal]);
  return parts.join(' · ') || '—';
}
