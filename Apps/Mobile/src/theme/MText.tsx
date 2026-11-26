import { Text, type TextProps, type TextStyle } from 'react-native';
import { colors, fonts, type FontWeight } from './tokens';

export interface MTextProps extends TextProps {
  size?: number;
  weight?: FontWeight;
  color?: string;
  /** Letter spacing in points. */
  tracking?: number;
  uppercase?: boolean;
  align?: TextStyle['textAlign'];
  /** Tabular digits for readouts that change while you watch them. */
  mono?: boolean;
}

/** Sora text with the monitor's defaults. Use this instead of bare `Text`. */
export function MText({
  size = 14,
  weight = 'regular',
  color = colors.text,
  tracking,
  uppercase,
  align,
  mono,
  style,
  ...rest
}: MTextProps) {
  return (
    <Text
      {...rest}
      style={[
        {
          fontFamily: fonts[weight],
          fontSize: size,
          color,
          letterSpacing: tracking,
          textTransform: uppercase ? 'uppercase' : undefined,
          textAlign: align,
          fontVariant: mono ? ['tabular-nums'] : undefined,
        },
        style,
      ]}
    />
  );
}
