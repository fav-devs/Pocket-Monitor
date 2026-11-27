/**
 * Watcher relay ⇄ UI camera model. Pure functions (tested in mapping.test.ts).
 *
 * - `stateFromRelay`: a host's state message folded into `CameraState` (what the wire does not
 *   carry keeps its last value), so the live picture and assists read a shared feed like a camera.
 * - `relayStateFromCamera`: the host's own `CameraState` as the state message it broadcasts.
 * - `relayCommandFor*`: the few controls the wire carries (record, tap focus, ISO, shutter, white
 *   balance, colour, zoom). Everything else is refused with operator copy, never sent into the void.
 */
import { capabilitiesFor, initialCameraState, modelDisplayName, zoomStopsFor } from '../defaults';
import type { CameraModelId, CameraState, ColorMode, ConnectionPhase } from '../types';
import { ColorMode as WireColorMode, IsoIndex, IsoIndexes, type IsoIndex as IsoIndexValue } from '@/core/commands/vocabulary';
import { wireColorMode } from '@/core/mapping';
import type { RelayCommand, RelayControl, RelayState } from './protocol';

// ───────────────────────────── Reading labels ─────────────────────────────

/** The first run of digits in a label: "ISO 800" is 800, "1/50" is 1. */
export function leadingNumber(text: string): number | null {
  const m = /\d+/.exec(text);
  return m ? Number(m[0]) : null;
}

/** "2.5×", "2.5x" or "x2" is 2.5; anything without a number is unknown. */
export function zoomFactorOf(label: string): number | null {
  const m = /\d+(?:\.\d+)?/.exec(label);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function shutterDenomOf(label: string): number | null {
  const t = label.trim();
  if (!t.startsWith('1/')) return null;
  return leadingNumber(t.slice(2));
}

/** The host's colour label (`ColorModes.label`, upstream `ColorMode.label`) as the UI colour mode. */
export function colorModeOf(label: string): ColorMode {
  const t = label.toLowerCase().replace(/\s+/g, '');
  if (t.includes('d-logm') || t.includes('dlogm')) return 'dlog-m';
  if (t.includes('d-log2') || t.includes('dlog2')) return 'dlog2';
  if (t.includes('d-log') || t.includes('dlog')) return 'dlog';
  if (t.includes('hlg') || t.includes('hdr')) return 'hlg';
  if (t.includes('10-bit') || t.includes('10bit')) return '10bit';
  return 'normal';
}

const COLOR_LABEL: Record<ColorMode, string> = {
  normal: 'Normal',
  hlg: 'HLG',
  'dlog-m': 'D-Log M',
  dlog: 'D-Log',
  dlog2: 'D-Log2',
  '10bit': 'Normal 10-bit',
};

/** The camera's model name (upstream sends `model.name`) or the Nano flag as a model id. */
export function modelOf(cameraModel: string | null | undefined, isNano: boolean | null | undefined): CameraModelId {
  const t = (cameraModel ?? '').toLowerCase();
  if (isNano || t.includes('nano')) return 'osmo-nano';
  if (t.includes('4 pro') || t.includes('4pro')) return 'osmo-pocket-4-pro';
  if (t.includes('pocket 4') || t.includes('pocket4')) return 'osmo-pocket-4';
  if (t.includes('pocket 3') || t.includes('pocket3')) return 'osmo-pocket-3';
  if (t.includes('action 6')) return 'osmo-action-6';
  return 'unknown';
}

/** "4K/60", "4K · 60" or "4K" → resolution and fps (fps null when the label has none). */
export function formatOf(label: string): { resolution: string | null; fps: number | null } {
  const t = label.trim();
  if (!t) return { resolution: null, fps: null };
  const [res, rest] = t.split(/\s*[/·@]\s*/);
  return { resolution: res || null, fps: rest ? leadingNumber(rest) : null };
}

// ───────────────────────────── Watcher side ─────────────────────────────

export type WatcherPhase = 'idle' | 'connecting' | 'needs-passcode' | 'live' | 'reconnecting' | 'failed';

export interface WatcherInfo {
  phase: WatcherPhase;
  /** Host title: "Studio iPhone · Pocket 3". */
  title: string;
  hostName: string;
  cameraName: string;
  control: RelayControl;
  holder: string;
  error: string | null;
  /** Reconnect attempt 1…3 while reconnecting. */
  attempt: number;
  /** Received pictures per second. */
  receivedFps: number;
  /** Host-advertised choices (only these are offered as controls). */
  options: { iso: number[]; shutter: number[]; zoom: number[] };
}

export const idleWatcherInfo: WatcherInfo = {
  phase: 'idle',
  title: '',
  hostName: '',
  cameraName: '',
  control: 'not-offered',
  holder: '',
  error: null,
  attempt: 0,
  receivedFps: 0,
  options: { iso: [], shutter: [], zoom: [] },
};

export function hostTitle(hostName: string, cameraName?: string | null): string {
  return cameraName ? `${hostName} · ${cameraName}` : hostName;
}

const PHASE: Record<WatcherPhase, ConnectionPhase> = {
  idle: 'idle',
  connecting: 'datalink',
  'needs-passcode': 'failed',
  live: 'live',
  reconnecting: 'recovering',
  failed: 'failed',
};

export function connectionPhaseFor(phase: WatcherPhase): ConnectionPhase {
  return PHASE[phase];
}

/** ISO numbers the host offers (auto excluded). */
export function isoOptionsOf(state: RelayState): number[] {
  const indices = state.controlOptions?.isoIndices ?? [];
  return indices.map((i) => IsoIndexes.value(i as IsoIndexValue)).filter((v): v is number => v != null);
}

/** Folds a state message into the previous camera state. */
export function stateFromRelay(prev: CameraState, state: RelayState, hello: { hostName: string; cameraName?: string | null }): CameraState {
  const model = modelOf(state.cameraModel, state.isNano);
  const fresh = prev.identity?.model !== model && model !== 'unknown';
  const base = fresh ? { ...initialCameraState(model), connection: prev.connection, identity: prev.identity } : prev;
  const cameraName = state.cameraName || hello.cameraName || hello.hostName;
  const iso = leadingNumber(state.iso);
  const isoAuto = /auto/i.test(state.iso);
  const isoOptions = isoOptionsOf(state);
  const shutter = shutterDenomOf(state.shutter);
  const shutterOptions = state.controlOptions?.shutterDenominators?.filter((d) => d > 0) ?? [];
  const zoom = zoomFactorOf(state.zoom);
  const zoomStops = (state.controlOptions?.zoomHundredths ?? []).filter((h) => h > 0).map((h) => h / 100);
  const { resolution, fps } = formatOf(state.format);
  const color = state.color ? colorModeOf(state.color) : base.format.colorMode;
  const stops = zoomStops.length ? zoomStops : base.zoom.stops;
  const z = zoomStopsFor(model);
  return {
    ...base,
    identity: {
      id: `relay:${hello.hostName}`,
      name: cameraName,
      model: model === 'unknown' ? (base.identity?.model ?? 'unknown') : model,
    },
    recording: { ...base.recording, recording: state.isRecording },
    exposure: {
      ...base.exposure,
      mode: isoAuto ? 'auto' : base.exposure.mode,
      iso: iso ?? base.exposure.iso,
      isoAuto,
      isoOptions: isoOptions.length ? isoOptions : base.exposure.isoOptions,
      shutterDenom: shutter ?? base.exposure.shutterDenom,
      shutterAuto: shutter == null && !state.shutter ? base.exposure.shutterAuto : shutter == null,
      shutterOptions: shutterOptions.length ? shutterOptions : base.exposure.shutterOptions,
    },
    format: {
      ...base.format,
      resolution: resolution ?? base.format.resolution,
      fps: fps ?? base.format.fps,
      colorMode: color,
      colorModeOptions: [color],
    },
    zoom: {
      ...base.zoom,
      factor: zoom ?? base.zoom.factor,
      stops,
      min: Math.min(1, ...stops),
      max: Math.max(z.max, ...stops),
    },
    power: { ...base.power, batteryPercent: state.batteryPercent },
    // A watcher has no gimbal, tracking or library of its own; the wire does not carry them.
    gimbal: { ...base.gimbal, available: false },
    tracking: { ...base.tracking, available: false, status: 'idle', box: undefined },
    capabilities: {
      ...capabilitiesFor(model),
      gimbal: false,
      tracking: false,
      selfieFlip: false,
      media: false,
      audioControls: false,
      manualFocus: false,
      aperture: false,
    },
  };
}

/** A label for a feature the wire cannot carry. */
export function needsDirectLink(feature: string): string {
  return `${feature} needs a direct camera link`;
}

/** Copy for a control ask the lease does not allow yet. */
export function controlRefusal(control: RelayControl, holder: string): string {
  switch (control) {
    case 'available':
      return 'Control requested';
    case 'requested':
      return 'Waiting for the host';
    case 'held-by':
      return `${holder} has control`;
    case 'not-offered':
      return 'The host is not offering control';
    default:
      return '';
  }
}

export type CommandPlan = { send: RelayCommand } | { quiet: true } | { refuse: string };

export function planRecord(start: boolean, recording: boolean): CommandPlan {
  if (start === recording) return { quiet: true };
  return { send: { kind: 'toggleRecording' } };
}

export function planIso(iso: number | 'auto', state: RelayState | null): CommandPlan {
  const offered = state?.controlOptions?.isoIndices ?? [];
  const index: number | null = iso === 'auto' ? IsoIndex.auto : IsoIndexes.fromIso(iso);
  if (index == null || (offered.length > 0 && !offered.includes(index))) return { refuse: 'Not offered by the host' };
  return { send: { kind: 'setISO', index } };
}

export function planShutter(denom: number | 'auto', state: RelayState | null): CommandPlan {
  if (denom === 'auto') return { refuse: needsDirectLink('Auto shutter') };
  const offered = state?.controlOptions?.shutterDenominators ?? [];
  if (offered.length > 0 && !offered.includes(Math.round(denom))) return { refuse: 'Not offered by the host' };
  return { send: { kind: 'setShutterDenom', denominator: Math.round(denom) } };
}

export function planZoom(factor: number): CommandPlan {
  if (!Number.isFinite(factor) || factor <= 0) return { quiet: true };
  return { send: { kind: 'setZoom', hundredths: Math.round(factor * 100) } };
}

export function planWhiteBalance(change: { preset?: string; kelvin?: number; tint?: number }, current: { kelvin: number | null; tint: number | null }): CommandPlan {
  const tint = Math.round(change.tint ?? current.tint ?? 0);
  if (change.preset === 'auto') return { send: { kind: 'setWhiteBalance', mode: 0, kelvin: 0, tint } };
  const kelvin = change.kelvin ?? (change.preset === 'custom' || change.preset == null ? current.kelvin : null);
  if (kelvin == null) return { refuse: needsDirectLink('White balance presets') };
  return { send: { kind: 'setWhiteBalance', mode: 1, kelvin: Math.round(kelvin), tint } };
}

export function planColor(mode: ColorMode): CommandPlan {
  return { send: { kind: 'setColor', mode: wireColorMode(mode) } };
}

/** A tap on the fitted picture, already in picture space (0…1), as camera 0…1000 focus coordinates. */
export function planFocus(point: { x: number; y: number }): CommandPlan {
  if (![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.y < 0 || point.x > 1 || point.y > 1) return { quiet: true };
  return {
    send: { kind: 'tapFocus', cameraX: Math.round(point.x * 1000), cameraY: Math.round(point.y * 1000), coordinateWidth: 1000, coordinateHeight: 1000 },
  };
}

// ───────────────────────────── Host side ─────────────────────────────

/** "1x", "2x", "1.5x" (upstream `CamFov.displayLabel`). */
export function zoomLabel(factor: number): string {
  const r = Math.round(factor * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}x`;
}

/** The host's camera state as the state message it shares. */
export function relayStateFromCamera(state: CameraState, allowsControl: boolean): RelayState {
  const e = state.exposure;
  const photo = state.format.shootingMode === 'photo';
  const model = state.identity?.model ?? 'unknown';
  const isoIndices = e.isoOptions
    .map((v) => IsoIndexes.fromIso(v))
    .filter((i): i is IsoIndexValue => i != null);
  return {
    isRecording: state.recording.recording,
    format: state.format.resolution ? `${state.format.resolution}/${state.format.fps}` : '',
    color: photo ? 'Normal' : COLOR_LABEL[state.format.colorMode] ?? '',
    zoom: zoomLabel(state.zoom.factor),
    liveFPS: state.connection.videoFps > 0 ? String(Math.round(state.connection.videoFps)) : '',
    batteryPercent: state.power.batteryPercent,
    cameraName: state.identity?.name ?? '',
    iso: e.isoAuto || e.iso == null ? 'Auto' : String(e.iso),
    shutter: e.shutterDenom && e.shutterDenom > 0 ? `1/${e.shutterDenom}` : '',
    allowsControlRequests: allowsControl,
    controlOptions: {
      isoIndices: e.isoOptions.length ? [IsoIndex.auto, ...isoIndices] : [],
      shutterDenominators: e.shutterOptions.filter((d) => d > 0),
      zoomHundredths: state.capabilities.zoom ? state.zoom.stops.map((s) => Math.round(s * 100)) : [],
    },
    cameraModel: model === 'unknown' ? null : modelDisplayName(model),
    isNano: model === 'osmo-nano',
  };
}

const WIRE_TO_UI_COLOR: Partial<Record<number, ColorMode>> = {
  [WireColorMode.normal]: 'normal',
  [WireColorMode.hdr]: 'hlg',
  [WireColorMode.dLog]: 'dlog',
  [WireColorMode.dLog2]: 'dlog2',
  [WireColorMode.dLogM]: 'dlog-m',
  [WireColorMode.normal10]: '10bit',
};

/** What a host does with a command from the watcher holding control (`handleWatcherRelayCommand`). */
export type HostAction =
  | { kind: 'record'; start: boolean }
  | { kind: 'focus'; x: number; y: number }
  | { kind: 'iso'; value: number | 'auto' }
  | { kind: 'shutter'; denom: number }
  | { kind: 'white-balance'; preset: 'auto' | 'custom'; kelvin?: number; tint: number }
  | { kind: 'color'; mode: ColorMode }
  | { kind: 'zoom'; factor: number };

export function hostActionFor(command: RelayCommand, state: CameraState): HostAction | null {
  switch (command.kind) {
    case 'toggleRecording':
      return { kind: 'record', start: !state.recording.recording };
    case 'tapFocus': {
      const { cameraX: x, cameraY: y, coordinateWidth: w, coordinateHeight: h } = command;
      return { kind: 'focus', x: w > 0 ? Math.min(1, Math.max(0, x / w)) : 0.5, y: h > 0 ? Math.min(1, Math.max(0, y / h)) : 0.5 };
    }
    case 'setISO': {
      if (command.index === IsoIndex.auto) return { kind: 'iso', value: 'auto' };
      const value = IsoIndexes.value(command.index as IsoIndexValue);
      return value == null ? null : { kind: 'iso', value };
    }
    case 'setShutterDenom':
      return command.denominator > 0 ? { kind: 'shutter', denom: command.denominator } : null;
    case 'setWhiteBalance':
      return command.mode === 0
        ? { kind: 'white-balance', preset: 'auto', tint: command.tint }
        : { kind: 'white-balance', preset: 'custom', kelvin: command.kelvin, tint: command.tint };
    case 'setColor': {
      const mode = WIRE_TO_UI_COLOR[command.mode];
      return mode ? { kind: 'color', mode } : null;
    }
    case 'setZoom':
      return command.hundredths > 0 ? { kind: 'zoom', factor: command.hundredths / 100 } : null;
  }
}
