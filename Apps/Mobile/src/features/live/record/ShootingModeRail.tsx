import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useCamera, useCameraSession, type ShootingMode } from '@/camera';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { DASH, MODE_LABEL } from '../format';
import { haptics } from '../haptics';
import { MODE_ITEM_H, type Rect } from '../layout/fieldMonitorLayout';
import { useLiveUi } from '../liveUiStore';
import { onVideo, textShadow } from '../chrome/primitives';

/** Rail words: short, Mimo-style. */
export const MODE_RAIL_LABEL: Record<ShootingMode, string> = {
  video: 'Video',
  photo: 'Photo',
  'slow-motion': 'Slow-mo',
  timelapse: 'Timelapse',
  hyperlapse: 'Hyperlapse',
  panorama: 'Pano',
  night: 'Night',
  unknown: DASH,
};

/** Mimo's order: motion modes before Video, stills after it, so Video sits mid-rail. */
const RAIL_ORDER: ShootingMode[] = ['hyperlapse', 'timelapse', 'slow-motion', 'video', 'photo', 'panorama', 'night', 'unknown'];

export function railOrder(modes: ShootingMode[]): ShootingMode[] {
  return [...modes].sort((a, b) => RAIL_ORDER.indexOf(a) - RAIL_ORDER.indexOf(b));
}

/** Width of one word in the horizontal (portrait) rail. */
const ITEM_W = 86;
/** Finger travel that steps one mode. */
const SWIPE = 28;

/**
 * The shooting-mode rail beside the record button (Mimo): the camera's own modes as words, the
 * current one in accent and centred on the record button. Tap a word or swipe the rail to change
 * (`control.setShootingMode`). Locked while recording: the rail dims and says why.
 *
 * Vertical along the trailing edge in landscape (centred on `center`, the record button's middle
 * in rail coordinates); a row under record in portrait.
 */
export function ShootingModeRail({
  rect,
  axis,
  center,
  notice,
}: {
  rect: Rect;
  axis: 'vertical' | 'horizontal';
  center: number;
  notice: (m: string, tone?: 'info' | 'warning' | 'error' | 'success') => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { control } = useCameraSession();
  const reported = useCamera((s) => s.format.shootingModeOptions.join('|'));
  const options = useMemo(() => (reported ? railOrder(reported.split('|') as ShootingMode[]) : []), [reported]);
  const current = useCamera((s) => s.format.shootingMode);
  const recording = useCamera((s) => s.recording.recording);
  const live = useCamera((s) => s.connection.phase === 'live');
  const locked = useLiveUi((s) => s.locked);

  // The word the operator chose shows at once; the camera's report replaces it.
  const [pending, setPending] = useState<ShootingMode | null>(null);
  useEffect(() => {
    if (!pending) return;
    if (pending === current) {
      setPending(null);
      return;
    }
    const t = setTimeout(() => setPending(null), 1500);
    return () => clearTimeout(t);
  }, [pending, current]);
  const shown = pending ?? current;
  const selected = Math.max(0, options.indexOf(shown));

  const step = axis === 'vertical' ? MODE_ITEM_H : ITEM_W;
  const target = center - (selected + 0.5) * step;
  const offset = useSharedValue(target);
  const drag = useSharedValue(0);
  useEffect(() => {
    offset.value = withTiming(target, { duration: 200 });
  }, [target, offset]);
  const moving = useAnimatedStyle(() => {
    const d = offset.value + drag.value;
    return { transform: axis === 'vertical' ? [{ translateY: d }] : [{ translateX: d }] };
  });

  const live$ = useRef({ options, selected, recording, choose: (_m: ShootingMode) => {} });
  const choose = (mode: ShootingMode) => {
    if (mode === shown) return;
    if (recording) {
      notice('Stop recording to change mode', 'warning');
      return;
    }
    haptics.selection();
    setPending(mode);
    control.setShootingMode(mode).catch(() => {
      setPending(null);
      notice('Mode did not change', 'error');
    });
  };
  live$.current = { options, selected, recording, choose };

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(live && !locked)
        .activeOffsetX(axis === 'horizontal' ? [-8, 8] : [-400, 400])
        .activeOffsetY(axis === 'vertical' ? [-8, 8] : [-400, 400])
        .onUpdate((e) => {
          if (live$.current.recording) return;
          const t = axis === 'vertical' ? e.translationY : e.translationX;
          drag.value = Math.max(-step, Math.min(step, t * 0.6));
        })
        .onEnd((e) => {
          const t = axis === 'vertical' ? e.translationY : e.translationX;
          const { options: opts, selected: i } = live$.current;
          // Swiping up (or left) brings the next word to the centre.
          const dir = t <= -SWIPE ? 1 : t >= SWIPE ? -1 : 0;
          const next = opts[Math.min(opts.length - 1, Math.max(0, i + dir))];
          if (dir !== 0 && next) live$.current.choose(next);
        })
        .onFinalize(() => {
          drag.value = withTiming(0, { duration: 160 });
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [axis, live, locked, step],
  );

  if (options.length === 0) return null;
  return (
    <GestureDetector gesture={pan}>
      <View
        collapsable={false}
        accessibilityRole="radiogroup"
        accessibilityLabel="Shooting mode"
        style={[styles.root, { left: rect.x, top: rect.y, width: rect.width, height: rect.height }, (recording || !live) && styles.dim]}
      >
        <Animated.View style={[axis === 'vertical' ? styles.column : styles.row, moving]}>
          {options.map((mode, i) => {
            const on = i === selected;
            const distance = Math.abs(i - selected);
            return (
              <Pressable
                key={mode}
                testID={`monitor.mode.${mode}`}
                accessibilityRole="radio"
                accessibilityLabel={MODE_LABEL[mode]}
                accessibilityState={{ checked: on, disabled: recording || locked || !live }}
                disabled={locked || !live}
                hitSlop={axis === 'horizontal' ? { top: 4, bottom: 4 } : undefined}
                onPress={() => choose(mode)}
                style={({ pressed }) => [
                  axis === 'vertical' ? { height: MODE_ITEM_H, width: rect.width } : { width: ITEM_W, height: rect.height },
                  styles.item,
                  { opacity: on ? 1 : distance === 1 ? 0.85 : distance === 2 ? 0.6 : 0.35 },
                  pressed && styles.pressed,
                ]}
              >
                <Text numberOfLines={1} style={[styles.word, on && { color: colors.accent, fontFamily: fonts.bold }]}>
                  {MODE_RAIL_LABEL[mode]}
                </Text>
              </Pressable>
            );
          })}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

function createStyles(_colors: ThemeColors) {
  return {
    root: { position: 'absolute' as const, overflow: 'hidden' as const },
    column: { flexDirection: 'column' as const },
    row: { flexDirection: 'row' as const },
    item: { alignItems: 'center' as const, justifyContent: 'center' as const },
    word: { fontFamily: fonts.semibold, fontSize: 13, color: onVideo.ink, ...textShadow },
    dim: { opacity: 0.45 },
    pressed: { opacity: 0.6 },
  };
}
