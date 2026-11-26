import { View } from 'react-native';
import { linkBandForScore } from '@/features/pairing/presentation';
import { MText, colors, linkHealthColor, withAlpha } from '@/theme';

/**
 * The host-resolved link score as a 12-dash scale with a band marker (`MonitorLinkHealthScale`).
 * A null score draws the empty scale for "no camera connected".
 */
export function LinkHealthScale({ title = 'Link Health', caption, score }: { title?: string; caption: string; score: number | null }) {
  const band = score === null ? null : linkBandForScore(score);
  const lit = band === 'poor' ? 4 : band === 'watch' ? 8 : band === 'stable' ? 12 : 0;
  const slot = band === 'poor' ? 0 : band === 'watch' ? 1 : band === 'stable' ? 2 : -1;
  const bandColor = band ? linkHealthColor(band) : colors.faint;
  const dash = (i: number) => {
    if (i >= lit) return withAlpha(colors.faint, 0.5);
    if (i < 4) return withAlpha(colors.linkPoor, 0.8);
    if (i < 8) return withAlpha(colors.linkWatch, 0.85);
    return withAlpha(colors.linkStable, 0.9);
  };
  const legend = (name: string, sub: string, align: 'flex-start' | 'center' | 'flex-end') => (
    <View style={{ flex: 1, flexDirection: 'row', gap: 4, justifyContent: align }}>
      <MText size={10} weight="semibold" color={colors.muted}>
        {name}
      </MText>
      <MText size={9} mono color={colors.faint}>
        {sub}
      </MText>
    </View>
  );
  return (
    <View
      accessible
      accessibilityLabel={`${title}: ${band ? band : 'no link'}. ${caption}`}
      style={{ padding: 13, gap: 9, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}
    >
      <MText size={13} weight="semibold">
        {title}
      </MText>
      <MText size={11.5} weight="medium" mono color={colors.muted}>
        {caption}
      </MText>
      <View style={{ flexDirection: 'row', height: 19 }}>
        {[0, 1, 2].map((s) => (
          <View key={s} style={{ flex: 1, alignItems: 'center' }}>
            {s === slot && band ? (
              <View
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 2,
                  borderRadius: 999,
                  backgroundColor: withAlpha(bandColor, 0.12),
                  borderWidth: 1,
                  borderColor: bandColor,
                }}
              >
                <MText size={9.5} weight="bold" tracking={0.5} color={bandColor}>
                  {band.toUpperCase()}
                </MText>
              </View>
            ) : null}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 3 }}>
        {Array.from({ length: 12 }, (_, i) => (
          <View key={i} style={{ flex: 1, height: 6, borderRadius: 2, backgroundColor: dash(i) }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row' }}>
        {legend('Poor', '<50', 'flex-start')}
        {legend('Watch', '50-79', 'center')}
        {legend('Stable', '80+', 'flex-end')}
      </View>
    </View>
  );
}
