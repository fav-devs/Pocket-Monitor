/**
 * Operator copy for startup, pairing and connection (ported from OpenPocketCine
 * `StartupConnectionCopy`, `AppModel.pairingWizard()`, OpenCine `PairingWizard`,
 * `StationNetworkSetupRules` and `SessionRecoveryCopy`). Never name sister apps or other brands.
 */
import { appBrand } from '@/features/startup/brand';

const app = appBrand.name;

export const StartupConnectionCopy = {
  openSettings: 'Open Settings',
  localNetworkDenied: `${app} needs Local Network access to reach the camera. Open Settings, turn on Local Network for ${app}, then try again.`,
  bluetoothDenied: `${app} needs Bluetooth access to find the camera. Open Settings, turn on Bluetooth for ${app}, then try again.`,
  bluetoothOff: 'Bluetooth is off. Turn it on in Control Center or Settings, then try again.',
  bluetoothNotReady: 'Bluetooth is not ready yet. Try again in a moment.',
  personalHotspotOn:
    'Turn off Personal Hotspot, then try again. While it is on, this iPhone cannot join the camera Wi-Fi.',
  preCheckTitle: 'Check first',
  preCheck: 'Turn off DJI Frame Tap and force quit DJI Mimo.',
  scanEmptyTitle: 'Still looking',
  scanEmptyHint: 'Move closer. Turn off Frame Tap and force quit DJI Mimo on nearby phones.',
  pairingDeferred: 'The camera is not ready to pair yet. Force quit DJI Mimo on nearby phones, then try again.',
  datalinkSilent:
    "The camera didn't answer over Wi-Fi. Force quit DJI Mimo on nearby phones, pause any VPN, then try again.",
  bluetoothTimedOut: "The camera didn't respond. Turn off Frame Tap and force quit DJI Mimo on nearby phones, then try again.",
  bluetoothEnded: 'The camera ended the connection. Force quit DJI Mimo on nearby phones, then try again.',
} as const;

/** Raw session errors → operator copy (`StartupConnectionCopy.friendly`). */
export function friendlyConnectionError(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'The connection stopped. Check the camera is on and nearby.';
  const lower = trimmed.toLowerCase();
  if (lower.includes('datalink handshake') || lower.includes('not ready for the datalink')) {
    return StartupConnectionCopy.datalinkSilent;
  }
  if (lower.includes('timed out') || lower.includes('timeout')) return StartupConnectionCopy.bluetoothTimedOut;
  if (lower.includes('disconnected') || lower.includes('camera disappeared')) return StartupConnectionCopy.bluetoothEnded;
  return trimmed;
}

/** Failures only iOS/Android Settings can fix get an Open Settings action. */
export function opensSettings(raw: string | undefined): boolean {
  return raw === StartupConnectionCopy.localNetworkDenied || raw === StartupConnectionCopy.bluetoothDenied;
}

/** The pair wizard: four pages, the same titles on every platform. */
export const PairingWizardCopy = {
  titles: ['Find your camera', 'Approve on the camera', 'Join camera Wi-Fi', 'Open video link'],
  /** One line per page; only what the operator has to do. */
  bodies: [
    'Turn the camera on and keep it close.',
    'Can take 90 seconds. Keep this app open.',
    'Tap Join when the phone asks. Pause any VPN or ad blocker.',
    '',
  ],
} as const;

/** Permission explainer before the first Bluetooth scan. */
export const PermissionCopy = {
  title: 'Allow access',
  items: [
    { id: 'bluetooth', title: 'Bluetooth' },
    { id: 'localNetwork', title: 'Local Network' },
    { id: 'location', title: 'Location (Wi-Fi name only)' },
  ],
  action: 'Continue',
} as const;

export type SetupKind = 'softap' | 'hotspot' | 'station';

/** Setup chooser copy (`StationNetworkSetupRules.copy`), in the order every app lists routes. */
export const SetupChooserCopy: Record<SetupKind, { title: string; body: string; action: string; id: string }> = {
  softap: {
    id: 'cameraAccessPoint',
    title: 'Camera Wi-Fi',
    body: 'The camera’s own network',
    action: 'Choose camera Wi-Fi',
  },
  station: {
    id: 'wifi',
    title: 'Wi-Fi',
    body: 'A router or venue network',
    action: 'Choose Wi-Fi',
  },
  hotspot: {
    id: 'phoneHotspot',
    title: 'Hotspot',
    body: 'This phone’s Personal Hotspot',
    action: 'Choose hotspot',
  },
};

export const setupOrder: SetupKind[] = ['softap', 'station', 'hotspot'];

export const SetupChooserText = {
  title: 'How it connects',
} as const;

export const NetworkSetupCopy = {
  networkTitle: 'Choose the network',
  networkHint: 'This phone must be on the same Wi-Fi.',
  /** The one constraint that silently breaks a shared network. */
  networkRules: 'WPA2 only. Guest networks with client isolation won’t work.',
  passwordTooShort: 'At least 8 characters.',
  hotspotChecks: ['Allow Others to Join', 'Maximize Compatibility'],
  hotspotNameHint: 'As in Settings › General › About › Name.',
  scanQr: 'Scan Wi-Fi QR code',
  scanQrUnavailable: 'Phone app only',
} as const;

/** Session recovery card copy (`SessionRecoveryCopy`). */
export const SessionRecoveryCopy = {
  retryingTitle: 'Reconnecting…',
  waitingTitle: 'Camera disconnected',
  retrying: 'This can take up to 2 minutes.',
  waiting: 'Turn the camera off and on, then retry.',
  retryAction: 'Retry connection',
  menuAction: 'Operator menu',
} as const;
