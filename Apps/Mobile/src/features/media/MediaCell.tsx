import { Image } from 'expo-image';
import { Circle, CircleCheck, Layers, Star } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { MText, colors, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { cardDetail, colorModeLabel, durationLabel, formatLabel } from './format';
import type { GalleryEntry } from './gallery';
import { ArtTag, favoriteGold, onPhoneTint } from './MediaChips';

/** Title + detail under a grid card's picture. Used by the masonry for placement. */
export const gridCaptionHeight = 44;

export interface MediaCellProps {
  entry: GalleryEntry;
  layout: 'grid' | 'list';
  tablet?: boolean;
  /** Grid only: card width; the picture keeps `aspect`. */
  width?: number;
  aspect?: number;
  selecting: boolean;
  selected: boolean;
  /** "18% · 42 MB/s" while downloading. */
  transferCaption?: string | null;
  transferFraction?: number | null;
  onPhone: boolean;
  onOpen: (id: string) => void;
  onSelect: (id: string) => void;
  onBeginSelection: (id: string) => void;
  onFavorite: (id: string) => void;
}

function stateLabel(p: MediaCellProps): { text: string; color: string } {
  if (p.transferFraction != null) return { text: 'CACHING', color: colors.accent };
  if (p.onPhone) return { text: 'ON PHONE', color: onPhoneTint };
  return { text: 'ON CAMERA', color: colors.muted };
}

function Thumbnail({ uri }: { uri?: string }) {
  // Not a touch target: on web this also stops the browser's native image drag from
  // swallowing the drag-select sweep.
  return uri ? (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
      <Image source={{ uri }} style={{ position: 'absolute', inset: 0 }} contentFit="cover" transition={120} recyclingKey={uri} />
    </View>
  ) : (
    <View style={{ position: 'absolute', inset: 0, backgroundColor: colors.raised }} />
  );
}

function SelectMark({ selected, title, onPress }: { selected: boolean; title: string; onPress: () => void }) {
  const Icon = selected ? CircleCheck : Circle;
  return (
    <PressableScale
      accessibilityLabel={selected ? `Deselect ${title}` : `Select ${title}`}
      onPress={onPress}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={20} color={selected ? colors.accent : 'rgba(255,255,255,0.75)'} strokeWidth={2} />
      </View>
    </PressableScale>
  );
}

function FavoriteButton({ favorite, onPress }: { favorite: boolean; onPress: () => void }) {
  return (
    <PressableScale
      accessibilityLabel={favorite ? 'Remove favorite' : 'Add favorite'}
      onPress={onPress}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Star size={14} color={favorite ? favoriteGold : 'rgba(255,255,255,0.75)'} fill={favorite ? favoriteGold : 'transparent'} strokeWidth={2} />
    </PressableScale>
  );
}

function SelectedOverlay({ radius }: { radius: number }) {
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', inset: 0, borderRadius: radius, borderWidth: 2, borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, 0.14) }}
    />
  );
}

function TransferDim({ caption }: { caption: string }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
      <MText size={10} weight="bold" mono numberOfLines={1} adjustsFontSizeToFit>
        {caption}
      </MText>
    </View>
  );
}

/** `MonitorMediaCell`: the gallery's grid card and list row. */
export const MediaCell = memo(function MediaCell(p: MediaCellProps) {
  const { entry, selecting, selected } = p;
  const item = entry.cover;
  const favorite = entry.members.some((m) => m.favorite);
  const duration = item.kind === 'video' ? durationLabel(item.durationSec) : '';
  const burst = entry.members.length > 1 ? entry.members.length : null;
  const state = stateLabel(p);
  const press = () => (selecting ? p.onSelect(entry.id) : p.onOpen(entry.id));
  const a11y = `${item.fileName}${burst ? `, ${burst} frames` : ''}${p.transferCaption ? `, ${p.transferCaption}` : ''}`;

  if (p.layout === 'list') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 59 }}>
        {selecting ? (
          <View style={{ paddingLeft: 4 }}>
            <SelectMark selected={selected} title={item.fileName} onPress={() => p.onSelect(entry.id)} />
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={a11y}
          accessibilityState={{ selected }}
          onPress={press}
          onLongPress={() => !selecting && p.onBeginSelection(entry.id)}
          delayLongPress={400}
          style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: selecting ? 2 : 8, paddingVertical: 8, opacity: pressed ? 0.8 : 1 })}
        >
          <View style={{ width: p.tablet ? 96 : 76, height: p.tablet ? 54 : 43, borderRadius: 6, overflow: 'hidden', backgroundColor: colors.raised }}>
            <Thumbnail uri={item.thumbnailUrl} />
            {p.transferCaption ? <TransferDim caption={p.transferCaption.split(' · ')[0]} /> : null}
            {duration ? (
              <View style={{ position: 'absolute', right: 2, bottom: 2 }}>
                <ArtTag text={duration} />
              </View>
            ) : null}
          </View>
          <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
            <MText size={11.5} weight="semibold" numberOfLines={1}>
              {item.fileName}
            </MText>
            {p.transferCaption && p.transferCaption.includes('·') ? (
              <MText size={9.5} weight="semibold" color={colors.accent} mono numberOfLines={1}>
                {p.transferCaption}
              </MText>
            ) : (
              <MText size={9.5} color={colors.faint} numberOfLines={1}>
                {[cardDetail(item), burst ? `${burst} frames` : null].filter(Boolean).join(' · ')}
              </MText>
            )}
          </View>
          {p.tablet ? (
            <>
              <MText size={10.5} color={colors.secondary} style={{ width: 90 }} numberOfLines={1}>
                {formatLabel(item)}
              </MText>
              <MText size={9} weight="bold" color={colors.secondary} style={{ width: 64 }} numberOfLines={1}>
                {colorModeLabel(item.colorMode) ?? ''}
              </MText>
              <ArtTag text={state.text} color={state.color} tracking={0.4} />
            </>
          ) : null}
        </Pressable>
        <FavoriteButton favorite={favorite} onPress={() => p.onFavorite(entry.id)} />
        {selected ? <SelectedOverlay radius={0} /> : null}
      </View>
    );
  }

  const width = p.width ?? 160;
  const pictureHeight = width / (p.aspect ?? 16 / 9);
  return (
    <View style={{ width, borderRadius: 11, overflow: 'hidden', backgroundColor: colors.surface }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={{ selected }}
        onPress={press}
        onLongPress={() => !selecting && p.onBeginSelection(entry.id)}
        delayLongPress={400}
        style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      >
        <View style={{ width, height: pictureHeight, backgroundColor: colors.raised }}>
          <Thumbnail uri={item.thumbnailUrl} />
          {burst ? (
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, flexDirection: 'row', gap: 2 }}>
              {entry.members.slice(0, 6).map((m) => (
                <View key={m.id} style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.35)' }} />
              ))}
            </View>
          ) : null}
          {p.transferCaption ? <TransferDim caption={p.transferCaption} /> : null}
          <View pointerEvents="none" style={{ position: 'absolute', left: 6, top: 6 }}>
            {selecting ? null : burst ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.66)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 3 }}>
                <Layers size={9} color={colors.text} strokeWidth={2.2} />
                <MText size={8.5} weight="bold">
                  {burst} frames
                </MText>
              </View>
            ) : null}
          </View>
          <View pointerEvents="none" style={{ position: 'absolute', left: 6, bottom: 6 }}>
            <ArtTag text={state.text} color={state.color} tracking={0.4} />
          </View>
          {duration ? (
            <View pointerEvents="none" style={{ position: 'absolute', right: 6, bottom: 6 }}>
              <ArtTag text={duration} />
            </View>
          ) : null}
          {p.transferFraction != null ? (
            <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(0,0,0,0.5)' }}>
              <View style={{ width: `${Math.min(1, Math.max(0, p.transferFraction)) * 100}%`, height: 3, backgroundColor: colors.accent }} />
            </View>
          ) : null}
        </View>
        <View style={{ height: gridCaptionHeight, paddingHorizontal: 9, justifyContent: 'center', gap: 3 }}>
          <MText size={10.5} weight="semibold" numberOfLines={1}>
            {item.fileName}
          </MText>
          <MText size={9} color={colors.faint} numberOfLines={1}>
            {cardDetail(item)}
          </MText>
        </View>
      </Pressable>
      {selecting ? (
        <View style={{ position: 'absolute', left: 2, top: 2 }}>
          <SelectMark selected={selected} title={item.fileName} onPress={() => p.onSelect(entry.id)} />
        </View>
      ) : null}
      <View style={{ position: 'absolute', right: 2, top: 2 }}>
        <FavoriteButton favorite={favorite} onPress={() => p.onFavorite(entry.id)} />
      </View>
      {selected ? <SelectedOverlay radius={11} /> : null}
    </View>
  );
});
