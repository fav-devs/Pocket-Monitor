import Svg, { Circle, Rect } from 'react-native-svg';

/**
 * The Pocket Monitor mark, the same one the desktop app ships (Apps/Desktop/installer/viewfinder.ico):
 * a white viewfinder ring around a red record dot on a dark tile. Drawn from the 256-unit original.
 */
export function AppLogo({ size = 32, tile = true }: { size?: number; tile?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" accessibilityLabel="Pocket Monitor">
      {tile ? <Rect x={0} y={0} width={256} height={256} rx={56} fill="#121212" /> : null}
      <Circle cx={128} cy={128} r={78} fill="none" stroke="#ffffff" strokeWidth={10} />
      <Circle cx={128} cy={128} r={52} fill="#e5273a" />
    </Svg>
  );
}
