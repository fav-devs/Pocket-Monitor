/**
 * The desktop app's picture commands (`Apps/Desktop/crates/pm-desktop/src/{luts,scopes,stills}.rs`):
 * colour cubes, still capture, and the scope sample channel.
 *
 * Scope samples come from Rust, which reads the decoded camera signal on its own thread and
 * sends one compact binary message per tick on a Tauri channel (`scope://samples`, ≤ 15 Hz,
 * only while a plate is on). The layout is `pm_controller::scopes::tap`; `parseScopeFrame`
 * reads it. Every consumer (the scope plates, the EV meter) registers what it needs with
 * `demandDesktopScopes`; the union goes to `scopes_configure` once per change.
 */
import { invoke, isTauri } from './tauri';

// ───────────────────────────── LUTs ─────────────────────────────

export interface DesktopLutEntry {
  /** The `lutId` for `PictureEffects` (`look:<name>`, `file:<name>`). */
  id: string;
  name: string;
}

export interface DesktopLutList {
  builtIn: DesktopLutEntry[];
  /** Every `.cube` in the LUT drop folder. */
  files: DesktopLutEntry[];
  /** Where to drop `.cube` files. */
  folder: string;
  /** The last `lut_select`. */
  selected: string | null;
}

export interface DesktopLutLoaded {
  id: string;
  name: string;
  size: number;
}

export const lutList = () => invoke<DesktopLutList>('lut_list');

/**
 * With `id: 'custom:<key>'`, hands Rust a cube the web keeps in its own storage (the twin of
 * `PocketVideo.loadLut`). Without an id it imports: the core validates it and the file is
 * written into the drop folder, returning its `file:<name>` id.
 */
export const lutLoad = (name: string, text: string, id?: string) => invoke<DesktopLutLoaded>('lut_load', { name, text, id: id ?? null });

/** Remembers the pick natively (`desktop-lut-v1.txt`). */
export const lutSelect = (id: string | null) => invoke<void>('lut_select', { id });

export const lutUnload = (id: string) => invoke<void>('lut_unload', { id });

// ───────────────────────────── Stills ─────────────────────────────

export interface DesktopStill {
  path: string;
  width: number;
  height: number;
}

/** The graded frame at its source raster, as a PNG in Pictures\Pocket Monitor. */
export const stillCapture = () => invoke<DesktopStill>('still_capture');

// ───────────────────────────── Scope samples ─────────────────────────────

/** What a consumer needs from the scope thread. */
export interface DesktopScopePlates {
  waveform?: 'Luma' | 'RGB' | null;
  parade?: 'RGB' | 'YRGB' | null;
  histogram?: boolean;
  /** VECTOR zoom (1, 2, 4) while it is on. */
  vectorscope?: number | null;
  lights?: boolean;
  /** `crushClipThreshold` (compensation stops / 10). */
  lightsThreshold?: number;
  /** The ND chip or the EV meter. */
  nd?: boolean;
}

export interface DesktopLight {
  clip: boolean;
  crush: boolean;
  /** Histogram median on the anchored axis, 0.5 balanced. */
  level: number;
}

/** One `scope://samples` message. Grids are row-major, row 0 at IRE 0. */
export interface DesktopScopeFrame {
  sequence: number;
  pixels: number;
  columns: number;
  levels: number;
  vectorBins: number;
  /** 18 % grey on the WAVE IRE axis (the core's, for the body's colour and ISO). */
  greyIre: number;
  /** Picture stops vs 18 % grey (core ND reading), null when not asked or unknown. */
  pictureStops: number | null;
  /** The glass to reach for, null when not asked or unknown. */
  ndStops: number | null;
  lights: { red: DesktopLight; green: DesktopLight; blue: DesktopLight } | null;
  waveLuma: Uint8Array | null;
  waveRed: Uint8Array | null;
  waveGreen: Uint8Array | null;
  waveBlue: Uint8Array | null;
  /** IRE-axis buckets (bucket i = IRE i/255·100). */
  histogram: { luma: Uint16Array; red: Uint16Array; green: Uint16Array; blue: Uint16Array } | null;
  /** Log densities 0…255, row 0 at the top (+Cr up), already zoomed. */
  vector: Uint8Array | null;
}

export const SCOPE_MAGIC = 'PMSC';
export const SCOPE_HEADER = 48;
const BLOCK = { waveLuma: 1, waveRed: 2, waveGreen: 4, waveBlue: 8, histogram: 16, vector: 32 } as const;

function asBytes(message: unknown): Uint8Array | null {
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  if (Array.isArray(message)) return Uint8Array.from(message as number[]);
  return null;
}

/** Reads one message; null for anything that is not a version-1 scope frame. */
export function parseScopeFrame(message: unknown): DesktopScopeFrame | null {
  const bytes = asBytes(message);
  if (!bytes || bytes.byteLength < SCOPE_HEADER) return null;
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== SCOPE_MAGIC || bytes[4] !== 1) return null;
  // Copy so typed views are aligned whatever the transport handed over.
  const buffer = bytes.slice().buffer;
  const view = new DataView(buffer);
  const blocks = view.getUint8(5);
  const columns = view.getUint16(6, true);
  const levels = view.getUint16(8, true);
  const vectorBins = view.getUint16(10, true);
  const stops = view.getFloat32(24, true);
  const light = (at: number): DesktopLight => ({
    clip: view.getUint8(at) === 1,
    crush: view.getUint8(at + 1) === 1,
    level: view.getUint16(at + 2, true) / 65535,
  });
  const nd = view.getInt8(40);
  const frame: DesktopScopeFrame = {
    sequence: view.getUint32(12, true),
    pixels: view.getUint32(16, true),
    columns,
    levels,
    vectorBins,
    greyIre: view.getFloat32(20, true),
    pictureStops: Number.isFinite(stops) ? stops : null,
    ndStops: nd >= 0 ? nd : null,
    lights: view.getUint8(41) === 1 ? { red: light(28), green: light(32), blue: light(36) } : null,
    waveLuma: null,
    waveRed: null,
    waveGreen: null,
    waveBlue: null,
    histogram: null,
    vector: null,
  };
  let at = SCOPE_HEADER;
  const cells = columns * levels;
  const take = (length: number) => {
    if (at + length > buffer.byteLength) return null;
    const out = new Uint8Array(buffer, at, length);
    at += length;
    return out;
  };
  if (blocks & BLOCK.waveLuma) frame.waveLuma = take(cells);
  if (blocks & BLOCK.waveRed) frame.waveRed = take(cells);
  if (blocks & BLOCK.waveGreen) frame.waveGreen = take(cells);
  if (blocks & BLOCK.waveBlue) frame.waveBlue = take(cells);
  if (blocks & BLOCK.histogram) {
    if (at % 2 === 0 && at + 4 * 512 <= buffer.byteLength) {
      const all = new Uint16Array(buffer, at, 4 * 256);
      frame.histogram = { luma: all.subarray(0, 256), red: all.subarray(256, 512), green: all.subarray(512, 768), blue: all.subarray(768, 1024) };
      at += 4 * 512;
    } else return null;
  }
  if (blocks & BLOCK.vector) frame.vector = take(vectorBins * vectorBins);
  return frame;
}

type ChannelMessage = { message?: unknown; index?: number; end?: boolean };

interface ChannelInternals {
  transformCallback(callback: (response: unknown) => void, once?: boolean): number;
  unregisterCallback?(id: number): void;
}

function internals(): ChannelInternals | null {
  if (typeof window === 'undefined') return null;
  return ((window as unknown as { __TAURI_INTERNALS__?: ChannelInternals }).__TAURI_INTERNALS__ ?? null) as ChannelInternals | null;
}

let latest: DesktopScopeFrame | null = null;
const listeners = new Set<() => void>();
const demands = new Map<number, DesktopScopePlates>();
let nextDemand = 1;
let channelId: number | null = null;
let lastIndex = -1;
let configured = '';
let flushQueued = false;

function onChannel(response: unknown) {
  const msg = response as ChannelMessage;
  if (!msg || msg.end) return;
  // Large messages arrive by fetch and may overtake each other: keep the newest only.
  if (typeof msg.index === 'number') {
    if (msg.index <= lastIndex) return;
    lastIndex = msg.index;
  }
  const frame = parseScopeFrame(msg.message);
  if (!frame) return;
  latest = frame;
  for (const l of listeners) l();
}

function channelArg(): string | null {
  const tauri = internals();
  if (!tauri) return null;
  if (channelId == null) {
    channelId = tauri.transformCallback(onChannel);
    lastIndex = -1;
  }
  return `__CHANNEL__:${channelId}`;
}

/** The union of every consumer's needs. */
export function mergePlates(all: Iterable<DesktopScopePlates>): DesktopScopePlates | null {
  const out: DesktopScopePlates = {};
  let any = false;
  for (const p of all) {
    if (p.waveform) out.waveform = out.waveform ?? p.waveform;
    if (p.parade) out.parade = out.parade ?? p.parade;
    if (p.histogram) out.histogram = true;
    if (p.vectorscope) out.vectorscope = Math.max(out.vectorscope ?? 0, p.vectorscope);
    if (p.lights) {
      out.lights = true;
      out.lightsThreshold = p.lightsThreshold ?? out.lightsThreshold ?? 0;
    }
    if (p.nd) out.nd = true;
    any = any || !!(p.waveform || p.parade || p.histogram || p.vectorscope || p.lights || p.nd);
  }
  return any ? out : null;
}

function flush() {
  flushQueued = false;
  const plates = mergePlates(demands.values());
  const key = JSON.stringify(plates);
  if (key === configured) return;
  configured = key;
  const channel = channelArg();
  if (!channel) return;
  if (!plates) latest = null;
  invoke('scopes_configure', { plates, channel }).catch(() => {
    configured = '';
  });
}

function schedule() {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

/** Registers what one consumer needs while it is mounted; returns the release. */
export function demandDesktopScopes(plates: DesktopScopePlates): { update(next: DesktopScopePlates): void; release(): void } {
  const id = nextDemand++;
  demands.set(id, plates);
  schedule();
  return {
    update(next) {
      demands.set(id, next);
      schedule();
    },
    release() {
      demands.delete(id);
      schedule();
    },
  };
}

export function subscribeDesktopScopes(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const getDesktopScopeFrame = () => latest;

/** True where the scope thread can serve the plates (inside the desktop app). */
export const desktopScopesAvailable = () => isTauri();

/** Test seam: forget the channel and every demand. */
export function resetDesktopScopesForTest() {
  latest = null;
  listeners.clear();
  demands.clear();
  channelId = null;
  lastIndex = -1;
  configured = '';
  flushQueued = false;
}
