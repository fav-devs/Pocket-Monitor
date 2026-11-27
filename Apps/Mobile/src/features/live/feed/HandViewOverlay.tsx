/**
 * The hand view (`Y`, desktop): what the hand tracker sees, over the picture. Each hand's 21
 * landmarks and skeleton (the stick hand green, the zoom hand blue), its box with its pose,
 * the pinch being held (where it began, where it is), the hold bar, and the faces found.
 * Drawn from `vision://hands` (≤ 15 Hz) with react-native-svg; never takes a touch.
 */
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { useDesktopGestures } from '@/camera/desktop/gestures';
import { useDesktopInput } from '@/camera/desktop/input';
import { fonts } from '@/constants/theme';
import { useAssists } from '@/state/assists';
import { onVideo } from '../chrome/primitives';
import type { Rect as PictureRect } from '../layout/fieldMonitorLayout';
import { overlayShapes, overlayStatus } from './handOverlayGeometry';

const ROLE = { stick: '#40ff80', zoom: '#5aaaff' } as const;
const TIP = '#ffc400';
const FACE = '#fedb2e';

const shadow = { textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 } as const;

export function HandViewOverlay({ picture }: { picture: PictureRect }) {
  const on = useDesktopGestures((s) => s.handView);
  const overlay = useDesktopGestures((s) => s.overlay);
  const gesturesOn = useDesktopGestures((s) => !!s.settings?.gestures);
  const mirrorOn = useAssists((s) => s.on.MIRROR);
  const mirrorOptions = useAssists((s) => s.options.mirror);
  const mirror = useMemo(
    () => ({ horizontal: mirrorOn && mirrorOptions.horizontal, vertical: mirrorOn && mirrorOptions.vertical }),
    [mirrorOn, mirrorOptions.horizontal, mirrorOptions.vertical],
  );
  const size = { width: picture.width, height: picture.height };
  const shapes = useMemo(() => overlayShapes(overlay, size, mirror), [overlay, size.width, size.height, mirror]);
  if (!on) return null;
  return (
    <View
      pointerEvents="none"
      testID="monitor.handView"
      style={{ position: 'absolute', left: picture.x, top: picture.y, width: picture.width, height: picture.height, overflow: 'hidden' }}
    >
      <Svg width={picture.width} height={picture.height}>
        {shapes.faces.map((f, i) => (
          <Rect key={`f${i}`} x={f.x} y={f.y} width={f.width} height={f.height} rx={6} stroke={FACE} strokeWidth={2} fill="none" />
        ))}
        {shapes.hands.map((hand, h) => {
          const color = ROLE[hand.role];
          return (
            <Rect
              key={`b${h}`}
              x={hand.box.x}
              y={hand.box.y}
              width={hand.box.width}
              height={hand.box.height}
              rx={8}
              stroke={color}
              strokeOpacity={0.45}
              strokeWidth={1.5}
              fill="none"
            />
          );
        })}
        {shapes.hands.flatMap((hand, h) =>
          hand.bones.map(([a, b], i) => (
            <Line key={`l${h}-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ROLE[hand.role]} strokeWidth={3} strokeLinecap="round" />
          )),
        )}
        {shapes.hands.flatMap((hand, h) =>
          hand.joints.map((p, i) => <Circle key={`j${h}-${i}`} cx={p.x} cy={p.y} r={p.tip ? 5 : 3} fill={p.tip ? TIP : '#ffffff'} />),
        )}
        {shapes.grabs.map((grab, i) => {
          const color = ROLE[grab.role];
          return [
            <Line key={`gl${i}`} x1={grab.anchor.x} y1={grab.anchor.y} x2={grab.point.x} y2={grab.point.y} stroke={color} strokeWidth={3} strokeDasharray="6 5" />,
            <Circle key={`ga${i}`} cx={grab.anchor.x} cy={grab.anchor.y} r={32} stroke={color} strokeWidth={4} fill="none" />,
            <Circle key={`gp${i}`} cx={grab.point.x} cy={grab.point.y} r={9} fill={color} />,
          ];
        })}
      </Svg>
      {shapes.hands.map((hand, h) => (
        <View key={`t${h}`} style={{ position: 'absolute', left: hand.box.x, top: Math.max(36, hand.box.y - 40) }}>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: onVideo.ink, ...shadow }}>{hand.label}</Text>
          <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: onVideo.inkMuted, fontVariant: ['tabular-nums'], ...shadow }}>
            {hand.detail}
          </Text>
          {hand.holding ? (
            <View style={{ marginTop: 4, height: 4, width: 120, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' }}>
              <View style={{ height: 4, width: 120 * shapes.hold, backgroundColor: shapes.hold >= 1 ? TIP : ROLE[hand.role] }} />
            </View>
          ) : null}
        </View>
      ))}
      {shapes.grabs.map((grab, i) => (
        <Text
          key={`gt${i}`}
          style={{ position: 'absolute', left: grab.anchor.x - 24, top: grab.anchor.y + 40, fontFamily: fonts.semibold, fontSize: 11, color: onVideo.ink, ...shadow }}
        >
          {grab.role === 'stick' ? 'Stick' : 'Zoom'}
        </Text>
      ))}
      <View style={{ position: 'absolute', left: 12, top: 12, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: onVideo.pill }}>
        <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: onVideo.ink }}>{overlayStatus(overlay, gesturesOn)}</Text>
      </View>
    </View>
  );
}

/** Where the record gesture's hold shows: low over the picture, centred. Desktop only. */
export function DesktopGestureHold({ picture }: { picture: PictureRect }) {
  const hold = useDesktopInput((s) => s.input?.gestureHold ?? null);
  if (!hold) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: picture.x, width: picture.width, top: picture.y + picture.height * 0.7 }}>
      <GestureHoldPill text={hold.text} fraction={hold.fraction} />
    </View>
  );
}

/** The record gesture's hold, filling: `HOLD TO START RECORDING` with a bar. */
export function GestureHoldPill({ text, fraction }: { text: string; fraction: number }) {
  const label = text.charAt(0) + text.slice(1).toLowerCase();
  return (
    <View
      pointerEvents="none"
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
      style={{
        alignSelf: 'center',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 12,
        backgroundColor: onVideo.notice,
      }}
    >
      <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: onVideo.ink }}>{label}</Text>
      <View style={{ height: 4, width: 160, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' }}>
        <View style={{ height: 4, width: 160 * Math.min(1, Math.max(0, fraction)), backgroundColor: '#e5273a' }} />
      </View>
    </View>
  );
}
