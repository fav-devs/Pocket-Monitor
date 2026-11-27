/**
 * Media labels, ported from OpenCine `ByteCountLabel`, `MediaTransferRate`, `StorageReadout`,
 * `MonitorTimecodeFormat`, `MonitorMediaGalleryLabels` and `MediaClipFormatting`.
 * Pure functions: no React, no RN.
 */
import type { CameraMediaItem, ColorMode } from '@/camera';

/** Decimal byte label with integer half-up rounding (`ByteCountLabel`). */
export function byteLabel(bytes: number): string {
  const b = Math.max(0, Math.floor(bytes));
  if (b <= 0) return '0 B';
  if (b < 1000) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const places = [0, 1, 2, 2];
  let unit = 0;
  let divisor = 1000;
  for (;;) {
    const scale = places[unit] === 0 ? 1 : places[unit] === 1 ? 10 : 100;
    const scaled =
      Math.floor(b / divisor) * scale + Math.floor(((b % divisor) * scale + Math.floor(divisor / 2)) / divisor);
    if (scaled >= 1000 * scale && unit < units.length - 1) {
      unit += 1;
      divisor *= 1000;
      continue;
    }
    let text = `${Math.floor(scaled / scale)}`;
    if (scaled % scale > 0) {
      const digits = String(scaled % scale).padStart(places[unit], '0').replace(/0+$/, '');
      text += `.${digits}`;
    }
    return `${text} ${units[unit]}`;
  }
}

/** "42 MB/s" — KB/s under 1 MB/s, one decimal under 10 MB/s, whole MB/s above. */
export function transferRateLabel(bytesPerSecond: number): string {
  const rate = Math.max(0, Math.round(bytesPerSecond));
  const kilobytes = Math.floor((rate + 500) / 1000);
  if (kilobytes < 1000) return `${kilobytes} KB/s`;
  const tenths = Math.floor((rate + 50_000) / 100_000);
  if (tenths < 100) return `${Math.floor(tenths / 10)}.${tenths % 10} MB/s`;
  return `${Math.floor((rate + 500_000) / 1_000_000)} MB/s`;
}

/** "18% · 42 MB/s", "18%" without a rate, null without progress. */
export function transferCaption(fraction: number | null | undefined, rate?: string | null): string | null {
  if (fraction == null || !Number.isFinite(fraction)) return null;
  const percent = `${Math.floor(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  return rate ? `${percent} · ${rate}` : percent;
}

/** Clip length: "0:21", "12:04", "1:02:03". */
export function durationLabel(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * `MonitorTimecodeFormat.label`: HH:MM:SS:FF from a position and a frame rate. Without a
 * frame rate the clock stays seconds-only. Hours wrap at 24 like a camera clock.
 */
export function timecodeLabel(seconds: number, fps?: number | null): string {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const whole = Math.floor(t);
  const hh = String(Math.floor(whole / 3600) % 24).padStart(2, '0');
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  const clock = `${hh}:${mm}:${ss}`;
  if (!fps || fps <= 0) return clock;
  const frames = Math.min(Math.ceil(fps) - 1, Math.floor((t - whole) * fps + 1e-6));
  return `${clock}:${String(frames).padStart(2, '0')}`;
}

export function timecodePlaceholder(frames: boolean): string {
  return frames ? '--:--:--:--' : '--:--:--';
}

const resolutionLevels: [number, string][] = [
  [7680, '8K'],
  [5120, '6K'],
  [3840, '4K'],
  [2880, '3K'],
  [2560, '2.7K'],
  [1920, '1080p'],
  [1280, '720p'],
];

/** "4K" from the long edge of a picture (`MonitorMediaGalleryLabels.resolution`). */
export function resolutionLabel(width?: number, height?: number): string | null {
  if (!width || !height) return null;
  const long = Math.max(width, height);
  return resolutionLevels.find(([min]) => long >= min)?.[1] ?? `${width}x${height}`;
}

export function colorModeLabel(mode?: ColorMode): string | null {
  switch (mode) {
    case 'normal':
      return 'Normal';
    case 'hlg':
      return 'HLG';
    case 'dlog-m':
      return 'D-Log M';
    case 'dlog':
      return 'D-Log';
    case 'dlog2':
      return 'D-Log2';
    case '10bit':
      return '10-bit';
    default:
      return null;
  }
}

/** True for log footage that "Convert log" applies to. */
export function isLogColor(mode?: ColorMode): boolean {
  return mode === 'dlog-m' || mode === 'dlog' || mode === 'dlog2';
}

/** "4K 30p" for clips, "4K" for stills. */
export function formatLabel(item: CameraMediaItem): string {
  const res = resolutionLabel(item.width, item.height);
  const fps = item.kind === 'video' && item.fps ? `${Math.round(item.fps)}p` : null;
  return [res, fps].filter(Boolean).join(' ');
}

/** The grid card's detail line: "4K 25p · D-Log M". */
export function cardDetail(item: CameraMediaItem): string {
  return [formatLabel(item), colorModeLabel(item.colorMode)].filter(Boolean).join(' · ');
}

/** Playback subtitle: "3840x2160 · 25p · 20.6 MB". */
export function playbackSubtitle(item: CameraMediaItem): string {
  const dims = item.width && item.height ? `${item.width}x${item.height}` : null;
  const fps = item.kind === 'video' && item.fps ? `${Math.round(item.fps)}p` : null;
  return [dims, fps, byteLabel(item.sizeBytes)].filter(Boolean).join(' · ');
}

/** `StorageReadout.label`: "60 GB · 47%", "60 GB" without capacity, "—" when unknown. */
export function storageReadout(freeMb: number, totalMb: number): string {
  if (!(freeMb > 0) && !(totalMb > 0)) return '—';
  const free = Math.max(0, freeMb) * 1_000_000;
  const total = totalMb > 0 ? totalMb * 1_000_000 : null;
  const label = byteLabel(free);
  if (!total) return label;
  const percent = Math.round((Math.min(free, total) / total) * 100);
  return `${label} · ${percent}%`;
}

/** Local day key "YYYYMMDD" for grouping. */
export function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** "Today", "Yesterday", or "Mon 24 Nov 2026". */
export function dayLabel(timestamp: number, now = Date.now()): string {
  const key = dayKey(timestamp);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now - 86_400_000)) return 'Yesterday';
  const d = new Date(timestamp);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${weekday} ${d.getDate()} ${month} ${d.getFullYear()}`;
}

export function dateTimeLabel(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dayLabel(timestamp)} · ${hh}:${mm}`;
}
