import { X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MText, colors, minTouch, radius } from '@/theme';
import { PressableScale } from '@/ui';

/** A scrim + centred card that stays inside the screen (no native Modal, so web behaves). */
export function OverlayCard({
  onDismiss,
  children,
  maxWidth = 460,
  align = 'center',
  label,
}: {
  onDismiss?: () => void;
  children: ReactNode;
  maxWidth?: number;
  align?: 'center' | 'bottom' | 'right';
  label?: string;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <View
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        justifyContent: align === 'bottom' ? 'flex-end' : 'center',
        alignItems: align === 'right' ? 'flex-end' : 'center',
        paddingTop: insets.top + 12,
        paddingBottom: insets.bottom + 12,
        paddingLeft: insets.left + 12,
        paddingRight: insets.right + 12,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={onDismiss}
        style={{ position: 'absolute', inset: 0, backgroundColor: colors.scrim }}
      />
      <View
        accessibilityViewIsModal
        accessibilityLabel={label}
        style={{
          width: '100%',
          maxWidth,
          maxHeight: height - insets.top - insets.bottom - 24,
          borderRadius: radius.lg,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

export function CardHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 12 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <MText size={11} weight="bold" tracking={1.6} uppercase>
          {title}
        </MText>
        {subtitle ? (
          <MText size={11} weight="medium" color={colors.muted}>
            {subtitle}
          </MText>
        ) : null}
      </View>
      {onClose ? <CloseButton onPress={onClose} /> : null}
    </View>
  );
}

export function CloseButton({ onPress, label = 'Close' }: { onPress: () => void; label?: string }) {
  return (
    <PressableScale accessibilityLabel={label} onPress={onPress} style={{ width: minTouch, height: minTouch, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}>
        <X size={12} color={colors.text} strokeWidth={2.2} />
      </View>
    </PressableScale>
  );
}

export function CardScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 16, gap: 14 }} showsVerticalScrollIndicator={false}>
      {children}
    </ScrollView>
  );
}

/** Wide text button (primary / destructive / plain). */
export function ActionButton({
  title,
  onPress,
  tone = 'primary',
  disabled,
  icon,
}: {
  title: string;
  onPress: () => void;
  tone?: 'primary' | 'destructive' | 'plain';
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const bg = tone === 'primary' ? colors.accent : tone === 'destructive' ? colors.recording : colors.raised;
  return (
    <PressableScale
      accessibilityLabel={title}
      onPress={onPress}
      disabled={disabled}
      style={{ minHeight: minTouch, flex: 1, borderRadius: radius.md, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 14 }}
    >
      {icon}
      <MText size={13} weight="semibold" color={tone === 'plain' ? colors.secondary : colors.onAccent}>
        {title}
      </MText>
    </PressableScale>
  );
}

/** `confirmationDialog`: title, optional message, destructive confirm and cancel. */
export function ConfirmDialog({
  title,
  message,
  confirmTitle = 'Delete',
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  confirmTitle?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <OverlayCard onDismiss={onCancel} maxWidth={360} label={title}>
      <View style={{ padding: 18, gap: 8 }}>
        <MText size={15} weight="semibold" align="center">
          {title}
        </MText>
        {message ? (
          <MText size={12} color={colors.muted} align="center">
            {message}
          </MText>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 14 }}>
        <ActionButton title="Cancel" tone="plain" onPress={onCancel} />
        <ActionButton title={confirmTitle} tone="destructive" onPress={onConfirm} />
      </View>
    </OverlayCard>
  );
}

/** Deletion in flight (`MonitorMediaDeletionOverlay`). */
export function BusyOverlay({ label }: { label: string }) {
  return (
    <View style={{ position: 'absolute', inset: 0, zIndex: 60, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ padding: 22, borderRadius: radius.lg, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.border, alignItems: 'center', gap: 12 }}>
        <ActivityIndicator color={colors.accent} />
        <MText size={13} weight="medium" color={colors.secondary}>
          {label}
        </MText>
      </View>
    </View>
  );
}

/** Capsule toast near the bottom edge. */
export function NoticeToast({ text, bottom = 24 }: { text: string; bottom?: number }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom, alignItems: 'center', zIndex: 40 }}>
      <View style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.border, maxWidth: 420 }}>
        <MText size={13} weight="medium" align="center">
          {text}
        </MText>
      </View>
    </View>
  );
}
