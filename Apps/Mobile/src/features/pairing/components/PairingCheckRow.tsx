import { AlertCircleIcon, CheckmarkCircle02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';

export type CheckState = 'complete' | 'active' | 'waiting' | 'failed';

export interface PairingCheck {
  title: string;
  subtitle?: string;
  state: CheckState;
  stateLabel: string;
  icon?: IconSvgElement;
}

/** A passive pairing status row (`CameraPairingCheckRow`): icon well, label, spinner or tick. */
export function PairingCheckRow({ check }: { check: PairingCheck }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { state } = check;
  const well =
    state === 'active' ? colors.ink : state === 'failed' ? colors.destructiveSoft : colors.surface;
  const tint =
    state === 'active' ? colors.inkForeground : state === 'failed' ? colors.destructive : colors.foreground;
  return (
    <View
      accessible
      accessibilityLabel={[check.title, check.subtitle, check.stateLabel].filter(Boolean).join(', ')}
      style={[styles.row, state === 'waiting' && styles.waiting]}
    >
      <Squircle width={40} height={40} radius={13} color={well}>
        <Icon icon={check.icon ?? CheckmarkCircle02Icon} size={19} color={tint} strokeWidth={1.7} />
      </Squircle>
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.title}>
          {check.title}
        </Text>
        {check.subtitle ? (
          <Text numberOfLines={2} style={[styles.subtitle, state === 'failed' && { color: colors.destructive }]}>
            {check.subtitle}
          </Text>
        ) : null}
      </View>
      <View style={styles.trailing}>
        {state === 'active' ? (
          <Spinner size={20} opacity={1} color={colors.foreground} accessibilityLabel={check.stateLabel} />
        ) : state === 'complete' ? (
          <Icon icon={Tick02Icon} size={20} color={colors.success} strokeWidth={2} />
        ) : state === 'failed' ? (
          <Icon icon={AlertCircleIcon} size={20} color={colors.destructive} strokeWidth={1.8} />
        ) : null}
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 14, minHeight: 56, paddingVertical: 6 },
    waiting: { opacity: 0.45 },
    text: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    subtitle: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mutedForeground },
    trailing: { width: 24, alignItems: 'center' as const, justifyContent: 'center' as const, marginRight: spacing.xs },
  };
}
