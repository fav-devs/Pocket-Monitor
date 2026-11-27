/**
 * BLE pairing / authorisation and Wi-Fi credential handoff — the pure decisions of the BLE leg.
 *
 * Sequence (written to FFF5, notifications on FFF4, frames reassembled by DumlNotificationAssembler):
 *   1. `0x00/0x2B 04 00` session wake            → `Commands.sessionWake()`
 *   2. `0x07/0x45` SetPairingPIN(identifier, token) → reply `00 01` paired, `00 02` approve on camera,
 *      `00 06` deferred (disconnect, wait 3 s, retry ≤ 2)
 *   3. camera's `0x07/0x46` *request* = approval → answer `pairApprovalAck(seq)` (flags 0xC0)
 *   4. `0x53/0x10` wake the AP (Pocket 3 often answers e0 / silent; continue after 2 s)
 *   5. `0x07/0x07` GetSSID, `0x07/0x0E` GetPassword → `[status][len][utf8]`, 4 s timeout, 12 s budget
 *
 * Source of truth: OpenCine `OpenCineDJIApple/DjiAppleConnectionRun.swift` (`completePairing`,
 * `wifiCredentials`, `wifiString`) and `DjiAppleControlExchange.swift` (0x46 auto-ack).
 * NATIVE: the BLE transport (CoreBluetooth / Android BLE, MTU, write pacing) is native; JS drives
 * this sequence using the frames and decisions below.
 */
import type { ByteInput } from '../bytes';
import { Commands } from '../commands/commands';
import { type DumlFrame, unpackStatusString } from '../duml/frame';
import { type CameraModel, pairingToken } from '../status/cameraModel';

export const PAIRING_REPLY_TIMEOUT_S = 90;
export const PAIRING_DEFERRED_RETRIES = 2;
export const PAIRING_RETRY_PAUSE_S = 3;
export const AP_WAKE_TIMEOUT_S = 2;
export const WIFI_STRING_ATTEMPT_TIMEOUT_S = 4;
export const WIFI_STRING_BUDGET_S = 12;
export const WIFI_STRING_RETRY_PAUSE_S = 0.4;

/** Frames that open pairing: wake then SetPairingPIN with the body's token. */
export function pairingFrames(model: CameraModel): DumlFrame[] {
  return [Commands.sessionWake(), Commands.setPairingPin(pairingToken(model))];
}

/** Waiter opcodes for each BLE step (set, cmd). */
export const PAIRING_REPLY_OPCODES: Array<[number, number]> = [
  [0x07, 0x45],
  [0x07, 0x46],
];

export type PairingOutcome = 'paired' | 'awaitApproval' | 'deferred' | 'approved' | 'ignore';

/**
 * Decide what a BLE frame means for pairing. `0x07/0x45 [00 01]` already paired, `[00 02]` the
 * operator must approve on the camera (then wait for 0x46), `[00 06]` deferred.
 */
export function pairingOutcome(frame: DumlFrame): PairingOutcome {
  if (frame.cmdSet === 0x07 && frame.cmdId === 0x46) return 'approved';
  if (frame.cmdSet !== 0x07 || frame.cmdId !== 0x45 || frame.payload.length < 2) return 'ignore';
  switch (frame.payload[1]) {
    case 2:
      return 'awaitApproval';
    case 6:
      return 'deferred';
    default:
      return 'paired';
  }
}

/** The camera's approval arrives as a `0x07/0x46` request (response bit clear); ack it. */
export function isPairApprovalRequest(frame: DumlFrame): boolean {
  return frame.cmdSet === 0x07 && frame.cmdId === 0x46 && (frame.flags & 0x80) === 0;
}
export function pairApprovalResponse(frame: DumlFrame): DumlFrame | null {
  return isPairApprovalRequest(frame) ? Commands.pairApprovalAck(frame.seq) : null;
}

/** AP wake `0x53/0x10`; the reply is optional. */
export const apWakeFrame = () => Commands.session5310();

export type WifiStringReply = { kind: 'value'; value: string } | { kind: 'refused'; status: number } | { kind: 'empty'; status: number };

/** Decode a GetSSID / GetPassword reply. Short or `0xE0…0xEF` status is a refusal. */
export function wifiStringReply(payload: ByteInput): WifiStringReply {
  const status = payload.length > 0 ? payload[0] : 0xff;
  const value = unpackStatusString(payload);
  if (value) return { kind: 'value', value };
  if (payload.length <= 1 || (status >= 0xe0 && status <= 0xef)) return { kind: 'refused', status };
  return { kind: 'empty', status };
}

export interface WifiCredentials {
  ssid: string;
  password: string;
}

/** Wi-Fi handoff frames (BLE message ids default per Osmosis). */
export const wifiCredentialFrames = () => ({ ssid: Commands.getWifiSsid(), password: Commands.getWifiPassword() });
