import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { MText, colors, withAlpha } from '@/theme';

/**
 * Same footprint as Live View's settings/media buttons (`MonitorSystemButtonMetrics`).
 * Pure visual; wrap in a pressable or `ActionMenu`.
 */
export function HeaderIconFace({
  icon: Icon,
  title,
  tablet,
  accented,
}: {
  icon: LucideIcon;
  title?: string;
  tablet?: boolean;
  accented?: boolean;
}) {
  const side = tablet ? 52 : 44;
  const glyph = tablet ? 22 : 20;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: side,
        height: side,
        paddingHorizontal: title ? 11 : 0,
        justifyContent: 'center',
        borderRadius: 12,
        backgroundColor: accented ? withAlpha(colors.accent, 0.12) : withAlpha(colors.secondary, 0.1),
        borderWidth: 1,
        borderColor: accented ? withAlpha(colors.accent, 0.3) : 'transparent',
      }}
    >
      <Icon size={glyph} color={accented ? colors.accent : colors.secondary} strokeWidth={1.8} />
      {title ? (
        <MText size={12.5} weight="semibold" numberOfLines={1}>
          {title}
        </MText>
      ) : null}
    </View>
  );
}
