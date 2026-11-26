import type { IconSvgElement } from '@hugeicons/react-native';
import {
  AspectRatioIcon,
  AudioWave01Icon,
  ChartColumnIcon,
  ChartHistogramIcon,
  ChartLineData01Icon,
  ChartRadarIcon,
  CubeIcon,
  FlipHorizontalIcon,
  FocusPointIcon,
  GridIcon,
  HorizontalResizeIcon,
  PlusMinusSquare01Icon,
  PlusSignIcon,
  RainbowIcon,
  SunglassesIcon,
  TrafficLightIcon,
} from '@hugeicons/core-free-icons';
import { Icon } from '@/components/icon';
import type { AssistTool } from '@/state/assists';

/** Zebra: a rounded frame crossed by diagonal stripes (Hugeicons format, 1.5 stroke). */
const ZebraIcon: IconSvgElement = [
  ['path', { d: 'M3 8C3 5.23858 5.23858 3 8 3H16C18.7614 3 21 5.23858 21 8V16C21 18.7614 18.7614 21 16 21H8C5.23858 21 3 18.7614 3 16V8Z', stroke: 'currentColor', strokeWidth: '1.5', key: '0' }],
  ['path', { d: 'M3.5 13.5L13.5 3.5M7.5 20.5L20.5 7.5M14 20.5L20.5 14', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '1' }],
];

/** Level: a spirit-level tube with its bubble centred and a horizon tick each side. */
const LevelIcon: IconSvgElement = [
  ['path', { d: 'M5 9H19C20.6569 9 22 10.3431 22 12C22 13.6569 20.6569 15 19 15H5C3.34315 15 2 13.6569 2 12C2 10.3431 3.34315 9 5 9Z', stroke: 'currentColor', strokeWidth: '1.5', key: '0' }],
  ['path', { d: 'M12 13.5C12.8284 13.5 13.5 12.8284 13.5 12C13.5 11.1716 12.8284 10.5 12 10.5C11.1716 10.5 10.5 11.1716 10.5 12C10.5 12.8284 11.1716 13.5 12 13.5Z', stroke: 'currentColor', strokeWidth: '1.5', key: '1' }],
  ['path', { d: 'M8.5 9V15M15.5 9V15', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '2' }],
];

/** Each tool's Hugeicon. */
export const ASSIST_ICONS: Record<AssistTool, IconSvgElement> = {
  LUT: CubeIcon,
  PEAK: FocusPointIcon,
  FALSE: RainbowIcon,
  ZEBRA: ZebraIcon,
  WAVE: ChartLineData01Icon,
  PARADE: ChartColumnIcon,
  HISTO: ChartHistogramIcon,
  VECTOR: ChartRadarIcon,
  LIGHTS: TrafficLightIcon,
  ND: SunglassesIcon,
  EV: PlusMinusSquare01Icon,
  AUDIO: AudioWave01Icon,
  GUIDES: AspectRatioIcon,
  GRID: GridIcon,
  CROSS: PlusSignIcon,
  LEVEL: LevelIcon,
  'DE-SQ': HorizontalResizeIcon,
  MIRROR: FlipHorizontalIcon,
};

/** Short caption under a tool well: the chip labels the monitor has always used, in title case. */
export const ASSIST_CAPTIONS: Record<AssistTool, string> = {
  LUT: 'LUT',
  PEAK: 'Peak',
  FALSE: 'False',
  ZEBRA: 'Zebra',
  WAVE: 'Wave',
  PARADE: 'Parade',
  HISTO: 'Histo',
  VECTOR: 'Vector',
  LIGHTS: 'Lights',
  ND: 'ND',
  EV: 'EV',
  AUDIO: 'Audio',
  GUIDES: 'Guides',
  GRID: 'Grid',
  CROSS: 'Cross',
  LEVEL: 'Level',
  'DE-SQ': 'De-sq',
  MIRROR: 'Mirror',
};

/** Tool artwork. */
export function AssistIcon({ tool, size = 20, color, strokeWidth = 1.5 }: { tool: AssistTool; size?: number; color?: string; strokeWidth?: number }) {
  return <Icon icon={ASSIST_ICONS[tool]} size={size} color={color} strokeWidth={strokeWidth} />;
}
