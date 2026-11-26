import { View } from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';
import { useCamera } from '@/camera';
import { colors, fonts } from '@/theme';
import { evLabel } from '../format';

/**
 * `MonitorExposureGauge`: passive telemetry, a sun on a vertical −3…+3 line. Auto shows the
 * EV bias; manual shows the camera's metered offset when it reports one.
 */
export function MonitorExposureGauge({ width, height }: { width: number; height: number }) {
  const value = useCamera((s) => (s.exposure.mode === 'manual' ? (s.exposure.meteredEv ?? null) : s.exposure.ev));
  const x = width / 2;
  const top = 34;
  const bottom = Math.max(top, height - 18);
  const fraction = value == null ? null : Math.min(1, Math.max(0, (value + 3) / 6));
  const markerY = fraction == null ? null : top + (bottom - top) * (1 - fraction);
  const color = colors.text;
  const rays = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel="Exposure meter"
      accessibilityValue={{ text: value == null ? 'Unknown' : `${evLabel(value)} stops` }}
      style={{ width, height }}
    >
      <Svg width={width} height={height}>
        <SvgText x={x} y={10} fill={color} fontSize={10} fontFamily={fonts.semibold} textAnchor="middle" stroke="rgba(0,0,0,0.35)" strokeWidth={0.3}>
          {value == null ? '--' : evLabel(value)}
        </SvgText>
        <SvgText x={x} y={26} fill={color} fontSize={8} fontFamily={fonts.medium} textAnchor="middle">
          +3
        </SvgText>
        <SvgText x={x} y={height - 2} fill={color} fontSize={8} fontFamily={fonts.medium} textAnchor="middle">
          {'−3'}
        </SvgText>
        {markerY == null ? (
          <Line x1={x} y1={top} x2={x} y2={bottom} stroke={color} strokeOpacity={0.8} strokeWidth={1} />
        ) : (
          <>
            {markerY - 9 > top ? <Line x1={x} y1={top} x2={x} y2={markerY - 9} stroke={color} strokeOpacity={0.8} strokeWidth={1} /> : null}
            {markerY + 9 < bottom ? <Line x1={x} y1={markerY + 9} x2={x} y2={bottom} stroke={color} strokeOpacity={0.8} strokeWidth={1} /> : null}
            <Circle cx={x} cy={markerY} r={2.5} fill={color} />
            {rays.map((a, i) => (
              <Line
                key={i}
                x1={x + Math.cos(a) * 4}
                y1={markerY + Math.sin(a) * 4}
                x2={x + Math.cos(a) * 6.5}
                y2={markerY + Math.sin(a) * 6.5}
                stroke={color}
                strokeWidth={1.2}
                strokeLinecap="round"
              />
            ))}
          </>
        )}
      </Svg>
    </View>
  );
}
