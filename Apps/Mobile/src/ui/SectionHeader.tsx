import { View } from 'react-native';
import { MText, colors } from '@/theme';

/** `MonitorSectionHeader`: small bold tracked caps, faint. */
export function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  return (
    <View accessibilityRole="header" style={{ flexDirection: 'row', alignItems: 'baseline', gap: 9 }}>
      <MText size={10} weight="bold" tracking={1.7} color={colors.faint} uppercase>
        {title}
      </MText>
      {detail ? (
        <MText size={10} tracking={0.7} color={colors.faint}>
          {detail}
        </MText>
      ) : null}
    </View>
  );
}
