/**
 * The few lines of operator help the settings pages keep (OpenCine `MonitorSettingsCopy`, OpenPocketCine
 * `SettingsHelpCopy`). Rows are labels and values; a line lives here only when an operator would otherwise
 * make a mistake or get stuck. Never name a sister app or another camera brand.
 */
export const SettingsCopy = {
  hdrPanel: 'Panel brightness only. Judge exposure on the scopes.',
  hideChrome: 'Tap the picture to bring it back.',
  remoteShutter: 'Volume buttons',
  headTracking: 'Needs AirPods Pro, 3, Max or later.',
  headTrackingPlatform: 'iPhone only.',
  noGimbal: 'Needs a camera with a gimbal.',
  programMoves: 'Set A, B and C from the gimbal sheet in Live View.',
  look: 'Monitor only. The camera file is unchanged.',
  exposureInLive: 'Change exposure in Live View.',
  shareNeedsCamera: 'Connect a camera to share its feed.',
  relayPending: 'Relay hosting comes in a later build.',
  joinWifi: 'Scan with Camera, then open Watch a feed.',
  previewCode: 'Preview code. Not scannable yet.',
  webDemo: 'Web always runs the demo.',
  clearCache: 'Removes downloaded clips and thumbnails. The on-device library stays.',
  resetSettings: 'Every preference goes back to its default. Saved cameras stay.',
  forgetCameras: (n: number) => `Removes ${n} saved ${n === 1 ? 'camera' : 'cameras'} and their Wi-Fi passwords.`,
  browserConfirmation: 'This may leave the camera Wi-Fi to reach the internet.',
} as const;

/** The game controller's button map, as label → action rows. */
export const GamepadButtons: readonly [string, string][] = [
  ['Cross / A', 'Record'],
  ['Circle / B', 'Recenter'],
  ['Square / X', 'Rotate 180°'],
  ['Triangle / Y', 'Track face'],
  ['L1 / R1', 'Zoom out / in'],
  ['L2 / R2', 'Hold to zoom'],
  ['D-pad ↑ ↓', 'ISO'],
  ['D-pad ← →', 'Shutter'],
];
