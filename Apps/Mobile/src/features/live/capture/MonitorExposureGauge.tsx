import { View } from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';
import { useCamera } from '@/camera';
import { fonts, useTheme } from '@/constants/theme';
import { evLabel } from '../format';
import { onVideo } from '../chrome/primitives';

/**
 * `MonitorExposureGauge`: passive telemetry on a dark plate, a sun on a vertical −3…+3 line.
 * Auto shows the EV bias; manual shows the camera's metered offset when it reports one.
 */
export function MonitorExposureGauge({ width, height }: { width: number; height: number }) {
  const { colors } = useTheme();
  const value = useCamera((s) => (s.exposure.mode === 'manual' ? (s.exposure.meteredEv ?? null) : s.exposure.ev));
  const x = width / 2;
  const top = 36;
  const bottom = Math.max(top, height - 20);
  const fraction = value == null ? null : Math.min(1, Math.max(0, (value + 3) / 6));
  const markerY = fraction == null ? null : top + (bottom - top) * (1 - fraction);
  const zeroY = top + (bottom - top) / 2;
  const ink = onVideo.ink;
  const off = value != null && Math.abs(value) >= 0.05;
  const rays = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel="Exposure meter"
      accessibilityValue={{ text: value == null ? 'Unknown' : `${evLabel(value)} stops` }}
      style={{ width, height, borderRadius: 12, backgroundColor: onVideo.plate }}
    >
      <Svg width={width} height={height}>
        <SvgText x={x} y={16} fill={off ? colors.accent : ink} fontSize={11} fontFamily={fonts.semibold} textAnchor="middle">
          {value == null ? '--' : evLabel(value)}
        </SvgText>
        <SvgText x={x} y={30} fill={onVideo.inkMuted} fontSize={8.5} fontFamily={fonts.medium} textAnchor="middle">
          +3
        </SvgText>
        <SvgText x={x} y={height - 7} fill={onVideo.inkMuted} fontSize={8.5} fontFamily={fonts.medium} textAnchor="middle">
          {'−3'}
        </SvgText>
        <Line x1={x - 4} y1={zeroY} x2={x + 4} y2={zeroY} stroke={onVideo.inkMuted} strokeWidth={1} />
        {markerY == null ? (
          <Line x1={x} y1={top} x2={x} y2={bottom} stroke={onVideo.guide} strokeWidth={1} />
        ) : (
          <>
            {markerY - 9 > top ? <Line x1={x} y1={top} x2={x} y2={markerY - 9} stroke={onVideo.guide} strokeWidth={1} /> : null}
            {markerY + 9 < bottom ? <Line x1={x} y1={markerY + 9} x2={x} y2={bottom} stroke={onVideo.guide} strokeWidth={1} /> : null}
            <Circle cx={x} cy={markerY} r={2.6} fill={ink} />
            {rays.map((a, i) => (
              <Line
                key={i}
                x1={x + Math.cos(a) * 4.2}
                y1={markerY + Math.sin(a) * 4.2}
                x2={x + Math.cos(a) * 6.6}
                y2={markerY + Math.sin(a) * 6.6}
                stroke={ink}
                strokeWidth={1.3}
                strokeLinecap="round"
              />
            ))}
          </>
        )}
      </Svg>
    </View>
  );
}
