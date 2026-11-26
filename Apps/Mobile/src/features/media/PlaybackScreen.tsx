import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ChartHistogramIcon,
  Delete02Icon,
  GoBackward15SecIcon,
  GoForward15SecIcon,
  InformationCircleIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  RepeatIcon,
  RotateClockwiseIcon,
  Share08Icon,
  StarIcon,
  Timer02Icon,
  ViewIcon,
  ViewOffSlashIcon,
  VolumeHighIcon,
  VolumeMute02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { VideoView } from 'expo-video';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCameraSession } from '@/camera';
import { Chip } from '@/components/chip';
import { ChipRow } from '@/components/field-section';
import { Sheet } from '@/components/sheet';
import { Spinner } from '@/components/spinner';
import { fonts, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';
import AssistBar from '@/features/assists/AssistBar';
import AssistOverlays from '@/features/assists/AssistOverlays';
import LivePicture from '@/features/picture/LivePicture';
import { useMediaPreferences } from '@/state/media';
import { DeliveryProgressPill, DeliveryQueueSheet } from './DeliveryQueue';
import { DeliverySheet } from './DeliverySheet';
import { useDelivery } from './deliveryStore';
import { durationLabel, playbackSubtitle, timecodeLabel } from './format';
import { deriveGallery } from './gallery';
import { useMediaBrowsing, useMediaLibrary } from './libraryStore';
import { favoriteColor, Glyph } from './MediaChips';
import { ConfirmSheet, NoticeToast } from './MediaOverlays';
import { ClipInfoList, clipInfoRows, PlaybackMeters, PlaybackScrubber, SideButton, StarRating, ToolWell, videoText } from './PlaybackParts';
import { usePlaybackEngine } from './usePlaybackEngine';

function fit(aspect: number, w: number, h: number): LayoutRectangle {
  if (w <= 0 || h <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  const width = Math.min(w, h * a);
  const height = width / a;
  return { x: (w - width) / 2, y: (h - height) / 2, width, height };
}

/** Conform targets below the capture rate (`MonitorConformPreview`). */
function conformTargets(fps?: number): number[] {
  if (!fps || fps <= 30) return [];
  return [30, 25, 24].filter((t) => t < fps);
}

/** A plain white transport icon (ai-cut watch chrome), or the big white play disc. */
function Transport({ icon, label, onPress, primary }: { icon: IconSvgElement; label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({ width: primary ? 64 : 48, height: primary ? 64 : 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.65 : 1 })}
    >
      {primary ? (
        <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' }}>
          <Glyph icon={icon} size={26} color="#111111" filled={icon !== RotateClockwiseIcon} strokeWidth={2} />
        </View>
      ) : (
        <Glyph icon={icon} size={24} color="#ffffff" strokeWidth={1.8} />
      )}
    </Pressable>
  );
}

/**
 * The player (`MonitorPlaybackScreen`): one fixed picture child (expo-video, or the demo
 * picture with a simulated timeline), with header actions, transport, scrubber, clip info,
 * star rating, conform preview, assists and clean view layered over it. Always on black.
 */
export default function PlaybackScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = decodeURIComponent(String(params.id ?? ''));
  const router = useRouter();
  const session = useCameraSession();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createStyles);
  const { width, height } = useWindowDimensions();
  const portrait = height >= width;
  useMediaBrowsing();

  const lib = useMediaLibrary();
  const prefs = useMediaPreferences();
  const deliveryPanelOpen = useDelivery((s) => s.panelOpen);
  const setDeliveryPanel = useDelivery((s) => s.setPanelOpen);

  // A deep link straight into playback lists the card first.
  useEffect(() => {
    if (lib.status === 'idle' || lib.service !== session.media) void lib.load(session.media);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const item = lib.items.find((i) => i.id === id);
  const order = useMemo(() => {
    const model = deriveGallery(lib.items, {
      category: lib.category,
      filters: lib.filters,
      sort: prefs.sort,
      stackBursts: prefs.stackBursts,
      groupByDay: false,
    });
    const covers = model.entries.map((e) => e.cover);
    return covers.some((c) => c.id === id) ? covers : lib.items;
  }, [lib.items, lib.category, lib.filters, prefs.sort, prefs.stackBursts, id]);
  const burst = useMemo(() => (item?.groupId ? lib.items.filter((i) => i.groupId === item.groupId) : []), [lib.items, item?.groupId]);
  const orderIndex = order.findIndex((i) => i.id === id || (item?.groupId && i.groupId === item.groupId));
  const prev = orderIndex > 0 ? order[orderIndex - 1] : undefined;
  const next = orderIndex >= 0 && orderIndex < order.length - 1 ? order[orderIndex + 1] : undefined;

  const [chrome, setChrome] = useState(true);
  const [assists, setAssists] = useState(prefs.playbackAssists);
  const [info, setInfo] = useState(false);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [conformOpen, setConformOpen] = useState(false);
  const [conform, setConform] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [scrubbing, setScrubbing] = useState<{ wasPlaying: boolean; position: number } | null>(null);
  const [canvas, setCanvas] = useState({ width: 0, height: 0 });
  const [headerH, setHeaderH] = useState(0);
  const [bottomH, setBottomH] = useState(0);

  useEffect(() => {
    setConform(null);
    setConformOpen(false);
    setRatingOpen(false);
  }, [id]);

  const isVideo = item?.kind === 'video';
  const localUri = item ? lib.localFiles[item.id] : undefined;
  const uri = isVideo ? localUri || item?.previewUrl || item?.originalUrl || null : null;
  const fps = item?.fps ?? 30;
  const targets = conformTargets(item?.fps);
  const engine = usePlaybackEngine({
    uri,
    durationSec: item?.durationSec ?? 10,
    fps,
    loop: prefs.loopPlayback,
    muted: prefs.mutePlayback || conform != null,
    rate: conform && item?.fps ? conform / item.fps : 1,
    autoplay: true,
    itemKey: `${id}|${uri ?? 'sim'}`,
  });

  // Keyboard transport on web: Space play/pause, ←/→ one frame, Shift ±1 s.
  useEffect(() => {
    if (Platform.OS !== 'web' || !isVideo || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === ' ') {
        e.preventDefault();
        engine.toggle();
      } else if (e.key === 'ArrowLeft') e.shiftKey ? engine.seek(engine.position - 1) : engine.stepFrames(-1);
      else if (e.key === 'ArrowRight') e.shiftKey ? engine.seek(engine.position + 1) : engine.stepFrames(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, isVideo]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/media');
  };
  const goTo = (target?: { id: string }) => target && router.setParams({ id: target.id });
  const sideInset = Math.max(insets.left, insets.right);

  if (!item) {
    const waiting = lib.status === 'loading' || lib.status === 'idle';
    return (
      <View style={styles.missing}>
        {waiting ? <Spinner opacity={1} size={24} color="#ffffff" /> : null}
        <Text style={styles.missingText}>{waiting ? 'Preparing playback…' : (lib.error ?? 'This clip is no longer on the camera.')}</Text>
        <View style={{ position: 'absolute', left: sideInset + 16, top: insets.top + 12 }}>
          <SideButton icon={ArrowLeft01Icon} label="Back to media" onPress={goBack} />
        </View>
      </View>
    );
  }

  const rating = prefs.ratings[item.id] ?? 0;
  const position = scrubbing ? scrubbing.position : engine.position;
  const timecode = prefs.playbackTimecode;
  const positionText = timecode ? timecodeLabel(position, item.fps) : durationLabel(position);
  const durationText = timecode ? timecodeLabel(engine.duration, item.fps) : durationLabel(engine.duration);
  const source = localUri ? 'Original · on phone' : !isVideo ? 'On camera' : engine.kind === 'simulated' ? 'On camera · demo picture' : 'Preview · on camera';
  const aspect = item.width && item.height ? item.width / item.height : 16 / 9;
  const rect = fit(aspect, canvas.width, canvas.height);
  const t = engine.position;
  const meterL = engine.playing ? -22 + 10 * Math.sin(t * 3.1) + 6 * Math.sin(t * 11.7) : -120;
  const meterR = engine.playing ? -24 + 10 * Math.sin(t * 2.7 + 1) + 6 * Math.sin(t * 9.3) : -120;
  const muted = prefs.mutePlayback || conform != null;
  const favoriteIds = burst.length ? burst.map((b) => b.id) : [item.id];

  const doDelete = async () => {
    setConfirmDelete(false);
    const ids = burst.length ? burst.map((b) => b.id) : [item.id];
    const target = next ?? prev;
    const ok = await lib.deleteItems(session.media, ids);
    if (!ok) return;
    if (target) router.setParams({ id: target.id });
    else goBack();
  };

  const picture =
    item.kind === 'photo' ? (
      <Image source={{ uri: localUri || item.originalUrl || item.previewUrl || item.thumbnailUrl }} style={{ width: '100%', height: '100%' }} contentFit="contain" transition={150} />
    ) : engine.kind === 'video' ? (
      <VideoView player={engine.player} style={{ width: '100%', height: '100%' }} contentFit="contain" nativeControls={false} />
    ) : (
      <LivePicture source={{ kind: 'demo', scene: 'studio' }} resizeMode="fit" context="playback" />
    );

  const tool = {
    assists: <ToolWell key="assists" icon={ChartHistogramIcon} label="Assists" caption="Assists" active={assists} onPress={() => setAssists((a) => !a)} />,
    conform: (
      <ToolWell
        key="conform"
        icon={Timer02Icon}
        label="Conform preview"
        caption={conform ? `${conform}p` : 'Conform'}
        active={conform != null}
        disabled={!targets.length}
        onPress={() => setConformOpen(true)}
      />
    ),
    sound: (
      <ToolWell
        key="sound"
        icon={muted ? VolumeMute02Icon : VolumeHighIcon}
        label={prefs.mutePlayback ? 'Unmute' : 'Mute'}
        caption={muted ? 'Muted' : 'Sound'}
        onPress={() => prefs.set('mutePlayback', !prefs.mutePlayback)}
      />
    ),
    loop: <ToolWell key="loop" icon={RepeatIcon} label="Loop playback" caption="Loop" active={prefs.loopPlayback} onPress={() => prefs.set('loopPlayback', !prefs.loopPlayback)} />,
    rate: (
      <ToolWell
        key="rate"
        icon={StarIcon}
        label="Star rating"
        caption={rating ? `${rating} of 5` : 'Rate'}
        filledIcon={rating > 0}
        iconColor={rating > 0 ? favoriteColor : undefined}
        onPress={() => setRatingOpen(true)}
      />
    ),
    remove: <ToolWell key="delete" icon={Delete02Icon} label="Delete clip from camera" caption="Delete" destructive onPress={() => setConfirmDelete(true)} />,
    hide: <ToolWell key="hide" icon={ViewOffSlashIcon} label="Hide playback controls" caption="Clean" onPress={() => setChrome(false)} />,
  };

  const transport = (
    <View style={styles.transport}>
      <Transport icon={PreviousIcon} label="Back one frame" onPress={() => engine.stepFrames(-1)} />
      <Transport icon={GoBackward15SecIcon} label="Back 15 seconds" onPress={() => engine.seek(engine.position - 15)} />
      <Transport
        primary
        icon={engine.reachedEnd ? RotateClockwiseIcon : engine.playing ? PauseIcon : PlayIcon}
        label={engine.reachedEnd ? 'Restart clip' : engine.playing ? 'Pause' : 'Play'}
        onPress={() => (engine.reachedEnd ? (engine.seek(0), engine.play()) : engine.toggle())}
      />
      <Transport icon={GoForward15SecIcon} label="Forward 15 seconds" onPress={() => engine.seek(engine.position + 15)} />
      <Transport icon={NextIcon} label="Forward one frame" onPress={() => engine.stepFrames(1)} />
    </View>
  );

  const shareButton = portrait ? (
    <Pressable accessibilityRole="button" accessibilityLabel="Share clip" onPress={() => setSharing(true)} hitSlop={6} style={({ pressed }) => [styles.shareSquare, pressed && { opacity: 0.75 }]}>
      <Glyph icon={Share08Icon} size={21} color="#111111" strokeWidth={1.8} />
    </Pressable>
  ) : (
    <Pressable accessibilityRole="button" accessibilityLabel="Share clip" onPress={() => setSharing(true)} hitSlop={6} style={({ pressed }) => [styles.sharePill, pressed && { opacity: 0.75 }]}>
      <Glyph icon={Share08Icon} size={18} color="#111111" strokeWidth={1.8} />
      <Text style={styles.shareLabel}>Share</Text>
    </Pressable>
  );

  return (
    <View style={styles.root}>
      {/* Picture canvas: fixed child, assists drawn inside the fitted picture rect. */}
      <View style={styles.fill} onLayout={(e) => setCanvas({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
        <View style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, overflow: 'hidden' }}>{picture}</View>
        {assists && isVideo ? (
          <AssistOverlays
            context="playback"
            pictureRect={{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }}
            colorMode={item.colorMode ?? null}
            clearance={{ top: chrome ? headerH : 0, bottom: chrome ? bottomH : 0, left: chrome && !portrait ? sideInset + 84 : 0 }}
          />
        ) : null}
        <Pressable
          accessibilityLabel={chrome ? 'Hide playback controls' : 'Show playback controls'}
          accessibilityRole="button"
          onPress={() => setChrome((c) => !c)}
          onLongPress={() => isVideo && engine.toggle()}
          style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
        {chrome && prev ? (
          <View style={{ position: 'absolute', left: rect.x + 10 + (portrait ? 0 : sideInset), top: rect.y + rect.height / 2 - 22 }}>
            <SideButton icon={ArrowLeft01Icon} label="Previous clip" onPress={() => goTo(prev)} />
          </View>
        ) : null}
        {chrome && next ? (
          <View style={{ position: 'absolute', left: rect.x + rect.width - 54 - (portrait ? 0 : sideInset), top: rect.y + rect.height / 2 - 22 }}>
            <SideButton icon={ArrowRight01Icon} label="Next clip" onPress={() => goTo(next)} />
          </View>
        ) : null}
      </View>

      {isVideo && engine.kind === 'video' && (!engine.ready || engine.error) ? (
        <View pointerEvents="none" style={styles.loading}>
          {engine.error ? null : <Spinner opacity={1} size={24} color="#ffffff" />}
          <Text style={styles.loadingText}>{engine.error ?? 'Preparing playback…'}</Text>
        </View>
      ) : null}

      {chrome ? (
        <>
          {/* Header */}
          <View
            style={[styles.header, { paddingTop: insets.top + (portrait ? 8 : 12), paddingLeft: sideInset + 16, paddingRight: sideInset + 16 }]}
            onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}
          >
            <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0.7)', 'rgba(0,0,0,0)']} style={styles.fill} />
            <View style={styles.headerRow}>
              <SideButton icon={ArrowLeft01Icon} label="Back to media" onPress={goBack} />
              <View style={styles.titleBlock}>
                <Text numberOfLines={1} style={styles.title}>
                  {item.fileName}
                </Text>
                <Text numberOfLines={1} style={styles.subtitle}>
                  {playbackSubtitle(item)}
                </Text>
              </View>
              <View style={styles.headerActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Favorite clip"
                  accessibilityState={{ selected: item.favorite }}
                  onPress={() => void lib.setFavorite(session.media, favoriteIds, !item.favorite)}
                  hitSlop={6}
                  style={({ pressed }) => [styles.headerIcon, pressed && { opacity: 0.7 }]}
                >
                  <Glyph icon={StarIcon} size={22} color={item.favorite ? favoriteColor : '#ffffff'} filled={item.favorite} strokeWidth={1.7} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clip information"
                  accessibilityState={{ selected: info }}
                  onPress={() => setInfo(true)}
                  hitSlop={6}
                  style={({ pressed }) => [styles.headerIcon, pressed && { opacity: 0.7 }]}
                >
                  <Glyph icon={InformationCircleIcon} size={22} color="#ffffff" strokeWidth={1.7} />
                </Pressable>
                {shareButton}
              </View>
            </View>
            <View style={styles.sourceRow}>
              <View style={styles.sourcePill}>
                <Text style={styles.sourceText}>{source}</Text>
              </View>
              {conform ? (
                <View style={styles.sourcePill}>
                  <Text style={styles.sourceText}>{`${conform}p conform`}</Text>
                </View>
              ) : null}
            </View>
            {isVideo && engine.kind === 'simulated' && prefs.playbackAudioMeters ? (
              <View style={styles.meters}>
                <PlaybackMeters left={meterL} right={meterR} />
              </View>
            ) : null}
          </View>

          {/* Bottom: filmstrip for bursts, transport and tools */}
          <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 10), paddingLeft: sideInset + 16, paddingRight: sideInset + 16 }]} onLayout={(e) => setBottomH(e.nativeEvent.layout.height)}>
            <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.45)', 'rgba(0,0,0,0.82)']} locations={[0, 0.35, 1]} style={styles.fill} />
            <View style={styles.bottomColumn}>
              {burst.length > 1 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filmstrip}>
                  {burst.map((b, i) => (
                    <Pressable
                      key={b.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Frame ${i + 1} of ${burst.length}`}
                      accessibilityState={{ selected: b.id === item.id }}
                      onPress={() => router.setParams({ id: b.id })}
                      style={[styles.frame, b.id === item.id && styles.frameOn]}
                    >
                      <Image source={{ uri: b.thumbnailUrl }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}
              {isVideo ? (
                <>
                  <View style={styles.clockRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={timecode ? 'Show minutes and seconds' : 'Show timecode'}
                      onPress={() => prefs.set('playbackTimecode', !timecode)}
                      hitSlop={8}
                      style={styles.clockHit}
                    >
                      <Text style={styles.clock}>{positionText}</Text>
                    </Pressable>
                    <Text style={styles.clockMuted}>{durationText}</Text>
                  </View>
                  <PlaybackScrubber
                    position={position}
                    duration={engine.duration}
                    buffered={engine.buffered}
                    onScrubbing={(active) => {
                      if (active) {
                        setScrubbing({ wasPlaying: engine.playing, position: engine.position });
                        engine.pause();
                      } else setScrubbing(null);
                    }}
                    onScrub={(s) => setScrubbing((cur) => (cur ? { ...cur, position: s } : cur))}
                    onSeek={(s) => {
                      engine.seek(s);
                      if (scrubbing?.wasPlaying) engine.play();
                    }}
                  />
                  {portrait ? (
                    <>
                      {transport}
                      <View style={styles.tools}>{[tool.assists, tool.conform, tool.sound, tool.loop, tool.rate, tool.remove, tool.hide]}</View>
                    </>
                  ) : (
                    <View style={styles.landscapeRow}>
                      <View style={[styles.toolGroup, { justifyContent: 'flex-start' }]}>{[tool.assists, tool.conform, tool.sound, tool.loop]}</View>
                      {transport}
                      <View style={[styles.toolGroup, { justifyContent: 'flex-end' }]}>{[tool.rate, tool.remove, tool.hide]}</View>
                    </View>
                  )}
                </>
              ) : (
                <View style={[styles.tools, styles.photoTools]}>{[tool.rate, tool.remove, tool.hide]}</View>
              )}
            </View>
          </View>
          {assists && isVideo ? (
            <View
              pointerEvents="box-none"
              style={
                portrait
                  ? { position: 'absolute', left: 12, right: 12, bottom: bottomH + 6, alignItems: 'center' }
                  : { position: 'absolute', left: sideInset + 12, top: headerH, bottom: bottomH, justifyContent: 'center' }
              }
            >
              <AssistBar orientation={portrait ? 'portrait' : 'landscape'} context="playback" />
            </View>
          ) : null}
        </>
      ) : (
        <View style={{ position: 'absolute', right: sideInset + 16, bottom: Math.max(insets.bottom, 10) + 12 }}>
          <SideButton icon={ViewIcon} label="Show playback controls" onPress={() => setChrome(true)} />
        </View>
      )}

      <DeliveryProgressPill bottom={chrome ? bottomH + 8 : Math.max(insets.bottom, 10) + 70} />
      {lib.notice ? <NoticeToast text={lib.notice} bottom={(chrome ? bottomH : Math.max(insets.bottom, 10)) + 90} /> : null}

      <Sheet visible={info} title="Clip info" onClose={() => setInfo(false)}>
        <ClipInfoList rows={clipInfoRows(item, { source: localUri ? 'On this phone (original)' : 'On camera', rating, frames: burst.length || undefined })} />
      </Sheet>
      <Sheet visible={ratingOpen} title="Rating" onClose={() => setRatingOpen(false)} expandable={false}>
        <View style={styles.ratingBody}>
          <StarRating stars={rating} onSelect={(s) => prefs.setRating(item.id, s)} />
          <Text style={styles.sheetMuted}>{rating ? `${rating} of 5` : 'Unrated'}</Text>
        </View>
      </Sheet>
      <Sheet visible={conformOpen && targets.length > 0} title="Conform preview" onClose={() => setConformOpen(false)} expandable={false} passthrough>
        <Text style={styles.sheetMuted}>{`Shot at ${item.fps} fps. Play it back at:`}</Text>
        <ChipRow>
          {[null, ...targets].map((target) => (
            <Chip
              key={String(target)}
              label={target == null ? 'Real time' : `${target}p · ${Math.round((target / (item.fps ?? target)) * 100)}%`}
              selected={conform === target}
              onPress={() => setConform(target)}
            />
          ))}
        </ChipRow>
        {conform != null ? <Text style={styles.sheetMuted}>Audio is muted while conformed.</Text> : null}
        <View style={{ height: spacing.sm }} />
      </Sheet>
      <DeliverySheet visible={sharing} items={burst.length ? burst : [item]} onClose={() => setSharing(false)} />
      <DeliveryQueueSheet visible={deliveryPanelOpen} onClose={() => setDeliveryPanel(false)} />
      <ConfirmSheet
        visible={confirmDelete}
        title={burst.length > 1 ? `Delete this burst (${burst.length} photos)?` : isVideo ? 'Delete this clip?' : 'Delete this photo?'}
        message="This removes the file from the camera card."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void doDelete()}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  const fill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };
  return {
    root: { flex: 1, backgroundColor: colors.preview },
    fill,
    missing: { flex: 1, backgroundColor: colors.preview, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 12, padding: 24 },
    missingText: { fontFamily: fonts.medium, fontSize: 14, color: 'rgba(255,255,255,0.7)', textAlign: 'center' as const },
    loading: { ...fill, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 12, backgroundColor: 'rgba(0,0,0,0.6)' },
    loadingText: { fontFamily: fonts.medium, fontSize: 14, ...videoText, textAlign: 'center' as const, maxWidth: 320 },
    header: { position: 'absolute' as const, left: 0, right: 0, top: 0, paddingBottom: 18 },
    headerRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12 },
    titleBlock: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontFamily: fonts.semibold, fontSize: 16, ...videoText },
    subtitle: { fontFamily: fonts.medium, fontSize: 12, color: 'rgba(255,255,255,0.7)', textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 },
    headerActions: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
    headerIcon: { width: 40, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const },
    shareSquare: { width: 44, height: 44, borderRadius: 14, borderCurve: 'continuous' as const, backgroundColor: '#ffffff', alignItems: 'center' as const, justifyContent: 'center' as const, marginLeft: 4 },
    sharePill: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      height: 44,
      paddingHorizontal: 18,
      borderRadius: 999,
      backgroundColor: '#ffffff',
      marginLeft: 6,
    },
    shareLabel: { fontFamily: fonts.semibold, fontSize: 15, color: '#111111' },
    sourceRow: { flexDirection: 'row' as const, gap: 6, marginTop: 10, marginLeft: 56 },
    sourcePill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.45)' },
    sourceText: { fontFamily: fonts.medium, fontSize: 11, color: '#ffffff' },
    meters: { position: 'absolute' as const, left: 72, bottom: -40 },
    bottom: { position: 'absolute' as const, left: 0, right: 0, bottom: 0, paddingTop: 28, alignItems: 'center' as const },
    bottomColumn: { width: '100%' as const, maxWidth: 760, gap: 4 },
    filmstrip: { gap: 6, paddingVertical: 4 },
    frame: { width: 64, height: 44, borderRadius: 8, overflow: 'hidden' as const, borderWidth: 2, borderColor: 'transparent' },
    frameOn: { borderColor: '#ffffff' },
    clockRow: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const },
    clockHit: { minHeight: 28, justifyContent: 'center' as const },
    clock: { fontFamily: fonts.semibold, fontSize: 13, ...videoText, fontVariant: ['tabular-nums' as const] },
    clockMuted: { fontFamily: fonts.medium, fontSize: 13, color: 'rgba(255,255,255,0.65)', fontVariant: ['tabular-nums' as const] },
    transport: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 6 },
    tools: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingTop: 6 },
    photoTools: { justifyContent: 'flex-end' as const, gap: 12 },
    landscapeRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
    toolGroup: { flex: 1, flexDirection: 'row' as const, gap: 6 },
    ratingBody: { alignItems: 'center' as const, gap: 4, paddingBottom: spacing.md },
    sheetMuted: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground },
  };
}
