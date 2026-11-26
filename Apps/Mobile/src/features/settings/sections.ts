import {
  ChartHistogramIcon,
  CustomerSupportIcon,
  GameController03Icon,
  HardDriveIcon,
  InformationCircleIcon,
  Joystick02Icon,
  LiveStreaming01Icon,
  Sun03Icon,
  Tap02Icon,
  Tv01Icon,
  Video01Icon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';

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
  /** Icon in the row's well on the Settings list. */
  icon: IconSvgElement;
}

/** How the Settings list groups the sections, in order. */
export const settingsGroups: { label: string; ids: SettingsSectionId[] }[] = [
  { label: 'Monitor', ids: ['connection', 'display', 'operator'] },
  { label: 'Control', ids: ['input', 'motion'] },
  { label: 'Picture', ids: ['exposure', 'assists'] },
  { label: 'Media', ids: ['media', 'sharing'] },
  { label: 'App', ids: ['storage', 'support', 'about'] },
];

export const settingsSections: SettingsSectionInfo[] = [
  { id: 'connection', title: 'Connection', rail: 'Link & networks', subtitle: 'Connection state and link behavior.', pill: 'Live', icon: Wifi01Icon },
  { id: 'display', title: 'Display', rail: 'Live view chrome', subtitle: 'Live view buttons and chrome.', pill: 'Visibility', icon: Tv01Icon },
  { id: 'operator', title: 'Operator', rail: 'Touch & safety', subtitle: 'Touch behavior and safety.', pill: 'Touch', icon: Tap02Icon },
  { id: 'input', title: 'Input & Orientation', rail: 'Controller & rotation', subtitle: 'Remote shutter, game controller, head tracking and rotation.', pill: 'Input', icon: GameController03Icon },
  { id: 'motion', title: 'Motion Control', rail: 'Gimbal & joystick', subtitle: 'How sticks move the gimbal, and programmed moves.', pill: 'Gimbal', icon: Joystick02Icon },
  { id: 'exposure', title: 'Exposure & Look', rail: 'EV meter & LUT', subtitle: 'Exposure readouts and the monitor look.', pill: 'Look', icon: Sun03Icon },
  { id: 'assists', title: 'View Assists', rail: 'Scopes & overlays', subtitle: 'Behavior for live-view tools.', pill: 'Assist', icon: ChartHistogramIcon },
  { id: 'media', title: 'Media & Delivery', rail: 'Library & uploads', subtitle: 'Clips on the camera, local cache and delivery.', pill: 'Media', icon: Video01Icon },
  { id: 'sharing', title: 'Feed sharing', rail: 'Watchers', subtitle: 'Share this feed with Pocket Monitor devices on the same camera Wi-Fi.', pill: 'Share', icon: LiveStreaming01Icon },
  { id: 'storage', title: 'Storage & System', rail: 'Cache & app', subtitle: 'Local cache and app-level behavior.', pill: 'Data', icon: HardDriveIcon },
  { id: 'support', title: 'Support', rail: 'Report a problem', subtitle: 'Help, feedback and diagnostics.', pill: 'Help', icon: CustomerSupportIcon },
  { id: 'about', title: 'About & Legal', rail: 'Licenses & notices', subtitle: 'Version, project and legal notices.', pill: 'App', icon: InformationCircleIcon },
];

export function sectionInfo(id: string | undefined): SettingsSectionInfo | undefined {
  return settingsSections.find((s) => s.id === id);
}
