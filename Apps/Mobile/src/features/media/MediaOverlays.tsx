import { Delete02Icon } from '@hugeicons/core-free-icons';
import { Text, View } from 'react-native';
import { Button } from '@/components/button';
import { Sheet } from '@/components/sheet';
import { Spinner } from '@/components/spinner';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';

/** A delete confirmation as a compact sheet: what goes, one line why, Delete and Cancel. */
export function ConfirmSheet({
  visible,
  title,
  message,
  confirmTitle = 'Delete',
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmTitle?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Sheet visible={visible} title={title} onClose={onCancel} expandable={false}>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      <View style={styles.actions}>
        <Button
          title={confirmTitle}
          icon={Delete02Icon}
          variant="secondary"
          destructive
          size="lg"
          onPress={onConfirm}
          style={{ backgroundColor: colors.destructiveSoft, borderColor: colors.destructiveSoft }}
        />
        <Button title="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </Sheet>
  );
}

/** Deletion in flight: the screen waits under a scrim. */
export function BusyOverlay({ label }: { label: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.scrim}>
      <View style={styles.busyCard}>
        <Spinner opacity={1} size={22} color={colors.foreground} />
        <Text style={styles.busyLabel}>{label}</Text>
      </View>
    </View>
  );
}

/** A short notice near the bottom edge ("Deleted 3 items"). */
export function NoticeToast({ text, bottom = 24 }: { text: string; bottom?: number }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View pointerEvents="none" style={[styles.toastWrap, { bottom }]}>
      <View style={styles.toast} accessibilityLiveRegion="polite">
        <Text style={styles.toastText}>{text}</Text>
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    message: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mutedForeground, paddingBottom: spacing.sm },
    actions: { gap: spacing.xs, paddingBottom: spacing.sm },
    scrim: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 60,
      backgroundColor: 'rgba(0,0,0,0.45)',
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    busyCard: {
      minWidth: 200,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
      borderRadius: radius.lg,
      backgroundColor: colors.background,
      alignItems: 'center' as const,
      gap: 12,
    },
    busyLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.foreground },
    toastWrap: { position: 'absolute' as const, left: 16, right: 16, alignItems: 'center' as const, zIndex: 40 },
    toast: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.65)', maxWidth: 420 },
    toastText: { fontFamily: fonts.medium, fontSize: 14, color: '#ffffff', textAlign: 'center' as const },
  };
}
