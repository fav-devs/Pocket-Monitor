import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Camera01Icon,
  ChartHistogramIcon,
  ColorsIcon,
  CropIcon,
  Delete02Icon,
  Download04Icon,
  GoBackward15SecIcon,
  GoForward15SecIcon,
  InformationCircleIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  RepeatIcon,
  RotateClockwiseIcon,
  Rotate01Icon,
  ScissorIcon,
  Share08Icon,
  SlidersHorizontalIcon,
  SmartPhone01Icon,
  SmileIcon,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { type GestureResponderEvent, Platform, Pressable, ScrollView, Text, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type CameraMediaItem, useCameraSession } from '@/camera';
import { Chip } from '@/components/chip';
import { ChipRow } from '@/components/field-section';
import { Sheet } from '@/components/sheet';
import { Spinner } from '@/components/spinner';
import { useEscapeKey } from '@/components/desktop';
import { useWideLayout } from '@/constants/layout';
import { fonts, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';
import {
  applyPreset,
  hasColor,
  hasGeometry,
  isIdentity,
  outputAspect,
  resetTool,
  revertTool,
  toolEdited,
  type ClipEdit,
  type EditTool,
} from '@/core/edit';
import AssistBar from '@/features/assists/AssistBar';
import AssistOverlays from '@/features/assists/AssistOverlays';
import LivePicture from '@/features/picture/LivePicture';
import { useClipEdit, useClipEdits } from '@/state/clipEdits';
import { useAssists } from '@/state/assists';
import { phoneClipItem, useMediaPreferences, usePhoneMedia } from '@/state/media';
import { DeliveryProgressPill, DeliveryQueueSheet } from './DeliveryQueue';
import { deliveryPlatform } from './deliveryPlatform';
import { DeliverySheet } from './DeliverySheet';
import { useDelivery } from './deliveryStore';
import { timecodeLabel } from './format';
import { deriveGallery } from './gallery';
import { useMediaBrowsing, useMediaLibrary, useMediaThumbnail } from './libraryStore';
import { favoriteColor, Glyph } from './MediaChips';
import { ConfirmSheet, NoticeToast } from './MediaOverlays';
import { ClipInfoList, clipInfoRows, PlaybackMeters, SideButton, StarRating, ToolWell, videoText } from './PlaybackParts';
import { PlaybackInspector } from './PlaybackInspector';
import { PlaybackFilmstrip, stripClock, usePlaybackFrames } from './PlaybackFilmstrip';
import { usePlaybackEngine } from './usePlaybackEngine';
import { useDesktopPlayback } from './desktop/useDesktopPlayback';
import { CompareLine, CropGestureLayer, EditedPicture } from './edit/EditedPicture';
import { AspectBody, EditorChrome, FaceBody, FilterBody, RotateBody, TOOL_TITLES, TrimBody, VolumeBody } from './edit/EditorPanels';
import { ExportSheet, LutHubSheet, PresetSheet } from './edit/EditSheets';
import { useEditExport } from './edit/exporter';
import { customCube } from './edit/cubes';
import { useLookThumbnails, useThumbFrame } from './edit/lookThumbs';
import { useEditPreview } from './edit/useEditPreview';

/** The picture rect for `aspect` in `w × h`: letterboxed (`fit`) or cropped to fill (`fill`). */
function place(aspect: number, w: number, h: number, mode: 'fit' | 'fill'): LayoutRectangle {
  if (w <= 0 || h <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  const width = mode === 'fill' ? Math.max(w, h * a) : Math.min(w, h * a);
  const height = width / a;
  return { x: (w - width) / 2, y: (h - height) / 2, width, height };
}

/** Conform targets below the capture rate (`MonitorConformPreview`). */
function conformTargets(fps?: number): number[] {
  if (!fps || fps <= 30) return [];
  return [30, 25, 24].filter((t) => t < fps);
}

/** The editor's tools in the tool row (Mimo order). */
const EDIT_TOOLS: { tool: EditTool; icon: IconSvgElement }[] = [
  { tool: 'filter', icon: ColorsIcon },
  { tool: 'aspect', icon: CropIcon },
  { tool: 'rotate', icon: Rotate01Icon },
  { tool: 'volume', icon: VolumeHighIcon },
  { tool: 'face', icon: SmileIcon },
  { tool: 'trim', icon: ScissorIcon },
];

/** A plain white transport icon (ai-cut watch chrome), or the big white play disc. */
function Transport({ icon, label, onPress, primary }: { icon: IconSvgElement; label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({ width: primary ? 64 : 44, height: primary ? 64 : 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.65 : 1 })}
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

/** A bare white icon in the top bar (Mimo's back / info / download). */
function BarIcon({ icon, label, onPress, color = '#ffffff', filled, disabled, selected, children }: {
  icon: IconSvgElement;
  label: string;
  onPress: () => void;
  color?: string;
  filled?: boolean;
  disabled?: boolean;
  selected?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({ width: 40, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.65 : 1 })}
    >
      {children ?? <Glyph icon={icon} size={22} color={color} filled={filled} strokeWidth={1.7} />}
    </Pressable>
  );
}

/**
 * The player (`MonitorPlaybackScreen`), laid out like Mimo's: the picture fills a portrait
 * screen (double-tap or pinch to fit; landscape fits), a thin top bar (back, info, HDR,
 * rendition, download, share, export), the Editing Preset button, and under the picture the
 * filmstrip scrubber, the tool row (edit tools, then playback tools) and favourite · transport ·
 * delete. An edit tool replaces the bottom with its panel (✕ · title · ✓) and fits the picture
 * above it. One fixed picture child: expo-video for a file, the demo picture on a simulated
 * timeline, or the desktop's native player. `?from=phone` plays a clip saved on this phone.
 */
export default function PlaybackScreen() {
  const params = useLocalSearchParams<{ id: string; from?: string }>();
  const id = decodeURIComponent(String(params.id ?? ''));
  const fromPhone = params.from === 'phone';
  const router = useRouter();
  const session = useCameraSession();
  // Desktop app: the clip plays natively through the graded Vulkan picture (§1.V).
  const desktop = session.kind === 'desktop' && !fromPhone;
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createStyles);
  const { width, height } = useWindowDimensions();
  const portrait = height >= width;
  // Wide layout: the clip's details and actions sit in an inspector beside the picture.
  const wideLayout = useWideLayout();
  const [inspector, setInspector] = useState(true);
  useMediaBrowsing();

  const lib = useMediaLibrary();
  const prefs = useMediaPreferences();
  const phoneClips = usePhoneMedia((s) => s.clips);
  const deliveryPanelOpen = useDelivery((s) => s.panelOpen);
  const setDeliveryPanel = useDelivery((s) => s.setPanelOpen);

  // A deep link straight into playback lists the card first.
  useEffect(() => {
    if (fromPhone) return;
    if (lib.status === 'idle' || lib.service !== session.media) void lib.load(session.media);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, fromPhone]);

  const phoneItems = useMemo(() => phoneClips.map(phoneClipItem), [phoneClips]);
  const items = fromPhone ? phoneItems : lib.items;
  const item: CameraMediaItem | undefined = items.find((i) => i.id === id);
  const order = useMemo(() => {
    const model = deriveGallery(items, {
      category: lib.category,
      filters: lib.filters,
      sort: prefs.sort,
      stackBursts: prefs.stackBursts,
      groupByDay: false,
    });
    const covers = model.entries.map((e) => e.cover);
    return covers.some((c) => c.id === id) ? covers : items;
  }, [items, lib.category, lib.filters, prefs.sort, prefs.stackBursts, id]);
  const burst = useMemo(() => (item?.groupId ? items.filter((i) => i.groupId === item.groupId) : []), [items, item?.groupId]);
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
  /** Portrait opens filled, like Mimo; double-tap or pinch toggles. Landscape always fits. */
  const [fill, setFill] = useState(true);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  /** Play the low-res copy even when the original is on the phone (rendition toggle). */
  const [preferLowRes, setPreferLowRes] = useState(false);

  // ── Editor state: the open tool, its working edit and the edit as it was on open (✕).
  const storedEdit = useClipEdit(item?.id, item?.durationSec);
  const setStoredEdit = useClipEdits((s) => s.setEdit);
  const [tool, setTool] = useState<EditTool | null>(null);
  const [draft, setDraft] = useState<ClipEdit | null>(null);
  const [snapshot, setSnapshot] = useState<ClipEdit | null>(null);
  const [compare, setCompare] = useState(false);
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  const [lutHubOpen, setLutHubOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportJob = useEditExport();
  const customLuts = useAssists((s) => s.options.lut.custom);

  useEffect(() => {
    setConform(null);
    setConformOpen(false);
    setRatingOpen(false);
    setPrepareError(null);
    setTool(null);
    setDraft(null);
    setSnapshot(null);
    setCompare(false);
    setPreferLowRes(false);
  }, [id]);

  const isVideo = item?.kind === 'video';
  const phoneClip = fromPhone ? phoneClips.find((c) => c.id === id) : undefined;
  const localUri = item ? (fromPhone ? phoneClip?.localUri || undefined : lib.localFiles[item.id] || item.localUri) : undefined;
  const thumbnail = useMediaThumbnail(item);
  // A real camera: the 720p proxy (or a still) is fetched to the phone first, as upstream does.
  const prepared = item && !fromPhone ? lib.prepared[item.id] : undefined;
  const canPrepare = !fromPhone && !desktop && !!session.media.preparePlayback && !localUri && !item?.previewUrl;
  const preparingFraction = item ? lib.preparing[item.id] : undefined;
  useEffect(() => {
    if (!item || !canPrepare || prepared) return;
    lib.preparePlayback(session.media, item.id).catch((e: unknown) => setPrepareError(e instanceof Error ? e.message : 'This clip could not be fetched from the camera.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, canPrepare, prepared, session]);
  const waitingForCamera = canPrepare && !prepared;

  // Renditions: the low-res copy (or the camera's preview stream) and the original on the phone.
  const lowResUri = prepared?.rendition === 'low-res' ? prepared.uri : item?.previewUrl;
  const playingLowRes = !!lowResUri && (preferLowRes || !localUri);
  const uri = isVideo ? (preferLowRes && lowResUri ? lowResUri : localUri || prepared?.uri || item?.previewUrl || null) : null;
  const fps = item?.fps ?? 30;
  const baseEngine = usePlaybackEngine({
    uri: desktop || waitingForCamera ? null : uri,
    durationSec: item?.durationSec ?? 10,
    fps,
    loop: prefs.loopPlayback,
    muted: prefs.mutePlayback || conform != null,
    rate: conform && item?.fps ? conform / item.fps : 1,
    autoplay: !desktop && !waitingForCamera,
    itemKey: `${id}|${uri ?? 'sim'}`,
  });
  const desktopEngine = useDesktopPlayback({
    enabled: desktop,
    item,
    loop: prefs.loopPlayback,
    muted: prefs.mutePlayback || conform != null,
    conform,
  });
  const engine = desktop ? desktopEngine : baseEngine;
  const targets = desktop ? desktopEngine.conformTargets : conformTargets(item?.fps);
  const frames = usePlaybackFrames({
    item,
    engine: {
      kind: engine.kind === 'desktop' ? 'video' : waitingForCamera ? 'video' : engine.kind,
      ready: engine.ready,
      duration: engine.duration,
      player: engine.kind === 'video' ? baseEngine.player : undefined,
      strip: engine.kind === 'desktop' ? engine.strip : undefined,
    },
    thumbnail,
    sourceKey: `${id}|${uri ?? 'sim'}`,
  });

  // Switching rendition keeps the playhead.
  const resumeAt = useRef<number | null>(null);
  useEffect(() => {
    if (resumeAt.current == null || engine.kind !== 'video' || !engine.ready) return;
    const t = resumeAt.current;
    resumeAt.current = null;
    engine.seek(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.kind, engine.ready, uri]);

  // ── The edit: live while a tool is open (draft), else the stored one.
  const editable = isVideo && !desktop;
  const edit = tool && draft ? draft : storedEdit;
  const source = useMemo(() => {
    const w = item?.width && item.width > 0 ? item.width : 1920;
    const h = item?.height && item.height > 0 ? item.height : Math.round(w / (16 / 9));
    return { width: w, height: h };
  }, [item?.width, item?.height]);
  const hdrSource = item?.colorMode === 'hlg';
  const editColour = editable && hasColor(edit);
  const { demoEffects, nativePreview, faceFound } = useEditPreview({
    edit: editable ? edit : storedEdit,
    engineKind: engine.kind,
    player: engine.kind === 'video' ? baseEngine.player : null,
    ready: engine.ready,
    compare: compare && !!tool,
    source,
    hdrSource,
    itemKey: `${id}|${uri ?? 'sim'}`,
    faceProbe: tool === 'face',
  });

  const openTool = (t: EditTool) => {
    setSnapshot(storedEdit);
    setDraft(storedEdit);
    setCompare(false);
    setTool(t);
    setChrome(true);
  };
  const closeTool = (apply: boolean) => {
    if (!item || !tool) return;
    if (apply && draft) setStoredEdit(item.id, draft);
    else if (snapshot && draft) setStoredEdit(item.id, revertTool(draft, snapshot, tool));
    setTool(null);
    setDraft(null);
    setSnapshot(null);
    setCompare(false);
  };
  const change = (next: ClipEdit) => setDraft(next);

  // Trim: playback stays inside the kept range (except while setting it).
  const trim = editable && tool !== 'trim' ? edit.trim : null;
  useEffect(() => {
    if (!trim || !engine.playing) return;
    if (engine.position >= trim.end - 0.03) {
      if (prefs.loopPlayback) engine.seek(trim.start);
      else {
        engine.pause();
        engine.seek(trim.end);
      }
    } else if (engine.position < trim.start - 0.15) engine.seek(trim.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trim?.start, trim?.end, engine.position, engine.playing]);

  // Look thumbnails from the current frame while Filter is open.
  const filterOpen = tool === 'filter';
  const thumbFrame = useThumbFrame({
    enabled: filterOpen,
    uri: engine.kind === 'video' ? uri : null,
    seconds: engine.position,
    refreshKey: `${id}|${filterOpen}`,
    demo: engine.kind === 'simulated',
  });
  const appliedLut = edit.lut;
  const appliedCube = customCube(appliedLut);
  const thumbs = useLookThumbnails(thumbFrame, appliedLut && appliedCube ? { id: appliedLut, cube: appliedCube } : null);

  const takeStill = () => {
    desktopEngine
      .screenshot()
      .then((path) => lib.showNotice(`Saved ${path.split(/[\\/]/).pop() ?? 'still'}`))
      .catch((e) => lib.showNotice(typeof e === 'string' ? e : 'Could not take the screenshot.'));
  };

  // Keyboard transport on web: Space play/pause, ←/→ one frame, Shift ±1 s.
  useEffect(() => {
    if (Platform.OS !== 'web' || (!isVideo && !desktop) || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return;
      // Desktop: S takes the graded screenshot, Esc goes back (the old player's keys).
      if (desktop && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        takeStill();
        return;
      }
      if (desktop && e.key === 'Escape') {
        e.preventDefault();
        goBack();
        return;
      }
      if (!isVideo) return;
      if (e.key === ' ') {
        e.preventDefault();
        engine.toggle();
      } else if (e.key === 'ArrowLeft') e.shiftKey ? engine.seek(engine.position - 1) : engine.stepFrames(-1);
      else if (e.key === 'ArrowRight') e.shiftKey ? engine.seek(engine.position + 1) : engine.stepFrames(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, isVideo, desktop]);

  // Single tap: chrome. Double tap: fill ↔ fit. Two-finger pinch: in fits, out fills.
  const lastScrubSeek = useRef(0);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinch = useRef<{ d0: number; done: boolean } | null>(null);
  useEffect(() => () => void (tapTimer.current && clearTimeout(tapTimer.current)), []);
  const onPicturePress = () => {
    // Editing: a tap plays / pauses (the panel stays).
    if (tool) {
      if (isVideo) engine.toggle();
      return;
    }
    const now = Date.now();
    if (now - lastTap.current < 280) {
      lastTap.current = 0;
      if (tapTimer.current) clearTimeout(tapTimer.current);
      tapTimer.current = null;
      if (portrait) setFill((f) => !f);
      return;
    }
    lastTap.current = now;
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null;
      setChrome((c) => !c);
    }, 280);
  };
  const touchDistance = (e: GestureResponderEvent) => {
    const t = e.nativeEvent.touches;
    return t && t.length >= 2 ? Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY) : null;
  };
  const onPinchMove = (e: GestureResponderEvent) => {
    if (tool) return;
    const d = touchDistance(e);
    if (d == null) return;
    if (!pinch.current) pinch.current = { d0: d, done: false };
    else if (!pinch.current.done && portrait) {
      const ratio = d / Math.max(1, pinch.current.d0);
      if (ratio < 0.85 || ratio > 1.15) {
        pinch.current.done = true;
        setFill(ratio > 1);
      }
    }
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/media');
  };
  const goTo = (target?: { id: string }) => target && router.setParams({ id: target.id });
  // The desktop app's own key handler above already takes Esc; the browser preview gets it here.
  // With a tool open, Esc cancels the tool first.
  useEscapeKey(tool ? () => closeTool(false) : goBack, (wideLayout && !desktop) || !!tool);
  const sideInset = Math.max(insets.left, insets.right);

  if (!item) {
    const waiting = !fromPhone && (lib.status === 'loading' || lib.status === 'idle');
    return (
      <View style={styles.missing}>
        {waiting ? <Spinner opacity={1} size={24} color="#ffffff" /> : null}
        <Text style={styles.missingText}>
          {waiting ? 'Preparing playback…' : fromPhone ? 'This clip is no longer on this phone.' : (lib.error ?? 'This clip is no longer on the camera.')}
        </Text>
        <View style={{ position: 'absolute', left: sideInset + 16, top: insets.top + 12 }}>
          <SideButton icon={ArrowLeft01Icon} label="Back to media" onPress={goBack} />
        </View>
      </View>
    );
  }

  const editing = !!tool && editable;
  const rating = prefs.ratings[item.id] ?? 0;
  const position = scrubbing ? scrubbing.position : engine.position;
  const timecode = prefs.playbackTimecode;
  const clock = timecode
    ? `${timecodeLabel(position, item.fps)} / ${timecodeLabel(engine.duration, item.fps)}`
    : `${stripClock(position)} / ${stripClock(engine.duration)}`;
  const onPhone = fromPhone || !!localUri || phoneClips.some((c) => c.id === item.id);
  const transfer = lib.transfers[item.id];
  // Mimo's centre title: which rendition is playing.
  const rendition = desktop
    ? (engine.kind === 'desktop' && engine.rendition) || (localUri ? 'Original' : 'On camera')
    : fromPhone
      ? 'On this phone'
      : localUri && !playingLowRes
        ? 'Original'
        : prepared
          ? prepared.rendition === 'low-res' || playingLowRes
            ? 'Low-Res'
            : 'Original'
          : !isVideo
            ? 'Photo'
            : engine.kind === 'simulated' && !waitingForCamera
              ? 'Demo'
              : 'Low-Res';
  // Low-Res ↔ Original: switch when both exist, or fetch the original from the Low-Res title.
  const canSwitchRendition = isVideo && !desktop && !fromPhone && engine.kind === 'video' && !!lowResUri && (!!localUri || !!session.media.download);
  const switchRendition = () => {
    resumeAt.current = engine.position;
    if (playingLowRes) {
      if (localUri) setPreferLowRes(false);
      else if (!transfer) {
        lib
          .download(session.media, item.id)
          .then(() => {
            resumeAt.current = engine.position;
            setPreferLowRes(false);
          })
          .catch((e: unknown) => lib.showNotice(`Download failed. ${e instanceof Error ? e.message : ''}`.trim()));
      }
    } else setPreferLowRes(true);
  };

  // ── Picture placement: the output aspect (crop / rotation) in the area the picture may use.
  const aspect = editable ? outputAspect(source, edit.rotation, edit.crop) : item.width && item.height ? item.width / item.height : 16 / 9;
  const landscapePanel = editing && !portrait;
  const panelW = landscapePanel ? Math.min(400, Math.max(320, canvas.width * 0.4)) : 0;
  const area = editing
    ? portrait
      ? { x: 0, y: insets.top + 8, width: canvas.width, height: Math.max(0, canvas.height - insets.top - 8 - panelSize.height) }
      : { x: sideInset + 8, y: insets.top + 8, width: Math.max(0, canvas.width - panelW - sideInset - 16), height: Math.max(0, canvas.height - insets.top - 16 - insets.bottom) }
    : { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const filled = portrait && fill && !desktop && !editing;
  const placed = place(aspect, area.width, area.height, filled ? 'fill' : 'fit');
  const rect = { ...placed, x: placed.x + area.x, y: placed.y + area.y };
  // A real clip crops about its centre. The demo scene's subject stands at 30 % of the frame
  // (`studio()` in the picture shaders), so the demo crops about the subject instead.
  if (filled && engine.kind === 'simulated' && isVideo && rect.width > canvas.width && !hasGeometry(edit)) {
    rect.x = Math.min(0, Math.max(canvas.width - rect.width, canvas.width / 2 - 0.3 * rect.width));
  }
  // The part of the picture on screen (fill crops it): where taps, overlays and buttons go.
  const shown = {
    x: Math.max(0, rect.x),
    y: Math.max(0, rect.y),
    width: Math.min(canvas.width, rect.width),
    height: Math.min(canvas.height, rect.height),
  };
  const t = engine.position;
  const meterL = engine.playing ? -22 + 10 * Math.sin(t * 3.1) + 6 * Math.sin(t * 11.7) : -120;
  const meterR = engine.playing ? -24 + 10 * Math.sin(t * 2.7 + 1) + 6 * Math.sin(t * 9.3) : -120;
  const muted = prefs.mutePlayback || conform != null;
  const favoriteIds = burst.length ? burst.map((b) => b.id) : [item.id];

  const setFavorite = (favorite: boolean) =>
    fromPhone ? usePhoneMedia.getState().setFavorite(favoriteIds, favorite) : void lib.setFavorite(session.media, favoriteIds, favorite);

  const download = () => {
    if (onPhone || transfer) return;
    lib
      .download(session.media, item.id)
      .then(() => lib.showNotice('Saved to this phone'))
      .catch((e: unknown) => lib.showNotice(`Download failed. ${e instanceof Error ? e.message : ''}`.trim()));
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    const ids = burst.length ? burst.map((b) => b.id) : [item.id];
    const target = next ?? prev;
    if (fromPhone) {
      for (const c of phoneClips.filter((x) => ids.includes(x.id))) if (c.localUri) await deliveryPlatform.discard(c.localUri);
      usePhoneMedia.getState().remove(ids);
      ids.forEach((x) => lib.forgetLocal(x));
      lib.showNotice('Deleted from this phone');
    } else {
      const ok = await lib.deleteItems(session.media, ids);
      if (!ok) return;
    }
    if (target) router.setParams({ id: target.id });
    else goBack();
  };

  const startExport = (quality: 'original' | 'low-res') => {
    void exportJob.start({
      item,
      edit: storedEdit,
      quality,
      originalUri: localUri ?? null,
      lowResUri: lowResUri && !/^https?:/.test(lowResUri) ? lowResUri : null,
      downloadOriginal: () => lib.download(session.media, item.id),
      sourceSize: source,
      hdrSource,
      simulate: engine.kind !== 'video',
    });
  };

  const stillUri = localUri || prepared?.uri || item.originalUrl || item.previewUrl || thumbnail;
  // Android: SurfaceView ignores view transforms, so a rotated / cropped preview uses a TextureView.
  const transformed = editable && (hasGeometry(edit) || tool === 'aspect' || tool === 'rotate');
  const videoPicture = (key: string) => (
    <VideoView
      key={key}
      player={baseEngine.player}
      style={{ width: '100%', height: '100%' }}
      contentFit="cover"
      nativeControls={false}
      surfaceType={transformed ? 'textureView' : 'surfaceView'}
    />
  );
  const demoPicture = (effects?: typeof demoEffects) => <LivePicture source={{ kind: 'demo', scene: 'studio' }} resizeMode="fill" context="playback" effects={effects} />;
  const picture = desktop ? null : item.kind === 'photo' ? (
      <Image source={{ uri: stillUri }} placeholder={thumbnail ? { uri: thumbnail } : undefined} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={150} />
    ) : waitingForCamera || (engine.kind === 'video' && !engine.ready) ? (
      thumbnail ? <Image source={{ uri: thumbnail }} style={{ width: '100%', height: '100%' }} contentFit="cover" /> : null
    ) : engine.kind === 'video' ? (
      videoPicture('video')
    ) : (
      demoPicture(demoEffects)
    );
  // Before/after: the demo draws both halves in React; a real clip splits in the native stage.
  const compareOn = editing && compare && editColour;
  const beforePicture = compareOn && engine.kind === 'simulated' ? demoPicture(undefined) : undefined;

  const tool_ = {
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
    hide: <ToolWell key="hide" icon={ViewOffSlashIcon} label="Hide playback controls" caption="Clean" onPress={() => setChrome(false)} />,
    still: desktop ? <ToolWell key="still" icon={Camera01Icon} label="Screenshot (S)" caption="Still" onPress={takeStill} /> : null,
  };
  const editWells = editable
    ? EDIT_TOOLS.map(({ tool: t, icon }) => (
        <ToolWell key={t} icon={icon} label={TOOL_TITLES[t]} caption={TOOL_TITLES[t]} edited={toolEdited(storedEdit, t)} onPress={() => openTool(t)} />
      ))
    : [];
  const playbackWells = isVideo ? [tool_.assists, tool_.conform, tool_.sound, tool_.loop, tool_.still, tool_.rate, tool_.hide] : [tool_.still, tool_.rate, tool_.hide];
  const toolRow = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolRow} style={styles.toolScroll}>
      {editWells}
      {editWells.length ? <View style={styles.toolDivider} /> : null}
      {playbackWells}
    </ScrollView>
  );

  const favoriteButton = (
    <BarIcon
      icon={StarIcon}
      label="Favorite clip"
      selected={item.favorite}
      color={item.favorite ? favoriteColor : '#ffffff'}
      filled={item.favorite}
      onPress={() => setFavorite(!item.favorite)}
    />
  );
  const deleteButton = (
    <BarIcon icon={Delete02Icon} label={fromPhone ? 'Delete clip from this phone' : 'Delete clip from camera'} color="#ff6b6b" onPress={() => setConfirmDelete(true)} />
  );

  const transport = (
    <View style={styles.transport}>
      <Transport icon={PreviousIcon} label="Back one frame" onPress={() => engine.stepFrames(-1)} />
      <Transport icon={GoBackward15SecIcon} label="Back 15 seconds" onPress={() => engine.seek(engine.position - 15)} />
      <Transport
        primary
        icon={engine.reachedEnd ? RotateClockwiseIcon : engine.playing ? PauseIcon : PlayIcon}
        label={engine.reachedEnd ? 'Restart clip' : engine.playing ? 'Pause' : 'Play'}
        onPress={() => (engine.reachedEnd ? (engine.seek(trim?.start ?? 0), engine.play()) : engine.toggle())}
      />
      <Transport icon={GoForward15SecIcon} label="Forward 15 seconds" onPress={() => engine.seek(engine.position + 15)} />
      <Transport icon={NextIcon} label="Forward one frame" onPress={() => engine.stepFrames(1)} />
    </View>
  );

  const loadingLine = prepareError
    ? prepareError
    : waitingForCamera
      ? preparingFraction
        ? `Fetching from camera… ${Math.round(preparingFraction * 100)}%`
        : 'Fetching from camera…'
      : engine.error
        ? engine.error
        : engine.kind === 'desktop' && engine.fetching?.total
          ? `Preparing playback… ${Math.round((engine.fetching.done / engine.fetching.total) * 100)}%`
          : 'Preparing playback…';
  const showLoading = prepareError != null || (isVideo && (waitingForCamera || (engine.kind === 'video' && (!engine.ready || !!engine.error)))) || (engine.kind === 'desktop' && (!engine.ready || !!engine.error));

  const infoRows = clipInfoRows(item, {
    source: fromPhone || localUri ? 'On this phone (original)' : prepared?.rendition === 'low-res' ? 'On camera · low-res copy on phone' : 'On camera',
    rating,
    frames: burst.length || undefined,
  });

  const edited = editable && !isIdentity(storedEdit);
  const lutName = appliedLut ? (customLuts.find((l) => l.id === appliedLut)?.name ?? null) : null;

  // ── The open tool's panel.
  const panelBody = !tool ? null : tool === 'filter' ? (
    <FilterBody edit={edit} onChange={change} thumbs={thumbs} lutName={lutName} onLutHub={() => setLutHubOpen(true)} />
  ) : tool === 'aspect' ? (
    <AspectBody edit={edit} onChange={change} source={source} />
  ) : tool === 'rotate' ? (
    <RotateBody edit={edit} onChange={change} />
  ) : tool === 'volume' ? (
    <VolumeBody edit={edit} onChange={change} />
  ) : tool === 'face' ? (
    <FaceBody edit={edit} onChange={change} faceFound={faceFound} />
  ) : (
    <TrimBody edit={edit} onChange={change} position={engine.position} duration={engine.duration} />
  );
  const colourTool = tool === 'filter' || tool === 'face';

  return (
    <View style={[styles.root, wideLayout && styles.rootRow]}>
      <View style={styles.stage}>
      {/* Picture canvas: fixed child, assists drawn inside the picture rect. */}
      <View style={styles.fill} onLayout={(e) => setCanvas({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
        {desktop ? (
          // The native player's picture shows through this hole; Rust letterboxes it.
          <View style={styles.fill} pointerEvents="none">
            <LivePicture source={{ kind: 'desktop' }} resizeMode="fit" context="playback" />
          </View>
        ) : (
          <View style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, overflow: 'hidden' }}>
            {editable && rect.width > 0 ? (
              <EditedPicture edit={edit} source={source} frame={{ width: rect.width, height: rect.height }} before={beforePicture}>
                {picture}
              </EditedPicture>
            ) : (
              picture
            )}
            {compareOn && nativePreview ? <CompareLine frame={{ width: rect.width, height: rect.height }} /> : null}
          </View>
        )}
        {assists && isVideo && !editing ? (
          <AssistOverlays
            context="playback"
            pictureRect={{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }}
            colorMode={item.colorMode ?? null}
            clearance={{ top: chrome ? headerH : 0, bottom: chrome ? bottomH : 0, left: chrome && !portrait ? sideInset + 84 : 0 }}
          />
        ) : null}
        {tool === 'aspect' && editable ? (
          <View style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
            <CropGestureLayer edit={edit} source={source} frame={{ width: rect.width, height: rect.height }} onChange={(crop) => change({ ...edit, crop })} />
          </View>
        ) : (
          <Pressable
            accessibilityLabel={editing ? (engine.playing ? 'Pause' : 'Play') : chrome ? 'Hide playback controls' : 'Show playback controls'}
            accessibilityHint={!editing && portrait ? (filled ? 'Double-tap to fit the picture' : 'Double-tap to fill the screen') : undefined}
            accessibilityRole="button"
            accessibilityActions={!editing && portrait ? [{ name: 'magicTap', label: filled ? 'Fit the picture' : 'Fill the screen' }] : undefined}
            onAccessibilityAction={() => !editing && portrait && setFill((f) => !f)}
            onPress={onPicturePress}
            onLongPress={() => isVideo && !editing && engine.toggle()}
            onTouchMove={onPinchMove}
            onTouchEnd={() => (pinch.current = null)}
            style={{ position: 'absolute', left: shown.x, top: shown.y, width: shown.width, height: shown.height }}
          />
        )}
        {chrome && !editing && prev ? (
          <View style={{ position: 'absolute', left: shown.x + 10 + (portrait ? 0 : sideInset), top: shown.y + shown.height / 2 - 22 }}>
            <SideButton icon={ArrowLeft01Icon} label="Previous clip" onPress={() => goTo(prev)} />
          </View>
        ) : null}
        {chrome && !editing && next ? (
          <View style={{ position: 'absolute', left: shown.x + shown.width - 54 - (portrait ? 0 : sideInset), top: shown.y + shown.height / 2 - 22 }}>
            <SideButton icon={ArrowRight01Icon} label="Next clip" onPress={() => goTo(next)} />
          </View>
        ) : null}
      </View>

      {showLoading ? (
        <View pointerEvents="none" style={styles.loading}>
          {engine.error || prepareError ? null : <Spinner opacity={1} size={24} color="#ffffff" />}
          <Text style={styles.loadingText}>{loadingLine}</Text>
        </View>
      ) : null}

      {editing ? (
        // ── Editor: the tool's panel replaces the bottom (portrait) or sits on the right (landscape).
        <View
          onLayout={(e) => setPanelSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
          style={
            landscapePanel
              ? [styles.sidePanel, { width: panelW + insets.right, paddingRight: insets.right, paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 10) }]
              : [styles.bottomPanel, { paddingBottom: Math.max(insets.bottom, 10), paddingLeft: insets.left, paddingRight: insets.right }]
          }
        >
          <View style={styles.panelColumn}>
            <EditorChrome
              tool={tool!}
              position={position}
              duration={engine.duration}
              playing={engine.playing}
              onToggle={() => engine.toggle()}
              compare={compare}
              onCompare={colourTool ? () => setCompare((c) => !c) : undefined}
              onReset={colourTool ? undefined : () => change(resetTool(edit, tool!))}
              resetDisabled={!toolEdited(edit, tool!)}
              onCancel={() => closeTool(false)}
              onApply={() => closeTool(true)}
            >
              {panelBody}
            </EditorChrome>
          </View>
        </View>
      ) : chrome ? (
        <>
          {/* Top bar: back · info · HDR | rendition | download · share · export */}
          <View
            style={[styles.header, { paddingTop: insets.top + (portrait ? 4 : 8), paddingLeft: sideInset + 8, paddingRight: sideInset + 8 }]}
            onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}
          >
            <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0.62)', 'rgba(0,0,0,0)']} style={styles.fill} />
            <View style={styles.headerRow}>
              <View style={styles.headerSide}>
                <BarIcon icon={ArrowLeft01Icon} label="Back to media" onPress={goBack} />
                <BarIcon
                  icon={InformationCircleIcon}
                  label="Clip information"
                  selected={wideLayout ? inspector : info}
                  onPress={() => (wideLayout ? setInspector((v) => !v) : setInfo(true))}
                />
                {hdrSource && editable ? (
                  <Pressable
                    accessibilityRole="switch"
                    accessibilityLabel="HDR"
                    accessibilityState={{ checked: storedEdit.hdr === 'keep' }}
                    onPress={() => setStoredEdit(item.id, { ...storedEdit, hdr: storedEdit.hdr === 'keep' ? 'sdr' : 'keep' })}
                    hitSlop={6}
                    style={({ pressed }) => [styles.hdr, storedEdit.hdr === 'keep' ? styles.hdrOn : styles.hdrOff, pressed && { opacity: 0.65 }]}
                  >
                    <Text style={[styles.hdrText, { color: storedEdit.hdr === 'keep' ? '#fedb2e' : 'rgba(255,255,255,0.6)' }]}>HDR</Text>
                  </Pressable>
                ) : null}
              </View>
              <Pressable
                accessibilityRole={canSwitchRendition ? 'button' : 'text'}
                accessibilityLabel={canSwitchRendition ? (playingLowRes ? (localUri ? 'Play the original' : 'Download and play the original') : 'Play the low-res copy') : undefined}
                disabled={!canSwitchRendition}
                onPress={switchRendition}
                style={({ pressed }) => [styles.titleBlock, pressed && { opacity: 0.65 }]}
              >
                <Text numberOfLines={1} style={styles.title}>
                  {transfer && canSwitchRendition && playingLowRes ? `Original ${Math.round(transfer.fraction * 100)}%` : conform ? `${rendition} · ${conform}p` : rendition}
                </Text>
                <Text numberOfLines={1} style={styles.subtitle}>
                  {item.fileName}
                </Text>
              </Pressable>
              <View style={[styles.headerSide, styles.headerSideEnd]}>
                {fromPhone || desktop ? null : (
                  <BarIcon
                    icon={onPhone ? SmartPhone01Icon : Download04Icon}
                    label={onPhone ? 'On this phone' : transfer ? `Downloading ${Math.round(transfer.fraction * 100)}%` : 'Download to phone'}
                    disabled={onPhone || !!transfer}
                    onPress={download}
                  >
                    {transfer ? <Text style={styles.percent}>{`${Math.round(transfer.fraction * 100)}%`}</Text> : undefined}
                  </BarIcon>
                )}
                <BarIcon icon={Share08Icon} label="Share clip" onPress={() => setSharing(true)} />
                {edited ? (
                  <Pressable accessibilityRole="button" accessibilityLabel="Export edited clip" onPress={() => setExportOpen(true)} hitSlop={6} style={({ pressed }) => [styles.exportPill, pressed && { opacity: 0.7 }]}>
                    <Text style={styles.exportText}>Export</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            {isVideo && engine.kind === 'simulated' && !waitingForCamera && prefs.playbackAudioMeters ? (
              <View style={[styles.meters, { right: sideInset + 16 }]}>
                <PlaybackMeters left={meterL} right={meterR} />
              </View>
            ) : null}
          </View>

          {editable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Editing Preset"
              onPress={() => setPresetsOpen(true)}
              style={({ pressed }) => [styles.presetButton, { top: headerH + (isVideo && engine.kind === 'simulated' && prefs.playbackAudioMeters ? 48 : 6), right: sideInset + 12 }, pressed && { opacity: 0.65 }]}
            >
              <View style={styles.presetWell}>
                <Glyph icon={SlidersHorizontalIcon} size={20} color="#ffffff" strokeWidth={1.8} />
              </View>
              <Text style={styles.presetCaption}>{'Editing\nPreset'}</Text>
            </Pressable>
          ) : null}

          {/* Bottom: burst frames, filmstrip scrubber, tools, favourite · transport · delete */}
          <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 10), paddingLeft: sideInset + 12, paddingRight: sideInset + 12 }]} onLayout={(e) => setBottomH(e.nativeEvent.layout.height)}>
            <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.5)', 'rgba(0,0,0,0.85)']} locations={[0, 0.35, 1]} style={styles.fill} />
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
                      <Image source={{ uri: b.thumbnailUrl ?? lib.thumbs[b.id] }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}
              {isVideo ? (
                <>
                  <PlaybackFilmstrip
                    frames={frames}
                    position={position}
                    duration={engine.duration}
                    clock={clock}
                    clockLabel={timecode ? 'Show minutes and seconds' : 'Show timecode'}
                    onClockPress={() => prefs.set('playbackTimecode', !timecode)}
                    onScrubbing={(active) => {
                      if (active) {
                        setScrubbing({ wasPlaying: engine.playing, position: engine.position });
                        engine.pause();
                      } else setScrubbing(null);
                    }}
                    onScrub={(s) => {
                      setScrubbing((cur) => (cur ? { ...cur, position: s } : cur));
                      // The picture follows the strip, at most ~30 seeks a second (desktop §1.V).
                      const now = Date.now();
                      if (now - lastScrubSeek.current >= 33) {
                        lastScrubSeek.current = now;
                        engine.seek(s);
                      }
                    }}
                    onSeek={(s) => {
                      engine.seek(s);
                      if (scrubbing?.wasPlaying) engine.play();
                    }}
                  />
                  {portrait ? (
                    <>
                      {toolRow}
                      <View style={styles.actionRow}>
                        {favoriteButton}
                        {transport}
                        {deleteButton}
                      </View>
                    </>
                  ) : (
                    <View style={styles.landscapeRow}>
                      <View style={{ flex: 1, minWidth: 0 }}>{toolRow}</View>
                      {transport}
                      <View style={styles.landscapeEnd}>
                        {favoriteButton}
                        {deleteButton}
                      </View>
                    </View>
                  )}
                </>
              ) : (
                <View style={styles.landscapeRow}>
                  {favoriteButton}
                  <View style={{ flex: 1, minWidth: 0 }}>{toolRow}</View>
                  {deleteButton}
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
        <View style={{ position: 'absolute', right: sideInset + 16, bottom: Math.max(insets.bottom, 10) + 12 }}>
          <SideButton icon={ViewIcon} label="Show playback controls" onPress={() => setChrome(true)} />
        </View>
      )}

      {!editing ? <DeliveryProgressPill bottom={chrome ? bottomH + 8 : Math.max(insets.bottom, 10) + 70} /> : null}
      {lib.notice ? <NoticeToast text={lib.notice} bottom={(editing ? panelSize.height : chrome ? bottomH : Math.max(insets.bottom, 10)) + 90} /> : null}

      <Sheet visible={info && !wideLayout} title="Clip info" onClose={() => setInfo(false)}>
        <ClipInfoList rows={infoRows} />
      </Sheet>
      <Sheet visible={ratingOpen} title="Rating" onClose={() => setRatingOpen(false)} expandable={false}>
        <View style={styles.ratingBody}>
          <StarRating stars={rating} onSelect={(s) => prefs.setRating(item.id, s)} />
          <Text style={styles.sheetMuted}>{rating ? `${rating} of 5` : 'Unrated'}</Text>
        </View>
      </Sheet>
      <Sheet visible={conformOpen && targets.length > 0} title="Conform preview" onClose={() => setConformOpen(false)} expandable={false} passthrough>
        <Text style={styles.sheetMuted}>{`Shot at ${item.fps} fps`}</Text>
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
      <LutHubSheet
        visible={lutHubOpen}
        onClose={() => setLutHubOpen(false)}
        applied={edit.lut}
        onApply={(lut) => {
          if (tool && draft) setDraft({ ...draft, lut, lutStrength: lut && lut !== draft.lut ? 1 : draft.lutStrength });
          else setStoredEdit(item.id, { ...storedEdit, lut });
          setLutHubOpen(false);
        }}
      />
      <PresetSheet
        visible={presetsOpen}
        onClose={() => setPresetsOpen(false)}
        edit={storedEdit}
        onApply={(p) => {
          setStoredEdit(item.id, applyPreset(storedEdit, p));
          setPresetsOpen(false);
          lib.showNotice(`Applied ${p.name}`);
        }}
      />
      <ExportSheet
        visible={exportOpen}
        onClose={() => setExportOpen(false)}
        edit={storedEdit}
        sourceSize={source}
        hdrSource={hdrSource}
        lowResAvailable={engine.kind !== 'video' || (!!lowResUri && !/^https?:/.test(lowResUri))}
        originalOnPhone={!!localUri}
        onExport={startExport}
      />
      <DeliverySheet visible={sharing} items={burst.length ? burst : [item]} onClose={() => setSharing(false)} />
      <DeliveryQueueSheet visible={deliveryPanelOpen} onClose={() => setDeliveryPanel(false)} />
      <ConfirmSheet
        visible={confirmDelete}
        title={
          burst.length > 1
            ? `Delete this burst (${burst.length} photos)${fromPhone ? ' from this phone' : ''}?`
            : `Delete this ${isVideo ? 'clip' : 'photo'}${fromPhone ? ' from this phone' : ''}?`
        }
        message={fromPhone ? 'The camera keeps its copy.' : 'Removes it from the camera card.'}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void doDelete()}
      />
      </View>
      {wideLayout && inspector && !editing ? (
        <PlaybackInspector
          fileName={item.fileName}
          rendition={conform ? `${rendition} · ${conform}p` : rendition}
          rows={infoRows}
          rating={rating}
          onRate={(s) => prefs.setRating(item.id, s)}
          favorite={item.favorite}
          onFavorite={() => setFavorite(!item.favorite)}
          download={
            fromPhone || desktop
              ? null
              : {
                  label: onPhone ? 'On phone' : transfer ? `${Math.round(transfer.fraction * 100)}%` : 'Download',
                  done: onPhone,
                  busy: !!transfer,
                  onPress: download,
                }
          }
          onShare={() => setSharing(true)}
          onDelete={() => setConfirmDelete(true)}
          deleteLabel={fromPhone ? 'Delete clip from this phone' : 'Delete clip from camera'}
          onStill={desktop ? takeStill : undefined}
          onClose={() => setInspector(false)}
        />
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  const fill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };
  return {
    root: { flex: 1, backgroundColor: colors.preview, overflow: 'hidden' as const },
    rootRow: { flexDirection: 'row' as const },
    stage: { flex: 1, overflow: 'hidden' as const },
    fill,
    missing: { flex: 1, backgroundColor: colors.preview, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 12, padding: 24 },
    missingText: { fontFamily: fonts.medium, fontSize: 14, color: 'rgba(255,255,255,0.7)', textAlign: 'center' as const },
    loading: { ...fill, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 12, backgroundColor: 'rgba(0,0,0,0.45)' },
    loadingText: { fontFamily: fonts.medium, fontSize: 14, ...videoText, textAlign: 'center' as const, maxWidth: 320 },
    header: { position: 'absolute' as const, left: 0, right: 0, top: 0, paddingBottom: 22 },
    headerRow: { flexDirection: 'row' as const, alignItems: 'center' as const },
    headerSide: { flexDirection: 'row' as const, alignItems: 'center' as const, minWidth: 128 },
    headerSideEnd: { justifyContent: 'flex-end' as const },
    titleBlock: { flex: 1, minWidth: 0, alignItems: 'center' as const, gap: 1, minHeight: 44, justifyContent: 'center' as const },
    title: { fontFamily: fonts.semibold, fontSize: 15, ...videoText, color: 'rgba(255,255,255,0.88)' },
    subtitle: { fontFamily: fonts.medium, fontSize: 11, color: 'rgba(255,255,255,0.6)', textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 },
    percent: { fontFamily: fonts.semibold, fontSize: 11, ...videoText, fontVariant: ['tabular-nums' as const] },
    hdr: { height: 24, paddingHorizontal: 6, borderRadius: 6, borderWidth: 1.5, alignItems: 'center' as const, justifyContent: 'center' as const, marginLeft: 4 },
    hdrOn: { borderColor: '#fedb2e' },
    hdrOff: { borderColor: 'rgba(255,255,255,0.5)' },
    hdrText: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 0.3 },
    exportPill: { height: 30, paddingHorizontal: 12, borderRadius: 999, backgroundColor: colors.accent, alignItems: 'center' as const, justifyContent: 'center' as const, marginLeft: 4 },
    exportText: { fontFamily: fonts.semibold, fontSize: 13, color: '#111111' },
    meters: { position: 'absolute' as const, bottom: -40 },
    presetButton: { position: 'absolute' as const, alignItems: 'center' as const, gap: 4, minWidth: 56 },
    presetWell: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center' as const, justifyContent: 'center' as const },
    presetCaption: { fontFamily: fonts.medium, fontSize: 11, ...videoText, textAlign: 'center' as const, lineHeight: 13 },
    bottom: { position: 'absolute' as const, left: 0, right: 0, bottom: 0, paddingTop: 36, alignItems: 'center' as const },
    bottomColumn: { width: '100%' as const, maxWidth: 760, gap: 6 },
    filmstrip: { gap: 6, paddingVertical: 4 },
    frame: { width: 64, height: 44, borderRadius: 8, overflow: 'hidden' as const, borderWidth: 2, borderColor: 'transparent' },
    frameOn: { borderColor: '#ffffff' },
    transport: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 4 },
    toolScroll: { flexGrow: 0 },
    toolRow: { gap: 14, paddingTop: 2, paddingHorizontal: 2, alignItems: 'flex-start' as const },
    toolDivider: { width: 1, height: 36, marginTop: 4, backgroundColor: 'rgba(255,255,255,0.22)' },
    actionRow: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const },
    landscapeRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
    landscapeEnd: { flexDirection: 'row' as const, alignItems: 'center' as const },
    bottomPanel: { position: 'absolute' as const, left: 0, right: 0, bottom: 0, backgroundColor: colors.preview, alignItems: 'center' as const },
    sidePanel: { position: 'absolute' as const, right: 0, top: 0, bottom: 0, backgroundColor: colors.preview, justifyContent: 'flex-end' as const },
    panelColumn: { width: '100%' as const, maxWidth: 560 },
    ratingBody: { alignItems: 'center' as const, gap: 4, paddingBottom: spacing.md },
    sheetMuted: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground },
  };
}
