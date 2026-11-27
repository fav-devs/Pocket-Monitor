import { modelDisplayName } from '@/camera/defaults';
import type { CameraNetworkPath, ConnectionPhase, ConnectionState, SavedCamera } from '@/camera/types';

/** Bluetooth RSSI → 0…4 bars for the scan list. */
export function rssiToBars(rssi: number): number {
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  if (rssi >= -85) return 1;
  return 0;
}

export function pathKindTitle(kind: CameraNetworkPath['kind']): string {
  switch (kind) {
    case 'softap':
      return 'Camera Wi-Fi';
    case 'station':
      return 'Wi-Fi';
    case 'hotspot':
      return 'Hotspot';
  }
}

/** "Camera Wi-Fi · OsmoPocket-1A2B". */
export function pathLabel(path: CameraNetworkPath): string {
  return path.ssid ? `${pathKindTitle(path.kind)} · ${path.ssid}` : pathKindTitle(path.kind);
}

export function relativeTime(at: number | undefined, now = Date.now()): string {
  if (!at) return 'Never connected';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}

export function savedSubtitle(camera: SavedCamera): string {
  return `${modelDisplayName(camera.model)} · ${pathKindTitle(camera.path.kind)}`;
}

export type StepState = 'done' | 'active' | 'waiting';

export interface SpineStep {
  id: 'bluetooth' | 'approve' | 'wifi' | 'datalink' | 'live';
  title: string;
  subtitle?: string;
  state: StepState;
  stateLabel: string;
}

const order: ConnectionPhase[] = [
  'idle',
  'scanning',
  'bluetooth',
  'authorizing',
  'wifi-handoff',
  'joining-wifi',
  'datalink',
  'live-start',
  'live',
];

/** Index of a phase along the spine; failure/recovery keep the furthest reached index. */
export function phaseIndex(phase: ConnectionPhase): number {
  const i = order.indexOf(phase);
  return i < 0 ? -1 : i;
}

/**
 * The connection spine as checklist rows (BLE → approve → Wi-Fi → datalink → live view).
 * `reached` is the furthest phase seen, so a failure marks where it stalled.
 */
export function spineSteps(
  connection: ConnectionState,
  reached: ConnectionPhase,
  options: { network?: string; transport?: CameraNetworkPath['kind'] },
): SpineStep[] {
  const failed = connection.phase === 'failed' || connection.phase === 'disconnected';
  const at = phaseIndex(connection.phase === 'failed' || connection.phase === 'recovering' || connection.phase === 'disconnected' ? reached : connection.phase);
  const wifiTitle =
    options.transport === 'station' ? 'Shared Wi-Fi' : options.transport === 'hotspot' ? 'Phone hotspot' : 'Camera Wi-Fi';
  // Rows are labels; the only subtitle is a value (the network being joined).
  const rows: { id: SpineStep['id']; title: string; subtitle?: string; from: number; to: number; activeLabel: string }[] = [
    { id: 'bluetooth', title: 'Bluetooth link', from: 1, to: 3, activeLabel: 'FINDING' },
    { id: 'approve', title: 'Camera approval', from: 3, to: 4, activeLabel: 'WAITING' },
    { id: 'wifi', title: wifiTitle, subtitle: options.network, from: 4, to: 6, activeLabel: 'JOINING' },
    { id: 'datalink', title: 'Camera link', from: 6, to: 7, activeLabel: 'OPENING' },
    { id: 'live', title: 'Live picture', from: 7, to: 8, activeLabel: 'STARTING' },
  ];
  return rows.map((r) => {
    const done = at >= r.to;
    const active = !done && at >= r.from;
    let stateLabel = done ? 'OK' : active ? r.activeLabel : 'WAITING';
    if (active && failed) stateLabel = 'FAILED';
    return {
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      state: done ? 'done' : active ? 'active' : 'waiting',
      stateLabel,
    };
  });
}

/** Rail page (0…3) of the pair/connect wizard for a phase. */
export function wizardPage(phase: ConnectionPhase): number {
  const i = phaseIndex(phase);
  if (i <= 2) return 1;
  if (i <= 3) return 1;
  if (i <= 5) return 2;
  return 3;
}

export interface WifiQr {
  ssid: string;
  password: string;
  security: string;
  hidden: boolean;
}

/** Parses the standard `WIFI:T:WPA;S:name;P:secret;;` QR payload. */
export function parseWifiQr(data: string): WifiQr | null {
  if (!data.toUpperCase().startsWith('WIFI:')) return null;
  const body = data.slice(5);
  const fields: Record<string, string> = {};
  let key = '';
  let value = '';
  let readingKey = true;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      if (readingKey) key += body[++i];
      else value += body[++i];
      continue;
    }
    if (readingKey && ch === ':') {
      readingKey = false;
      continue;
    }
    if (ch === ';') {
      if (key) fields[key.toUpperCase()] = value;
      key = '';
      value = '';
      readingKey = true;
      continue;
    }
    if (readingKey) key += ch;
    else value += ch;
  }
  if (!fields.S) return null;
  return { ssid: fields.S, password: fields.P ?? '', security: fields.T ?? 'WPA', hidden: fields.H === 'true' };
}

/** Operator label for a phase (`ConnectionPhase.label`). */
export function connectionPhaseLabel(phase: ConnectionPhase): string {
  switch (phase) {
    case 'idle':
      return 'Idle';
    case 'scanning':
      return 'Scanning for camera…';
    case 'bluetooth':
      return 'Connecting (Bluetooth)…';
    case 'authorizing':
      return 'Approve on the camera screen';
    case 'wifi-handoff':
      return 'Reading Wi-Fi credentials…';
    case 'joining-wifi':
      return 'Joining camera Wi-Fi…';
    case 'datalink':
      return 'Opening datalink…';
    case 'live-start':
      return 'Starting live view…';
    case 'live':
      return 'Connected';
    case 'recovering':
      return 'Reconnecting…';
    case 'failed':
      return 'Failed';
    case 'disconnected':
      return 'Disconnected';
  }
}

/** 0…100 delivery score for the link health scale; null when there is no live picture. */
export function linkHealthScore(c: ConnectionState): number | null {
  if (c.phase !== 'live' && c.phase !== 'recovering') return null;
  if (c.phase === 'recovering') return 20;
  const fps = Math.min(1, c.videoFps / 30);
  const agePenalty = Math.max(0, (c.lastFrameAgeMs - 120) / 25);
  let score = Math.round(100 * fps - agePenalty);
  if (c.linkBand === 'poor') score = Math.min(score, 45);
  else if (c.linkBand === 'watch') score = Math.min(score, 75);
  return Math.max(0, Math.min(100, score));
}

export function linkBandForScore(score: number): 'poor' | 'watch' | 'stable' {
  return score < 50 ? 'poor' : score < 80 ? 'watch' : 'stable';
}
