import { Text, View } from 'react-native';
import { Spinner } from '@/components/spinner';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';

/** Four rising bars (`CameraSignalBars`). `overlay` draws them white for a pill over a picture. */
export function SignalBars({ count, tone = 'surface' }: { count: number; tone?: 'surface' | 'overlay' }) {
  const { colors } = useTheme();
  const on = tone === 'overlay' ? '#ffffff' : colors.foreground;
  const off = tone === 'overlay' ? 'rgba(255,255,255,0.3)' : colors.borderStrong;
  return (
    <View
      accessible
      accessibilityLabel={`Signal ${count} of 4`}
      style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 12 }}
    >
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={{ width: 3, height: 3 + i * 3, borderRadius: 1.5, backgroundColor: i < count ? on : off }} />
      ))}
    </View>
  );
}

/** Spinner + short muted label for work in progress (`CameraProgressLabel`). */
export function ProgressLabel({ title }: { title: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View accessible accessibilityLabel={title} style={styles.row}>
      <Spinner size={16} opacity={1} color={colors.mutedForeground} />
      <Text style={styles.label} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm },
    label: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground },
  };
}
