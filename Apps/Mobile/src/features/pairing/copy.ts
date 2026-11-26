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
  preCheck: 'Before pairing, turn off DJI Frame Tap and force quit DJI Mimo.',
  scanEmptyTitle: 'Still looking',
  scanEmptyHint:
    'Turn off DJI Frame Tap and force quit DJI Mimo on every phone near the camera. Make sure the camera is on and activated, then move closer.',
  pairingDeferred:
    'The camera is not ready to pair again yet. Force quit DJI Mimo on every phone near the camera, wait a few seconds, then try again.',
  datalinkSilent:
    'The camera did not answer over its Wi-Fi. Turn off DJI Frame Tap and force quit DJI Mimo on every phone near the camera, pause any VPN or ad blocker, then try again.',
  bluetoothTimedOut:
    "The camera didn't respond in time. Check Bluetooth, turn off DJI Frame Tap and force quit DJI Mimo on every phone near the camera, then try again.",
  bluetoothEnded:
    'The camera ended the connection. Turn off DJI Frame Tap and force quit DJI Mimo on every phone near the camera, then try again.',
} as const;

/** Raw session errors → operator copy (`StartupConnectionCopy.friendly`). */
export function friendlyConnectionError(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'The connection stopped. Check the camera is on and nearby, then try again.';
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

/** The pair wizard: four pages, the same titles and rail captions on every platform. */
export const PairingWizardCopy = {
  titles: ['Find your camera', 'Approve on the camera', 'Join camera Wi-Fi', 'Open video link'],
  rail: ['Bluetooth scan', 'Camera prompt', 'Camera network', 'Video link'],
  bodies: [
    'Turn the camera on and keep the phone nearby. Pocket and Nano both appear. Choose the one you want.',
    "If the camera shows Approve, tap it on that camera's screen. First-time pairing can wait up to 90 seconds.",
    "We read the camera's network over Bluetooth, then join its Wi-Fi for you.",
    'Exposure, LUTs and scopes go live as soon as the video link is up.',
  ],
  approveLines: ['Look for an Approve / pairing prompt', 'Tap it on the camera screen'],
  approvePhoneLines: ['Wait here, we keep the Bluetooth link alive', "Don't force-quit the app"],
  joinLines: [
    'Leave the camera on. It brings up its own Wi-Fi',
    'On 5.8 GHz that can take about a minute; we keep trying',
  ],
  joinPhoneLines: [
    'Tap Join when the phone asks to join the camera network',
    'Pause any VPN or ad blocker, or exclude this app from it',
  ],
  hints: [
    'Choose the camera that matches your screen',
    'Nothing to type. Approve it on the camera',
    'The phone asks to join the camera network',
    'Monitoring opens when the picture is ready',
  ],
} as const;

/** Permission explainer before the first Bluetooth scan. */
export const PermissionCopy = {
  title: 'Before we look for cameras',
  body: `${app} pairs over Bluetooth, then talks to the camera over Wi-Fi. Your phone asks for each permission once.`,
  items: [
    { id: 'bluetooth', title: 'Bluetooth', detail: 'Finds the camera and hands over its Wi-Fi.' },
    { id: 'localNetwork', title: 'Local Network', detail: 'Carries the live picture and camera controls.' },
    { id: 'location', title: 'Location (Wi-Fi name only)', detail: 'The phone needs it to read the camera network name. No GPS is stored.' },
  ],
  action: 'Continue',
} as const;

export type SetupKind = 'softap' | 'hotspot' | 'station';

/** Setup chooser copy (`StationNetworkSetupRules.copy`), in the order every app lists routes. */
export const SetupChooserCopy: Record<SetupKind, { title: string; body: string; tag: string; action: string; id: string }> = {
  softap: {
    id: 'cameraAccessPoint',
    title: 'Camera Wi-Fi',
    body: 'This phone joins the camera’s own Wi-Fi. No router or hotspot needed.',
    tag: 'Best in the field with one camera',
    action: 'Choose camera Wi-Fi',
  },
  station: {
    id: 'wifi',
    title: 'Wi-Fi',
    body: 'A router, venue network or another device’s hotspot. Cameras and this phone join the same Wi-Fi.',
    tag: 'Best for studios and several cameras',
    action: 'Choose Wi-Fi',
  },
  hotspot: {
    id: 'phoneHotspot',
    title: 'Hotspot',
    body: 'This phone’s Personal Hotspot. Works anywhere you have cellular.',
    tag: 'Best on the move',
    action: 'Choose hotspot',
  },
};

export const setupOrder: SetupKind[] = ['softap', 'station', 'hotspot'];

export const SetupChooserText = {
  title: 'How should this camera connect?',
  footer: 'Camera Wi-Fi stays available. Switch setups from the camera’s chips at any time.',
} as const;

export const NetworkSetupCopy = {
  networkTitle: 'Choose the network',
  networkHint: 'The camera and this phone must be on the same Wi-Fi.',
  beforeYouConnect: 'BEFORE YOU CONNECT',
  checks: [
    { title: 'WPA2 or WPA2/WPA3 mixed', detail: 'WPA3-only networks can refuse some cameras.' },
    { title: 'Devices can see each other', detail: 'Guest networks with client isolation block the picture.' },
    { title: 'Camera within range', detail: 'The camera leaves its own Wi-Fi and joins this one.' },
  ],
  passwordSaved: 'Saved on this phone in secure storage. Multiview can reuse it.',
  openNetwork: 'Leave it empty only for an open network.',
  hotspotChecklistTitle: 'IN SETTINGS › PERSONAL HOTSPOT',
  hotspotChecks: [
    { title: 'Allow Others to Join', detail: 'Lets the camera join without a prompt.' },
    { title: 'Maximize Compatibility', detail: 'Uses 2.4 GHz, which every Osmo camera supports.' },
  ],
  hotspotNameHint: 'This phone’s name, as in Settings › General › About › Name.',
  hotspotPasswordHint: 'Copy it from Settings › Personal Hotspot once. It is remembered here.',
  hotspotNotDetected: 'Personal Hotspot not detected yet. It can appear once the camera joins.',
  scanQr: 'Scan Wi-Fi QR code',
  scanQrHint: 'Point the camera at a Wi-Fi QR code, e.g. on a router or a phone’s Share Wi-Fi screen.',
  scanQrUnavailable: 'QR scanning needs the phone app. Type the network name and password instead.',
} as const;

/** Session recovery card copy (`SessionRecoveryCopy`). */
export const SessionRecoveryCopy = {
  retryingTitle: 'Reconnecting…',
  waitingTitle: 'Camera disconnected',
  retrying: (camera: string) =>
    `${camera} dropped off. Holding the last frame while we reconnect. This can take up to 2 minutes.`,
  waiting: (camera: string) =>
    `${camera} didn't come back. Turn the camera off and on, then tap Retry. The frame below is held, not live.`,
  retryAction: 'Retry connection',
  menuAction: 'Operator menu',
} as const;
