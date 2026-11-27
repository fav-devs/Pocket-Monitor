import type { IconSvgElement } from '@hugeicons/react-native';
import {
  Camera01Icon,
  CameraRotated02Icon,
  FaceIdIcon,
  FullScreenIcon,
  Home09Icon,
  Layers01Icon,
  LockIcon,
  MinimizeScreenIcon,
  MoreHorizontalIcon,
  PlayIcon,
  ShrinkDotIcon,
  SquareUnlock02Icon,
} from '@hugeicons/core-free-icons';
import type { ReactNode } from 'react';
import { Image, Platform, Pressable, Text, View, type ViewStyle } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { Icon } from '@/components/icon';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { useMediaLibrary } from '@/features/media/libraryStore';
import { useAssists } from '@/state/assists';
import { usePreferences } from '@/state/preferences';
import { isPhotoMode } from '../format';
import { haptics } from '../haptics';
import { QUICK_GAP, type FieldMonitorLayout, type Rect } from '../layout/fieldMonitorLayout';
import { useLiveUi, type CaptureSheetId } from '../liveUiStore';
import { onVideo, rectStyle } from './primitives';

/**
 * Soft shadow for white glyphs over the picture (Mimo: no plates). iOS shadows a background-less
 * view by its content; web and Android need a drop-shadow filter (a box shadow would draw a plate).
 */
const glyphShadow: ViewStyle =
  Platform.OS === 'ios'
    ? { shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 2.5, shadowOffset: { width: 0, height: 0 } }
    : ({ filter: [{ dropShadow: { offsetX: 0, offsetY: 0, standardDeviation: 2, color: 'rgba(0,0,0,0.6)' } }] } as ViewStyle);

/**
 * A strip or quick-icon button: a bare white glyph (no plate), an optional word over or under
 * it (Mimo's AUTO, ON), accent while its panel is open. At least 44pt.
 */
export function StripButton({
  icon,
  label,
  above,
  below,
  active = false,
  disabled = false,
  onPress,
  onLongPress,
  testID,
  accessibilityValue,
  children,
  overVideo = false,
  size = 24,
}: {
  icon?: IconSvgElement;
  label: string;
  above?: string;
  below?: string;
  active?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  testID?: string;
  accessibilityValue?: { text: string };
  children?: ReactNode;
  overVideo?: boolean;
  size?: number;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const ink = active ? colors.accent : onVideo.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={accessibilityValue}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={
        onPress
          ? () => {
              haptics.light();
              onPress();
            }
          : undefined
      }
      onLongPress={onLongPress}
      hitSlop={4}
      style={({ pressed }) => [styles.button, disabled && styles.dim, pressed && styles.pressed]}
    >
      {above ? <Text style={[styles.word, overVideo && styles.wordShadow, { color: ink }]}>{above}</Text> : null}
      {children ?? (icon ? <View style={overVideo ? glyphShadow : null}><Icon icon={icon} size={size} color={ink} strokeWidth={1.7} /></View> : null)}
      {below ? <Text style={[styles.word, overVideo && styles.wordShadow, { color: ink }]}>{below}</Text> : null}
    </Pressable>
  );
}

/** Opens one panel, or closes it when it is already open. */
function useTogglePanel() {
  const set = useLiveUi((s) => s.set);
  return (id: CaptureSheetId, extra?: Partial<{ cameraTab: 'camera' | 'gimbal' | 'general' }>) => {
    const s = useLiveUi.getState();
    const open = s.captureSheet === id && (!extra?.cameraTab || s.cameraTab === extra.cameraTab);
    set({ captureSheet: open ? null : id, gimbalPanel: 'none', zoomDialOpen: false, ...(extra ?? null) });
  };
}

/** Mimo's AUTO / M over a camera glyph: opens the exposure panel. */
export function ExposureModeButton() {
  const manual = useCamera((s) => s.exposure.mode === 'manual');
  const open = useLiveUi((s) => ['exposure', 'iso', 'shutter', 'ev', 'aperture'].includes(s.captureSheet ?? ''));
  const toggle = useTogglePanel();
  return (
    <StripButton
      testID="monitor.strip.exposure"
      label="Exposure"
      accessibilityValue={{ text: manual ? 'Manual' : 'Auto' }}
      above={manual ? 'M' : 'AUTO'}
      icon={Camera01Icon}
      size={22}
      active={open}
      onPress={() => toggle('exposure')}
    />
  );
}

/** Mimo's format chip: resolution over frame rate in a small outlined box. */
export function FormatChip() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const resolution = useCamera((s) => s.format.resolution);
  const fps = useCamera((s) => s.format.fps);
  const photo = useCamera((s) => isPhotoMode(s.format.shootingMode));
  const open = useLiveUi((s) => s.captureSheet === 'format');
  const toggle = useTogglePanel();
  const ink = open ? colors.accent : onVideo.ink;
  return (
    <StripButton
      testID="monitor.capture.format"
      label="Recording format"
      accessibilityValue={{ text: `${resolution} ${fps}` }}
      active={open}
      disabled={photo}
      onPress={() => toggle('format')}
    >
      <View style={[styles.chip, { borderColor: ink }]}>
        <Text numberOfLines={1} style={[styles.chipTop, { color: ink }]}>
          {photo ? 'PHOTO' : resolution.toUpperCase()}
        </Text>
        {!photo ? <Text style={[styles.chipBottom, { color: ink }]}>{fps}</Text> : null}
      </View>
    </StripButton>
  );
}

/**
 * Subject tracking (Mimo's ActiveTrack ON/OFF): turns tap-to-track on or off; off also stops a
 * running track. Disabled on cameras that cannot track.
 */
export function TrackingToggle({ notice }: { notice: (m: string) => void }) {
  const { control } = useCameraSession();
  const on = usePreferences((p) => p.tapToTrack);
  const setPref = usePreferences((p) => p.set);
  const can = useCamera((s) => s.capabilities.tracking && s.tracking.available);
  const running = useCamera((s) => s.tracking.status !== 'idle');
  return (
    <StripButton
      testID="monitor.strip.tracking"
      label="Subject tracking"
      accessibilityValue={{ text: on ? 'On' : 'Off' }}
      icon={FaceIdIcon}
      below={on && can ? 'ON' : 'OFF'}
      active={running}
      disabled={!can}
      onPress={() => {
        const next = !on;
        setPref('tapToTrack', next);
        if (!next && running) control.stopTracking().catch(() => {});
        notice(next ? 'Tap the picture to track' : 'Tracking off');
      }}
    />
  );
}

/** Opens the assist palette panel; a dot shows while any assist is on. */
export function AssistsButton() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const open = useLiveUi((s) => s.captureSheet === 'assists');
  const anyOn = useAssists((a) => Object.values(a.on).some(Boolean));
  const toggle = useTogglePanel();
  return (
    <StripButton testID="monitor.strip.assists" label="Assists" icon={Layers01Icon} active={open} onPress={() => toggle('assists')}>
      <View>
        <Icon icon={Layers01Icon} size={24} color={open ? colors.accent : onVideo.ink} strokeWidth={1.7} />
        {anyOn ? <View style={styles.dot} /> : null}
      </View>
    </StripButton>
  );
}

/** Mimo's `…`: the camera settings panel. */
export function MoreButton() {
  const open = useLiveUi((s) => s.captureSheet === 'camera' || s.gimbalPanel === 'sheet');
  const set = useLiveUi((s) => s.set);
  return (
    <StripButton
      testID="monitor.system.settings"
      label="Camera settings"
      icon={MoreHorizontalIcon}
      size={26}
      active={open}
      onPress={() => {
        const s = useLiveUi.getState();
        set(
          open
            ? { captureSheet: null, gimbalPanel: 'none' }
            : { captureSheet: 'camera', cameraTab: s.cameraTab === 'gimbal' ? 'camera' : s.cameraTab, gimbalPanel: 'none', zoomDialOpen: false },
        );
      }}
    />
  );
}

export function BackButton({ onPress }: { onPress: () => void }) {
  return <StripButton testID="monitor.system.back" label="Back to cameras" icon={Home09Icon} onPress={onPress} />;
}

/**
 * The leading controls: exposure mode, format, tracking, assists and `…` — a column down the
 * leading strip (back at its top, `…` at its foot), or a row under the picture in portrait.
 */
export function LeadingControls({ layout, notice }: { layout: FieldMonitorLayout; notice: (m: string) => void }) {
  const styles = useThemedStyles(createStyles);
  const vertical = layout.axis === 'vertical';
  const r = layout.leading;
  if (vertical) {
    return (
      <View pointerEvents="box-none" style={[rectStyle(r), styles.column]}>
        <View style={[styles.columnMiddle, layout.tablet && styles.columnMiddleTablet]}>
          <ExposureModeButton />
          <FormatChip />
          <TrackingToggle notice={notice} />
          <AssistsButton />
        </View>
        <MoreButton />
      </View>
    );
  }
  return (
    <View pointerEvents="box-none" style={[rectStyle(r), styles.row]}>
      <ExposureModeButton />
      <FormatChip />
      <TrackingToggle notice={notice} />
      <AssistsButton />
      <MoreButton />
    </View>
  );
}

/**
 * Quick icons over the picture (Mimo's trailing column, above record): selfie flip, DISP and
 * recenter. They dim while the screen is locked. Fills its rect from the top (a column) or the
 * leading end (a row in portrait); a movable item sizes it to its icons.
 */
export function QuickIcons({ vertical, onFlip }: { vertical: boolean; onFlip: () => void }) {
  const styles = useThemedStyles(createStyles);
  const session = useCameraSession();
  const flip = useCamera((s) => s.capabilities.selfieFlip);
  const selfie = useCamera((s) => s.gimbal.face === 'selfie');
  const gimbal = useCamera((s) => s.capabilities.gimbal && s.gimbal.available);
  const recentering = useCamera((s) => s.gimbal.recentering);
  const live = useCamera((s) => s.connection.phase === 'live');
  const locked = useLiveUi((s) => s.locked);
  return (
    <View pointerEvents={locked ? 'none' : 'box-none'} style={[vertical ? styles.quickColumn : styles.quickRow, locked && styles.dimmed]}>
      {flip ? (
        <StripButton overVideo testID="monitor.quick.flip" label="Selfie flip" icon={CameraRotated02Icon} active={selfie} disabled={!live} onPress={onFlip} />
      ) : null}
      <DispButton />
      {gimbal ? (
        <StripButton
          overVideo
          testID="monitor.quick.recenter"
          label="Recenter gimbal"
          icon={ShrinkDotIcon}
          active={recentering}
          disabled={!live}
          onPress={() => session.gimbal.recenter().catch(() => {})}
        />
      ) : null}
    </View>
  );
}

/** How many icons `QuickIcons` shows for the current camera. */
export function useQuickCount() {
  const flip = useCamera((s) => s.capabilities.selfieFlip);
  const gimbal = useCamera((s) => s.capabilities.gimbal && s.gimbal.available);
  return (flip ? 1 : 0) + 1 + (gimbal ? 1 : 0);
}

/**
 * The lock group (under record in landscape, the quick row's end in portrait): anything the
 * platform adds (Picture in Picture), then the screen lock, which stays reachable while locked.
 */
export function LockGroup({ vertical, extra }: { vertical: boolean; extra?: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const locked = useLiveUi((s) => s.locked);
  return (
    <View pointerEvents="box-none" style={vertical ? styles.quickColumn : styles.quickRow}>
      {extra ? (
        <View pointerEvents={locked ? 'none' : 'box-none'} style={locked && styles.dimmed}>
          {extra}
        </View>
      ) : null}
      <LockButton />
    </View>
  );
}

/** DISP: live chrome ↔ clean picture. */
export function DispButton() {
  const disp = useLiveUi((s) => s.disp);
  const set = useLiveUi((s) => s.set);
  return (
    <StripButton
      overVideo
      testID="monitor.system.display"
      label="Display"
      accessibilityValue={{ text: disp === 'live' ? 'Controls shown' : 'Clean picture' }}
      icon={disp === 'live' ? FullScreenIcon : MinimizeScreenIcon}
      onPress={() => set({ disp: disp === 'live' ? 'clean' : 'live', captureSheet: null, zoomDialOpen: false, gimbalPanel: 'none' })}
    />
  );
}

/** Screen lock: locks every other live control (the Motion Control run pill stays). */
export function LockButton() {
  const locked = useLiveUi((s) => s.locked);
  const set = useLiveUi((s) => s.set);
  return (
    <StripButton
      overVideo
      testID="monitor.system.lock"
      label={locked ? 'Unlock controls' : 'Lock controls'}
      icon={locked ? LockIcon : SquareUnlock02Icon}
      active={locked}
      onPress={() => {
        haptics.medium();
        const panel = useLiveUi.getState().gimbalPanel;
        set({ locked: !locked, captureSheet: null, gimbalPanel: panel === 'runPill' ? 'runPill' : 'none', zoomDialOpen: false });
      }}
    />
  );
}

/** Media: the newest clip's thumbnail when the library has listed one, else a play glyph. */
export function MediaButton({ rect, onPress }: { rect: Rect; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  const thumb = useMediaLibrary((s) => {
    const first = s.items[0];
    return first ? (first.thumbnailUrl ?? s.thumbs[first.id]) : undefined;
  });
  const media = useCamera((s) => s.capabilities.media);
  return (
    <View pointerEvents="box-none" style={[rectStyle(rect), styles.center]}>
      <Pressable
        testID="monitor.system.media"
        accessibilityRole="button"
        accessibilityLabel="Camera media"
        disabled={!media}
        hitSlop={6}
        onPress={() => {
          haptics.light();
          onPress();
        }}
        style={({ pressed }) => [styles.media, !media && styles.dim, pressed && styles.pressed]}
      >
        {thumb ? <Image source={{ uri: thumb }} style={styles.mediaThumb} /> : <Icon icon={PlayIcon} size={18} color={onVideo.ink} strokeWidth={1.8} />}
      </Pressable>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    button: { minWidth: 44, minHeight: 44, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 1 },
    word: { fontFamily: fonts.bold, fontSize: 10, lineHeight: 12, letterSpacing: 0.3, color: onVideo.ink },
    wordShadow: { textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 3 },
    chip: {
      minWidth: 34,
      paddingHorizontal: 3,
      paddingVertical: 1,
      borderRadius: 3,
      borderWidth: 1.4,
      alignItems: 'flex-end' as const,
    },
    chipTop: { fontFamily: fonts.bold, fontSize: 9.5, lineHeight: 11, letterSpacing: 0.2 },
    chipBottom: { fontFamily: fonts.bold, fontSize: 9.5, lineHeight: 11 },
    dot: {
      position: 'absolute' as const,
      right: -4,
      top: -3,
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.primary,
    },
    column: { alignItems: 'center' as const, paddingBottom: 2 },
    columnMiddle: { flex: 1, alignItems: 'center' as const, justifyContent: 'space-evenly' as const },
    // A tall tablet strip keeps the group together rather than spreading it down the screen.
    columnMiddleTablet: { justifyContent: 'center' as const, gap: 40 },
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-around' as const },
    quickColumn: { alignItems: 'center' as const, gap: QUICK_GAP },
    quickRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 14 },
    dimmed: { opacity: 0.4 },
    center: { alignItems: 'center' as const, justifyContent: 'center' as const },
    media: {
      width: 36,
      height: 36,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: 'rgba(255,255,255,0.85)',
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      overflow: 'hidden' as const,
    },
    mediaThumb: { width: 36, height: 36 },
    dim: { opacity: 0.4 },
    pressed: { opacity: 0.65 },
  };
}
