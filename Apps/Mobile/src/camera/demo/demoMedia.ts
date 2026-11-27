import type { CameraMediaItem } from '../session';

/**
 * Procedural pictures for the demo camera, so the demo ships no footage: an SVG sketch of the
 * demo "studio" scene (`features/picture/web/shaders.ts` `studio()`): a warm-to-cool wall with
 * practical bokeh, a window, a colour checker, the subject and the orange ball on the table.
 * `t` moves the light sweep, the subject's sway and the ball, as the live picture does, so
 * filmstrip frames along a clip differ the way frames of a real take would.
 */
export interface DemoLook {
  /** Wall tint, degrees of hue rotation from the studio's warm brown. */
  hue: number;
  /** Camera pan, in picture heights (−0.3 … 0.3). */
  pan: number;
  /** Exposure: 0.6 (dark) … 1.3 (bright). */
  exposure: number;
  /** Lens zoom around the subject's face: 1 (wide) … 2.2 (close-up). */
  zoom: number;
  /** Photo frames are 4:3 crops. */
  aspect: '16:9' | '4:3';
}

const H = 180;
const W = 320;
const A = 16 / 9;

function rgb(r: number, g: number, b: number, k = 1): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255 * k)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

const CHECKER: [number, number, number][] = [
  [0.45, 0.32, 0.26], [0.76, 0.58, 0.5], [0.36, 0.48, 0.61], [0.35, 0.42, 0.26], [0.51, 0.5, 0.69], [0.4, 0.74, 0.67],
  [0.84, 0.48, 0.17], [0.29, 0.36, 0.65], [0.76, 0.33, 0.38], [0.36, 0.24, 0.42], [0.62, 0.74, 0.25], [0.88, 0.63, 0.18],
  [0.2, 0.24, 0.59], [0.27, 0.58, 0.29], [0.69, 0.19, 0.22], [0.93, 0.78, 0.13], [0.73, 0.33, 0.58], [0.0, 0.52, 0.63],
  [0.95, 0.95, 0.94], [0.78, 0.78, 0.78], [0.62, 0.62, 0.62], [0.47, 0.47, 0.47], [0.33, 0.33, 0.33], [0.2, 0.2, 0.2],
];

/** One frame of the studio scene at `t` seconds, as SVG markup. */
export function studioSvg(t: number, look: DemoLook): string {
  const k = look.exposure;
  const X = (qx: number) => ((qx - look.pan) / A + 0.5) * W;
  const Y = (qy: number) => (qy + 0.5) * H;
  const R = (r: number) => r * H;
  const parts: string[] = [];
  const sweep = X(0.9 * Math.sin(t * 0.21));
  parts.push(
    `<defs>`,
    `<linearGradient id="wall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="hsl(${26 + look.hue},24%,${Math.round(26 * k)}%)"/><stop offset="1" stop-color="hsl(${212 + look.hue / 2},22%,${Math.round(15 * k)}%)"/></linearGradient>`,
    `<radialGradient id="key" cx="0.2" cy="0.25" r="0.6"><stop offset="0" stop-color="rgba(255,214,170,${0.45 * k})"/><stop offset="1" stop-color="rgba(255,214,170,0)"/></radialGradient>`,
    `<radialGradient id="sweep"><stop offset="0" stop-color="rgba(255,226,190,${0.3 * k})"/><stop offset="1" stop-color="rgba(255,226,190,0)"/></radialGradient>`,
    `<radialGradient id="bokeh"><stop offset="0" stop-color="rgba(255,236,200,1)"/><stop offset="0.55" stop-color="rgba(255,206,140,0.9)"/><stop offset="1" stop-color="rgba(255,180,100,0)"/></radialGradient>`,
    `<radialGradient id="skin" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="${rgb(0.78, 0.56, 0.44, k)}"/><stop offset="1" stop-color="${rgb(0.42, 0.28, 0.21, k)}"/></radialGradient>`,
    `<radialGradient id="ball" cx="0.35" cy="0.3" r="0.7"><stop offset="0" stop-color="${rgb(1, 0.75, 0.45, k)}"/><stop offset="0.4" stop-color="${rgb(0.86, 0.32, 0.06, k)}"/><stop offset="1" stop-color="${rgb(0.35, 0.1, 0.02, k)}"/></radialGradient>`,
    `<linearGradient id="shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(0,0,0,0.75)"/><stop offset="0.45" stop-color="rgba(0,0,0,0)"/></linearGradient>`,
    `</defs>`,
    `<rect width="${W}" height="${H}" fill="url(#wall)"/>`,
    `<rect width="${W}" height="${H}" fill="url(#key)"/>`,
    `<ellipse cx="${sweep}" cy="${Y(-0.15)}" rx="${R(0.35)}" ry="${R(0.6)}" fill="url(#sweep)"/>`,
  );
  for (let i = 0; i < 5; i++) parts.push(`<circle cx="${X(-0.85 + 0.12 * i)}" cy="${Y(-0.38 + 0.03 * Math.sin(i * 2.1))}" r="${R(0.05)}" fill="url(#bokeh)"/>`);
  // Window / softbox, its frame and mullion.
  parts.push(
    `<rect x="${X(0.62 - 0.19)}" y="${Y(-0.3 - 0.15)}" width="${R(0.38)}" height="${R(0.3)}" fill="#0a0a0a"/>`,
    `<rect x="${X(0.62 - 0.18)}" y="${Y(-0.3 - 0.14)}" width="${R(0.36)}" height="${R(0.28)}" fill="${rgb(0.93, 0.95, 0.98, Math.min(1.05, k + 0.2))}"/>`,
    `<rect x="${X(0.62) - R(0.006)}" y="${Y(-0.44)}" width="${R(0.012)}" height="${R(0.28)}" fill="#0a0a0a"/>`,
  );
  // Table and the deep shadow on the left.
  parts.push(`<rect x="0" y="${Y(0.25)}" width="${W}" height="${H - Y(0.25)}" fill="${rgb(0.14, 0.09, 0.06, k)}"/>`);
  parts.push(`<rect x="0" y="${Y(0.1)}" width="${W}" height="${H - Y(0.1)}" fill="url(#shade)"/>`);
  // Colour checker on its easel.
  const cx0 = X(0.2);
  const cy0 = Y(0.02);
  const cw = R(0.42) / 6;
  const ch = R(0.28) / 4;
  parts.push(`<rect x="${cx0}" y="${cy0}" width="${R(0.42)}" height="${R(0.28)}" fill="#050505"/>`);
  CHECKER.forEach(([r, g, b], idx) => {
    const col = idx % 6;
    const row = Math.floor(idx / 6);
    parts.push(`<rect x="${cx0 + col * cw + cw * 0.1}" y="${cy0 + row * ch + ch * 0.1}" width="${cw * 0.8}" height="${ch * 0.8}" fill="${rgb(r, g, b, k)}"/>`);
  });
  // Subject: shirt, face, eyes, mouth; sways gently.
  const sx = 0.02 * Math.sin(t * 0.6);
  const sy = 0.008 * Math.sin(t * 1.1);
  parts.push(`<rect x="${X(-0.35 - 0.21 + sx)}" y="${Y(0.36 - 0.2 + sy)}" width="${R(0.42)}" height="${R(0.5)}" rx="${R(0.04)}" fill="${rgb(0.07, 0.12, 0.22, k)}"/>`);
  const fx = X(-0.35 + sx);
  const fy = Y(-0.04 + sy);
  parts.push(`<circle cx="${fx}" cy="${fy}" r="${R(0.18)}" fill="url(#skin)"/>`);
  for (const s of [-1, 1]) {
    parts.push(`<circle cx="${fx + R(0.34 * 0.18) * s}" cy="${fy - R(0.08 * 0.18)}" r="${R(0.1 * 0.18)}" fill="rgba(235,235,235,0.9)"/>`);
    parts.push(`<circle cx="${fx + R((0.34 * s + 0.02 * Math.sin(t * 0.7)) * 0.18)}" cy="${fy - R(0.08 * 0.18)}" r="${R(0.045 * 0.18)}" fill="#060606"/>`);
  }
  parts.push(`<rect x="${fx - R(0.2 * 0.18)}" y="${fy + R(0.4 * 0.18)}" width="${R(0.4 * 0.18)}" height="${R(0.09 * 0.18)}" rx="${R(0.03 * 0.18)}" fill="${rgb(0.6, 0.27, 0.24, k)}"/>`);
  // The orange ball rolling on the table.
  parts.push(`<circle cx="${X(0.45 * Math.sin(t * 0.45))}" cy="${Y(0.31)}" r="${R(0.045)}" fill="url(#ball)"/>`);
  // Exposure ramp along the bottom edge.
  for (let i = 0; i < 17; i++) {
    const v = Math.min(1, 0.18 * Math.pow(2, i - 8)) ** (1 / 2.2);
    parts.push(`<rect x="${(i * W) / 17}" y="${H * 0.965}" width="${W / 17 + 0.5}" height="${H * 0.035}" fill="${rgb(v, v, v)}"/>`);
  }
  const vw = look.aspect === '4:3' ? (H * 4) / 3 : W;
  const vx = (W - vw) / 2;
  // Zoom: scale the scene about the face, keeping the face where a framed shot puts it.
  const z = look.zoom;
  const zx = X(-0.35);
  const zy = Y(-0.04);
  const [defs, ...scene] = splitDefs(parts);
  const body = z > 1.01 ? `<g transform="translate(${zx} ${zy}) scale(${z}) translate(${-zx} ${-zy})">${scene.join('')}</g>` : scene.join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${H}" viewBox="${vx.toFixed(1)} 0 ${vw.toFixed(1)} ${H}" preserveAspectRatio="xMidYMid slice">${defs}${body}</svg>`;
}

/** `<defs>…</defs>` as one string, then the drawing. */
function splitDefs(parts: string[]): string[] {
  const end = parts.indexOf('</defs>');
  return [parts.slice(0, end + 1).join(''), ...parts.slice(end + 1)];
}

export const svgDataUrl = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/** A stable look per item, so each card reads as a different take. */
export function demoLookFor(item: Pick<CameraMediaItem, 'id' | 'kind'>): DemoLook {
  let h = 0;
  for (let i = 0; i < item.id.length; i++) h = (h * 31 + item.id.charCodeAt(i)) >>> 0;
  const zoom = [1, 1.45, 1.9, 2.3][(h >> 11) % 4];
  return {
    hue: ((h % 9) - 4) * 16,
    // Wide shots pan across the room; close-ups keep the subject near the middle.
    pan: zoom > 1 ? -0.35 + (((h >> 3) % 5) - 2) * 0.06 : -0.3 + ((h >> 3) % 9) * 0.075,
    exposure: 0.7 + ((h >> 7) % 9) * 0.075,
    zoom,
    aspect: item.kind === 'photo' ? '4:3' : '16:9',
  };
}

/**
 * Filmstrip frames for a demo clip: `count` pictures spread over the take (frame i at the middle
 * of its slice), as data URLs.
 */
export function demoFilmstripFrames(item: Pick<CameraMediaItem, 'id' | 'kind' | 'durationSec'>, count: number): string[] {
  const look = demoLookFor(item);
  const duration = Math.max(1, item.durationSec ?? 10);
  const offset = (look.pan + 1) * 37;
  return Array.from({ length: count }, (_, i) => svgDataUrl(studioSvg(offset + ((i + 0.5) / count) * duration, look)));
}

/** Days back for each demo item. */
const DAYS = [0, 0, 0, 0, 1, 1, 1, 1, 1, 3, 3, 3, 4, 4, 6, 6, 6, 9];

export function demoMediaItems(): CameraMediaItem[] {
  const now = Date.now();
  const day = 86_400_000;
  const items: CameraMediaItem[] = [];
  const specs: [CameraMediaItem['kind'], number?, string?][] = [
    ['video', 48],
    ['video', 12],
    ['photo'],
    ['video', 95],
    ['photo', undefined, 'burst-1'],
    ['photo', undefined, 'burst-1'],
    ['photo', undefined, 'burst-1'],
    ['video', 7],
    ['video', 31],
    ['photo'],
    ['video', 240],
    ['photo'],
    ['video', 83],
    ['video', 5],
    ['photo'],
    ['video', 27],
    ['video', 64],
    ['photo'],
  ];
  specs.forEach(([kind, dur, group], i) => {
    const n = String(i + 1).padStart(4, '0');
    const id = `demo-${n}`;
    const look = demoLookFor({ id, kind });
    items.push({
      id,
      kind,
      fileName: `DJI_${n}.${kind === 'video' ? 'MP4' : 'JPG'}`,
      // Several takes a day, like a real card: today, yesterday, then older days.
      createdAt: now - DAYS[i] * day - (i % 4) * 1_800_000,
      durationSec: dur,
      sizeBytes: kind === 'video' ? (dur ?? 10) * 1_250_000 : 6_400_000,
      width: kind === 'video' ? 3840 : 4000,
      height: kind === 'video' ? 2160 : 3000,
      fps: kind === 'video' ? (i % 3 === 0 ? 60 : 30) : undefined,
      colorMode: i % 4 === 0 ? 'dlog-m' : 'normal',
      favorite: i % 5 === 1,
      groupId: group,
      thumbnailUrl: svgDataUrl(studioSvg((look.pan + 1) * 37 + (dur ?? 2) / 2, look)),
    });
  });
  return items;
}
