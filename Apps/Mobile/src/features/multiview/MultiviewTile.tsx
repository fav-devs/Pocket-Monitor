import { Add01Icon, RefreshIcon } from '@hugeicons/core-free-icons';
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { CameraSessionScope, useCamera, useCameraSession } from '@/camera';
import type { TileLook, TileSnapshot } from '@/camera/multiview/types';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { onVideo, rectStyle, textShadow } from '@/features/live/chrome/primitives';
import { elapsedLabel, formatChip } from '@/features/live/format';
import type { Rect } from '@/features/live/layout/fieldMonitorLayout';
import { LinkGauge } from '@/features/live/status/LiveTelemetry';
import LivePicture from '@/features/picture/LivePicture';
import { lookBadge, useTileEffects } from './tileLook';

/** Thumbnails say what the link is doing in one word; the large tile says it in full. */
const COMPACT_STATUS: Record<TileSnapshot['phase'], string> = {
  empty: '',
  connecting: 'Connecting',
  waiting: 'Waiting for video',
  live: 'Live',
  reconnecting: 'Reconnecting',
  failed: 'Failed',
};

interface TileProps {
  tile: TileSnapshot;
  rect: Rect;
  look: TileLook;
  fill: boolean;
  /** The selected camera: its picture feeds the scopes; a grid tile shows a white edge. */
  selected: boolean;
  /** Center stage's large picture. */
  large: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onReconnect: () => void;
}

/**
 * One Multiview slot: the camera's own picture (its look), name, REC tally and link health over
 * it, and its connection state when it is not live. A recording camera gets the tally border.
 * Empty slots are an Add well.
 */
export const MultiviewTile = memo(function MultiviewTile(props: TileProps) {
  const styles = useThemedStyles(createStyles);
  const { tile, rect } = props;
  if (!tile.session || !tile.camera) {
    const compact = rect.width < 160;
    return (
      <Pressable
        testID={`multiview.tile.${tile.slot}.add`}
        accessibilityRole="button"
        accessibilityLabel="Add camera"
        onPress={props.onPress}
        style={({ pressed }) => [rectStyle(rect), styles.empty, pressed && styles.pressed]}
      >
        <Squircle width={compact ? 36 : 44} height={compact ? 36 : 44} radius={compact ? 12 : 15} color={onVideo.well} style={styles.center}>
          <Icon icon={Add01Icon} size={compact ? 18 : 22} color={onVideo.ink} strokeWidth={1.8} />
        </Squircle>
        {!compact ? <Text style={styles.emptyCaption}>Add camera</Text> : null}
      </Pressable>
    );
  }
  return (
    <View testID={`multiview.tile.${tile.slot}`} style={[rectStyle(rect), styles.tile]}>
      <CameraSessionScope session={tile.session}>
        <TileBody {...props} />
      </CameraSessionScope>
    </View>
  );
});

function TileBody({ tile, rect, look, fill, selected, large, onPress, onLongPress, onReconnect }: TileProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const session = useCameraSession();
  // `session.video` changes with the link phase; re-render on it.
  useCamera((s) => s.connection.phase);
  const elapsed = useCamera((s) => (s.recording.recording ? s.recording.elapsedSec : -1));
  const format = useCamera((s) => formatChip(s.format.resolution, s.format.fps));
  const effects = useTileEffects(look);
  const compact = rect.width < 200;
  // Thumbnails: name and REC dot; the take time and format belong to the large picture.
  const small = !large && rect.width < 300;
  const recording = tile.recording;
  const live = tile.phase === 'live';
  const badge = lookBadge(look);
  const busy = tile.phase === 'connecting' || tile.phase === 'waiting' || tile.phase === 'reconnecting';
  const note = tile.recordNote && tile.recordNote !== 'Recording' && tile.recordNote !== 'Recording stopped' ? tile.recordNote : null;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tile.camera!.name}
        accessibilityValue={{ text: recording ? 'Recording' : tile.status }}
        accessibilityHint={large ? undefined : 'Shows this camera large'}
        accessibilityState={{ selected }}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={450}
        style={styles.fill}
      >
        <View pointerEvents="none" style={styles.fill}>
          <LivePicture source={session.video} resizeMode={fill ? 'fill' : 'fit'} effects={effects} publishSamples={selected} />
        </View>
      </Pressable>

      {/* Name and tally, top leading. */}
      <View pointerEvents="none" style={[styles.topRow, small && styles.topRowSmall, compact && styles.topRowCompact]}>
        <View style={[styles.namePill, compact && styles.namePillCompact]}>
          {recording ? <View style={[styles.recDot, { backgroundColor: colors.dotPink }]} /> : null}
          <Text numberOfLines={1} style={[styles.name, compact && styles.nameCompact]}>
            {tile.camera!.name}
          </Text>
          {recording && elapsed >= 0 && !small ? <Text style={styles.elapsed}>{elapsedLabel(elapsed)}</Text> : null}
        </View>
      </View>

      {/* Link health, top trailing (large tiles also show the format). */}
      {live && !compact ? (
        <View pointerEvents="box-none" style={styles.topTrailing}>
          {large ? (
            <View style={styles.smallPill}>
              <Text style={styles.smallPillText}>{format}</Text>
            </View>
          ) : null}
          <LinkGauge />
        </View>
      ) : null}

      {/* Look and record note, bottom leading. */}
      {(badge && !compact && live) || note ? (
        <View pointerEvents="none" style={styles.bottomRow}>
          {note ? (
            <View style={styles.smallPill}>
              <Text numberOfLines={1} style={styles.smallPillText}>
                {note}
              </Text>
            </View>
          ) : null}
          {badge && !compact && live ? (
            <View style={styles.smallPill}>
              <Text numberOfLines={1} style={styles.smallPillText}>
                {badge}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Not live: what the link is doing, or why it stopped. */}
      {!live ? (
        <View pointerEvents="box-none" style={[styles.status, session.video.kind === 'none' && styles.statusBlank]}>
          {busy ? <Spinner size={compact ? 14 : 18} color={onVideo.ink} opacity={0.3} /> : null}
          <Text numberOfLines={compact ? 1 : 2} style={[styles.statusText, compact && styles.statusTextCompact]}>
            {compact ? COMPACT_STATUS[tile.phase] : tile.status}
          </Text>
          {tile.phase === 'failed' && tile.failure && !compact ? (
            <Text numberOfLines={rect.height > 220 ? 3 : 2} style={styles.failure}>
              {tile.failure}
            </Text>
          ) : null}
          {tile.phase === 'failed' ? (
            <Pressable
              testID={`multiview.tile.${tile.slot}.reconnect`}
              accessibilityRole="button"
              accessibilityLabel={`Reconnect ${tile.camera!.name}`}
              onPress={onReconnect}
              hitSlop={10}
              style={({ pressed }) => [styles.reconnect, compact && styles.reconnectCompact, pressed && styles.pressed]}
            >
              <Icon icon={RefreshIcon} size={14} color={onVideo.dark} strokeWidth={2} />
              {!compact ? <Text style={styles.reconnectText}>Reconnect</Text> : null}
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Tally border while recording; a white edge on the selected grid tile. */}
      {recording ? (
        <View pointerEvents="none" style={[styles.border, { borderColor: colors.dotPink, borderWidth: large ? 3 : 2.5 }]} />
      ) : selected && !large ? (
        <View pointerEvents="none" style={[styles.border, { borderColor: onVideo.ink, borderWidth: 2 }]} />
      ) : null}
    </>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    tile: { backgroundColor: colors.preview, borderRadius: 12, overflow: 'hidden' as const },
    fill: { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0 },
    center: { alignItems: 'center' as const, justifyContent: 'center' as const },
    empty: {
      borderRadius: 12,
      backgroundColor: 'rgba(255,255,255,0.06)',
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 8,
    },
    emptyCaption: { fontFamily: fonts.medium, fontSize: 12, color: onVideo.inkMuted },
    topRow: { position: 'absolute' as const, left: 8, top: 8, right: 96, flexDirection: 'row' as const },
    topRowSmall: { right: 52 },
    topRowCompact: { left: 5, top: 5, right: 5 },
    namePill: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      height: 26,
      maxWidth: '100%' as const,
      paddingHorizontal: 10,
      borderRadius: 999,
      backgroundColor: onVideo.pill,
    },
    namePillCompact: { height: 20, paddingHorizontal: 7, gap: 4 },
    recDot: { width: 7, height: 7, borderRadius: 3.5 },
    name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 12, color: onVideo.ink },
    nameCompact: { fontSize: 10 },
    elapsed: { fontFamily: fonts.semibold, fontSize: 12, color: onVideo.ink, fontVariant: ['tabular-nums' as const] },
    topTrailing: { position: 'absolute' as const, right: 8, top: 8, flexDirection: 'row' as const, gap: 6, alignItems: 'center' as const },
    bottomRow: { position: 'absolute' as const, left: 8, bottom: 8, right: 8, flexDirection: 'row' as const, gap: 6 },
    smallPill: { height: 24, justifyContent: 'center' as const, paddingHorizontal: 9, borderRadius: 999, backgroundColor: onVideo.pill, flexShrink: 1 },
    smallPillText: { fontFamily: fonts.medium, fontSize: 11, color: onVideo.ink },
    status: {
      ...{ position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0 },
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 8,
      paddingHorizontal: 16,
      backgroundColor: 'rgba(0,0,0,0.35)',
    },
    statusBlank: { backgroundColor: 'rgba(255,255,255,0.08)' },
    statusText: { fontFamily: fonts.semibold, fontSize: 13, color: onVideo.ink, textAlign: 'center' as const, ...textShadow },
    statusTextCompact: { fontSize: 10 },
    failure: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: onVideo.inkMuted, textAlign: 'center' as const, maxWidth: 360 },
    reconnect: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      height: 30,
      paddingHorizontal: 12,
      borderRadius: 999,
      backgroundColor: onVideo.chosen,
    },
    reconnectCompact: { height: 26, paddingHorizontal: 8 },
    reconnectText: { fontFamily: fonts.semibold, fontSize: 12, color: onVideo.dark },
    border: { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0, borderRadius: 12 },
    pressed: { opacity: 0.7 },
  };
}
