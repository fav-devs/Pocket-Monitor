import { Image, type ImageSource } from 'expo-image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type GestureResponderEvent, PanResponder, Pressable, Text, View } from 'react-native';
import type { CameraMediaItem } from '@/camera';
import { demoFilmstripFrames } from '@/camera/demo/demoMedia';
import { fonts, type ThemeColors, useThemedStyles } from '@/constants/theme';
import type { PlaybackEngine } from './usePlaybackEngine';

/** Frames along the strip. */
export const FILMSTRIP_FRAMES = 10;
const FRAME_W = 46;
const FRAME_H = 50;

/** A filmstrip frame: an image URL, or a native thumbnail from expo-video (`VideoThumbnail`). */
export type FilmstripFrame = string | object;

/** `00:00 / 01:23` (Mimo): minutes and seconds, both two digits; hours when the clip has them. */
export function stripClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

/**
 * Frames for the strip: the desktop's `pm://strip` pictures, procedural frames for the demo
 * camera, frames cut from the local proxy (expo-video `generateThumbnailsAsync`), else the
 * camera's thumbnail repeated while nothing better exists.
 */
export function usePlaybackFrames(options: {
  item: CameraMediaItem | undefined;
  engine: Pick<PlaybackEngine, 'kind' | 'ready' | 'duration'> & { player?: PlaybackEngine['player']; strip?: string[] };
  thumbnail?: string;
  /** Changes when the picture source changes. */
  sourceKey: string;
}): FilmstripFrame[] {
  const { item, engine, thumbnail, sourceKey } = options;
  const [cut, setCut] = useState<{ key: string; frames: FilmstripFrame[] } | null>(null);
  const demo = engine.kind === 'simulated';
  const demoFrames = useMemo(() => (item && demo && item.kind === 'video' ? demoFilmstripFrames(item, FILMSTRIP_FRAMES) : null), [item, demo]);

  useEffect(() => {
    if (engine.kind !== 'video' || !engine.ready || !engine.player || !(engine.duration > 0)) return;
    let live = true;
    const times = Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => ((i + 0.5) / FILMSTRIP_FRAMES) * engine.duration);
    engine.player
      .generateThumbnailsAsync(times, { maxWidth: 160 })
      .then((thumbs) => {
        if (live && thumbs.length) setCut({ key: sourceKey, frames: thumbs as FilmstripFrame[] });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [engine.kind, engine.ready, engine.player, engine.duration, sourceKey]);

  if (engine.strip && engine.strip.length) return engine.strip;
  if (demoFrames) return demoFrames;
  if (cut && cut.key === sourceKey) return cut.frames;
  return thumbnail ? Array.from({ length: FILMSTRIP_FRAMES }, () => thumbnail) : [];
}

/**
 * Mimo's scrubber: a strip of frames that slides under a fixed playhead in the middle, with the
 * time above it. Drag the strip to scrub (the picture follows); a tap seeks to the frame tapped.
 */
export function PlaybackFilmstrip({
  frames,
  position,
  duration,
  clock,
  onClockPress,
  clockLabel,
  onScrub,
  onSeek,
  onScrubbing,
  markers,
  onMarkerLongPress,
}: {
  frames: FilmstripFrame[];
  position: number;
  duration: number;
  /** "00:00 / 01:23". */
  clock: string;
  onClockPress?: () => void;
  clockLabel?: string;
  onScrub: (seconds: number) => void;
  onSeek: (seconds: number) => void;
  onScrubbing: (active: boolean) => void;
  /** Optional (additive). Marker pins on the strip: a tap seeks to one, a hold edits it. */
  markers?: { id: string; time: number; color: string; label: string }[];
  onMarkerLongPress?: (id: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [width, setWidth] = useState(0);
  const count = Math.max(1, frames.length || FILMSTRIP_FRAMES);
  const stripW = count * FRAME_W;
  const cb = useRef({ onScrub, onSeek, onScrubbing, duration, position, stripW, width });
  cb.current = { onScrub, onSeek, onScrubbing, duration, position, stripW, width };
  const drag = useRef<{ start: number; moved: boolean; last: number } | null>(null);

  const clamp = (t: number) => Math.min(Math.max(0, t), cb.current.duration);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        drag.current = { start: cb.current.position, moved: false, last: cb.current.position };
      },
      onPanResponderMove: (_e, g) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.abs(g.dx) < 4) return;
        if (!d.moved) {
          d.moved = true;
          cb.current.onScrubbing(true);
        }
        // Dragging the strip left moves forward in time.
        d.last = clamp(d.start - (g.dx / cb.current.stripW) * cb.current.duration);
        cb.current.onScrub(d.last);
      },
      onPanResponderRelease: (e: GestureResponderEvent) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved) {
          cb.current.onSeek(d.last);
          cb.current.onScrubbing(false);
          return;
        }
        // A tap: seek to the time under the finger.
        const x = e.nativeEvent.locationX ?? cb.current.width / 2;
        cb.current.onSeek(clamp(cb.current.position + ((x - cb.current.width / 2) / cb.current.stripW) * cb.current.duration));
      },
      onPanResponderTerminate: () => {
        if (drag.current?.moved) cb.current.onScrubbing(false);
        drag.current = null;
      },
    }),
  ).current;

  const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const left = width / 2 - fraction * stripW;
  const step = (delta: number) => onSeek(clamp(position + delta));

  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={clockLabel ?? 'Playback time'}
        onPress={onClockPress}
        hitSlop={8}
        style={({ pressed }) => [styles.clockPill, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.clock}>{clock}</Text>
      </Pressable>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        {...responder.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Playback position"
        accessibilityValue={{ text: clock }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        style={styles.track}
      >
        {width > 0 ? (
          <View pointerEvents="none" style={[styles.strip, { left, width: stripW }]}>
            {Array.from({ length: count }, (_, i) => {
              const f = frames[i];
              const source = (typeof f === 'string' ? { uri: f } : f) as ImageSource;
              return (
                <View key={i} style={styles.frame}>
                  {f ? <Image source={source} style={styles.frameImage} contentFit="cover" transition={0} /> : null}
                </View>
              );
            })}
          </View>
        ) : null}
        {width > 0 && markers?.length && duration > 0
          ? markers.map((m) => {
              const x = left + Math.min(1, Math.max(0, m.time / duration)) * stripW;
              if (x < -8 || x > width + 8) return null;
              return (
                <Pressable
                  key={m.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${m.label} at ${stripClock(m.time)}`}
                  accessibilityHint="Hold to edit"
                  onPress={() => onSeek(m.time)}
                  onLongPress={() => onMarkerLongPress?.(m.id)}
                  delayLongPress={350}
                  hitSlop={{ top: 8, bottom: 30, left: 14, right: 14 }}
                  style={[styles.pin, { left: x - 8 }]}
                >
                  <View style={[styles.pinHead, { backgroundColor: m.color }]} />
                  <View style={[styles.pinLine, { backgroundColor: m.color }]} />
                </Pressable>
              );
            })
          : null}
        <View pointerEvents="none" style={[styles.playhead, { left: width / 2 - 1 }]} />
      </View>
    </View>
  );
}

function createStyles(_colors: ThemeColors) {
  return {
    root: { alignItems: 'center' as const, gap: 8 },
    clockPill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.45)' },
    clock: {
      fontFamily: fonts.semibold,
      fontSize: 13,
      color: '#ffffff',
      fontVariant: ['tabular-nums' as const],
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowRadius: 4,
    },
    track: { width: '100%' as const, height: FRAME_H + 12, justifyContent: 'center' as const, overflow: 'hidden' as const },
    strip: { position: 'absolute' as const, top: 6, height: FRAME_H, flexDirection: 'row' as const, borderRadius: 6, overflow: 'hidden' as const },
    frame: { width: FRAME_W, height: FRAME_H, backgroundColor: 'rgba(255,255,255,0.08)' },
    frameImage: { width: '100%' as const, height: '100%' as const },
    pin: { position: 'absolute' as const, top: 0, width: 16, height: FRAME_H + 6, alignItems: 'center' as const },
    pinHead: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: '#ffffff' },
    pinLine: { width: 2, flex: 1, opacity: 0.9 },
    playhead: {
      position: 'absolute' as const,
      top: 0,
      bottom: 0,
      width: 2,
      borderRadius: 1,
      backgroundColor: '#ffffff',
      shadowColor: '#000',
      shadowOpacity: 0.5,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 0 },
    },
  };
}
