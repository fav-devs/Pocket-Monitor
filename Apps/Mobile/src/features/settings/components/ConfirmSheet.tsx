import { useRef } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/button';
import { Sheet } from '@/components/sheet';
import { fonts, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmTitle: string;
  destructive?: boolean;
}

/**
 * A two-choice confirmation as a compact sheet (works on web, where `Alert` does not). Keeps the last request while
 * the sheet closes so its words don't vanish mid-animation.
 */
export function ConfirmSheet({
  request,
  onConfirm,
  onCancel,
}: {
  request: ConfirmRequest | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const last = useRef<ConfirmRequest | null>(request);
  if (request) last.current = request;
  const shown = request ?? last.current;
  return (
    <Sheet
      visible={!!request}
      title={shown?.title ?? ''}
      onClose={onCancel}
      expandable={false}
      footer={
        <View style={styles.actions}>
          <Button
            size="lg"
            title={shown?.confirmTitle ?? 'OK'}
            variant={shown?.destructive ? 'secondary' : 'primary'}
            destructive={shown?.destructive}
            onPress={onConfirm}
          />
          <Button size="lg" variant="ghost" title="Cancel" onPress={onCancel} />
        </View>
      }
    >
      <Text style={styles.message}>{shown?.message}</Text>
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    message: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.mutedForeground, paddingBottom: spacing.sm },
    actions: { gap: spacing.xs, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md },
  };
}
