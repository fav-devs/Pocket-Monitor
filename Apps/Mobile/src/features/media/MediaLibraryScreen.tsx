import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  ArrowUpDown,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  CloudUpload,
  Images,
  LayoutGrid,
  ListFilter,
  ListChecks,
  Menu,
  RefreshCw,
  Settings2,
  Share as ShareIcon,
  Star,
  Trash2,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCamera, useCameraSession } from '@/camera';
import { type MediaThumbnailSize, useMediaPreferences } from '@/state/media';
import { MText, colors, minTouch, radius, withAlpha } from '@/theme';
import { PressableScale, SectionHeader } from '@/ui';
import { DeliveryProgressPill, DeliveryQueuePanel } from './DeliveryQueue';
import { DeliverySheet } from './DeliverySheet';
import { useDelivery } from './deliveryStore';
import { FilterPopup } from './FilterPopup';
import { storageReadout } from './format';
import { categoryTitles, deriveGallery, selectedItems, sortOrder, sortTitles } from './gallery';
import { activeFilterCount, type MediaCategory, useMediaBrowsing, useMediaLibrary } from './libraryStore';
import { MediaChip } from './MediaChips';
import { MediaGallery } from './MediaGallery';
import { ActionButton, BusyOverlay, ConfirmDialog, NoticeToast } from './MediaOverlays';

const copy = {
  emptyAll: 'Nothing on this camera yet. Record a clip, then pull to refresh.',
  emptyFavorites: 'Nothing favorited yet. Star a clip to find it here.',
  emptyVideos: 'No videos on this camera yet. Record a clip, then pull to refresh.',
  emptyPhotos: 'No photos on this camera yet. Capture a still, then pull to refresh.',
  filterEmpty: 'Nothing in this tab matches the filters.',
  disconnected: 'Connect the camera to list clips on the body.',
  browseHint: 'Tap to open · Hold, then drag to select',
  selectingHint: 'Swipe to scroll · Hold or drag sideways to select',
  cachedOnly: 'Camera disconnected. Showing clips cached on this phone.',
};

const categories: MediaCategory[] = ['all', 'video', 'photo', 'favorites'];

function haptic() {
  if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
}

/** `MonitorNavigationItem`: a category with its count; selected gets the accent bar. */
function CategoryItem({ title, count, selected, vertical, onPress }: { title: string; count: number; selected: boolean; vertical: boolean; onPress: () => void }) {
  return (
    <PressableScale
      accessibilityLabel={`Show ${title} media`}
      accessibilityState={{ selected }}
      onPress={onPress}
      noScale
      style={{
        minHeight: minTouch,
        paddingHorizontal: 12,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: selected ? colors.raised : 'transparent',
        alignSelf: vertical ? 'stretch' : 'auto',
      }}
    >
      {selected ? <View style={{ width: 3, height: 16, borderRadius: 2, backgroundColor: colors.accent }} /> : vertical ? <View style={{ width: 3 }} /> : null}
      <MText size={12.5} weight={selected ? 'semibold' : 'medium'} color={selected ? colors.text : colors.secondary} style={vertical ? { flex: 1 } : undefined}>
        {title}
      </MText>
      <MText size={10} color={selected ? colors.accent : colors.faint} mono>
        {count}
      </MText>
    </PressableScale>
  );
}

/** `MonitorCatalogDisplayControls`: grid/list and thumbnail size. */
function DisplayControls() {
  const layout = useMediaPreferences((s) => s.layout);
  const size = useMediaPreferences((s) => s.thumbnailSize);
  const set = useMediaPreferences((s) => s.set);
  const group = { flexDirection: 'row' as const, gap: 2, padding: 3, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.35)' };
  const cell = (on: boolean) => ({ width: 40, height: minTouch - 6, borderRadius: 7, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: on ? 'rgba(255,255,255,0.14)' : 'transparent' });
  return (
    <View accessibilityLabel="Media layout and thumbnail size" style={{ flexDirection: 'row', gap: 6 }}>
      <View style={group}>
        <PressableScale accessibilityLabel="Grid view" accessibilityState={{ selected: layout === 'grid' }} onPress={() => set('layout', 'grid')} style={cell(layout === 'grid')}>
          <LayoutGrid size={13} color={layout === 'grid' ? colors.text : colors.muted} />
        </PressableScale>
        <PressableScale accessibilityLabel="List view" accessibilityState={{ selected: layout === 'list' }} onPress={() => set('layout', 'list')} style={cell(layout === 'list')}>
          <Menu size={13} color={layout === 'list' ? colors.text : colors.muted} />
        </PressableScale>
      </View>
      <View style={group}>
        {(['small', 'medium', 'large'] as MediaThumbnailSize[]).map((s) => {
          const dot = s === 'small' ? 7 : s === 'medium' ? 10 : 13;
          return (
            <PressableScale key={s} accessibilityLabel={`${s[0].toUpperCase()}${s.slice(1)} thumbnails`} accessibilityState={{ selected: size === s }} onPress={() => set('thumbnailSize', s)} style={[cell(size === s), { width: 36 }]}>
              <View style={{ width: dot, height: dot, borderRadius: 3, backgroundColor: size === s ? colors.text : colors.faint }} />
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}

function EmptyState({ title, message, busy, action }: { title: string; message?: string; busy?: boolean; action?: { title: string; onPress: () => void } }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 }}>
      {busy ? <ActivityIndicator color={colors.accent} /> : <Images size={26} color={colors.faint} strokeWidth={1.6} />}
      <MText size={15} weight="semibold" align="center">
        {title}
      </MText>
      {message ? (
        <MText size={12} color={colors.muted} align="center" style={{ maxWidth: 340 }}>
          {message}
        </MText>
      ) : null}
      {action ? (
        <View style={{ flexDirection: 'row', width: 160, marginTop: 6 }}>
          <ActionButton title={action.title} onPress={action.onPress} tone="plain" />
        </View>
      ) : null}
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
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const tablet = Math.min(width, height) >= 600;
  useMediaBrowsing();

  const identityName = useCamera((s) => s.identity?.name);
  const phase = useCamera((s) => s.connection.phase);
  const freeMb = useCamera((s) => s.power.storageFreeMb);
  const totalMb = useCamera((s) => s.power.storageTotalMb);
  const sdPresent = useCamera((s) => s.power.sdPresent);
  const sourceAvailable = session.kind === 'demo' || phase === 'live' || phase === 'recovering';

  const lib = useMediaLibrary();
  const prefs = useMediaPreferences();
  const deliveryPanelOpen = useDelivery((s) => s.panelOpen);
  const setDeliveryPanel = useDelivery((s) => s.setPanelOpen);
  const deliveryCount = useDelivery((s) => s.batches.filter((b) => b.status === 'running' || b.status === 'queued').length);

  const [filterOpen, setFilterOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [shareIds, setShareIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (sourceAvailable) void lib.load(session.media);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sourceAvailable]);

  // Offline (native camera dropped), only clips cached on this phone are browsable.
  const visibleItems = useMemo(
    () => (sourceAvailable ? lib.items : lib.items.filter((i) => lib.localFiles[i.id])),
    [lib.items, lib.localFiles, sourceAvailable],
  );
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
  const brand = (identityName ?? (session.kind === 'demo' ? 'Demo camera' : 'Camera')).toUpperCase();

  const back = () => {
    if (lib.selecting) return lib.endSelection();
    if (router.canGoBack()) router.back();
    else router.replace('/live');
  };
  const open = useCallback((id: string) => router.push(`/media/${encodeURIComponent(id)}`), [router]);
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
      void useMediaLibrary.getState().setFavorite(session.media, entry.members.map((m) => m.id), fav);
    },
    [model.entries, session.media],
  );

  const selection = selectedItems(model.entries, lib.selected);
  const cycleSort = () => prefs.set('sort', sortOrder[(sortOrder.indexOf(prefs.sort) + 1) % sortOrder.length]);
  const refresh = () => sourceAvailable && void lib.load(session.media, { refresh: true });

  const tabMessage =
    lib.category === 'favorites' ? copy.emptyFavorites : lib.category === 'video' ? copy.emptyVideos : lib.category === 'photo' ? copy.emptyPhotos : copy.emptyAll;
  const empty =
    lib.status === 'loading' ? (
      <EmptyState title="Listing clips on camera…" busy />
    ) : lib.status === 'error' ? (
      <EmptyState title="Couldn't list clips" message={lib.error ?? undefined} action={{ title: 'Try again', onPress: refresh }} />
    ) : !sourceAvailable && !visibleItems.length ? (
      <EmptyState title="Camera disconnected" message={copy.disconnected} />
    ) : filterCount > 0 ? (
      <EmptyState title="No matching clips" message={copy.filterEmpty} action={{ title: 'Clear filters', onPress: () => lib.setFilters({ resolutions: [], frameRates: [], colors: [] }) }} />
    ) : (
      <EmptyState title={sourceAvailable ? 'No clips yet' : 'No cached clips'} message={tabMessage} />
    );

  const hint = lib.selecting ? copy.selectingHint : sourceAvailable ? copy.browseHint : copy.cachedOnly;
  const storage = sdPresent || totalMb > 0 ? storageReadout(freeMb, totalMb) : session.kind === 'demo' ? 'Demo card' : '—';

  const navCategories = categories.map((c) => (
    <CategoryItem key={c} title={categoryTitles[c]} count={model.counts[c]} selected={lib.category === c} vertical={landscape} onPress={() => lib.setCategory(c)} />
  ));

  const header = (
    <View style={{ flexDirection: landscape && width > 760 ? 'row' : 'column', gap: 8, alignItems: landscape && width > 760 ? 'center' : 'stretch' }}>
      <View style={{ flex: landscape && width > 760 ? 1 : undefined, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {lib.refreshing ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          <MText size={10.5} weight="semibold">
            {model.entries.length} items · {categoryTitles[lib.category].toLowerCase()}
          </MText>
        </View>
        <MText size={9} color={colors.faint} numberOfLines={2}>
          {hint}
        </MText>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ flexGrow: 0 }}>
        <MediaChip icon={ArrowUpDown} label="Sort" text={sortTitles[prefs.sort]} onPress={cycleSort} />
        <MediaChip icon={ListFilter} label="Filter library" text={filterCount ? `Filter ${filterCount}` : 'Filter'} active={filterOpen || filterCount > 0} onPress={() => setFilterOpen(true)} />
        <MediaChip icon={ListChecks} label={lib.selecting ? 'Exit selection' : 'Select'} text={lib.selecting ? 'Done' : 'Select'} active={lib.selecting} onPress={() => (lib.selecting ? lib.endSelection() : lib.beginSelection())} />
        <MediaChip icon={CloudUpload} label="Deliveries" text={deliveryCount ? `Queue ${deliveryCount}` : 'Queue'} active={deliveryCount > 0} onPress={() => setDeliveryPanel(true)} />
        <MediaChip icon={RefreshCw} label="Refresh" onPress={refresh} disabled={!sourceAvailable || lib.refreshing || lib.status === 'loading'} />
        <MediaChip icon={Settings2} label="Media settings" onPress={() => router.push('/media/settings')} />
      </ScrollView>
    </View>
  );

  const selectionTray = lib.selecting ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 6, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
      <MediaChip icon={X} label="Exit selection" onPress={lib.endSelection} />
      <MText size={10.5} weight="semibold" numberOfLines={1}>
        {lib.selected.length} selected
      </MText>
      <View style={{ flex: 1 }} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 3 }} style={{ flexGrow: 0, flexShrink: 1 }}>
        <MediaChip icon={CircleCheck} label="Select all" text="All" onPress={() => lib.setSelected(model.entries.map((e) => e.id))} />
        <MediaChip
          icon={Star}
          label="Favorite selected"
          disabled={!selection.length}
          onPress={() => void lib.setFavorite(session.media, selection.map((i) => i.id), !selection.every((i) => i.favorite))}
        />
        <MediaChip icon={ShareIcon} label="Share selected" text="Share" active disabled={!selection.length} onPress={() => setShareIds(selection.map((i) => i.id))} />
        <MediaChip icon={Trash2} label="Delete selected" danger disabled={!selection.length || !sourceAvailable} onPress={() => setConfirmDelete(selection.map((i) => i.id))} />
      </ScrollView>
    </View>
  ) : null;

  const gallery = (
    <MediaGallery
      sections={model.sections}
      layout={prefs.layout}
      thumbnailSize={prefs.thumbnailSize}
      tablet={tablet}
      wide={landscape}
      selecting={lib.selecting}
      selected={lib.selected}
      transfers={lib.transfers}
      localFiles={lib.localFiles}
      refreshing={lib.refreshing}
      onRefresh={sourceAvailable ? refresh : undefined}
      onOpen={open}
      onSelect={onSelect}
      onBeginSelection={onBeginSelection}
      onSelection={lib.setSelected}
      onFavorite={onFavorite}
      empty={empty}
      bottomInset={deliveryCount ? 72 : 12}
    />
  );

  const backButton = (
    <PressableScale accessibilityLabel={lib.selecting ? 'Exit selection' : 'Back'} onPress={back} style={{ width: 48, height: 48, borderRadius: radius.md, backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center' }}>
      <ChevronLeft size={22} color={colors.text} strokeWidth={2} />
    </PressableScale>
  );
  const heading = (
    <View style={{ gap: 1, flexShrink: 1 }}>
      <MText size={8.5} weight="bold" tracking={1.4} color={colors.accent} numberOfLines={1}>
        {brand}
      </MText>
      <MText size={17} weight="semibold">
        Media
      </MText>
    </View>
  );
  const statusCard = (
    <View style={{ padding: 9, gap: 5, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.04)' }}>
      <SectionHeader title="Library" />
      <MText size={9.5} color={colors.muted} numberOfLines={3}>
        {sourceAvailable ? 'Camera + local cache' : 'Available on this phone'}
      </MText>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <MText size={9.5} color={colors.muted}>
          Card free
        </MText>
        <MText size={9.5} weight="semibold" color={colors.secondary} mono>
          {storage}
        </MText>
      </View>
      {lib.error && lib.status === 'ready' ? (
        <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center' }}>
          <CircleAlert size={11} color={colors.linkWatch} />
          <MText size={9} color={colors.linkWatch} numberOfLines={2} style={{ flex: 1 }}>
            {lib.error}
          </MText>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      {landscape ? (
        <View style={{ flex: 1, flexDirection: 'row', paddingTop: Math.max(insets.top, 10), paddingBottom: Math.max(insets.bottom, 10), paddingLeft: Math.max(insets.left, 10), paddingRight: Math.max(insets.right, 12), gap: 12 }}>
          <View style={{ width: 206, borderRadius: 16, backgroundColor: colors.surface, padding: 10, gap: 9 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {backButton}
              {heading}
            </View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 2 }} showsVerticalScrollIndicator={false}>
              {navCategories}
              <View style={{ height: 8 }} />
              {statusCard}
            </ScrollView>
            <DisplayControls />
          </View>
          <View style={{ flex: 1, gap: 8 }}>
            {header}
            {gallery}
            {selectionTray}
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, paddingTop: insets.top + 6, paddingBottom: Math.max(insets.bottom, 8), paddingHorizontal: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {backButton}
            {heading}
            <View style={{ flex: 1 }} />
            <View style={{ alignItems: 'flex-end' }}>
              <MText size={8.5} weight="bold" tracking={1.2} color={colors.faint}>
                CARD FREE
              </MText>
              <MText size={10.5} weight="semibold" color={colors.secondary} mono>
                {storage}
              </MText>
            </View>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 4 }}>
            {navCategories}
          </ScrollView>
          {header}
          {gallery}
          {selectionTray}
          {!lib.selecting ? (
            <View style={{ alignItems: 'center' }}>
              <DisplayControls />
            </View>
          ) : null}
        </View>
      )}

      <DeliveryProgressPill bottom={Math.max(insets.bottom, 10) + (landscape ? 4 : 64)} />
      {lib.notice ? <NoticeToast text={lib.notice} bottom={Math.max(insets.bottom, 10) + 70} /> : null}
      {lib.deleting.length ? <BusyOverlay label={`Deleting ${lib.deleting.length} item${lib.deleting.length === 1 ? '' : 's'}…`} /> : null}
      {filterOpen ? <FilterPopup options={model.filterOptions} filters={lib.filters} onChange={lib.setFilters} onClose={() => setFilterOpen(false)} /> : null}
      {shareIds ? (
        <DeliverySheet
          items={lib.items.filter((i) => shareIds.includes(i.id))}
          onClose={() => {
            setShareIds(null);
            lib.endSelection();
          }}
        />
      ) : null}
      {deliveryPanelOpen ? <DeliveryQueuePanel onClose={() => setDeliveryPanel(false)} /> : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={confirmDelete.length === 1 ? 'Delete 1 item from the camera?' : `Delete ${confirmDelete.length} items from the camera?`}
          message="This removes the files from the camera card. Copies already on this phone stay."
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const ids = confirmDelete;
            setConfirmDelete(null);
            void lib.deleteItems(session.media, ids);
          }}
        />
      ) : null}
      {/* The accent wash under the selection count keeps the mode obvious on bright thumbnails. */}
      {lib.selecting ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, backgroundColor: withAlpha(colors.accent, 0.8) }} /> : null}
    </View>
  );
}
