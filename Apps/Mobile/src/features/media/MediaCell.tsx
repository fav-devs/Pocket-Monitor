import { Image01Icon, Layers01Icon, SmartPhone01Icon, StarIcon, Tick02Icon, Video01Icon } from '@hugeicons/core-free-icons';
import { Image } from 'expo-image';
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { cardDetail, colorModeLabel, durationLabel, formatLabel } from './format';
import type { GalleryEntry } from './gallery';
import { ArtPill, favoriteColor, Glyph, ProgressBar } from './MediaChips';

/** Name + detail under a grid tile's picture. Used by the masonry for placement. */
export const gridCaptionHeight = 44;
/** A list row's height (the gallery places rows from it). */
export const listRowHeight = 64;
const TILE_RADIUS = 14;

export interface MediaCellProps {
  entry: GalleryEntry;
  layout: 'grid' | 'list';
  tablet?: boolean;
  /** Grid only: tile width; the picture keeps `aspect`. */
  width?: number;
  aspect?: number;
  selecting: boolean;
  selected: boolean;
  /** "18% · 42 MB/s" while downloading. */
  transferCaption?: string | null;
  transferFraction?: number | null;
  onPhone: boolean;
  /** List only: the first / last row of its section (rounded corners, no separator). */
  first?: boolean;
  last?: boolean;
  onOpen: (id: string) => void;
  onSelect: (id: string) => void;
  onBeginSelection: (id: string) => void;
  onFavorite: (id: string) => void;
}

function stateLabel(p: MediaCellProps): string {
  if (p.transferFraction != null) return 'Caching';
  if (p.onPhone) return 'On phone';
  return 'On camera';
}

function Thumbnail({ uri, kind }: { uri?: string; kind: 'video' | 'photo' }) {
  const { colors } = useTheme();
  // Not a touch target: on web this also stops the browser's native image drag from
  // swallowing the drag-select sweep.
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
      {uri ? (
        <Image source={{ uri }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="cover" transition={120} recyclingKey={uri} />
      ) : (
        <Icon icon={kind === 'video' ? Video01Icon : Image01Icon} size={22} color={colors.mutedForeground} />
      )}
    </View>
  );
}

/** The selection check (ai-cut tile badge): an empty ring, or a filled primary tick. */
function SelectMark({ selected, title, onPress }: { selected: boolean; title: string; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={selected ? `Deselect ${title}` : `Select ${title}`}
      onPress={onPress}
      style={styles.markHit}
    >
      <View style={[styles.mark, selected && styles.markOn]}>{selected ? <Icon icon={Tick02Icon} size={15} color="#ffffff" strokeWidth={2.5} /> : null}</View>
    </Pressable>
  );
}

function FavoriteButton({ favorite, onPress, onPicture }: { favorite: boolean; onPress: () => void; onPicture: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={favorite ? 'Remove favorite' : 'Add favorite'}
      accessibilityState={{ selected: favorite }}
      onPress={onPress}
      style={({ pressed }) => [styles.markHit, pressed && { opacity: 0.7 }]}
    >
      {onPicture ? (
        <View style={styles.favWell}>
          <Glyph icon={StarIcon} size={14} color={favorite ? favoriteColor : '#ffffff'} filled={favorite} strokeWidth={2} />
        </View>
      ) : (
        <Glyph icon={StarIcon} size={18} color={favorite ? favoriteColor : colors.mutedForeground} filled={favorite} strokeWidth={1.7} />
      )}
    </Pressable>
  );
}

/** `MonitorMediaCell`: the gallery's grid tile and list row. */
export const MediaCell = memo(function MediaCell(p: MediaCellProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { entry, selecting, selected } = p;
  const item = entry.cover;
  const favorite = entry.members.some((m) => m.favorite);
  const duration = item.kind === 'video' ? durationLabel(item.durationSec) : '';
  const burst = entry.members.length > 1 ? entry.members.length : null;
  const press = () => (selecting ? p.onSelect(entry.id) : p.onOpen(entry.id));
  const a11y = `${item.fileName}${burst ? `, ${burst} frames` : ''}${p.transferCaption ? `, ${p.transferCaption}` : ''}`;
  const detail = [cardDetail(item), burst ? `${burst} frames` : null].filter(Boolean).join(' · ');

  if (p.layout === 'list') {
    const rate = p.transferCaption && p.transferCaption.includes('·');
    return (
      <View style={[styles.listRow, !p.last && styles.listBorder, selected && styles.listSelected, p.first && styles.listFirst, p.last && styles.listLast]}>
        {selecting ? <SelectMarkList selected={selected} title={item.fileName} onPress={() => p.onSelect(entry.id)} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={a11y}
          accessibilityState={{ selected }}
          onPress={press}
          onLongPress={() => !selecting && p.onBeginSelection(entry.id)}
          delayLongPress={400}
          style={({ pressed }) => [styles.listPress, { paddingLeft: selecting ? 0 : 12 }, pressed && { opacity: 0.75 }]}
        >
          <View style={[styles.listThumb, p.tablet && styles.listThumbLarge]}>
            <Thumbnail uri={item.thumbnailUrl} kind={item.kind} />
            {p.transferCaption ? (
              <View pointerEvents="none" style={styles.dim}>
                <Text style={styles.dimText}>{p.transferCaption.split(' · ')[0]}</Text>
              </View>
            ) : null}
            {duration ? <ArtPill text={duration} style={styles.listDuration} /> : null}
          </View>
          <View style={styles.listText}>
            <Text numberOfLines={1} style={styles.listName}>
              {item.fileName}
            </Text>
            <Text numberOfLines={1} style={[styles.listDetail, rate && { color: colors.primary }]}>
              {rate ? p.transferCaption : detail}
            </Text>
          </View>
          {p.tablet ? (
            <>
              <Text numberOfLines={1} style={[styles.listColumn, { width: 84 }]}>
                {formatLabel(item)}
              </Text>
              <Text numberOfLines={1} style={[styles.listColumn, { width: 72 }]}>
                {colorModeLabel(item.colorMode) ?? ''}
              </Text>
              <Text numberOfLines={1} style={[styles.listColumn, { width: 76 }, p.onPhone && { color: colors.success }]}>
                {stateLabel(p)}
              </Text>
            </>
          ) : null}
        </Pressable>
        <FavoriteButton favorite={favorite} onPicture={false} onPress={() => p.onFavorite(entry.id)} />
      </View>
    );
  }

  const width = p.width ?? 160;
  const pictureHeight = width / (p.aspect ?? 16 / 9);
  return (
    <View style={{ width }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={{ selected }}
        onPress={press}
        onLongPress={() => !selecting && p.onBeginSelection(entry.id)}
        delayLongPress={400}
        style={({ pressed }) => [pressed && { opacity: 0.8 }]}
      >
        <View style={[styles.picture, { width, height: pictureHeight }]}>
          <Thumbnail uri={item.thumbnailUrl} kind={item.kind} />
          {p.transferCaption ? (
            <View pointerEvents="none" style={styles.dim}>
              <Text numberOfLines={1} adjustsFontSizeToFit style={styles.dimText}>
                {p.transferCaption}
              </Text>
            </View>
          ) : null}
          {burst && !selecting ? <ArtPill icon={Layers01Icon} text={`${burst}`} style={styles.topLeft} /> : null}
          {p.onPhone && p.transferFraction == null ? <ArtPill icon={SmartPhone01Icon} style={styles.bottomLeft} /> : null}
          {duration ? <ArtPill text={duration} style={styles.bottomRight} /> : null}
          {p.transferFraction != null ? <ProgressBar fraction={p.transferFraction} height={3} onVideo style={styles.transferBar} /> : null}
          {selected ? <View pointerEvents="none" style={styles.selectedOutline} /> : null}
        </View>
        <View style={styles.meta}>
          <Text numberOfLines={1} style={styles.name}>
            {item.fileName}
          </Text>
          <Text numberOfLines={1} style={styles.detail}>
            {cardDetail(item) || (item.kind === 'video' ? 'Video' : 'Photo')}
          </Text>
        </View>
      </Pressable>
      {selecting ? (
        <View style={styles.markPos}>
          <SelectMark selected={selected} title={item.fileName} onPress={() => p.onSelect(entry.id)} />
        </View>
      ) : null}
      <View style={styles.favPos}>
        <FavoriteButton favorite={favorite} onPicture onPress={() => p.onFavorite(entry.id)} />
      </View>
    </View>
  );
});

function SelectMarkList({ selected, title, onPress }: { selected: boolean; title: string; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={selected ? `Deselect ${title}` : `Select ${title}`}
      onPress={onPress}
      style={styles.markHit}
    >
      <View style={[styles.mark, { borderColor: colors.borderStrong, backgroundColor: 'transparent' }, selected && styles.markOn]}>
        {selected ? <Icon icon={Tick02Icon} size={15} color="#ffffff" strokeWidth={2.5} /> : null}
      </View>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  const fill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };
  return {
    picture: { borderRadius: TILE_RADIUS, overflow: 'hidden' as const, backgroundColor: colors.surface },
    meta: { height: gridCaptionHeight, paddingTop: 6, paddingRight: 4 },
    name: { fontFamily: fonts.semibold, fontSize: 12, color: colors.foreground },
    detail: { fontFamily: fonts.regular, fontSize: 11, color: colors.mutedForeground, marginTop: 1 },
    topLeft: { position: 'absolute' as const, top: 7, left: 7 },
    bottomLeft: { position: 'absolute' as const, bottom: 7, left: 7 },
    bottomRight: { position: 'absolute' as const, bottom: 7, right: 7 },
    transferBar: { position: 'absolute' as const, left: 0, right: 0, bottom: 0, borderRadius: 0 },
    dim: { ...fill, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center' as const, justifyContent: 'center' as const, paddingHorizontal: 4 },
    dimText: { fontFamily: fonts.semibold, fontSize: 12, color: '#ffffff', fontVariant: ['tabular-nums' as const] },
    selectedOutline: { ...fill, borderRadius: TILE_RADIUS, borderWidth: 3, borderColor: colors.primary, backgroundColor: 'rgba(23,169,243,0.12)' },
    markPos: { position: 'absolute' as const, top: -2, left: -2 },
    favPos: { position: 'absolute' as const, top: -2, right: -2 },
    markHit: { width: 44, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    mark: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: '#ffffff',
      backgroundColor: 'rgba(0,0,0,0.2)',
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    markOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    favWell: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center' as const, justifyContent: 'center' as const },
    listRow: { flexDirection: 'row' as const, alignItems: 'center' as const, height: listRowHeight, paddingRight: 2 },
    listBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    listSelected: { backgroundColor: colors.primarySoft },
    listFirst: { borderTopLeftRadius: 22, borderTopRightRadius: 22 },
    listLast: { borderBottomLeftRadius: 22, borderBottomRightRadius: 22 },
    listPress: { flex: 1, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, height: '100%' as const },
    listThumb: { width: 72, height: 44, borderRadius: 10, overflow: 'hidden' as const, backgroundColor: colors.surfaceStrong },
    listThumbLarge: { width: 84, height: 48 },
    listDuration: { position: 'absolute' as const, right: 3, bottom: 3, paddingHorizontal: 5, paddingVertical: 1 },
    listText: { flex: 1, minWidth: 0, gap: 2 },
    listName: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    listDetail: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
    listColumn: { fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground },
  };
}
