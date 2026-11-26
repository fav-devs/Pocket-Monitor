import { useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Platform, RefreshControl, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import type { MediaLayout, MediaThumbnailSize } from '@/state/media';
import { MText, colors } from '@/theme';
import { DragSelection } from './dragSelection';
import type { GalleryEntry, GallerySection } from './gallery';
import { layoutMasonry, uprightAspect } from './masonry';
import { gridCaptionHeight, MediaCell } from './MediaCell';
import type { MediaTransfer } from './libraryStore';
import { transferReadout } from './libraryStore';

const gridSpacing = 10;
const sectionHeaderHeight = 30;
const sectionGap = 14;
const listRowHeight = 59;

export function columnsFor(size: MediaThumbnailSize, tablet: boolean, wide: boolean): number {
  const base = size === 'small' ? (tablet ? 5 : 3) : size === 'medium' ? (tablet ? 4 : 2) : tablet ? 2 : 1;
  // A landscape phone has room for one more column at small/medium.
  return wide && !tablet && size !== 'large' ? base + 1 : base;
}

interface Placed {
  entry: GalleryEntry;
  x: number;
  y: number;
  width: number;
  height: number;
  aspect: number;
}

interface PlacedHeader {
  key: string;
  title: string;
  count: number;
  y: number;
}

export interface MediaGalleryProps {
  sections: GallerySection[];
  layout: MediaLayout;
  thumbnailSize: MediaThumbnailSize;
  tablet: boolean;
  wide: boolean;
  selecting: boolean;
  selected: string[];
  transfers: Record<string, MediaTransfer>;
  localFiles: Record<string, string>;
  refreshing: boolean;
  onRefresh?: () => void;
  onOpen: (id: string) => void;
  onSelect: (id: string) => void;
  onBeginSelection: (id: string) => void;
  onSelection: (ids: string[]) => void;
  onFavorite: (id: string) => void;
  empty?: ReactNode;
  bottomInset?: number;
}

/**
 * `MonitorMediaCatalog`'s gallery: day sections over a staggered grid (or a list). Cards are
 * placed absolutely from metadata, so the drag-select sweep can hit-test them exactly:
 * hold a card, then drag; or, while selecting, drag sideways across cards.
 */
export function MediaGallery(p: MediaGalleryProps) {
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [windowTop, setWindowTop] = useState(0);
  const [dragging, setDragging] = useState(false);
  const scrollY = useRef(0);
  const origin = useRef({ x: 0, y: 0 });
  const scrollRef = useRef<ComponentRef<typeof View>>(null);
  const holdArmed = useRef(false);
  const drag = useRef<DragSelection | null>(null);

  const columns = columnsFor(p.thumbnailSize, p.tablet, p.wide);
  const { placed, headers, height, order } = useMemo(() => {
    const placed: Placed[] = [];
    const headers: PlacedHeader[] = [];
    let y = 0;
    for (const section of p.sections) {
      if (section.title) {
        headers.push({ key: section.key, title: section.title, count: section.entries.length, y });
        y += sectionHeaderHeight;
      }
      if (p.layout === 'grid') {
        const m = layoutMasonry(
          section.entries.map((e) => uprightAspect(e.cover.width, e.cover.height)),
          columns,
          width,
          gridSpacing,
          gridCaptionHeight,
        );
        // Placement order follows columns top to bottom so a sweep reads naturally.
        section.entries.forEach((entry, i) => {
          const f = m.frames[i];
          placed.push({ entry, x: f.x, y: y + f.y, width: f.width, height: f.height, aspect: f.aspect });
        });
        y += m.height + sectionGap;
      } else {
        section.entries.forEach((entry, i) => {
          placed.push({ entry, x: 0, y: y + i * (listRowHeight + 1), width, height: listRowHeight, aspect: 16 / 9 });
        });
        y += section.entries.length * (listRowHeight + 1) + sectionGap;
      }
    }
    const order = p.sections.flatMap((s) => s.entries.map((e) => e.id));
    return { placed, headers, height: Math.max(0, y - sectionGap), order };
  }, [p.sections, p.layout, columns, width]);

  // Only realize cards near the viewport (large cards hold thousands of clips).
  const visible = useMemo(() => {
    if (placed.length < 120) return placed;
    const top = windowTop - viewport;
    const bottom = windowTop + viewport * 2;
    return placed.filter((c) => c.y + c.height >= top && c.y <= bottom);
  }, [placed, windowTop, viewport]);

  const hit = (pageX: number, pageY: number): string | null => {
    const x = pageX - origin.current.x;
    const y = pageY - origin.current.y + scrollY.current;
    const c = placed.find((c) => x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height);
    return c?.entry.id ?? null;
  };

  const selectedRef = useRef(p.selected);
  selectedRef.current = p.selected;
  const propsRef = useRef(p);
  propsRef.current = p;
  const measureOrigin = () => {
    scrollRef.current?.measureInWindow?.((x: number, y: number) => {
      origin.current = { x, y };
    });
  };

  /**
   * Sweep tracking reads raw pointer/touch moves on the content (they bubble whatever view owns
   * the responder), so a hold on a card can turn straight into a sweep without lifting.
   */
  const gesture = useRef<{ x0: number; y0: number; startId: string | null; sweeping: boolean } | null>(null);
  const sweptAt = useRef(0);
  const point = (e: { nativeEvent: unknown }) => {
    const n = e.nativeEvent as { pageX?: number; pageY?: number; clientX?: number; clientY?: number; touches?: { pageX: number; pageY: number }[] };
    const t = n.touches && n.touches.length ? n.touches[0] : null;
    return { x: t?.pageX ?? n.pageX ?? n.clientX ?? 0, y: t?.pageY ?? n.pageY ?? n.clientY ?? 0 };
  };
  const onDown = (e: { nativeEvent: unknown }) => {
    measureOrigin();
    const { x, y } = point(e);
    gesture.current = { x0: x, y0: y, startId: hit(x, y), sweeping: false };
    console.log('DBG down', x, y, JSON.stringify(origin.current), gesture.current.startId);
  };
  const onMove = (e: { nativeEvent: unknown }) => {
    const g = gesture.current;
    const { x, y } = point(e);
    console.log('DBG move', !!g, x, y, g?.sweeping, propsRef.current.selecting, holdArmed.current);
    if (!g) return;
    if (!g.sweeping) {
      if (!propsRef.current.selecting) return;
      const dx = x - g.x0;
      const dy = y - g.y0;
      const go = holdArmed.current ? Math.hypot(dx, dy) > 6 : Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3;
      if (!go || !g.startId) return;
      // A hold already selected its card: the sweep that follows selects, never clears it.
      const base = new Set(selectedRef.current);
      if (holdArmed.current) base.delete(g.startId);
      drag.current = DragSelection.begin(order, g.startId, base);
      if (!drag.current) return;
      g.sweeping = true;
      setDragging(true);
      propsRef.current.onSelection([...drag.current.selected]);
    }
    const id = hit(x, y);
    if (id && drag.current?.move(order.indexOf(id))) propsRef.current.onSelection([...drag.current.selected]);
  };
  const onUp = () => {
    if (gesture.current?.sweeping) {
      sweptAt.current = Date.now();
      setDragging(false);
    }
    gesture.current = null;
    drag.current = null;
    holdArmed.current = false;
  };
  /** A sweep that ends on a card must not also count as a tap on it. */
  const guard = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
    if (Date.now() - sweptAt.current < 350 || gesture.current?.sweeping) return;
    fn(...a);
  };

  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
    setViewport(e.nativeEvent.layout.height);
    measureOrigin();
  };

  const selectedSet = useMemo(() => new Set(p.selected), [p.selected]);
  const empty = p.sections.every((s) => s.entries.length === 0);

  return (
    <View ref={scrollRef} style={{ flex: 1 }} onLayout={onLayout}>
      <ScrollView
        style={{ flex: 1 }}
        scrollEnabled={!dragging}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={64}
        onScroll={(e) => {
          scrollY.current = e.nativeEvent.contentOffset.y;
          const bucket = Math.floor(scrollY.current / Math.max(1, viewport / 2)) * Math.max(1, viewport / 2);
          if (bucket !== windowTop) setWindowTop(bucket);
        }}
        onScrollBeginDrag={measureOrigin}
        refreshControl={p.onRefresh ? <RefreshControl refreshing={p.refreshing} onRefresh={p.onRefresh} tintColor={colors.accent} /> : undefined}
        contentContainerStyle={{ paddingBottom: p.bottomInset ?? 12, flexGrow: 1 }}
      >
        {empty ? (
          <View style={{ flex: 1, minHeight: viewport - 12 }}>{p.empty}</View>
        ) : (
          <View
            onTouchStart={onDown}
            onTouchMove={onMove}
            onTouchEnd={onUp}
            onTouchCancel={onUp}
            {...(Platform.OS === 'web' ? { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp } : {})}
            style={{ height, width: '100%' }}
          >
            {headers.map((h) => (
              <View key={h.key} style={{ position: 'absolute', left: 2, right: 0, top: h.y, height: sectionHeaderHeight, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <MText size={10} weight="bold" tracking={1.5} color={colors.secondary} uppercase>
                  {h.title}
                </MText>
                <MText size={9.5} color={colors.faint} mono>
                  {h.count}
                </MText>
              </View>
            ))}
            {p.layout === 'list'
              ? p.sections.map((s) => {
                  const first = placed.find((c) => c.entry.id === s.entries[0]?.id);
                  if (!first) return null;
                  return (
                    <View
                      key={`bg-${s.key}`}
                      style={{ position: 'absolute', left: 0, right: 0, top: first.y, height: s.entries.length * (listRowHeight + 1) - 1, borderRadius: 12, backgroundColor: colors.surface }}
                    />
                  );
                })
              : null}
            {width > 0 &&
              visible.map((c) => {
                const t = p.transfers[c.entry.id];
                const showRate = p.layout === 'list' || p.thumbnailSize !== 'small';
                return (
                  <View key={c.entry.id} style={{ position: 'absolute', left: c.x, top: c.y, width: c.width, height: c.height }}>
                    <MediaCell
                      entry={c.entry}
                      layout={p.layout}
                      tablet={p.tablet}
                      width={c.width}
                      aspect={c.aspect}
                      selecting={p.selecting}
                      selected={selectedSet.has(c.entry.id)}
                      transferCaption={transferReadout(t, showRate)}
                      transferFraction={t ? t.fraction : null}
                      onPhone={!!p.localFiles[c.entry.id]}
                      onOpen={guard(p.onOpen)}
                      onSelect={guard(p.onSelect)}
                      onBeginSelection={(id) => {
                        holdArmed.current = true;
                        p.onBeginSelection(id);
                      }}
                      onFavorite={p.onFavorite}
                    />
                  </View>
                );
              })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
