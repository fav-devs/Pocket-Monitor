import { StopIcon } from '@hugeicons/core-free-icons';
import { Pressable, Text, View } from 'react-native';
import { useCamera } from '@/camera';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Sheet } from '@/components/sheet';
import { fonts, radius, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { elapsedLabel } from '../format';
import { useLiveUi } from '../liveUiStore';

/** Optional stop-recording confirmation (Settings → Recording → Confirm stop). */
export function StopConfirmSheet({ onStop }: { onStop: () => void }) {
  const styles = useThemedStyles(createStyles);
  const open = useLiveUi((s) => s.stopConfirmOpen);
  const set = useLiveUi((s) => s.set);
  const recording = useCamera((s) => s.recording.recording);
  const elapsed = useCamera((s) => s.recording.elapsedSec);
  const cancel = () => set({ stopConfirmOpen: false });
  return (
    <Sheet visible={open && recording} title="Stop recording?" onClose={cancel} expandable={false}>
      <Text style={styles.detail}>Take length {elapsedLabel(elapsed)}</Text>
      <View style={styles.actions}>
        <Button title="Keep recording" variant="secondary" size="lg" onPress={cancel} style={styles.flex} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop"
          onPress={onStop}
          style={({ pressed }) => [styles.stop, pressed && { opacity: 0.75 }]}
        >
          <Icon icon={StopIcon} size={18} color="#ffffff" strokeWidth={2} />
          <Text style={styles.stopLabel}>Stop</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    detail: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    actions: { flexDirection: 'row' as const, gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.xs },
    flex: { flex: 1 },
    stop: {
      flex: 1,
      minHeight: 50,
      borderRadius: radius.md,
      flexDirection: 'row' as const,
      gap: spacing.sm,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: colors.dotPink,
    },
    stopLabel: { fontFamily: fonts.semibold, fontSize: 15, color: '#ffffff' },
  };
}
