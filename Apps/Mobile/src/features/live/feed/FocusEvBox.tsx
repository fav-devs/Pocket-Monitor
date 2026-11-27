import { useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Line } from 'react-native-svg';
import { useCamera, useCameraSession } from '@/camera';
import { fonts, useTheme } from '@/constants/theme';
import { nearestIndex } from '../capture/CaptureSheetHost';
import { textShadow } from '../chrome/primitives';
import { evLabel } from '../format';
import { haptics } from '../haptics';
import type { Rect } from '../layout/fieldMonitorLayout';

/** Finger travel per EV option while dragging the sun. */
const STEP = 12;
const SUN = 22;

function Sun({ color }: { color: string }) {
  const rays = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  const c = SUN / 2;
  return (
    <Svg width={SUN} height={SUN}>
      <Circle cx={c} cy={c} r={3.6} fill={color} />
      {rays.map((a, i) => (
        <Line
          key={i}
          x1={c + Math.cos(a) * 6}
          y1={c + Math.sin(a) * 6}
          x2={c + Math.cos(a) * 9.5}
          y2={c + Math.sin(a) * 9.5}
          stroke={color}
          strokeWidth={1.4}
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );
}

/**
 * Mimo's focus box with its EV sun beside it: the box marks the focus point (the picture's
 * centre until a tap sets one) and the sun is an exposure handle — drag it up or down to change
 * EV, one option per 12 pt, committed on release. In full manual the sun shows the camera's
 * metered offset instead and does not move EV. Replaces the old EV gauge on the left. Hidden
 * while a tracking box is up.
 */
export function FocusEvBox({ picture, enabled }: { picture: Rect; enabled: boolean }) {
  const { colors } = useTheme();
  const { control } = useCameraSession();
  const focus = useCamera((s) => s.focus);
  const tracking = useCamera((s) => s.tracking.status !== 'idle' && !!s.tracking.box);
  const e = useCamera((s) => s.exposure);
  const evApplies = e.mode !== 'manual' || e.isoAuto || e.shutterAuto;
  const [preview, setPreview] = useState<number | null>(null);
  const live = useRef({ e, start: 0, last: 0 });
  live.current.e = e;

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(enabled && evApplies)
        .minDistance(2)
        .onStart(() => {
          const ex = live.current.e;
          live.current.start = nearestIndex(ex.evOptions, ex.ev);
          live.current.last = live.current.start;
          haptics.light();
        })
        .onUpdate((ev) => {
          const opts = live.current.e.evOptions;
          const i = Math.min(opts.length - 1, Math.max(0, live.current.start - Math.round(ev.translationY / STEP)));
          if (i !== live.current.last) {
            live.current.last = i;
            haptics.selection();
          }
          setPreview(i);
        })
        .onEnd(() => {
          const opts = live.current.e.evOptions;
          const i = live.current.last;
          if (opts[i] != null && i !== nearestIndex(opts, live.current.e.ev)) control.setEv(opts[i]).catch(() => {});
        })
        .onFinalize(() => setPreview(null)),
    [enabled, evApplies, control],
  );

  if (tracking || picture.width < 1) return null;
  const side = Math.round(Math.min(picture.width, picture.height) * 0.17);
  const fx = (focus.hasPoint ? focus.x : 0.5) * picture.width;
  const fy = (focus.hasPoint ? focus.y : 0.5) * picture.height;
  const left = Math.min(Math.max(fx - side / 2, 4), picture.width - side - 4);
  const top = Math.min(Math.max(fy - side / 2, 4), picture.height - side - 4);
  // The sun sits right of the box (left of it near the trailing edge), raised for +EV.
  const value = preview != null ? e.evOptions[preview] : evApplies ? e.ev : (e.meteredEv ?? 0);
  const span = side * 0.9;
  const sunY = top + side / 2 - Math.max(-1, Math.min(1, value / 3)) * (span / 2);
  const onRight = left + side + 8 + 44 <= picture.width;
  const sunX = onRight ? left + side + 4 : left - 48;
  const color = colors.accent;
  const tick = 6;
  const showValue = preview != null || Math.abs(value) >= 0.05;

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: picture.x, top: picture.y, width: picture.width, height: picture.height, overflow: 'hidden' }}
    >
      <View
        pointerEvents="none"
        accessible
        accessibilityLabel="Focus point"
        style={{ position: 'absolute', left, top, width: side, height: side, borderWidth: 1, borderColor: color }}
      >
        {/* Mimo's mid-side ticks. */}
        <View style={{ position: 'absolute', left: side / 2 - 0.5, top: 0, width: 1, height: tick, backgroundColor: color }} />
        <View style={{ position: 'absolute', left: side / 2 - 0.5, bottom: 0, width: 1, height: tick, backgroundColor: color }} />
        <View style={{ position: 'absolute', top: side / 2 - 0.5, left: 0, height: 1, width: tick, backgroundColor: color }} />
        <View style={{ position: 'absolute', top: side / 2 - 0.5, right: 0, height: 1, width: tick, backgroundColor: color }} />
      </View>
      {preview != null ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: sunX + 21.5, top: top + side / 2 - span / 2 - 6, width: 1, height: span + 12, backgroundColor: color, opacity: 0.7 }} />
      ) : null}
      <GestureDetector gesture={pan}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={evApplies ? 'Exposure compensation' : 'Exposure meter'}
          accessibilityValue={{ text: `${evLabel(value)} stops` }}
          accessibilityActions={evApplies ? [{ name: 'increment' }, { name: 'decrement' }] : []}
          onAccessibilityAction={(a) => {
            const i = nearestIndex(e.evOptions, e.ev) + (a.nativeEvent.actionName === 'increment' ? 1 : -1);
            const v = e.evOptions[Math.min(e.evOptions.length - 1, Math.max(0, i))];
            if (v != null) control.setEv(v).catch(() => {});
          }}
          style={{ position: 'absolute', left: sunX, top: sunY - 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: evApplies ? 1 : 0.6 }}
        >
          <Sun color={color} />
        </View>
      </GestureDetector>
      {showValue ? (
        <Text
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: onRight ? sunX + 38 : sunX - 34,
            top: sunY - 9,
            fontFamily: fonts.semibold,
            fontSize: 12,
            color,
            fontVariant: ['tabular-nums'],
            ...textShadow,
          }}
        >
          {evLabel(value)}
        </Text>
      ) : null}
    </View>
  );
}
