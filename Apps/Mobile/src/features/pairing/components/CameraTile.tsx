import { Camera01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { SignalBars } from './StatusBits';

export interface CameraTileBadge {
  label: string;
  /** A small dot before the label (live, ready). */
  dot?: string;
}

export interface CameraTileItem {
  id: string;
  name: string;
  detail: string;
  /** Top-left pill over the picture ("Live", "Last used"). */
  badge?: CameraTileBadge;
  /** Bottom-left pill over the picture: the network path. */
  path?: { icon: IconSvgElement; label: string };
  /** Bluetooth signal, when the camera is in range. */
  signalBars?: number;
  /** Dim the picture when the camera is not around. */
  away?: boolean;
  icon?: IconSvgElement;
}

/**
 * One camera on the Cameras home, in the ai-cut project tile style: a picture area on `surface`
 * with pills over it, then the name and one detail line. Tap acts; long press or the dots open
 * the camera's actions.
 */
export function CameraTile({
  item,
  width,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  onMore,
}: {
  item: CameraTileItem;
  width: number;
  disabled?: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  onMore?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <View style={{ width }}>
      <Pressable
        testID={`cameras.card.${item.id}`}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint ?? (onMore ? 'Touch and hold for camera actions' : undefined)}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={onPress}
        onLongPress={onMore}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => [disabled && styles.disabled, pressed && styles.pressed]}
      >
        <View style={[styles.picture, hovered && !disabled && styles.pictureHover, { width, height: Math.round(width * 0.75) }]}>
          <View style={item.away ? styles.away : null}>
            <Icon icon={item.icon ?? Camera01Icon} size={28} color={colors.mutedForeground} />
          </View>
          {item.badge ? (
            <View style={[styles.pill, styles.topLeft]}>
              {item.badge.dot ? <View style={[styles.dot, { backgroundColor: item.badge.dot }]} /> : null}
              <Text numberOfLines={1} style={styles.pillText}>
                {item.badge.label}
              </Text>
            </View>
          ) : null}
          {item.signalBars !== undefined ? (
            <View style={[styles.pill, styles.topRight]}>
              <SignalBars count={item.signalBars} tone="overlay" />
            </View>
          ) : null}
          {item.path ? (
            <View style={[styles.pill, styles.bottomLeft]}>
              <Icon icon={item.path.icon} size={12} color="#ffffff" strokeWidth={2} />
              <Text numberOfLines={1} style={styles.pillText}>
                {item.path.label}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={[styles.meta, onMore ? styles.metaWithMore : null]}>
          <Text numberOfLines={1} style={styles.name}>
            {item.name}
          </Text>
          <Text numberOfLines={1} style={styles.detail}>
            {item.detail}
          </Text>
        </View>
      </Pressable>
      {onMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Options for ${item.name}`}
          disabled={disabled}
          onPress={onMore}
          hitSlop={14}
          style={({ pressed }) => [styles.more, pressed && styles.pressed]}
        >
          <Icon icon={MoreHorizontalIcon} size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    picture: {
      overflow: 'hidden' as const,
      borderRadius: 14,
      backgroundColor: colors.surface,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    pictureHover: { backgroundColor: colors.surfaceStrong },
    away: { opacity: 0.5 },
    pill: {
      position: 'absolute' as const,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 5,
      maxWidth: '78%' as const,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 999,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    topLeft: { top: 8, left: 8 },
    topRight: { top: 8, right: 8, paddingVertical: 5 },
    bottomLeft: { bottom: 8, left: 8 },
    dot: { width: 6, height: 6, borderRadius: 3 },
    pillText: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 11, color: '#ffffff' },
    meta: { marginTop: 7, gap: 1 },
    metaWithMore: { paddingRight: 26 },
    name: { fontFamily: fonts.semibold, fontSize: 13, color: colors.foreground },
    detail: { fontFamily: fonts.regular, fontSize: 11, color: colors.mutedForeground },
    more: { position: 'absolute' as const, right: -2, bottom: 6, padding: 2 },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.5 },
  };
}
