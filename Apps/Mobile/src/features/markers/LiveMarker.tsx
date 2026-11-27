import { Flag02Icon } from '@hugeicons/core-free-icons';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import { fonts, useThemedStyles } from '@/constants/theme';
import { MARKER_SWATCH, markerClock, tagKey, toastTags } from '@/core/markers';
import { useClipMeta } from '@/state/clipMeta';
import { addMarker, tagMarker, useMarkerToast } from './capture';

/**
 * The live view's Marker button: a 44pt side button over the picture (movable, `marker` in the
 * layout), shown while recording. The count of this take's markers rides on it.
 */
export function MarkerButton({ count, ghost }: { count: number; ghost?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add marker"
      accessibilityHint={undefined}
      disabled={ghost}
      onPress={() => addMarker('button')}
      hitSlop={4}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Icon icon={Flag02Icon} size={22} color="#ffffff" strokeWidth={1.8} />
      {count > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** "Marker 3 · 00:41" with quick tag chips, for a few seconds after a marker; tapping a chip tags it. */
export function MarkerToast({ top, maxWidth }: { top: number; maxWidth: number }) {
  const styles = useThemedStyles(createStyles);
  const shown = useMarkerToast((s) => s.shown);
  const line = useMarkerToast((s) => s.line);
  const userTags = useClipMeta((s) => s.userTags);
  const marker = useClipMeta((s) => {
    if (!shown) return undefined;
    const list = shown.ref.kind === 'take' ? s.takes.find((t) => t.id === (shown.ref as { takeId: string }).takeId)?.markers : s.clips[(shown.ref as { itemId: string }).itemId]?.markers;
    return list?.find((m) => m.id === shown.markerId);
  });
  if (line) {
    return (
      <View pointerEvents="none" style={[styles.wrap, { top }]}>
        <View accessibilityLiveRegion="polite" style={styles.plate}>
          <Text style={styles.title}>{line.text}</Text>
        </View>
      </View>
    );
  }
  if (!shown) return null;
  const tags = toastTags(userTags);
  const current = marker?.tag ?? null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top }]}>
      <View style={[styles.plate, { maxWidth }]} accessibilityLiveRegion="polite">
        <View style={styles.head}>
          <View style={[styles.dot, { backgroundColor: MARKER_SWATCH[marker?.color ?? 'blue'] }]} />
          <Text style={styles.title}>{`Marker ${shown.number} · ${markerClock(shown.time)}`}</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
          {tags.map((t) => {
            const on = current != null && tagKey(current) === tagKey(t);
            return (
              <Pressable
                key={t}
                accessibilityRole="button"
                accessibilityLabel={`Tag ${t}`}
                accessibilityState={{ selected: on }}
                onPress={() => tagMarker(shown.ref, shown.markerId, t)}
                hitSlop={6}
                style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{t}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

function createStyles() {
  const shadow = { textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 };
  return {
    button: {
      width: 44,
      height: 44,
      borderRadius: 14,
      backgroundColor: 'rgba(255,255,255,0.18)',
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    pressed: { opacity: 0.65 },
    badge: {
      position: 'absolute' as const,
      top: -4,
      right: -4,
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      borderRadius: 9,
      backgroundColor: '#ffffff',
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    badgeText: { fontFamily: fonts.bold, fontSize: 11, color: '#111111', fontVariant: ['tabular-nums' as const] },
    wrap: { position: 'absolute' as const, left: 0, right: 0, alignItems: 'center' as const },
    plate: { backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, gap: 8, alignItems: 'center' as const },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    title: { fontFamily: fonts.medium, fontSize: 14, color: '#ffffff', fontVariant: ['tabular-nums' as const], ...shadow },
    chips: { gap: 6, paddingHorizontal: 2 },
    chip: { height: 32, paddingHorizontal: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center' as const, justifyContent: 'center' as const },
    chipOn: { backgroundColor: '#ffffff' },
    chipText: { fontFamily: fonts.medium, fontSize: 13, color: '#ffffff' },
    chipTextOn: { color: '#111111' },
  };
}
