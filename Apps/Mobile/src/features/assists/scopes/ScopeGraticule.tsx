import { View } from 'react-native';
import Svg, { Circle, Line, Rect, Text as SvgText } from 'react-native-svg';
import {
  VECTOR_SKIN_ANGLE_DEG,
  VECTOR_SKIN_LENGTH,
  VECTOR_TARGETS,
  vectorTargetPoint,
  waveformGuideStrokes,
  type ScopeGuides,
  type TrafficLightsReading,
} from '@/core/media';
import { fonts } from '@/constants/theme';
import { HISTO, SCOPE_COLORS, histogramPlotRect, plotX, plotY, vectorscopeSquare, waveformPlotRect } from './scopeGeometry';

/** Solid 0 / 100, dashed safe 5 / 95, grey at the transfer's paper IRE. */
export function WaveformGuides({ width, height, guides, middleGrayIRE }: { width: number; height: number; guides: ScopeGuides; middleGrayIRE: number }) {
  const plot = waveformPlotRect(width, height);
  return (
    <Svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
      {[25, 50, 75].map((ire) => (
        <Line key={ire} x1={plot.x} x2={plot.x + plot.width} y1={plotY(ire, plot)} y2={plotY(ire, plot)} stroke={SCOPE_COLORS.grid} strokeWidth={1} />
      ))}
      {waveformGuideStrokes(guides.clip, guides.crush, guides.middle, middleGrayIRE).map((s, i) => {
        const y = plotY(s.ire, plot);
        const grey = Math.abs(s.ire - middleGrayIRE) < 0.05 && !s.crushClipColor;
        return (
          <Line
            key={i}
            x1={plot.x}
            x2={plot.x + plot.width}
            y1={y}
            y2={y}
            stroke={s.crushClipColor ? SCOPE_COLORS.clip : grey ? SCOPE_COLORS.middle : SCOPE_COLORS.boundary}
            strokeWidth={grey ? 1 : 1.25}
            strokeDasharray={s.dashed ? '3 3' : undefined}
          />
        );
      })}
    </Svg>
  );
}

/** Parade lane separators on top of the waveform guides. */
export function ParadeLanes({ width, height, lanes }: { width: number; height: number; lanes: number }) {
  const plot = waveformPlotRect(width, height);
  return (
    <Svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
      {Array.from({ length: lanes - 1 }, (_, i) => {
        const x = plot.x + ((i + 1) * plot.width) / lanes;
        return <Line key={i} x1={x} x2={x} y1={plot.y} y2={plot.y + plot.height} stroke={SCOPE_COLORS.grid} strokeWidth={1} />;
      })}
    </Svg>
  );
}

function Lamp({ x, y, color, hot }: { x: number; y: number; color: string; hot: boolean }) {
  return (
    <Rect
      x={x + 0.75}
      y={y + 0.75}
      width={HISTO.lampWidth - 1.5}
      height={HISTO.lampHeight - 1.5}
      rx={2}
      fill={hot ? color : 'transparent'}
      stroke={color}
      strokeOpacity={hot ? 1 : 0.8}
      strokeWidth={1.5}
    />
  );
}

/** Reference grid, 0 / 100 strokes, the clip-zone tint and the crush / clip lamps. */
export function HistogramFrame({ width, height, lamps, traffic }: { width: number; height: number; lamps: boolean; traffic: TrafficLightsReading | null }) {
  const plot = histogramPlotRect(width, height, lamps);
  const anyClip = !!traffic && (traffic.red.clip || traffic.green.clip || traffic.blue.clip);
  const col = (x: number, which: 'crush' | 'clip') =>
    traffic
      ? [
          { c: SCOPE_COLORS.lampRed, hot: traffic.red[which] },
          { c: SCOPE_COLORS.lampGreen, hot: traffic.green[which] },
          { c: SCOPE_COLORS.lampBlue, hot: traffic.blue[which] },
        ].map((l, i) => <Lamp key={`${which}${i}`} x={x} y={12 + i * (HISTO.lampHeight + 3)} color={l.c} hot={l.hot} />)
      : null;
  return (
    <Svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
      {[1, 2, 3].map((s) => {
        const y = plot.y + (plot.height * s) / 4;
        return <Line key={s} x1={plot.x} x2={plot.x + plot.width} y1={y} y2={y} stroke={SCOPE_COLORS.faintGrid} strokeWidth={1} />;
      })}
      {lamps && anyClip ? (
        <Rect x={plotX(HISTO.clipZoneIRE, plot)} y={plot.y} width={plotX(100, plot) - plotX(HISTO.clipZoneIRE, plot)} height={plot.height} fill="rgba(255,150,142,0.11)" />
      ) : null}
      {[0, 100].map((ire) => (
        <Line key={ire} x1={plotX(ire, plot)} x2={plotX(ire, plot)} y1={plot.y} y2={plot.y + plot.height} stroke={SCOPE_COLORS.boundary} strokeWidth={1.25} />
      ))}
      {lamps ? col(HISTO.outerPad, 'crush') : null}
      {lamps ? col(width - HISTO.outerPad - HISTO.lampWidth, 'clip') : null}
    </Svg>
  );
}

/** Ring, centre cross, dashed skin line and the six 75% targets. */
export function VectorscopeGraticule({ width, height }: { width: number; height: number }) {
  const sq = vectorscopeSquare(width, height);
  const cx = sq.x + sq.width / 2;
  const cy = sq.y + sq.height / 2;
  const radius = sq.width / 2;
  const a = (VECTOR_SKIN_ANGLE_DEG * Math.PI) / 180;
  const arm = 8;
  const box = 7;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width, height }}>
      <Svg width={width} height={height}>
        <Circle cx={cx} cy={cy} r={radius} stroke={SCOPE_COLORS.ring} strokeWidth={1.25} fill="none" />
        <Line x1={cx - arm} x2={cx + arm} y1={cy} y2={cy} stroke={SCOPE_COLORS.faint} strokeWidth={1} />
        <Line x1={cx} x2={cx} y1={cy - arm} y2={cy + arm} stroke={SCOPE_COLORS.faint} strokeWidth={1} />
        <Line
          x1={cx}
          y1={cy}
          x2={cx + Math.cos(a) * radius * VECTOR_SKIN_LENGTH}
          y2={cy - Math.sin(a) * radius * VECTOR_SKIN_LENGTH}
          stroke={SCOPE_COLORS.middle}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        {VECTOR_TARGETS.map((t) => {
          const [fx, fy] = vectorTargetPoint(t.r, t.g, t.b);
          const px = sq.x + fx * sq.width;
          const py = sq.y + fy * sq.height;
          const dx = px - cx;
          const dy = py - cy;
          const len = Math.max(1, Math.hypot(dx, dy));
          return [
            <Rect key={`${t.label}b`} x={px - box / 2} y={py - box / 2} width={box} height={box} stroke={SCOPE_COLORS.box} strokeWidth={1} fill="none" />,
            <SvgText
              key={`${t.label}t`}
              x={px + (dx / len) * 10}
              y={py + (dy / len) * 10 + 2.5}
              fill={SCOPE_COLORS.label}
              fontSize={6.5}
              fontFamily={fonts.semibold}
              textAnchor="middle"
            >
              {t.label}
            </SvgText>,
          ];
        })}
      </Svg>
    </View>
  );
}
