/**
 * Operator help shared by the settings pages (OpenCine `MonitorSettingsCopy`, OpenPocketCine
 * `SettingsHelpCopy`). Never name a sister app or another camera brand.
 */
import { appBrand } from '@/features/startup/brand';

const app = appBrand.name;

export const SettingsCopy = {
  currentTransport:
    'Pocket uses Bluetooth to pair, then the camera’s own Wi-Fi (or a shared Wi-Fi or hotspot you set up) for HEVC.',
  phaseHelp: 'Where the BLE → Wi-Fi → datalink handshake is right now.',
  networkHelp: 'Network joined for this session. The password stays in secure storage on this phone.',
  savedHelp: 'Pair from the home list. Settings does not start a new pair; that stays on Your cameras.',
  linkHealthHelp: 'Delivery of the live picture (frame rate and freshness), not Bluetooth signal strength.',
  linkStats: 'Show FPS, bitrate and frame age beside the link chip in Live View.',
  themeHelp: 'Charcoal field-monitor chrome with Sky Blue accents, tuned for low reflection on set.',
  protocolHelp: 'Camera control speaks DUML over Bluetooth and the camera’s Wi-Fi. No DJI SDK is bundled or required.',
  versionHelp: `Current ${app} build from the native project metadata.`,
  keepScreenAwake:
    "Keeps the screen awake while this app is active. Turn off to use the device's normal auto-lock setting. The system may still dim the screen when the device is hot.",
  gimbalHaptics:
    'Short confirmation pulses for switches, settings, and gimbal limits. A connected controller also rumbles at a stop.',
  recordConfirmation: 'Ask before starting or stopping recording to prevent mistaps.',
  recordCountdown: 'Count 3-2-1 on the monitor before the camera starts recording.',
  tapToFocus: 'A single tap on the picture sets the focus point. Off keeps taps for chrome only.',
  tapToTrack: 'Touch and hold a subject to track it with the gimbal.',
  doubleTapLevel: 'Double-tap the picture to level the gimbal horizon.',
  hdrPanel:
    "Outdoor panel brightness, not a grade. WAVE, HISTO, PARADE, VECTOR, zebras and false color still read the decoded camera signal, so judge exposure there, not from how bright the picture looks. This is not the camera's HDR/HLG color mode. Off by default.",
  recordingBorder: 'A red frame around the picture while the camera records.',
  hideChrome: 'Fade the live chrome while recording. Tap the picture to bring it back.',
  pictureFit: 'Fit shows the whole frame. Fill crops the picture to the panel.',
  chromeOpacity: 'How solid the floating live chrome is over the picture.',
  remoteShutter: 'Volume buttons start and stop recording while Live View is open.',
  autoRotate: 'Rotate the feed and chrome with the phone. Off keeps the current orientation.',
  headTracking:
    'Experimental. Head turns set matching pan and tilt angles within the gimbal’s range. Needs AirPods with motion (Pro, 3, Max, or later) in your ears. Off by default. On-screen stick, a game controller, and Motion Control take priority.',
  joystickSensitivity:
    'How far a stick throw moves the gimbal, on-screen or with a connected game controller. Small throws crawl; full throw is fastest. 4 is the captured feel. 5 reaches full speed sooner; 1 is the slowest.',
  virtualJoystickSize:
    'How large the on-screen stick is. Medium is the default. Large is easier to grab; Small keeps more of the picture clear.',
  invertPan: 'Reverse left and right on the on-screen stick. Off is the default. A game controller is unchanged.',
  invertTilt: 'Reverse up and down on the on-screen stick. Off is the default. A game controller is unchanged.',
  deadZone: 'Ignore small movements near the center. The default is 8%. Increase it to make the center less sensitive.',
  response: 'Standard keeps the current feel. Linear responds evenly. Fine makes small movements gentler.',
  pictureRelative: 'Stick directions follow the picture, even when the camera faces you.',
  directionLock: 'Lock a throw to pan or tilt only, whichever moves first.',
  gimbalJoystick: 'Which analog stick pans and tilts. Left is the default. The other stick does not move the gimbal.',
  gamepad:
    'A connected game controller. The selected gimbal joystick pans and tilts. Cross/A records. Circle/B recenters. Square/X is rotate-180. Triangle/Y tracks a face. L1/R1 jump zoom out/in. L2/R2 hold-to-zoom (deeper is faster). D-pad up/down ISO, left/right shutter.',
  programLegs: 'Seconds the gimbal takes for each leg of an A → B → C move.',
  programSmoothness: 'Eases the start and end of each leg. 0 moves at constant speed.',
  evMeter:
    "Show the camera's exposure meter at the picture's left edge in DISP 1. Auto and Manual use the camera reading without changing exposure settings.",
  look: 'Looks apply on this phone. The file on the camera is unchanged.',
  shutterAngle: 'Show shutter as a cinema angle (180°) instead of a speed (1/50) in video.',
  shareThisFeed: 'Watching devices join this camera’s Wi-Fi, then receive the shared picture from this phone.',
  broadcastPriority: 'Steadier picture uses more delay when the radio is busy.',
  watcherPasscode: 'Watchers enter this once. Leave empty for an open feed.',
  controlRequests: 'A watcher can ask to record, focus, and change exposure. You grant or deny on this phone.',
  joinWifi: 'On the watching device, scan this code with Camera, join the Wi-Fi, then open Watch a feed.',
  cacheFullResolution:
    'Download the original camera file when you open a clip. Off keeps only the 720p proxy to save space. Share needs the original, so connect the camera if it is not cached.',
  clearCache: 'Removes downloaded clip files, thumbnails, and camera indexes for every camera. The on-device library is left intact.',
  cacheScope: 'Clips, thumbnails and indexes downloaded from every camera on this phone.',
  demoMode: 'Start the simulated camera from Your cameras without hardware. The web preview always runs the demo.',
  resetSettings: 'Return every operator preference on this phone to its default. Saved cameras are kept.',
  forgetCameras: 'Remove every saved camera and its Wi-Fi password from this phone.',
  report: 'Tell us what happened in the app. Choose whether to include technical details and an email for a reply.',
  shareDiagnostics:
    'Saves a report with connection events, warnings, and errors. No name, location, or Wi-Fi password. Share it with support or paste it into beta feedback.',
  automaticReportsUnavailable:
    'This build cannot send automatic reports. You can still share a report from this phone.',
  deleteReports: 'Remove the connection events kept in memory for diagnostics.',
  sourceHelp: `View the ${app} project on GitHub. Opening this may leave the camera Wi-Fi if that is the only network.`,
  termsHelp: `How you can use ${app}.`,
  browserConfirmation: (title: string) =>
    `To open ${title}, ${app} may disconnect from the camera's Wi-Fi and switch to cellular or another internet-connected Wi-Fi network. You can reconnect to the camera after you finish.`,
} as const;
