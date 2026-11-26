import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { VideoView } from 'expo-video';
import {
  Box,
  ChevronLeft,
  ChevronRight,
  Info,
  Maximize,
  Minimize,
  Pause,
  Play,
  Repeat,
  RotateCw,
  Share as ShareIcon,
  SkipBack,
  SkipForward,
  Star,
  StepBack,
  StepForward,
  Timer,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCameraSession } from '@/camera';
import AssistBar from '@/features/assists/AssistBar';
import AssistOverlays from '@/features/assists/AssistOverlays';
import LivePicture from '@/features/picture/LivePicture';
import { useMediaPreferences } from '@/state/media';
import { MText, colors, minTouch, radius } from '@/theme';
import { PressableScale } from '@/ui';
import { DeliveryProgressPill, DeliveryQueuePanel } from './DeliveryQueue';
import { DeliverySheet } from './DeliverySheet';
import { useDelivery } from './deliveryStore';
import { durationLabel, playbackSubtitle, timecodeLabel } from './format';
import { deriveGallery } from './gallery';
import { useMediaBrowsing, useMediaLibrary } from './libraryStore';
import { favoriteGold, PlaybackChip } from './MediaChips';
import { ConfirmDialog, NoticeToast } from './MediaOverlays';
import { ClipInfoPanel, clipInfoRows, PlaybackMeters, PlaybackScrubber, RatingAnchor, StarRating } from './PlaybackParts';
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

function TransportButton({ icon: Icon, label, onPress, size = 22, disabled }: { icon: typeof Play; label: string; onPress: () => void; size?: number; disabled?: boolean }) {
  return (
    <PressableScale accessibilityLabel={label} onPress={onPress} disabled={disabled} style={{ width: size > 24 ? 56 : minTouch, height: minTouch, alignItems: 'center', justifyContent: 'center' }}>
      <Icon size={size} color={colors.text} strokeWidth={1.8} fill={Icon === Play || Icon === Pause ? colors.text : 'transparent'} />
    </PressableScale>
  );
}

/**
 * The player (`MonitorPlaybackScreen`): one fixed picture child (expo-video, or the demo
 * picture with a simulated timeline), with header actions, transport, scrubber, clip info,
 * star rating, conform preview, assists and clean view layered over it.
 */
export default function PlaybackScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = decodeURIComponent(String(params.id ?? ''));
  const router = useRouter();
  const session = useCameraSession();
  const insets = useSafeAreaInsets();
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
  const uri = isVideo ? (localUri || item?.previewUrl || item?.originalUrl || null) : null;
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

  if (!item) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
        {lib.status === 'loading' || lib.status === 'idle' ? <ActivityIndicator color={colors.accent} /> : null}
        <MText size={14} weight="medium" color={colors.muted} align="center">
          {lib.status === 'loading' || lib.status === 'idle' ? 'Preparing playback…' : lib.error ?? 'This clip is no longer on the camera.'}
        </MText>
        <View style={{ position: 'absolute', left: insets.left + 16, top: insets.top + 12 }}>
          <PlaybackChip icon={ChevronLeft} label="Back to media" onPress={goBack} />
        </View>
      </View>
    );
  }

  const rating = prefs.ratings[item.id] ?? 0;
  const position = scrubbing ? scrubbing.position : engine.position;
  const timecode = prefs.playbackTimecode;
  const positionText = timecode ? timecodeLabel(position, item.fps) : durationLabel(position);
  const durationText = timecode ? timecodeLabel(engine.duration, item.fps) : durationLabel(engine.duration);
  const source = localUri ? 'ORIGINAL · ON PHONE' : engine.kind === 'simulated' ? 'ON CAMERA · DEMO PICTURE' : 'PREVIEW · ON CAMERA';
  const aspect = item.width && item.height ? item.width / item.height : 16 / 9;
  const rect = fit(aspect, canvas.width, canvas.height);
  const sideInset = Math.max(insets.left, insets.right);
  const t = engine.position;
  const meterL = engine.playing ? -22 + 10 * Math.sin(t * 3.1) + 6 * Math.sin(t * 11.7) : -120;
  const meterR = engine.playing ? -24 + 10 * Math.sin(t * 2.7 + 1) + 6 * Math.sin(t * 9.3) : -120;

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

  const headerActions = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: portrait ? 'flex-end' : undefined }}>
      <RatingAnchor stars={rating} expanded={ratingOpen} onToggle={() => setRatingOpen((v) => !v)} />
      <PlaybackChip
        icon={Star}
        label="Favorite clip"
        filled={item.favorite}
        tint={item.favorite ? favoriteGold : undefined}
        onPress={() => void lib.setFavorite(session.media, burst.length ? burst.map((b) => b.id) : [item.id], !item.favorite)}
      />
      <PlaybackChip icon={Info} label="Clip information" active={info} onPress={() => setInfo((v) => !v)} />
      <PlaybackChip icon={ShareIcon} label="Share clip" accent text={portrait ? undefined : 'Share'} onPress={() => setSharing(true)} />
      <PlaybackChip icon={Trash2} label="Delete clip from camera" destructive onPress={() => setConfirmDelete(true)} />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Picture canvas: fixed child, assists drawn inside the fitted picture rect. */}
      <View style={{ position: 'absolute', inset: 0 }} onLayout={(e) => setCanvas({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
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
          <PressableScale accessibilityLabel="Previous clip" onPress={() => goTo(prev)} style={{ position: 'absolute', left: rect.x + 4, top: rect.y + rect.height / 2 - 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}>
              <ChevronLeft size={14} color={colors.accent} strokeWidth={2.4} />
            </View>
          </PressableScale>
        ) : null}
        {chrome && next ? (
          <PressableScale accessibilityLabel="Next clip" onPress={() => goTo(next)} style={{ position: 'absolute', left: rect.x + rect.width - 48, top: rect.y + rect.height / 2 - 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}>
              <ChevronRight size={14} color={colors.accent} strokeWidth={2.4} />
            </View>
          </PressableScale>
        ) : null}
      </View>

      {isVideo && engine.kind === 'video' && (!engine.ready || engine.error) ? (
        <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.72)' }}>
          <View style={{ padding: 24, gap: 12, alignItems: 'center', borderRadius: radius.md, backgroundColor: colors.glassStrong }}>
            {engine.error ? null : <ActivityIndicator color={colors.accent} />}
            <MText size={14} weight="medium" color={colors.muted} align="center">
              {engine.error ?? 'Preparing playback…'}
            </MText>
          </View>
        </View>
      ) : null}

      {chrome ? (
        <>
          {/* Header */}
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              paddingTop: insets.top + (portrait ? 8 : 12),
              paddingLeft: sideInset + 16,
              paddingRight: sideInset + 16,
              paddingBottom: 18,
            }}
            onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}
          >
            <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0.72)', 'rgba(0,0,0,0)']} style={{ position: 'absolute', inset: 0 }} />
            <View style={{ flexDirection: portrait ? 'column' : 'row', gap: portrait ? 8 : 12, alignItems: portrait ? 'stretch' : 'flex-start' }}>
              <View style={{ flexDirection: 'row', gap: 12, flex: portrait ? undefined : 1, alignItems: 'flex-start' }}>
                <PressableScale accessibilityLabel="Back to media" onPress={goBack} style={{ width: 48, height: 48, borderRadius: radius.md, backgroundColor: 'rgba(40,42,44,0.72)', alignItems: 'center', justifyContent: 'center' }}>
                  <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
                </PressableScale>
                <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
                  <MText size={13} weight="semibold" numberOfLines={1}>
                    {item.fileName}
                  </MText>
                  <MText size={9.5} color={colors.muted} numberOfLines={portrait ? 2 : 1}>
                    {playbackSubtitle(item)}
                  </MText>
                  <View style={{ alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 4, borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.5)' }}>
                    <MText size={8} weight="bold" tracking={0.5} color={colors.secondary}>
                      {source}
                    </MText>
                  </View>
                </View>
              </View>
              {headerActions}
            </View>
            {ratingOpen ? (
              <View style={{ alignItems: 'flex-end', marginTop: 8 }}>
                <StarRating stars={rating} onSelect={(s) => prefs.setRating(item.id, s)} />
              </View>
            ) : null}
            {isVideo && engine.kind === 'simulated' && prefs.playbackAudioMeters ? (
              <View style={{ position: 'absolute', left: sideInset + 76, bottom: -30 }}>
                <PlaybackMeters left={meterL} right={meterR} />
              </View>
            ) : null}
          </View>

          {/* Bottom: transport for clips, filmstrip for bursts */}
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              paddingBottom: Math.max(insets.bottom, 8),
              paddingTop: 16,
              paddingHorizontal: sideInset + 12,
              alignItems: 'center',
            }}
            onLayout={(e) => setBottomH(e.nativeEvent.layout.height)}
          >
            <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.4)', 'rgba(0,0,0,0.8)']} locations={[0, 0.38, 1]} style={{ position: 'absolute', inset: 0 }} />
            <View style={{ width: '100%', maxWidth: 680, gap: 2 }}>
              {burst.length > 1 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
                  {burst.map((b, i) => (
                    <PressableScale key={b.id} accessibilityLabel={`Frame ${i + 1} of ${burst.length}`} accessibilityState={{ selected: b.id === item.id }} onPress={() => router.setParams({ id: b.id })} style={{ width: 64, height: 44, borderRadius: 6, overflow: 'hidden', borderWidth: 2, borderColor: b.id === item.id ? colors.accent : 'transparent' }}>
                      <Image source={{ uri: b.thumbnailUrl }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                    </PressableScale>
                  ))}
                </ScrollView>
              ) : null}
              {isVideo ? (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <PressableScale noScale accessibilityLabel={timecode ? 'Show minutes and seconds' : 'Show timecode'} onPress={() => prefs.set('playbackTimecode', !timecode)} style={{ minHeight: 32, justifyContent: 'center' }}>
                      <MText size={11} weight="bold" mono>
                        {positionText}
                      </MText>
                    </PressableScale>
                    <View style={{ flex: 1 }} />
                    {conform ? (
                      <MText size={9.5} weight="bold" color={colors.accent} style={{ marginRight: 10 }}>
                        {`${conform}p CONFORM`}
                      </MText>
                    ) : null}
                    <MText size={11} color={colors.secondary} mono>
                      {durationText}
                    </MText>
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
                  <View style={{ flexDirection: portrait ? 'column' : 'row', alignItems: 'center', gap: portrait ? 4 : 10 }}>
                    {!portrait ? (
                      <View style={{ flex: 1, flexDirection: 'row' }}>
                        <PlaybackChip icon={Box} label="Assists" active={assists} onPress={() => setAssists((a) => !a)} />
                      </View>
                    ) : null}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                      <TransportButton icon={StepBack} label="Back one frame" onPress={() => engine.stepFrames(-1)} size={18} />
                      <TransportButton icon={SkipBack} label="Back 15 seconds" onPress={() => engine.seek(engine.position - 15)} />
                      <TransportButton
                        icon={engine.reachedEnd ? RotateCw : engine.playing ? Pause : Play}
                        label={engine.reachedEnd ? 'Restart clip' : engine.playing ? 'Pause' : 'Play'}
                        onPress={() => (engine.reachedEnd ? (engine.seek(0), engine.play()) : engine.toggle())}
                        size={28}
                      />
                      <TransportButton icon={SkipForward} label="Forward 15 seconds" onPress={() => engine.seek(engine.position + 15)} />
                      <TransportButton icon={StepForward} label="Forward one frame" onPress={() => engine.stepFrames(1)} size={18} />
                    </View>
                    <View style={{ flex: portrait ? undefined : 1, flexDirection: 'row', justifyContent: portrait ? 'center' : 'flex-end', gap: 8 }}>
                      {portrait ? <PlaybackChip icon={Box} label="Assists" active={assists} onPress={() => setAssists((a) => !a)} /> : null}
                      <PlaybackChip icon={Timer} label="Conform preview" active={conform != null || conformOpen} disabled={!targets.length} onPress={() => setConformOpen((v) => !v)} />
                      <PlaybackChip
                        icon={prefs.mutePlayback || conform != null ? VolumeX : Volume2}
                        label={prefs.mutePlayback ? 'Unmute' : 'Mute'}
                        onPress={() => prefs.set('mutePlayback', !prefs.mutePlayback)}
                      />
                      <PlaybackChip icon={Repeat} label="Loop playback" active={prefs.loopPlayback} onPress={() => prefs.set('loopPlayback', !prefs.loopPlayback)} />
                      <PlaybackChip icon={Maximize} label="Hide playback controls" onPress={() => setChrome(false)} />
                    </View>
                  </View>
                </>
              ) : (
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 4 }}>
                  <PlaybackChip icon={Maximize} label="Hide playback controls" onPress={() => setChrome(false)} />
                </View>
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
        <View style={{ position: 'absolute', right: sideInset + 12, bottom: Math.max(insets.bottom, 8) + 12 }}>
          <PlaybackChip icon={Minimize} label="Show playback controls" onPress={() => setChrome(true)} />
        </View>
      )}

      {conformOpen && targets.length ? (
        <View style={{ position: 'absolute', left: 12, right: 12, bottom: Math.max(insets.bottom, 8) + (portrait ? 190 : 120), alignItems: 'center' }}>
          <View style={{ width: '100%', maxWidth: 420, padding: 14, gap: 8, borderRadius: 14, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.border }}>
            <MText size={9} weight="bold" tracking={1.8}>
              CONFORM PREVIEW
            </MText>
            <MText size={9.5} color={colors.muted}>
              {`Shot at ${item.fps} fps. Play it back at:`}
            </MText>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {[null, ...targets].map((target) => {
                const on = conform === target;
                const label = target == null ? 'Real time' : `${target}p · ${Math.round((target / (item.fps ?? target)) * 100)}%`;
                return (
                  <PressableScale key={String(target)} accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={() => setConform(target)} style={{ minHeight: 40, paddingHorizontal: 12, borderRadius: 9, justifyContent: 'center', backgroundColor: on ? colors.accent : 'rgba(255,255,255,0.06)' }}>
                    <MText size={12} weight="semibold" color={on ? colors.onAccent : colors.secondary}>
                      {label}
                    </MText>
                  </PressableScale>
                );
              })}
            </View>
            {conform != null ? (
              <MText size={9} color={colors.muted}>
                Audio is muted while conformed.
              </MText>
            ) : null}
          </View>
        </View>
      ) : null}

      {info ? (
        <View style={{ position: 'absolute', right: sideInset + 12, top: insets.top + 12, bottom: Math.max(insets.bottom, 8) + 12, width: Math.min(300, width - 24) }}>
          <ClipInfoPanel rows={clipInfoRows(item, { source: localUri ? 'On this phone (original)' : 'On camera', rating, frames: burst.length || undefined })} onClose={() => setInfo(false)} />
        </View>
      ) : null}

      <DeliveryProgressPill bottom={Math.max(insets.bottom, 8) + (portrait ? 200 : 130)} />
      {lib.notice ? <NoticeToast text={lib.notice} bottom={Math.max(insets.bottom, 8) + (portrait ? 260 : 170)} /> : null}
      {sharing ? <DeliverySheet items={burst.length ? burst : [item]} onClose={() => setSharing(false)} /> : null}
      {deliveryPanelOpen ? <DeliveryQueuePanel onClose={() => setDeliveryPanel(false)} /> : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={burst.length > 1 ? `Delete this burst (${burst.length} photos) from the camera?` : 'Delete this clip from the camera?'}
          message="This removes the file from the camera card."
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void doDelete()}
        />
      ) : null}
    </View>
  );
}
