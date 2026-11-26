import { ChevronDown, ChevronUp, Star } from 'lucide-react-native';
import { useRef, useState, type ComponentRef } from 'react';
import { PanResponder, ScrollView, View } from 'react-native';
import type { CameraMediaItem } from '@/camera';
import { MText, colors, minTouch, radius } from '@/theme';
import { PressableScale, SectionHeader } from '@/ui';
import { byteLabel, colorModeLabel, dateTimeLabel, durationLabel, resolutionLabel } from './format';
import { CloseButton } from './MediaOverlays';

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
        cb.current.onScrubbing(true);
        cb.current.onScrub(seconds(g.x0));
      },
      onPanResponderMove: (_e, g) => cb.current.onScrub(seconds(g.moveX)),
      onPanResponderRelease: (_e, g) => {
        cb.current.onSeek(seconds(g.moveX || g.x0));
        cb.current.onScrubbing(false);
      },
      onPanResponderTerminate: () => cb.current.onScrubbing(false),
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
      style={{ height: 28, justifyContent: 'center' }}
    >
      <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)' }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${bufferedFraction * 100}%`, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)' }} />
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fraction * 100}%`, borderRadius: 2, backgroundColor: colors.accent }} />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: `${fraction * 100}%`,
          marginLeft: -7,
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: '#fff',
          shadowColor: '#000',
          shadowOpacity: 0.6,
          shadowRadius: 2,
          shadowOffset: { width: 0, height: 1 },
        }}
      />
    </View>
  );
}

/** `MonitorStarRating`: tapping the current level clears it. */
export function StarRating({ stars, onSelect }: { stars: number; onSelect: (stars: number) => void }) {
  return (
    <View style={{ flexDirection: 'row', paddingHorizontal: 4, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.border }}>
      {[1, 2, 3, 4, 5].map((level) => (
        <PressableScale
          key={level}
          accessibilityLabel={`Rate ${level} ${level === 1 ? 'star' : 'stars'}`}
          accessibilityState={{ selected: level <= stars }}
          onPress={() => onSelect(level === stars ? 0 : level)}
          style={{ width: minTouch, height: minTouch, alignItems: 'center', justifyContent: 'center' }}
        >
          <Star size={20} color={level <= stars ? colors.accent : colors.muted} fill={level <= stars ? colors.accent : 'transparent'} strokeWidth={1.8} />
        </PressableScale>
      ))}
    </View>
  );
}

/** `MonitorPlaybackRatingAnchor`: compact star + chevron that opens the rating shade. */
export function RatingAnchor({ stars, expanded, onToggle }: { stars: number; expanded: boolean; onToggle: () => void }) {
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <PressableScale
      accessibilityLabel={expanded ? 'Hide star rating' : 'Show star rating'}
      onPress={onToggle}
      style={{ width: 56, height: minTouch, borderRadius: radius.pill, backgroundColor: 'rgba(40,42,44,0.72)', borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 }}
    >
      <Star size={12} color={stars ? colors.accent : colors.muted} fill={stars ? colors.accent : colors.muted} />
      {stars ? (
        <MText size={10} weight="bold" color={colors.accent} mono>
          {stars}
        </MText>
      ) : null}
      <Chevron size={11} color={colors.muted} strokeWidth={2.4} />
    </PressableScale>
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

/** `MonitorClipInfoPanel`. */
export function ClipInfoPanel({ rows, onClose }: { rows: [string, string][]; onClose: () => void }) {
  return (
    <View style={{ flex: 1, borderRadius: radius.lg, backgroundColor: 'rgba(26,27,28,0.96)', borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 4, paddingTop: 4 }}>
        <View style={{ flex: 1 }}>
          <SectionHeader title="Clip info" />
        </View>
        <CloseButton onPress={onClose} label="Close clip information" />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 14, gap: 10 }}>
        {rows.map(([k, v]) => (
          <View key={k} style={{ gap: 2 }}>
            <MText size={9.5} weight="semibold" color={colors.muted} tracking={0.4}>
              {k}
            </MText>
            <MText size={12} mono selectable>
              {v}
            </MText>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

/** Two-channel playback meter (dBFS −60…0) with peak hold colouring. */
export function PlaybackMeters({ left, right }: { left: number; right: number }) {
  const bar = (db: number, label: string) => {
    const f = Math.min(1, Math.max(0, (db + 60) / 60));
    const color = db > -6 ? colors.recording : db > -18 ? colors.digitalCrop : colors.linkStable;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <MText size={8} weight="bold" color={colors.muted} style={{ width: 7 }}>
          {label}
        </MText>
        <View style={{ width: 96, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
          <View style={{ width: `${f * 100}%`, height: 4, backgroundColor: color }} />
        </View>
      </View>
    );
  };
  return (
    <View accessibilityLabel={`Audio levels left ${Math.round(left)} dB, right ${Math.round(right)} dB`} style={{ gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.45)' }}>
      {bar(left, 'L')}
      {bar(right, 'R')}
    </View>
  );
}

/** Small hook-free helper for a toggled boolean. */
export function useToggle(initial = false): [boolean, () => void, (v: boolean) => void] {
  const [v, set] = useState(initial);
  return [v, () => set((x) => !x), set];
}
