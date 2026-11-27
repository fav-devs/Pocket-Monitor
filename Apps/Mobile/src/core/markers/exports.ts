/**
 * "Export markers" for a selection of clips, in the forms editors import:
 *
 * - FCPXML 1.10 (Final Cut Pro, and Resolve / Premiere through their FCPXML import): one event
 *   (the shoot, else "Pocket Monitor") with each clip as an `asset-clip` carrying its markers,
 *   its tags as keywords, a favourite rating and its notes.
 * - A DaVinci Resolve marker EDL (Timeline › Import › Timeline Markers from EDL): the clips laid
 *   end to end from 01:00:00:00 at the first clip's rate, one marker event per marker with
 *   Resolve's `|C:ResolveColor… |M:name |D:frames` line.
 * - A Resolve-style marker CSV and a Premiere-style CSV (the columns of Premiere's own marker
 *   export, plus the file name), timecodes in clip time.
 *
 * Pure. Timecodes are non-drop at the clip's rate rounded to a whole number.
 */
import { type ClipIdentity, type ClipMarker, type MarkerColor, frameAt, markerTitle, sortMarkers } from './model';

export interface ExportClip {
  identity: ClipIdentity;
  markers: ClipMarker[];
  tags: string[];
  rating: number;
  favorite: boolean;
  notes: string;
  shootName?: string;
}

export type MarkerExportFormat = 'fcpxml' | 'resolve-edl' | 'resolve-csv' | 'premiere-csv';

export const MARKER_EXPORT_FORMATS: { id: MarkerExportFormat; label: string; extension: string; mimeType: string }[] = [
  { id: 'fcpxml', label: 'Final Cut Pro (FCPXML)', extension: 'fcpxml', mimeType: 'application/xml' },
  { id: 'resolve-edl', label: 'DaVinci Resolve (EDL)', extension: 'edl', mimeType: 'text/plain' },
  { id: 'resolve-csv', label: 'DaVinci Resolve (CSV)', extension: 'csv', mimeType: 'text/csv' },
  { id: 'premiere-csv', label: 'Premiere Pro (CSV)', extension: 'csv', mimeType: 'text/csv' },
];

const RESOLVE_COLOR: Record<MarkerColor, string> = {
  blue: 'Blue',
  cyan: 'Cyan',
  green: 'Green',
  yellow: 'Yellow',
  red: 'Red',
  pink: 'Pink',
  purple: 'Purple',
  cream: 'Cream',
};

/** The whole-number rate timecodes count in. */
const baseRate = (fps: number | undefined) => Math.max(1, Math.round(fps && fps > 0 ? fps : 30));

/** HH:MM:SS:FF (non-drop) for a frame count. */
export function timecodeFromFrames(frames: number, fps: number | undefined): string {
  const r = baseRate(fps);
  const f = Math.max(0, Math.round(frames));
  const two = (n: number) => String(n).padStart(2, '0');
  const ff = f % r;
  const total = Math.floor(f / r);
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}:${two(ff)}`;
}

/** HH:MM:SS:FF for seconds into a clip. */
export function timecodeAt(seconds: number, fps: number | undefined): string {
  return timecodeFromFrames(Math.round(Math.max(0, seconds) * baseRate(fps)), fps);
}

/** FCPXML frame duration as `num/den` for a rate (NTSC rates are 1001-based). */
export function frameDuration(fps: number | undefined): { num: number; den: number } {
  const f = fps && fps > 0 ? fps : 30;
  for (const base of [24, 30, 48, 60, 120, 240]) {
    if (Math.abs(f - (base * 1000) / 1001) < 0.02) return { num: 1001, den: base * 1000 };
  }
  return { num: 1, den: Math.max(1, Math.round(f)) };
}

const rational = (frames: number, fd: { num: number; den: number }) => (frames === 0 ? '0s' : `${frames * fd.num}/${fd.den}s`);

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

const baseName = (fileName: string) => {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
};

/** FCPXML 1.10 with one event of asset-clips and their markers. */
export function toFcpxml(clips: ExportClip[], eventName?: string): string {
  const formats = new Map<string, string>();
  const res: string[] = [];
  const body: string[] = [];
  let next = 1;
  const event = eventName || clips.find((c) => c.shootName)?.shootName || 'Pocket Monitor';
  for (const clip of clips) {
    const id = clip.identity;
    const fd = frameDuration(id.fps);
    const fmtKey = `${fd.num}/${fd.den}|${id.width ?? 0}x${id.height ?? 0}`;
    let fmt = formats.get(fmtKey);
    if (!fmt) {
      fmt = `r${next++}`;
      formats.set(fmtKey, fmt);
      const size = id.width && id.height ? ` width="${id.width}" height="${id.height}"` : '';
      res.push(`    <format id="${fmt}" frameDuration="${rational(1, fd)}"${size}/>`);
    }
    const asset = `r${next++}`;
    const totalFrames = Math.max(1, Math.round((id.durationSec ?? 0) * (fd.den / fd.num)));
    const dur = rational(totalFrames, fd);
    const name = xml(baseName(id.fileName));
    res.push(
      `    <asset id="${asset}" name="${name}" start="0s" duration="${dur}" hasVideo="1" hasAudio="1" format="${fmt}">`,
      `      <media-rep kind="original-media" src="${xml(encodeURI(`./${id.fileName}`))}"/>`,
      `    </asset>`,
    );
    const inner: string[] = [];
    if (clip.notes.trim()) inner.push(`        <note>${xml(clip.notes.trim())}</note>`);
    const markers = sortMarkers(clip.markers);
    markers.forEach((m, i) => {
      const frame = Math.min(totalFrames - 1, Math.round(m.time * (fd.den / fd.num)));
      const note = [m.tag, m.label && m.label !== markerTitle(m, i) ? m.label : ''].filter(Boolean).join(' · ');
      inner.push(`        <marker start="${rational(Math.max(0, frame), fd)}" duration="${rational(1, fd)}" value="${xml(markerTitle(m, i))}"${note ? ` note="${xml(note)}"` : ''}/>`);
    });
    if (clip.tags.length) inner.push(`        <keyword start="0s" duration="${dur}" value="${xml(clip.tags.join(', '))}"/>`);
    if (clip.favorite || clip.rating >= 4) inner.push(`        <rating start="0s" duration="${dur}" value="favorite"/>`);
    body.push(`      <asset-clip ref="${asset}" name="${name}" duration="${dur}" format="${fmt}" tcFormat="NDF">`, ...inner, `      </asset-clip>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    ...res,
    '  </resources>',
    '  <library>',
    `    <event name="${xml(event)}">`,
    ...body,
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

/** EDL text has no escapes: keep it to one printable line. */
const edlText = (s: string) => s.replace(/[|\r\n]+/g, ' ').trim();

/** A Resolve marker EDL: the clips end to end from 01:00:00:00, one event per marker. */
export function toResolveEdl(clips: ExportClip[], title = 'Pocket Monitor markers'): string {
  const fps = clips.find((c) => c.identity.fps)?.identity.fps ?? 30;
  const r = baseRate(fps);
  const lines = [`TITLE: ${edlText(title)}`, 'FCM: NON-DROP FRAME', ''];
  let event = 1;
  let offset = 3600 * r; // 01:00:00:00
  for (const clip of clips) {
    const clipFrames = Math.max(1, Math.round((clip.identity.durationSec ?? 0) * r));
    sortMarkers(clip.markers).forEach((m, i) => {
      const f = Math.min(clipFrames - 1, Math.round(m.time * r));
      const rec = offset + Math.max(0, f);
      const n = String(event++).padStart(3, '0');
      lines.push(
        `${n}  001      V     C        ${timecodeFromFrames(rec, r)} ${timecodeFromFrames(rec + 1, r)} ${timecodeFromFrames(rec, r)} ${timecodeFromFrames(rec + 1, r)}`,
        ` |C:ResolveColor${RESOLVE_COLOR[m.color]} |M:${edlText(markerTitle(m, i))} |D:1`,
        '',
      );
    });
    offset += clipFrames;
  }
  return lines.join('\n');
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csv = (rows: (string | number)[][]) => `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

/** Resolve-style marker CSV: one row per marker, in clip time. */
export function toResolveCsv(clips: ExportClip[]): string {
  const rows: (string | number)[][] = [['File Name', 'Marker Name', 'Notes', 'Color', 'Source In', 'Duration', 'Frame', 'Seconds', 'Keywords', 'Clip Tags', 'Rating']];
  for (const clip of clips) {
    const fps = clip.identity.fps;
    sortMarkers(clip.markers).forEach((m, i) => {
      rows.push([
        clip.identity.fileName,
        markerTitle(m, i),
        m.label,
        RESOLVE_COLOR[m.color],
        timecodeAt(m.time, fps),
        1,
        frameAt(m.time, fps),
        (Math.round(m.time * 1000) / 1000).toFixed(3),
        m.tag ?? '',
        clip.tags.join('; '),
        clip.rating || '',
      ]);
    });
  }
  return csv(rows);
}

/** Premiere-style CSV: the columns of Premiere's marker export, then the file name. */
export function toPremiereCsv(clips: ExportClip[]): string {
  const rows: (string | number)[][] = [['Marker Name', 'Description', 'In', 'Out', 'Duration', 'Marker Type', 'File Name']];
  for (const clip of clips) {
    const fps = clip.identity.fps;
    sortMarkers(clip.markers).forEach((m, i) => {
      const tc = timecodeAt(m.time, fps);
      rows.push([markerTitle(m, i), [m.tag, m.label].filter(Boolean).join(' · '), tc, tc, '00:00:00:00', 'Comment', clip.identity.fileName]);
    });
  }
  return csv(rows);
}

export function exportMarkers(format: MarkerExportFormat, clips: ExportClip[], eventName?: string): string {
  switch (format) {
    case 'fcpxml':
      return toFcpxml(clips, eventName);
    case 'resolve-edl':
      return toResolveEdl(clips);
    case 'resolve-csv':
      return toResolveCsv(clips);
    case 'premiere-csv':
      return toPremiereCsv(clips);
  }
}

/** "Pocket Monitor markers 2026-11-27.fcpxml", or the one clip's name. */
export function exportFileName(format: MarkerExportFormat, clips: ExportClip[], now = Date.now()): string {
  const ext = MARKER_EXPORT_FORMATS.find((f) => f.id === format)!.extension;
  const suffix = format === 'premiere-csv' ? ' Premiere' : format === 'resolve-csv' ? ' Resolve' : '';
  if (clips.length === 1) return `${baseName(clips[0].identity.fileName)} markers${suffix}.${ext}`;
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `Pocket Monitor markers ${day}${suffix}.${ext}`;
}
