/**
 * Connect-spine stages, their operator copy, and the failure → copy map. Pure: no I/O.
 *
 * Spine (CONTEXT.md): BLE → pairing/auth → Wi-Fi handoff → join → UDP datalink → live view.
 * Order follows OpenCine `DjiAppleConnectionRun.run` and the desktop shell
 * (`Apps/Desktop/crates/opc-camera/src/{pairing,session}.rs`).
 */
import type { WifiJoinResult } from '@modules/pocket-native/src/types';
import { CameraSoftAPSwitch } from '@/core/connection/cameraSoftAP';
import { STATION_JOIN_MESSAGES, type StationJoinFailure } from '@/core/ble/stationJoin';
import type { ConnectionPhase } from '../types';

/** Every step the native connect walks through, in order. */
export type ConnectStage =
  | 'scanning'
  | 'bluetooth'
  | 'pairing'
  | 'awaiting-approval'
  | 'wifi-handoff'
  | 'joining-wifi'
  | 'joining-host-wifi'
  | 'station-join'
  | 'datalink'
  | 'registering'
  | 'live-start'
  | 'waiting-picture'
  | 'waiting-picture-slow';

export const CONNECT_STAGE_ORDER: ConnectStage[] = [
  'scanning',
  'bluetooth',
  'pairing',
  'awaiting-approval',
  'wifi-handoff',
  'joining-wifi',
  'joining-host-wifi',
  'station-join',
  'datalink',
  'registering',
  'live-start',
  'waiting-picture',
  'waiting-picture-slow',
];

export function stagePhase(stage: ConnectStage): ConnectionPhase {
  switch (stage) {
    case 'scanning':
      return 'scanning';
    case 'bluetooth':
      return 'bluetooth';
    case 'pairing':
    case 'awaiting-approval':
      return 'authorizing';
    case 'wifi-handoff':
      return 'wifi-handoff';
    case 'joining-wifi':
    case 'joining-host-wifi':
    case 'station-join':
      return 'joining-wifi';
    case 'datalink':
    case 'registering':
      return 'datalink';
    case 'live-start':
    case 'waiting-picture':
    case 'waiting-picture-slow':
      return 'live-start';
  }
}

export function stageDetail(stage: ConnectStage, ctx: { ssid?: string | null; name?: string | null } = {}): string {
  switch (stage) {
    case 'scanning':
      return 'Looking for the camera';
    case 'bluetooth':
      return 'Connecting over Bluetooth';
    case 'pairing':
      return 'Pairing with the camera';
    case 'awaiting-approval':
      return 'Approve this phone on the camera screen';
    case 'wifi-handoff':
      return 'Camera is sharing its Wi-Fi';
    case 'joining-wifi':
      return ctx.ssid ? `Joining ${ctx.ssid}` : 'Joining camera Wi-Fi';
    case 'joining-host-wifi':
      return ctx.ssid ? `Joining ${ctx.ssid} on this phone` : 'Joining the shared Wi-Fi';
    case 'station-join':
      return ctx.ssid ? `Camera is joining ${ctx.ssid}` : 'Camera is joining the shared Wi-Fi';
    case 'datalink':
      return 'Opening the camera link';
    case 'registering':
      return 'Registering with the camera';
    case 'live-start':
      return 'Starting live view';
    case 'waiting-picture':
      return 'Waiting for the first picture';
    case 'waiting-picture-slow':
      return 'Still waiting for the picture. A VPN or ad blocker on this phone can block live view; turn it off and retry.';
  }
}

export type ConnectFailure =
  | { kind: 'no-native-io' }
  | { kind: 'bluetooth-power'; state: string }
  | { kind: 'bluetooth-permission' }
  | { kind: 'camera-not-found' }
  | { kind: 'ble-connect'; message?: string }
  | { kind: 'ble-dropped'; during: string }
  | { kind: 'pairing-timeout' }
  | { kind: 'pairing-deferred' }
  | { kind: 'credentials-refused'; which: 'ssid' | 'password' }
  | { kind: 'credentials-timeout'; which: 'ssid' | 'password' }
  | { kind: 'ssid-conflict'; ssid: string }
  | { kind: 'wifi-join'; outcome: WifiJoinResult['outcome']; ssid: string; message?: string }
  | { kind: 'saved-password-missing'; ssid: string }
  | { kind: 'station'; failure: StationJoinFailure }
  | { kind: 'station-no-host'; ssid: string }
  | { kind: 'datalink-open'; message?: string }
  | { kind: 'datalink-handshake' }
  | { kind: 'local-network-denied' }
  | { kind: 'unknown'; message: string };

export class ConnectError extends Error {
  constructor(readonly failure: ConnectFailure) {
    super(connectFailureCopy(failure));
    this.name = 'ConnectError';
  }
}

/** Raised inside a connect attempt that was superseded by disconnect / a newer connect. */
export class ConnectCancelled extends Error {
  constructor() {
    super('Connect cancelled');
    this.name = 'ConnectCancelled';
  }
}

/** Operator copy for a failure, with the fix where there is one. */
export function connectFailureCopy(f: ConnectFailure): string {
  switch (f.kind) {
    case 'no-native-io':
      return 'This build has no camera radio support. Use a development build on a phone, or the demo camera.';
    case 'bluetooth-power':
      if (f.state === 'unauthorized') return 'Bluetooth access is off for Pocket Monitor. Allow it in Settings, then retry.';
      if (f.state === 'unsupported') return 'This phone has no Bluetooth LE.';
      return 'Bluetooth is off. Turn it on, then retry.';
    case 'bluetooth-permission':
      return 'Bluetooth access is off for Pocket Monitor. Allow it in Settings, then retry.';
    case 'camera-not-found':
      return 'The camera did not answer over Bluetooth. Wake it, keep it within a few metres, then retry.';
    case 'ble-connect':
      return 'Could not connect to the camera over Bluetooth. Restart the camera and retry.';
    case 'ble-dropped':
      return 'The camera dropped Bluetooth while pairing. Keep it close and retry.';
    case 'pairing-timeout':
      return 'The camera did not finish pairing. Approve the request on the camera screen, then retry.';
    case 'pairing-deferred':
      return 'The camera is busy and deferred pairing. Wait a moment, then retry.';
    case 'credentials-refused':
      return f.which === 'ssid'
        ? 'The camera would not share its Wi-Fi name. Restart the camera and pair again.'
        : 'The camera would not share its Wi-Fi password. Restart the camera and pair again.';
    case 'credentials-timeout':
      return 'The camera did not send its Wi-Fi details in time. Keep it close and retry.';
    case 'ssid-conflict':
      return `${f.ssid} looks like another camera's Wi-Fi. Check you picked the right camera.`;
    case 'wifi-join':
      return wifiJoinCopy(f.outcome, f.ssid);
    case 'saved-password-missing':
      return `The password for ${f.ssid} is not saved on this phone. Set up the network again.`;
    case 'station':
      return STATION_JOIN_MESSAGES[f.failure];
    case 'station-no-host':
      return `The camera joined ${f.ssid}, but this build cannot find it on that network yet. Use camera Wi-Fi instead.`;
    case 'datalink-open':
      return 'Joined the camera Wi-Fi but could not open the camera link. Retry; if it keeps failing, restart the camera.';
    case 'datalink-handshake':
      return 'The camera did not answer on its Wi-Fi. Make sure this phone is still on the camera network, then retry.';
    case 'local-network-denied':
      return 'Local Network access is off for Pocket Monitor. Allow it in Settings → Privacy → Local Network, then retry.';
    case 'unknown':
      return f.message || 'Something went wrong while connecting. Retry.';
  }
}

export function wifiJoinCopy(outcome: WifiJoinResult['outcome'], ssid: string): string {
  switch (outcome) {
    case 'user-denied':
      return `Joining ${ssid} was cancelled. Tap Join when the phone asks, then retry.`;
    case 'not-found':
      return `${ssid} is not in range yet. ${CameraSoftAPSwitch.frequencyHint}`;
    case 'wrong-password':
      return `The camera rejected the Wi-Fi password for ${ssid}. Pair the camera again.`;
    case 'timeout':
      return `This phone did not join ${ssid} in time. ${CameraSoftAPSwitch.frequencyHint}`;
    default:
      return `Could not join ${ssid}. Retry, or forget the network in Wi-Fi settings and pair again.`;
  }
}

/** `PocketWifi.join` result → failure, or null when the phone is on the network. */
export function wifiJoinFailure(result: WifiJoinResult, ssid: string): ConnectFailure | null {
  if (result.joined || result.outcome === 'joined' || result.outcome === 'already-associated') return null;
  return { kind: 'wifi-join', outcome: result.outcome, ssid, message: result.message };
}

/** True when a join failure says the cached credentials themselves are wrong (drop them). */
export function joinRejectsCredentials(outcome: WifiJoinResult['outcome']): boolean {
  // iOS reports a wrong WPA passphrase as a timeout (README "PocketWifi"), so both count.
  return outcome === 'wrong-password' || outcome === 'timeout';
}

/** Datalink `failed` event → failure. */
export function datalinkFailure(error: string | undefined): ConnectFailure {
  if (error && /local\s*network/i.test(error)) return { kind: 'local-network-denied' };
  return { kind: 'datalink-open', message: error };
}

/** Anything thrown inside connect → failure copy. */
export function failureOf(error: unknown): ConnectFailure {
  if (error instanceof ConnectError) return error.failure;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return { kind: 'unknown', message };
}
