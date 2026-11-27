import { StarIcon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { useRef, type ComponentRef } from 'react';
import { PanResponder, Pressable, Text, View } from 'react-native';
import type { CameraMediaItem } from '@/camera';
import { Icon } from '@/components/icon';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { byteLabel, colorModeLabel, dateTimeLabel, durationLabel, resolutionLabel } from './format';
import { favoriteColor, Glyph } from './MediaChips';

/** Text over video: white with a soft shadow (on-video chrome). */
export const videoText = { color: '#ffffff', textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 } as const;

/**
 * `MonitorPlaybackScrubber`: a drag on the track reports seconds; the host decides how to seek.
 * Arrow keys / accessibility increments move one second.
 */
export function PlaybackScrubber({
  position,
  duration,
  buffered = 0,
  onScrub,
  onSeek,
  onScrubbing,
}: {
  position: number;
  duration: number;
  buffered?: number;
  onScrub: (seconds: number) => void;
  onSeek: (seconds: number) => void;
  onScrubbing: (active: boolean) => void;
}) {
  const track = useRef<ComponentRef<typeof View>>(null);
  const geometry = useRef({ x: 0, width: 1 });
  const cb = useRef({ onScrub, onSeek, onScrubbing, duration });
  cb.current = { onScrub, onSeek, onScrubbing, duration };
  const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const bufferedFraction = duration > 0 ? Math.min(1, Math.max(0, buffered / duration)) : 0;
  const dragging = useRef(false);

  const measure = () => track.current?.measureInWindow?.((x: number, _y: number, width: number) => (geometry.current = { x, width: Math.max(1, width) }));
  const seconds = (pageX: number) => {
    const { x, width } = geometry.current;
    return Math.min(1, Math.max(0, (pageX - x) / width)) * cb.current.duration;
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (_e, g) => {
        measure();
        dragging.current = true;
        cb.current.onScrubbing(true);
        cb.current.onScrub(seconds(g.x0));
      },
      onPanResponderMove: (_e, g) => cb.current.onScrub(seconds(g.moveX)),
      onPanResponderRelease: (_e, g) => {
        dragging.current = false;
        cb.current.onSeek(seconds(g.moveX || g.x0));
        cb.current.onScrubbing(false);
      },
      onPanResponderTerminate: () => {
        dragging.current = false;
        cb.current.onScrubbing(false);
      },
    }),
  ).current;

  return (
    <View
      ref={track}
      onLayout={measure}
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Playback position"
      accessibilityValue={{ text: `${Math.floor(Math.max(0, position))} seconds` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        const t = Math.min(duration, Math.max(0, position + (e.nativeEvent.actionName === 'increment' ? 1 : -1)));
        onSeek(t);
      }}
      style={{ height: 32, justifyContent: 'center' }}
    >
      <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${bufferedFraction * 100}%`, backgroundColor: 'rgba(255,255,255,0.3)' }} />
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fraction * 100}%`, backgroundColor: '#ffffff' }} />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: `${fraction * 100}%`,
          marginLeft: -8,
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: '#ffffff',
          shadowColor: '#000',
          shadowOpacity: 0.35,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 1 },
        }}
      />
    </View>
  );
}

/**
 * A tool well over video (ai-cut editor toolbar): a 44pt squircle `rgba(255,255,255,0.18)` with a
 * 22pt white icon and an 11pt caption under it. Selected is the ink fill (white on playback).
 */
export function ToolWell({
  icon,
  label,
  caption,
  onPress,
  active,
  destructive,
  disabled,
  filledIcon,
  iconColor,
}: {
  icon: IconSvgElement;
  label: string;
  caption?: string;
  onPress: () => void;
  active?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  filledIcon?: boolean;
  iconColor?: string;
}) {
  const color = iconColor ?? (active ? '#111111' : destructive ? '#ff6b6b' : '#ffffff');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({ alignItems: 'center', gap: 5, minWidth: 48, opacity: disabled ? 0.35 : pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 15,
          borderCurve: 'continuous',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: active ? '#f4f4f4' : 'rgba(255,255,255,0.18)',
        }}
      >
        <Glyph icon={icon} size={22} color={color} filled={filledIcon} strokeWidth={1.7} />
      </View>
      {caption ? (
        <Text numberOfLines={1} style={{ fontFamily: fonts.medium, fontSize: 11, ...videoText }}>
          {caption}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** A 44pt translucent squircle over video (back, previous/next clip). */
export function SideButton({ icon, label, onPress, size = 44 }: { icon: IconSvgElement; label: string; onPress: () => void; size?: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: 14,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.18)',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon icon={icon} size={22} color="#ffffff" strokeWidth={1.8} />
    </Pressable>
  );
}

/** `MonitorStarRating`: five big stars; tapping the current level clears it. */
export function StarRating({ stars, onSelect }: { stars: number; onSelect: (stars: number) => void }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Star rating" style={{ flexDirection: 'row', justifyContent: 'center', gap: 4 }}>
      {[1, 2, 3, 4, 5].map((level) => {
        const on = level <= stars;
        return (
          <Pressable
            key={level}
            accessibilityRole="radio"
            accessibilityLabel={`Rate ${level} ${level === 1 ? 'star' : 'stars'}`}
            accessibilityState={{ checked: level === stars }}
            onPress={() => onSelect(level === stars ? 0 : level)}
            style={({ pressed }) => ({ width: 56, height: 56, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
          >
            <Glyph icon={StarIcon} size={34} color={on ? favoriteColor : colors.mutedForeground} filled={on} strokeWidth={1.5} />
          </Pressable>
        );
      })}
    </View>
  );
}

export function clipInfoRows(item: CameraMediaItem, extra: { source: string; rating: number; frames?: number }): [string, string][] {
  const rows: [string, string][] = [
    ['File', item.fileName],
    ['Type', item.kind === 'video' ? 'Video' : extra.frames ? `Photo · burst of ${extra.frames}` : 'Photo'],
    ['Resolution', item.width && item.height ? `${item.width} × ${item.height} (${resolutionLabel(item.width, item.height)})` : '—'],
  ];
  if (item.kind === 'video') {
    rows.push(['Frame rate', item.fps ? `${item.fps} fps` : '—']);
    rows.push(['Duration', durationLabel(item.durationSec) || '—']);
  }
  rows.push(['Color', colorModeLabel(item.colorMode) ?? '—']);
  rows.push(['Size', byteLabel(item.sizeBytes)]);
  rows.push(['Recorded', dateTimeLabel(item.createdAt)]);
  rows.push(['Source', extra.source]);
  rows.push(['Favorite', item.favorite ? 'Yes' : 'No']);
  rows.push(['Rating', extra.rating ? `${extra.rating} of 5` : 'Unrated']);
  return rows;
}

/** `MonitorClipInfoPanel`'s rows: label left, value right, on a surface card. */
export function ClipInfoList({ rows }: { rows: [string, string][] }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.infoCard}>
      {rows.map(([k, v], i) => (
        <View key={k} style={[styles.infoRow, i < rows.length - 1 && styles.infoBorder]}>
          <Text style={styles.infoKey}>{k}</Text>
          <Text style={styles.infoValue} selectable numberOfLines={2}>
            {v}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Two-channel playback meter (dBFS −60…0) on a dark plate. */
export function PlaybackMeters({ left, right }: { left: number; right: number }) {
  const { colors } = useTheme();
  const bar = (db: number, label: string) => {
    const f = Math.min(1, Math.max(0, (db + 60) / 60));
    const color = db > -6 ? colors.destructive : db > -18 ? colors.accent : colors.success;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ fontFamily: fonts.semibold, fontSize: 10, width: 8, color: 'rgba(255,255,255,0.7)' }}>{label}</Text>
        <View style={{ width: 96, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.16)', overflow: 'hidden' }}>
          <View style={{ width: `${f * 100}%`, height: 4, backgroundColor: color }} />
        </View>
      </View>
    );
  };
  return (
    <View
      accessibilityLabel={`Audio levels left ${Math.round(left)} dB, right ${Math.round(right)} dB`}
      style={{ gap: 5, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, borderCurve: 'continuous', backgroundColor: 'rgba(0,0,0,0.45)' }}
    >
      {bar(left, 'L')}
      {bar(right, 'R')}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    infoCard: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' as const, marginBottom: spacing.sm },
    infoRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md, minHeight: 46, paddingHorizontal: spacing.md, paddingVertical: 10 },
    infoBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    infoKey: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, width: 96 },
    infoValue: { flex: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.foreground, textAlign: 'right' as const },
  };
}
