import { Camera01Icon, Cancel01Icon, Delete02Icon, Download04Icon, Share08Icon, SmartPhone01Icon, StarIcon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { chromeRegion, isHovered } from '@/components/desktop';
import { ToolbarButton } from '@/components/page-toolbar';
import { TOOLBAR_HEIGHT } from '@/constants/layout';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { favoriteColor, Glyph } from './MediaChips';
import { ClipInfoList, StarRating } from './PlaybackParts';

/** The inspector's width beside the picture in the wide layout. */
export const INSPECTOR_WIDTH = 320;

/**
 * Playback's inspector in the wide layout: the clip's details and actions in a side panel next to
 * the picture (macOS Photos / QuickTime), instead of the phone's sheets.
 */
export function PlaybackInspector({
  fileName,
  rendition,
  rows,
  rating,
  onRate,
  favorite,
  onFavorite,
  download,
  onShare,
  onDelete,
  deleteLabel,
  onStill,
  onClose,
}: {
  fileName: string;
  rendition: string;
  rows: [string, string][];
  rating: number;
  onRate: (stars: number) => void;
  favorite: boolean;
  onFavorite: () => void;
  download: { label: string; done: boolean; busy: boolean; onPress: () => void } | null;
  onShare: () => void;
  onDelete: () => void;
  deleteLabel: string;
  onStill?: () => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.panel} {...chromeRegion()}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.heading}>
          Info
        </Text>
        <ToolbarButton icon={Cancel01Icon} label="Hide info" onPress={onClose} />
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
        <View style={styles.titleBlock}>
          <Text selectable numberOfLines={2} style={styles.fileName}>
            {fileName}
          </Text>
          <Text style={styles.rendition}>{rendition}</Text>
        </View>
        <View style={styles.actions}>
          <Action icon={StarIcon} label="Favorite" accessibilityLabel="Favorite clip" on={favorite} onPress={onFavorite} tint={favorite ? favoriteColor : undefined} filled={favorite} />
          {download ? (
            <Action
              icon={download.done ? SmartPhone01Icon : Download04Icon}
              label={download.label}
              disabled={download.done || download.busy}
              onPress={download.onPress}
            />
          ) : null}
          <Action icon={Share08Icon} label="Share" onPress={onShare} />
          {onStill ? <Action icon={Camera01Icon} label="Still" onPress={onStill} /> : null}
          <Action icon={Delete02Icon} label="Delete" accessibilityLabel={deleteLabel} destructive onPress={onDelete} />
        </View>
        <View style={styles.section}>
          <Text style={styles.label}>Rating</Text>
          <View style={styles.rating}>
            <StarRating stars={rating} onSelect={onRate} />
          </View>
        </View>
        <View style={styles.section}>
          <Text style={styles.label}>Details</Text>
          <ClipInfoList rows={rows} />
        </View>
      </ScrollView>
    </View>
  );
}

function Action({
  icon,
  label,
  accessibilityLabel,
  onPress,
  disabled,
  destructive,
  on,
  tint,
  filled,
}: {
  icon: IconSvgElement;
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
  on?: boolean;
  tint?: string;
  filled?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const color = tint ?? (destructive ? colors.destructive : colors.foreground);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled, selected: !!on }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => [styles.action, isHovered(state) && !disabled && styles.actionHover, state.pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Glyph icon={icon} size={20} color={color} filled={filled} strokeWidth={1.7} />
      <Text numberOfLines={1} style={[styles.actionLabel, destructive && { color: colors.destructive }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    flex: { flex: 1 },
    panel: {
      width: INSPECTOR_WIDTH,
      backgroundColor: colors.panel,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.border,
    },
    head: {
      height: TOOLBAR_HEIGHT,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingLeft: 20,
      paddingRight: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    heading: { fontFamily: fonts.semibold, fontSize: 16, color: colors.foreground },
    body: { padding: 20, gap: spacing.lg },
    titleBlock: { gap: 4 },
    fileName: { fontFamily: fonts.semibold, fontSize: 17, letterSpacing: -0.2, color: colors.foreground },
    rendition: { fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground },
    actions: { flexDirection: 'row' as const, gap: 8 },
    action: {
      flex: 1,
      minWidth: 0,
      height: 60,
      borderRadius: 12,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 5,
      backgroundColor: colors.surface,
    },
    actionHover: { backgroundColor: colors.surfaceStrong },
    actionLabel: { fontFamily: fonts.medium, fontSize: 11, color: colors.foreground },
    section: { gap: 8 },
    label: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground },
    rating: { alignItems: 'flex-start' as const },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.4 },
  };
}
