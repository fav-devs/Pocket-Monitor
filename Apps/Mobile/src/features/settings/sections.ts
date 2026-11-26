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
  { id: 'connection', title: 'Connection', icon: Wifi01Icon },
  { id: 'display', title: 'Display', icon: Tv01Icon },
  { id: 'operator', title: 'Operator', icon: Tap02Icon },
  { id: 'input', title: 'Input & Orientation', icon: GameController03Icon },
  { id: 'motion', title: 'Motion Control', icon: Joystick02Icon },
  { id: 'exposure', title: 'Exposure & Look', icon: Sun03Icon },
  { id: 'assists', title: 'View Assists', icon: ChartHistogramIcon },
  { id: 'media', title: 'Media & Delivery', icon: Video01Icon },
  { id: 'sharing', title: 'Feed sharing', icon: LiveStreaming01Icon },
  { id: 'storage', title: 'Storage & System', icon: HardDriveIcon },
  { id: 'support', title: 'Support', icon: CustomerSupportIcon },
  { id: 'about', title: 'About & Legal', icon: InformationCircleIcon },
];

export function sectionInfo(id: string | undefined): SettingsSectionInfo | undefined {
  return settingsSections.find((s) => s.id === id);
}
