import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useCamera, useCameraSession, type ShootingMode } from '@/camera';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { DASH, MODE_LABEL } from '../format';
import { haptics } from '../haptics';
import type { Rect } from '../layout/fieldMonitorLayout';
import { useLiveUi } from '../liveUiStore';
import { onVideo, textShadow } from '../chrome/primitives';

/** Rail words: short caps, Mimo-style. */
export const MODE_RAIL_LABEL: Record<ShootingMode, string> = {
  video: 'VIDEO',
  photo: 'PHOTO',
  'slow-motion': 'SLOW-MO',
  timelapse: 'TIMELAPSE',
  hyperlapse: 'HYPERLAPSE',
  panorama: 'PANO',
  night: 'NIGHT',
  unknown: DASH,
};

/** Mimo's order: motion modes before Video, stills after it, so Video sits mid-rail. */
const RAIL_ORDER: ShootingMode[] = ['hyperlapse', 'timelapse', 'slow-motion', 'video', 'photo', 'panorama', 'night', 'unknown'];

export function railOrder(modes: ShootingMode[]): ShootingMode[] {
  return [...modes].sort((a, b) => RAIL_ORDER.indexOf(a) - RAIL_ORDER.indexOf(b));
}

/** Length of one word along the rail (both orientations: landscape turns the row on its side). */
const ITEM_W = 86;
/** Finger travel that steps one mode. */
const SWIPE = 28;

/**
 * The shooting-mode rail beside the record button (Mimo): the camera's own modes as words, the
 * current one in accent and centred on the record button. Tap a word or swipe along the rail to
 * change (`control.setShootingMode`). Locked while recording: the rail dims and says why.
 *
 * Landscape: a row of words turned −90° down the trailing strip, reading bottom to top like
 * Mimo (motion modes below Video, stills above), centred on `center` (the record button's middle
 * in rail coordinates). Portrait: a plain row above record.
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

  const vertical = axis === 'vertical';
  const step = ITEM_W;
  // Turned −90°, the row's +x points up the screen and x = 0 sits at the rail's foot.
  const along = vertical ? rect.height - center : center;
  const target = along - (selected + 0.5) * step;
  const offset = useSharedValue(target);
  const drag = useSharedValue(0);
  useEffect(() => {
    offset.value = withTiming(target, { duration: 200 });
  }, [target, offset]);
  const moving = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value + drag.value }] }));

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
          // Along the row: a finger moving up the turned rail moves the row toward +x.
          const t = axis === 'vertical' ? -e.translationY : e.translationX;
          drag.value = Math.max(-step, Math.min(step, t * 0.6));
        })
        .onEnd((e) => {
          const t = axis === 'vertical' ? -e.translationY : e.translationX;
          const { options: opts, selected: i } = live$.current;
          // Moving the row back (left, or down the turned rail) brings the next word to the centre.
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
  const words = (
    <Animated.View style={[styles.row, moving]}>
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
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => choose(mode)}
            style={({ pressed }) => [
              { width: ITEM_W, height: vertical ? rect.width : rect.height },
              styles.item,
              { opacity: on ? 1 : distance === 1 ? 0.7 : distance === 2 ? 0.5 : 0.32 },
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
  );
  return (
    <GestureDetector gesture={pan}>
      <View
        collapsable={false}
        accessibilityRole="radiogroup"
        accessibilityLabel="Shooting mode"
        style={[styles.root, { left: rect.x, top: rect.y, width: rect.width, height: rect.height }, (recording || !live) && styles.dim]}
      >
        {vertical ? (
          <View
            style={{
              position: 'absolute',
              width: rect.height,
              height: rect.width,
              left: (rect.width - rect.height) / 2,
              top: (rect.height - rect.width) / 2,
              transform: [{ rotate: '-90deg' }],
            }}
          >
            {words}
          </View>
        ) : (
          words
        )}
      </View>
    </GestureDetector>
  );
}

function createStyles(_colors: ThemeColors) {
  return {
    root: { position: 'absolute' as const, overflow: 'hidden' as const },
    row: { flexDirection: 'row' as const },
    item: { alignItems: 'center' as const, justifyContent: 'center' as const },
    // Mimo's slightly condensed caps.
    word: { fontFamily: fonts.semibold, fontSize: 12.5, letterSpacing: -0.2, color: onVideo.ink, ...textShadow },
    dim: { opacity: 0.45 },
    pressed: { opacity: 0.6 },
  };
}
