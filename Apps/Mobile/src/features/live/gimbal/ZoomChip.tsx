import { useRef } from 'react';
import { Pressable } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { MText, colors } from '@/theme';
import { isDigitalZoom, zoomLabel } from '../format';
import { haptics } from '../haptics';
import { readoutShadow } from '../chrome/primitives';
import { cancelZoomRamp, nextStop, zoomTapStops } from './zoom';

const DOUBLE_TAP_MS = 260;

/**
 * `ZoomChip`: tap cycles the camera's zoom stops; a double tap cycles the extended (long)
 * stops where the body has them; hold opens the continuous zoom dial. Amber past optical.
 */
export function ZoomChip({ size, disabled, onOpenDial }: { size: number; disabled?: boolean; onOpenDial: () => void }) {
  const session = useCameraSession();
  const zoom = useCamera((s) => s.zoom);
  const available = useCamera((s) => s.capabilities.zoom);
  const pendingTap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { single, extended } = zoomTapStops(zoom);
  const digital = isDigitalZoom(zoom.factor, zoom.opticalMax);

  const go = (stops: number[]) => {
    const z = session.getState().zoom;
    const target = nextStop(stops, z.factor);
    if (target == null) return;
    cancelZoomRamp();
    haptics.selection();
    session.control.setZoom(target).catch(() => {});
  };

  const onPress = () => {
    if (extended.length === 0) {
      go(single);
      return;
    }
    if (pendingTap.current) {
      clearTimeout(pendingTap.current);
      pendingTap.current = null;
      go(extended);
      return;
    }
    pendingTap.current = setTimeout(() => {
      pendingTap.current = null;
      go(single);
    }, DOUBLE_TAP_MS);
  };

  if (!available) return null;
  return (
    <Pressable
      testID="monitor.zoom.chip"
      accessibilityRole="button"
      accessibilityLabel="Zoom"
      accessibilityValue={{ text: zoomLabel(zoom.factor) }}
      accessibilityHint={
        extended.length
          ? `Tap cycles ${single.join(' and ')} times. Double tap cycles ${extended.join(' and ')} times. Hold opens the continuous zoom dial.`
          : 'Tap cycles camera zoom stops. Hold opens the continuous zoom dial.'
      }
      disabled={disabled}
      onPress={onPress}
      onLongPress={() => {
        haptics.medium();
        onOpenDial();
      }}
      delayLongPress={380}
      style={({ pressed }) => ({
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.72 : 1,
      })}
    >
      <MText size={18} weight="bold" mono color={digital ? colors.digitalCrop : colors.text} style={readoutShadow} numberOfLines={1}>
        {zoomLabel(zoom.factor)}
      </MText>
    </Pressable>
  );
}
