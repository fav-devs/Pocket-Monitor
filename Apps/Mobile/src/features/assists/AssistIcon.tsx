import {
  Aperture,
  AudioWaveform,
  Box,
  ChartArea,
  ChartColumn,
  ChevronsUpDown,
  CircleDot,
  Contrast,
  Crosshair,
  FlipHorizontal2,
  Grid3x3,
  Mountain,
  Plus,
  SlidersVertical,
  SquareDashed,
  type LucideIcon,
} from 'lucide-react-native';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { MText } from '@/theme';
import type { AssistTool } from '@/state/assists';

const LUCIDE: Partial<Record<AssistTool, LucideIcon>> = {
  LUT: Box,
  PEAK: Mountain,
  FALSE: Contrast,
  WAVE: AudioWaveform,
  PARADE: ChartColumn,
  HISTO: ChartArea,
  VECTOR: Crosshair,
  ND: Aperture,
  AUDIO: SlidersVertical,
  GUIDES: SquareDashed,
  GRID: Grid3x3,
  CROSS: Plus,
  LEVEL: CircleDot,
  'DE-SQ': ChevronsUpDown,
  MIRROR: FlipHorizontal2,
};

/** Tool artwork (`MonitorAssistToolGlyph`): EV is its abbreviation, DE-SQ the rotated glyph. */
export function AssistIcon({ tool, size = 20, color }: { tool: AssistTool; size?: number; color: string }) {
  if (tool === 'EV') {
    return (
      <MText size={size * 0.7} weight="semibold" color={color} style={{ width: size, height: size, lineHeight: size, textAlign: 'center' }}>
        EV
      </MText>
    );
  }
  if (tool === 'ZEBRA') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Rect x={3} y={3} width={18} height={18} rx={3} stroke={color} strokeWidth={1.8} fill="none" />
        {[0, 6, 12].map((o) => (
          <Line key={o} x1={3 + o} y1={21} x2={21} y2={3 + o} stroke={color} strokeWidth={1.8} />
        ))}
        <Line x1={3} y1={15} x2={15} y2={3} stroke={color} strokeWidth={1.8} />
      </Svg>
    );
  }
  if (tool === 'LIGHTS') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Rect x={7} y={2} width={10} height={20} rx={3} stroke={color} strokeWidth={1.8} fill="none" />
        <Circle cx={12} cy={7} r={1.8} fill={color} />
        <Circle cx={12} cy={12} r={1.8} fill={color} />
        <Circle cx={12} cy={17} r={1.8} fill={color} />
      </Svg>
    );
  }
  const Icon = LUCIDE[tool]!;
  return (
    <Icon size={size} color={color} strokeWidth={1.8} style={tool === 'DE-SQ' ? { transform: [{ rotate: '90deg' }] } : undefined} />
  );
}
