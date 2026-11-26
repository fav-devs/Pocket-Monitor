/**
 * Connection phase (Bluetooth → Wi-Fi → datalink), connect timeline marks, and the map onto the
 * UI contract's `ConnectionPhase` in src/camera/types.ts.
 * Source of truth: fork `ConnectionPhase.swift` / OpenCine `CameraConnectionPhase.swift`,
 * `OpenCineDJI/ConnectTimeline.swift`.
 */
import type { ConnectionPhase as UIConnectionPhase } from '../../camera/types';

export type CameraConnectionPhase =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  /** GATT connect + notifications + arm pairing */
  | { kind: 'connectingGatt' }
  /** SetPairingPIN sent */
  | { kind: 'pairing' }
  /** camera showed a prompt — user must tap it */
  | { kind: 'awaitingApproval' }
  /** asking the camera for its SSID + passphrase */
  | { kind: 'readingWifiCreds' }
  | { kind: 'joiningWifi' }
  /** UDP handshake + register + subscribe */
  | { kind: 'openingDatalink' }
  | { kind: 'live' }
  | { kind: 'failed'; reason: string };

export function phaseLabel(p: CameraConnectionPhase): string {
  switch (p.kind) {
    case 'idle':
      return 'Idle';
    case 'scanning':
      return 'Scanning for camera…';
    case 'connectingGatt':
      return 'Connecting (Bluetooth)…';
    case 'pairing':
      return 'Pairing…';
    case 'awaitingApproval':
      return 'Approve on the camera screen';
    case 'readingWifiCreds':
      return 'Reading Wi-Fi credentials…';
    case 'joiningWifi':
      return 'Joining camera Wi-Fi…';
    case 'openingDatalink':
      return 'Opening datalink…';
    case 'live':
      return 'Connected';
    case 'failed':
      return `Failed: ${p.reason}`;
  }
}

export const isTerminalFailure = (p: CameraConnectionPhase) => p.kind === 'failed';

/**
 * Map the core phase onto the UI checklist phase. `liveViewStarted` distinguishes datalink
 * registered (`live-start`) from a presented picture (`live`); `recovering` overrides.
 */
export function toUIConnectionPhase(p: CameraConnectionPhase, opts: { pictureLive?: boolean; recovering?: boolean } = {}): UIConnectionPhase {
  if (opts.recovering && p.kind !== 'failed' && p.kind !== 'idle') return 'recovering';
  switch (p.kind) {
    case 'idle':
      return 'idle';
    case 'scanning':
      return 'scanning';
    case 'connectingGatt':
      return 'bluetooth';
    case 'pairing':
    case 'awaitingApproval':
      return 'authorizing';
    case 'readingWifiCreds':
      return 'wifi-handoff';
    case 'joiningWifi':
      return 'joining-wifi';
    case 'openingDatalink':
      return 'datalink';
    case 'live':
      return opts.pictureLive ? 'live' : 'live-start';
    case 'failed':
      return 'failed';
  }
}

/** Monotonic connect-path marks: `connect: gatt=0.40s pair=1.10s path=3.20s`. */
export class ConnectTimeline {
  private marks: Array<{ name: string; at: number }> = [];
  constructor(private readonly t0: number) {}
  mark(name: string, now: number): void {
    this.marks.push({ name, at: now });
  }
  line(): string {
    if (!this.marks.length) return 'connect:';
    return `connect: ${this.marks.map((m) => `${m.name}=${(m.at - this.t0).toFixed(2)}s`).join(' ')}`;
  }
}
