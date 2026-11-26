/**
 * Operator Setup navigation vocabulary (`MonitorSettingsTab`), one entry per section page.
 * Ids are stable route segments: `/settings/<id>`.
 */
export type SettingsSectionId =
  | 'connection'
  | 'display'
  | 'operator'
  | 'input'
  | 'motion'
  | 'exposure'
  | 'assists'
  | 'media'
  | 'sharing'
  | 'storage'
  | 'support'
  | 'about';

export interface SettingsSectionInfo {
  id: SettingsSectionId;
  title: string;
  /** Second line in the navigation rail. */
  rail: string;
  /** One line under the page title. */
  subtitle: string;
  /** Caps capsule beside the title. */
  pill: string;
}

export const settingsSections: SettingsSectionInfo[] = [
  { id: 'connection', title: 'Connection', rail: 'Link & networks', subtitle: 'Connection state and link behavior.', pill: 'Live' },
  { id: 'display', title: 'Display', rail: 'Live view chrome', subtitle: 'Live view buttons and chrome.', pill: 'Visibility' },
  { id: 'operator', title: 'Operator', rail: 'Touch & safety', subtitle: 'Touch behavior and safety.', pill: 'Touch' },
  { id: 'input', title: 'Input & Orientation', rail: 'Controller & rotation', subtitle: 'Remote shutter, game controller, head tracking and rotation.', pill: 'Input' },
  { id: 'motion', title: 'Motion Control', rail: 'Gimbal & joystick', subtitle: 'How sticks move the gimbal, and programmed moves.', pill: 'Gimbal' },
  { id: 'exposure', title: 'Exposure & Look', rail: 'EV meter & LUT', subtitle: 'Exposure readouts and the monitor look.', pill: 'Look' },
  { id: 'assists', title: 'View Assists', rail: 'Scopes & overlays', subtitle: 'Behavior for live-view tools.', pill: 'Assist' },
  { id: 'media', title: 'Media & Delivery', rail: 'Library & uploads', subtitle: 'Clips on the camera, local cache and delivery.', pill: 'Media' },
  { id: 'sharing', title: 'Feed sharing', rail: 'Watchers', subtitle: 'Share this feed with Pocket Monitor devices on the same camera Wi-Fi.', pill: 'Share' },
  { id: 'storage', title: 'Storage & System', rail: 'Cache & app', subtitle: 'Local cache and app-level behavior.', pill: 'Data' },
  { id: 'support', title: 'Support', rail: 'Report a problem', subtitle: 'Help, feedback and diagnostics.', pill: 'Help' },
  { id: 'about', title: 'About & Legal', rail: 'Licenses & notices', subtitle: 'Version, project and legal notices.', pill: 'App' },
];

export function sectionInfo(id: string | undefined): SettingsSectionInfo | undefined {
  return settingsSections.find((s) => s.id === id);
}
