import type { CameraMediaItem } from '../session';

/** Procedural thumbnail: an SVG gradient as a data URL, so the demo ships no footage. */
function thumb(hueA: number, hueB: number, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hueA},45%,38%)"/><stop offset="1" stop-color="hsl(${hueB},50%,14%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="210" cy="80" r="36" fill="hsla(${hueA + 30},60%,70%,0.35)"/><rect x="40" y="110" width="120" height="40" rx="6" fill="hsla(${hueB},30%,80%,0.18)"/><text x="16" y="28" font-family="sans-serif" font-size="14" fill="rgba(255,255,255,0.55)">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function demoMediaItems(): CameraMediaItem[] {
  const now = Date.now();
  const day = 86_400_000;
  const items: CameraMediaItem[] = [];
  const specs: [CameraMediaItem['kind'], number, number, number?, string?][] = [
    ['video', 200, 260, 48],
    ['video', 20, 340, 12],
    ['photo', 120, 200],
    ['video', 280, 30, 95],
    ['photo', 40, 10, undefined, 'burst-1'],
    ['photo', 45, 15, undefined, 'burst-1'],
    ['photo', 50, 20, undefined, 'burst-1'],
    ['video', 170, 230, 7],
    ['video', 330, 260, 31],
    ['photo', 90, 150],
    ['video', 10, 50, 240],
    ['photo', 210, 250],
  ];
  specs.forEach(([kind, a, b, dur, group], i) => {
    const n = String(i + 1).padStart(4, '0');
    items.push({
      id: `demo-${n}`,
      kind,
      fileName: `DJI_${n}.${kind === 'video' ? 'MP4' : 'JPG'}`,
      createdAt: now - i * (day / 3),
      durationSec: dur,
      sizeBytes: kind === 'video' ? (dur ?? 10) * 1_250_000 : 6_400_000,
      width: kind === 'video' ? 3840 : 4000,
      height: kind === 'video' ? 2160 : 3000,
      fps: kind === 'video' ? (i % 3 === 0 ? 60 : 30) : undefined,
      colorMode: i % 4 === 0 ? 'dlog-m' : 'normal',
      favorite: i % 5 === 1,
      groupId: group,
      thumbnailUrl: thumb(a, b, `DJI_${n}`),
    });
  });
  return items;
}
