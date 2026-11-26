import { Text, View } from 'react-native';
import { linkBandForScore } from '@/features/pairing/presentation';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { tint } from './feedback';

type Band = 'poor' | 'watch' | 'stable';

const bandTitle: Record<Band, string> = { poor: 'Poor', watch: 'Watch', stable: 'Stable' };

/**
 * The host-resolved link score as a 12-dash scale with the band named (`MonitorLinkHealthScale`). A null score draws
 * the empty scale with no caption. Sits inside a settings group card.
 */
export function LinkHealthScale({ caption, score }: { caption?: string | null; score: number | null }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const band = score === null ? null : linkBandForScore(score);
  const bandColor = (b: Band) => (b === 'poor' ? colors.destructive : b === 'watch' ? colors.warning : colors.success);
  const lit = band === 'poor' ? 4 : band === 'watch' ? 8 : band === 'stable' ? 12 : 0;
  const dash = (i: number) => {
    if (i >= lit) return colors.surfaceStrong;
    return bandColor(i < 4 ? 'poor' : i < 8 ? 'watch' : 'stable');
  };
  return (
    <View accessible accessibilityLabel={`Link health: ${band ? bandTitle[band] : 'no link'}${caption ? `. ${caption}` : ''}`} style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.state}>{band ? bandTitle[band] : 'No link'}</Text>
        {band && score !== null ? (
          <View style={[styles.pill, { backgroundColor: tint(bandColor(band), 0.14) }]}>
            <Text style={[styles.pillText, { color: bandColor(band) }]}>{score}</Text>
          </View>
        ) : null}
      </View>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      <View style={styles.dashes}>
        {Array.from({ length: 12 }, (_, i) => (
          <View key={i} style={[styles.dash, { backgroundColor: dash(i) }]} />
        ))}
      </View>
      <View style={styles.legend}>
        <Text style={[styles.legendText, band === 'poor' && styles.legendOn]}>Poor &lt;50</Text>
        <Text style={[styles.legendText, styles.centre, band === 'watch' && styles.legendOn]}>Watch 50–79</Text>
        <Text style={[styles.legendText, styles.end, band === 'stable' && styles.legendOn]}>Stable 80+</Text>
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    card: { padding: spacing.md, gap: 10 },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm },
    state: { flex: 1, fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.4, color: colors.foreground },
    pill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
    pillText: { fontFamily: fonts.semibold, fontSize: 12, fontVariant: ['tabular-nums' as const] },
    caption: { fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    dashes: { flexDirection: 'row' as const, gap: 4, marginTop: 2 },
    dash: { flex: 1, height: 6, borderRadius: 3 },
    legend: { flexDirection: 'row' as const },
    legendText: { flex: 1, fontFamily: fonts.medium, fontSize: 11, color: colors.mutedForeground },
    legendOn: { color: colors.foreground, fontFamily: fonts.semibold },
    centre: { textAlign: 'center' as const },
    end: { textAlign: 'right' as const },
  };
}
