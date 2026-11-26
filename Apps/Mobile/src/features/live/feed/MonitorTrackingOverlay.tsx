import { Text, View } from 'react-native';
import { useCamera } from '@/camera';
import { fonts, useTheme } from '@/constants/theme';
import { onVideo, withAlphaHex } from '../chrome/primitives';
import type { Rect } from '../layout/fieldMonitorLayout';

/** Corner-bracket box (`MonitorTrackingOverlay` / face box style). */
function Brackets({ w, h, color, len = 14 }: { w: number; h: number; color: string; len?: number }) {
  const l = Math.min(len, w / 2, h / 2);
  const t = 2;
  const corner = (style: object) => <View style={[{ position: 'absolute', width: l, height: l, borderColor: color }, style]} />;
  return (
    <>
      {corner({ left: 0, top: 0, borderLeftWidth: t, borderTopWidth: t, borderTopLeftRadius: 6 })}
      {corner({ right: 0, top: 0, borderRightWidth: t, borderTopWidth: t, borderTopRightRadius: 6 })}
      {corner({ left: 0, bottom: 0, borderLeftWidth: t, borderBottomWidth: t, borderBottomLeftRadius: 6 })}
      {corner({ right: 0, bottom: 0, borderRightWidth: t, borderBottomWidth: t, borderBottomRightRadius: 6 })}
    </>
  );
}

/**
 * Tracking box (ActiveTrack) and the tap-focus box, in picture coordinates. Searching is
 * dashed, tracking is accent brackets with the subject label, lost is amber.
 */
export function MonitorTrackingOverlay({ picture }: { picture: Rect }) {
  const { colors } = useTheme();
  const tracking = useCamera((s) => s.tracking);
  const focus = useCamera((s) => s.focus);
  const box = tracking.status !== 'idle' ? tracking.box : undefined;
  const side = Math.min(picture.width, picture.height) * 0.14;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: picture.x, top: picture.y, width: picture.width, height: picture.height, overflow: 'hidden' }}
    >
      {!box && focus.hasPoint ? (
        <View
          accessible
          accessibilityLabel="Focus point"
          style={{
            position: 'absolute',
            left: focus.x * picture.width - side / 2,
            top: focus.y * picture.height - side / 2,
            width: side,
            height: side,
            borderWidth: 1.5,
            borderRadius: 4,
            borderColor: colors.accent,
          }}
        />
      ) : null}
      {box ? (
        <View
          accessible
          accessibilityLabel={tracking.status === 'tracking' ? `Tracking ${tracking.label ?? 'subject'}` : tracking.status === 'lost' ? 'Subject lost' : 'Finding subject'}
          style={{
            position: 'absolute',
            left: box.x * picture.width,
            top: box.y * picture.height,
            width: box.width * picture.width,
            height: box.height * picture.height,
            borderWidth: tracking.status === 'searching' ? 1.5 : 0,
            borderStyle: 'dashed',
            borderColor: onVideo.ink,
            backgroundColor: tracking.status === 'tracking' ? withAlphaHex(colors.accent, 0.06) : 'transparent',
          }}
        >
          {tracking.status !== 'searching' ? (
            <Brackets
              w={box.width * picture.width}
              h={box.height * picture.height}
              color={tracking.status === 'lost' ? colors.warning : colors.accent}
            />
          ) : null}
          {tracking.status === 'tracking' && tracking.label ? (
            <View style={{ position: 'absolute', left: 0, top: -24, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.accent }}>
              <Text style={{ fontFamily: fonts.semibold, fontSize: 11, color: onVideo.dark }}>{tracking.label}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
