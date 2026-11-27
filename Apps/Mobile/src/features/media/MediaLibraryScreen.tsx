import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  ArrowUpDownIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CloudUploadIcon,
  Delete02Icon,
  FilterHorizontalIcon,
  Image01Icon,
  RefreshIcon,
  Search01Icon,
  Settings02Icon,
  Share08Icon,
  SmartPhone01Icon,
  StarIcon,
  StarOffIcon,
  WifiDisconnected01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCamera, useCameraSession } from '@/camera';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { PageToolbar, ToolbarButton } from '@/components/page-toolbar';
import { WIDE_PAGE_PADDING, useScreenSize, useWideLayout } from '@/constants/layout';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { type MediaLibrarySource, phoneClipItem, useMediaPreferences, usePhoneMedia } from '@/state/media';
import { DeliveryProgressPill, DeliveryQueueSheet } from './DeliveryQueue';
import { deliveryPlatform } from './deliveryPlatform';
import { DeliverySheet } from './DeliverySheet';
import { useDelivery } from './deliveryStore';
import { byteLabel, storageReadout } from './format';
import { categoryTitles, deriveGallery, selectedItems } from './gallery';
import { FilterSheet, ViewSheet } from './LibrarySheets';
import { activeFilterCount, emptyFilters, type MediaCategory, useMediaBrowsing, useMediaLibrary } from './libraryStore';
import { useDesktopMediaSync } from './desktop/useDesktopMediaSync';
import { HeaderButton, TextAction } from './MediaChips';
import { MediaGallery } from './MediaGallery';
import { BusyOverlay, ConfirmSheet, NoticeToast } from './MediaOverlays';
import type { CameraMediaItem } from '@/camera';

const copy = {
  emptyPull: 'Pull to refresh.',
  selectingHint: 'Drag to select more',
  cachedOnly: 'Offline · clips on this phone',
  phoneEmpty: 'Downloads from the camera land here.',
};

const sourceTitles: Record<MediaLibrarySource, string> = { camera: 'Camera', phone: 'Phone' };

/** Mimo's "Device  Local" title tabs: the chosen source in full ink, the other muted. */
function SourceTabs({ value, onChange, compact }: { value: MediaLibrarySource; onChange: (s: MediaLibrarySource) => void; compact?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.sourceTabs} accessibilityRole="tablist">
      {(['camera', 'phone'] as const).map((s) => {
        const on = s === value;
        return (
          <Pressable
            key={s}
            accessibilityRole="tab"
            accessibilityLabel={s === 'camera' ? 'Media on the camera' : 'Clips on this phone'}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(s)}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            style={({ pressed }) => [styles.sourceTab, compact && styles.sourceTabCompact, pressed && !on && { opacity: 0.6 }]}
          >
            <Text numberOfLines={1} style={[styles.title, compact && styles.titleCompact, !on && styles.titleOff]}>
              {sourceTitles[s]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const categories: MediaCategory[] = ['all', 'video', 'photo', 'favorites'];
const DOCK_HEIGHT = 66;

function haptic() {
  if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
}

function CategoryPill({ title, count, selected, onPress }: { title: string; count: number; selected: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`Show ${title} media`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.pill, selected && styles.pillOn, pressed && !selected && { opacity: 0.7 }]}
    >
      <Text style={[styles.pillLabel, selected && styles.pillLabelOn]}>{title}</Text>
      <Text style={[styles.pillCount, selected && styles.pillCountOn]}>{count}</Text>
    </Pressable>
  );
}

function SquareButton({ icon, label, onPress, active, badge }: { icon: IconSvgElement; label: string; onPress: () => void; active?: boolean; badge?: number }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.square, active && styles.squareOn, pressed && { opacity: 0.75 }]}
    >
      <Icon icon={icon} size={19} color={active ? colors.inkForeground : colors.foreground} />
      {badge ? (
        <View style={styles.squareBadge}>
          <Text style={styles.squareBadgeText}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function EmptyState({ icon, title, message, busy, action }: { icon: IconSvgElement; title: string; message?: string; busy?: boolean; action?: { title: string; onPress: () => void } }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.empty}>
      <View style={styles.emptyThumb}>{busy ? <Spinner opacity={1} size={24} color={colors.mutedForeground} /> : <Icon icon={icon} size={28} color={colors.mutedForeground} />}</View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message ? <Text style={styles.emptyMuted}>{message}</Text> : null}
      {action ? <Button title={action.title} onPress={action.onPress} style={styles.emptyAction} /> : null}
    </View>
  );
}

/**
 * The camera's media library (`MonitorMediaCatalog` / `MonitorOperatorCatalogScreen`). Listing
 * pauses live view on the camera; leaving media resumes it (`useMediaBrowsing`).
 */
export default function MediaLibraryScreen() {
  const router = useRouter();
  const session = useCameraSession();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { width, large, landscape } = useScreenSize();
  const wide = width >= 700;
  // Desktop / landscape tablet: a toolbar header, the grid filling the page, no back (the sidebar).
  const wideLayout = useWideLayout();
  useMediaBrowsing();
  // Desktop app: each page of the card's listing fills the grid as it arrives.
  useDesktopMediaSync();

  const identityName = useCamera((s) => s.identity?.name);
  const phase = useCamera((s) => s.connection.phase);
  const freeMb = useCamera((s) => s.power.storageFreeMb);
  const totalMb = useCamera((s) => s.power.storageTotalMb);
  const sdPresent = useCamera((s) => s.power.sdPresent);
  const sourceAvailable = session.kind === 'demo' || phase === 'live' || phase === 'recovering';

  const lib = useMediaLibrary();
  const prefs = useMediaPreferences();
  const source = prefs.librarySource;
  const onPhoneTab = source === 'phone';
  const phoneClips = usePhoneMedia((s) => s.clips);
  const phoneItems = useMemo(() => phoneClips.map(phoneClipItem), [phoneClips]);
  const deliveryPanelOpen = useDelivery((s) => s.panelOpen);
  const setDeliveryPanel = useDelivery((s) => s.setPanelOpen);
  const deliveryCount = useDelivery((s) => s.batches.filter((b) => b.status === 'running' || b.status === 'queued').length);
  const deliveryActive = deliveryCount > 0;

  const [query, setQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareItems, setShareItems] = useState<CameraMediaItem[]>([]);

  // Listing pauses live view on the camera, so it runs only while the Camera tab is shown.
  useEffect(() => {
    if (sourceAvailable && !onPhoneTab) void lib.load(session.media);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sourceAvailable, onPhoneTab]);

  // Originals on this phone: downloaded this session, or saved earlier (the Phone tab's records).
  const onPhone = useMemo(() => {
    const map: Record<string, string> = { ...lib.localFiles };
    for (const c of phoneClips) if (!map[c.id]) map[c.id] = c.localUri || 'saved';
    return map;
  }, [lib.localFiles, phoneClips]);

  // Offline (native camera dropped), only clips cached on this phone are browsable.
  const visibleItems = useMemo(() => {
    const available = onPhoneTab ? phoneItems : sourceAvailable ? lib.items : lib.items.filter((i) => onPhone[i.id]);
    const q = query.trim().toLowerCase();
    return q ? available.filter((i) => i.fileName.toLowerCase().includes(q)) : available;
  }, [onPhoneTab, phoneItems, lib.items, onPhone, sourceAvailable, query]);
  const model = useMemo(
    () =>
      deriveGallery(visibleItems, {
        category: lib.category,
        filters: lib.filters,
        sort: prefs.sort,
        stackBursts: prefs.stackBursts,
        groupByDay: prefs.groupByDay,
      }),
    [visibleItems, lib.category, lib.filters, prefs.sort, prefs.stackBursts, prefs.groupByDay],
  );

  const filterCount = activeFilterCount(lib.filters);
  const cameraName = identityName ?? (session.kind === 'demo' ? 'Demo camera' : 'Camera');
  useEffect(() => lib.setCameraName(cameraName), [cameraName, lib]);
  const setSource = (next: MediaLibrarySource) => {
    if (next === source) return;
    haptic();
    lib.endSelection();
    prefs.set('librarySource', next);
  };

  const back = () => {
    if (lib.selecting) return lib.endSelection();
    if (router.canGoBack()) router.back();
    else router.replace('/live');
  };
  const open = useCallback(
    (id: string) => router.push(onPhoneTab ? `/media/${encodeURIComponent(id)}?from=phone` : `/media/${encodeURIComponent(id)}`),
    [router, onPhoneTab],
  );
  const onSelect = useCallback((id: string) => {
    haptic();
    useMediaLibrary.getState().toggleSelected(id);
  }, []);
  const onBeginSelection = useCallback((id: string) => {
    haptic();
    useMediaLibrary.getState().beginSelection(id);
  }, []);
  const onFavorite = useCallback(
    (id: string) => {
      const entry = model.entries.find((e) => e.id === id);
      if (!entry) return;
      const fav = !entry.members.some((m) => m.favorite);
      const ids = entry.members.map((m) => m.id);
      if (onPhoneTab) usePhoneMedia.getState().setFavorite(ids, fav);
      else void useMediaLibrary.getState().setFavorite(session.media, ids, fav);
    },
    [model.entries, session.media, onPhoneTab],
  );

  const selection = selectedItems(model.entries, lib.selected);
  const allSelected = model.entries.length > 0 && model.entries.every((e) => lib.selected.includes(e.id));
  const allFavorite = selection.length > 0 && selection.every((i) => i.favorite);
  const refresh = () => sourceAvailable && !onPhoneTab && void lib.load(session.media, { refresh: true });
  const searching = query.trim().length > 0;
  const setFavorites = (ids: string[], favorite: boolean) =>
    onPhoneTab ? usePhoneMedia.getState().setFavorite(ids, favorite) : void lib.setFavorite(session.media, ids, favorite);
  /** Phone tab: deletes the copies on this phone; the camera keeps its own. */
  const deleteFromPhone = async (ids: string[]) => {
    for (const c of phoneClips.filter((x) => ids.includes(x.id))) if (c.localUri) await deliveryPlatform.discard(c.localUri);
    usePhoneMedia.getState().remove(ids);
    ids.forEach((id) => lib.forgetLocal(id));
    lib.endSelection();
    lib.showNotice(ids.length === 1 ? 'Deleted 1 item from this phone' : `Deleted ${ids.length} items from this phone`);
  };

  const empty =
    onPhoneTab && !visibleItems.length && !searching ? (
      <EmptyState icon={SmartPhone01Icon} title="No clips on this phone" message={copy.phoneEmpty} />
    ) : !onPhoneTab && lib.status === 'loading' ? (
      <EmptyState icon={Image01Icon} title="Listing clips on camera…" busy />
    ) : !onPhoneTab && lib.status === 'error' ? (
      <EmptyState icon={AlertCircleIcon} title="Couldn't list clips" message={lib.error ?? undefined} action={{ title: 'Try again', onPress: refresh }} />
    ) : !sourceAvailable && !visibleItems.length && !searching ? (
      <EmptyState icon={WifiDisconnected01Icon} title="Camera disconnected" />
    ) : searching && !model.entries.length ? (
      <EmptyState icon={Search01Icon} title="No matches" />
    ) : filterCount > 0 ? (
      <EmptyState icon={FilterHorizontalIcon} title="No matching clips" action={{ title: 'Clear filters', onPress: () => lib.setFilters(emptyFilters) }} />
    ) : lib.category === 'favorites' ? (
      <EmptyState icon={StarIcon} title="No favorites yet" />
    ) : (
      <EmptyState icon={Image01Icon} title={sourceAvailable ? 'No clips yet' : 'No cached clips'} message={sourceAvailable ? copy.emptyPull : undefined} />
    );

  const storage = sdPresent || totalMb > 0 ? `${storageReadout(freeMb, totalMb)} free` : session.kind === 'demo' ? 'Demo card' : null;
  const count = `${model.entries.length} item${model.entries.length === 1 ? '' : 's'}`;
  const phoneBytes = phoneItems.reduce((n, i) => n + (i.sizeBytes || 0), 0);
  const subline = lib.selecting
    ? copy.selectingHint
    : (onPhoneTab ? ['On this phone', count, phoneBytes ? byteLabel(phoneBytes) : null] : [cameraName, storage, count]).filter(Boolean).join(' · ');
  const pad = wideLayout ? WIDE_PAGE_PADDING : Math.max(insets.left, insets.right, spacing.md);
  const dense = prefs.layout === 'grid' && !prefs.gridCaptions;
  // The dense grid runs edge to edge (2 pt in from a phone's edge, the notch side on landscape).
  const gridPad = wideLayout ? pad : dense ? Math.max(insets.left, insets.right, 2) : pad;
  const dockInset = lib.selecting ? DOCK_HEIGHT + Math.max(insets.bottom, 12) + 8 : 0;
  const pillBottom = lib.selecting ? dockInset : Math.max(insets.bottom, 12) + 4;
  const galleryBottom = dockInset + (deliveryActive ? 84 : 0) + (lib.selecting ? 0 : Math.max(insets.bottom, 12));

  const titleRow = (
    <View style={styles.titleRow}>
      <View style={styles.titleLeft}>
        <Pressable accessibilityRole="button" accessibilityLabel={lib.selecting ? 'Exit selection' : 'Back'} onPress={back} hitSlop={8} style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}>
          <Icon icon={lib.selecting ? Cancel01Icon : ArrowLeft01Icon} size={22} color={colors.foreground} />
        </Pressable>
        {lib.selecting ? (
          <Text accessibilityRole="header" accessibilityLiveRegion="polite" numberOfLines={1} style={[styles.title, styles.selectionTitle]}>
            {`${lib.selected.length} selected`}
          </Text>
        ) : (
          <SourceTabs value={source} onChange={setSource} />
        )}
        {wide ? (
          <Text numberOfLines={1} style={styles.sublineInline}>
            {subline}
          </Text>
        ) : null}
      </View>
      <View style={styles.headerRight}>
        {lib.selecting ? (
          <>
            <TextAction
              title={allSelected ? 'Deselect all' : 'Select all'}
              onPress={() => lib.setSelected(allSelected ? [] : model.entries.map((e) => e.id))}
            />
            <TextAction title="Done" label="Exit selection" onPress={lib.endSelection} />
          </>
        ) : (
          <>
            <HeaderButton
              icon={RefreshIcon}
              label="Refresh"
              busy={!onPhoneTab && lib.refreshing}
              onPress={refresh}
              disabled={onPhoneTab || !sourceAvailable || lib.refreshing || lib.status === 'loading'}
            />
            <HeaderButton icon={CloudUploadIcon} label="Deliveries" badge={deliveryCount || undefined} onPress={() => setDeliveryPanel(true)} />
            <HeaderButton icon={CheckmarkCircle02Icon} label="Select" onPress={() => lib.beginSelection()} disabled={!model.entries.length} />
            <HeaderButton icon={Settings02Icon} label="Media settings" round onPress={() => router.push('/media/settings')} />
          </>
        )}
      </View>
    </View>
  );

  const wideToolbar = (
    <PageToolbar
      bordered={false}
      leading={
        lib.selecting ? (
          <View style={styles.titleLeft}>
            <ToolbarButton icon={Cancel01Icon} label="Exit selection" onPress={lib.endSelection} />
            <Text accessibilityRole="header" accessibilityLiveRegion="polite" numberOfLines={1} style={styles.toolbarTitle}>
              {`${lib.selected.length} selected`}
            </Text>
          </View>
        ) : (
          <SourceTabs value={source} onChange={setSource} compact />
        )
      }
      detail={subline}
      actions={
        lib.selecting ? (
          <>
            <ToolbarButton
              variant="secondary"
              title={allSelected ? 'Deselect all' : 'Select all'}
              onPress={() => lib.setSelected(allSelected ? [] : model.entries.map((e) => e.id))}
            />
            <ToolbarButton variant="primary" title="Done" label="Exit selection" onPress={lib.endSelection} />
          </>
        ) : (
          <>
            <ToolbarButton
              icon={RefreshIcon}
              label="Refresh"
              busy={!onPhoneTab && lib.refreshing}
              onPress={refresh}
              disabled={onPhoneTab || !sourceAvailable || lib.refreshing || lib.status === 'loading'}
            />
            <ToolbarButton icon={CloudUploadIcon} label="Deliveries" badge={deliveryCount || undefined} onPress={() => setDeliveryPanel(true)} />
            <ToolbarButton icon={Settings02Icon} label="Media settings" onPress={() => router.push('/media/settings')} />
            <ToolbarButton icon={CheckmarkCircle02Icon} title="Select" variant="secondary" onPress={() => lib.beginSelection()} disabled={!model.entries.length} />
          </>
        )
      }
    />
  );

  const searchRow = (
    <View style={[styles.searchRow, wide && styles.searchRowWide]}>
      <View style={styles.searchField}>
        <Icon icon={Search01Icon} size={18} color={colors.mutedForeground} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search clips"
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel="Search clips"
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          style={[styles.searchInput, Platform.OS === 'web' && ({ outlineStyle: 'none' } as object)]}
        />
        {query ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} hitSlop={8}>
            <Icon icon={Cancel01Icon} size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
      <SquareButton icon={ArrowUpDownIcon} label="Sort and view" onPress={() => setViewOpen(true)} />
      <SquareButton icon={FilterHorizontalIcon} label="Filter library" active={filterCount > 0} badge={filterCount || undefined} onPress={() => setFilterOpen(true)} />
    </View>
  );

  const categoryRow = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll} contentContainerStyle={[styles.categories, wide && styles.categoriesWide]}>
      {categories.map((c) => (
        <CategoryPill key={c} title={categoryTitles[c]} count={model.counts[c]} selected={lib.category === c} onPress={() => lib.setCategory(c)} />
      ))}
    </ScrollView>
  );

  const notices = (
    <>
      {!onPhoneTab && !sourceAvailable && lib.items.length > 0 ? (
        <View style={styles.notice}>
          <Icon icon={WifiDisconnected01Icon} size={16} color={colors.warning} />
          <Text style={[styles.noticeText, { color: colors.warning }]}>{copy.cachedOnly}</Text>
        </View>
      ) : null}
      {!onPhoneTab && lib.error && lib.status === 'ready' ? (
        <View style={styles.notice}>
          <Icon icon={AlertCircleIcon} size={16} color={colors.destructive} />
          <Text style={[styles.noticeText, { color: colors.destructive }]} numberOfLines={2}>
            {lib.error}
          </Text>
        </View>
      ) : null}
    </>
  );

  return (
    <View style={styles.root}>
      {wideLayout ? wideToolbar : null}
      <View style={[styles.header, { paddingTop: wideLayout ? 0 : insets.top + (landscape && !large ? 6 : spacing.sm), paddingLeft: pad, paddingRight: pad }]}>
        <View style={[styles.headerColumn, wideLayout && styles.columnFill]}>
          {wideLayout ? null : titleRow}
          {wide ? null : (
            <Text numberOfLines={1} style={styles.subline}>
              {subline}
            </Text>
          )}
          {notices}
          {wide ? (
            <View style={styles.wideControls}>
              {categoryRow}
              {searchRow}
            </View>
          ) : (
            <>
              {searchRow}
              {categoryRow}
            </>
          )}
        </View>
      </View>

      <View style={[styles.body, { paddingLeft: gridPad, paddingRight: gridPad }]}>
        <View style={[styles.bodyColumn, wideLayout && styles.columnFill]}>
          <MediaGallery
            sections={model.sections}
            layout={prefs.layout}
            thumbnailSize={prefs.thumbnailSize}
            captions={prefs.gridCaptions}
            downloadMarks={!onPhoneTab}
            titleInset={pad - gridPad + 2}
            tablet={large}
            wide={landscape}
            fill={wideLayout}
            selecting={lib.selecting}
            selected={lib.selected}
            transfers={lib.transfers}
            localFiles={onPhone}
            refreshing={!onPhoneTab && lib.refreshing}
            onRefresh={sourceAvailable && !onPhoneTab ? refresh : undefined}
            onOpen={open}
            onSelect={onSelect}
            onBeginSelection={onBeginSelection}
            onSelection={lib.setSelected}
            onFavorite={onFavorite}
            empty={empty}
            bottomInset={galleryBottom}
          />
        </View>
      </View>

      {lib.selecting ? (
        <View style={[styles.dockWrap, { paddingBottom: Math.max(insets.bottom, 12), paddingLeft: pad, paddingRight: pad }]}>
          <View style={styles.dock}>
            <Button
              title={allFavorite ? 'Unstar' : 'Favorite'}
              icon={allFavorite ? StarOffIcon : StarIcon}
              variant="secondary"
              accessibilityLabel="Favorite selected"
              disabled={!selection.length}
              onPress={() => setFavorites(selection.map((i) => i.id), !allFavorite)}
              style={styles.dockButton}
            />
            <Button
              title="Share"
              icon={Share08Icon}
              accessibilityLabel="Share selected"
              disabled={!selection.length}
              onPress={() => {
                setShareItems((onPhoneTab ? phoneItems : lib.items).filter((i) => selection.some((s) => s.id === i.id)));
                setShareOpen(true);
              }}
              style={styles.dockButton}
            />
            <Button
              title="Delete"
              icon={Delete02Icon}
              variant="ghost"
              destructive
              accessibilityLabel="Delete selected"
              disabled={!selection.length || (!onPhoneTab && !sourceAvailable)}
              onPress={() => setConfirmDelete(selection.map((i) => i.id))}
              style={styles.dockButton}
            />
          </View>
        </View>
      ) : null}

      <DeliveryProgressPill bottom={pillBottom} />
      {lib.notice ? <NoticeToast text={lib.notice} bottom={pillBottom + (deliveryActive ? 84 : 12)} /> : null}
      {lib.deleting.length ? <BusyOverlay label={`Deleting ${lib.deleting.length} item${lib.deleting.length === 1 ? '' : 's'}…`} /> : null}

      <FilterSheet visible={filterOpen} options={model.filterOptions} filters={lib.filters} onChange={lib.setFilters} onClose={() => setFilterOpen(false)} />
      <ViewSheet visible={viewOpen} onClose={() => setViewOpen(false)} />
      <DeliverySheet
        visible={shareOpen}
        items={shareItems}
        onClose={() => {
          setShareOpen(false);
          lib.endSelection();
        }}
      />
      <DeliveryQueueSheet visible={deliveryPanelOpen} onClose={() => setDeliveryPanel(false)} />
      <ConfirmSheet
        visible={confirmDelete !== null}
        title={`Delete ${confirmDelete?.length === 1 ? '1 item' : `${confirmDelete?.length ?? 0} items`} from ${onPhoneTab ? 'this phone' : 'the camera'}?`}
        message={onPhoneTab ? 'The camera keeps its copy.' : 'Copies on this phone stay.'}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const ids = confirmDelete ?? [];
          setConfirmDelete(null);
          if (onPhoneTab) void deleteFromPhone(ids);
          else void lib.deleteItems(session.media, ids);
        }}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, backgroundColor: colors.background },
    header: { paddingBottom: spacing.sm },
    headerColumn: { width: '100%' as const, maxWidth: 1200, alignSelf: 'center' as const },
    titleRow: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, gap: spacing.sm, minHeight: 44 },
    titleLeft: { flex: 1, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, minWidth: 0 },
    iconBtn: { padding: 4, marginLeft: -4 },
    title: { fontFamily: fonts.semibold, fontSize: 24, letterSpacing: -0.6, color: colors.foreground, flexShrink: 1 },
    titleOff: { color: colors.mutedForeground, opacity: 0.75 },
    sourceTabs: { flexDirection: 'row' as const, alignItems: 'baseline' as const, gap: 12, flexShrink: 1, minWidth: 0 },
    sourceTab: { minHeight: 44, justifyContent: 'center' as const },
    selectionTitle: { fontSize: 20, letterSpacing: -0.3 },
    titleCompact: { fontSize: 20, letterSpacing: -0.3 },
    sourceTabCompact: { minHeight: 32 },
    toolbarTitle: { fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.3, color: colors.foreground, flexShrink: 1 },
    columnFill: { maxWidth: '100%' as const },
    headerRight: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
    subline: { fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground, marginTop: 2, marginBottom: spacing.sm + 4 },
    sublineInline: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground, marginLeft: spacing.sm, marginTop: 6 },
    notice: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, marginBottom: spacing.sm },
    noticeText: { flex: 1, fontFamily: fonts.medium, fontSize: 13 },
    wideControls: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md, marginTop: 4 },
    searchRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm },
    searchRowWide: { width: 400, flexShrink: 1 },
    searchField: {
      flex: 1,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      height: 38,
      paddingHorizontal: 12,
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
    searchInput: { flex: 1, minWidth: 0, fontFamily: fonts.regular, fontSize: 15, color: colors.foreground, paddingVertical: 0 },
    square: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: colors.surface,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    squareOn: { backgroundColor: colors.ink },
    squareBadge: {
      position: 'absolute' as const,
      top: -4,
      right: -4,
      minWidth: 16,
      height: 16,
      paddingHorizontal: 4,
      borderRadius: 8,
      backgroundColor: colors.primary,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    squareBadgeText: { fontFamily: fonts.semibold, fontSize: 10, color: '#ffffff' },
    categoryScroll: { flexGrow: 1, flexShrink: 1 },
    categories: { gap: spacing.sm, paddingTop: spacing.sm + 2, paddingBottom: 2 },
    categoriesWide: { paddingTop: 0 },
    pill: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      height: 34,
      paddingHorizontal: 14,
      borderRadius: radius.pill,
      backgroundColor: colors.surface,
    },
    pillOn: { backgroundColor: colors.ink },
    pillLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.foreground },
    pillLabelOn: { fontFamily: fonts.semibold, color: colors.inkForeground },
    pillCount: { fontFamily: fonts.medium, fontSize: 12, color: colors.mutedForeground },
    pillCountOn: { color: colors.inkForeground, opacity: 0.6 },
    body: { flex: 1 },
    bodyColumn: { flex: 1, width: '100%' as const, maxWidth: 1200, alignSelf: 'center' as const },
    dockWrap: { position: 'absolute' as const, left: 0, right: 0, bottom: 0, paddingTop: 10 },
    dock: {
      width: '100%' as const,
      maxWidth: 560,
      alignSelf: 'center' as const,
      flexDirection: 'row' as const,
      gap: 8,
      padding: 8,
      borderRadius: 24,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOpacity: 0.12,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
    dockButton: { flex: 1, paddingHorizontal: 8 },
    empty: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
    emptyThumb: {
      width: 72,
      height: 96,
      borderRadius: 14,
      backgroundColor: colors.surface,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      marginBottom: spacing.sm,
    },
    emptyTitle: { fontFamily: fonts.semibold, fontSize: 20, color: colors.foreground, textAlign: 'center' as const },
    emptyMuted: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, textAlign: 'center' as const, maxWidth: 320 },
    emptyAction: { marginTop: spacing.sm, minWidth: 160 },
  };
}
