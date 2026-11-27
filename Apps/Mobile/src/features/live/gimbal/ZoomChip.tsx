import { useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useCamera, useCameraSession } from '@/camera';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { isDigitalZoom, zoomLabel } from '../format';
import { haptics } from '../haptics';
import { onVideo } from '../chrome/primitives';
import { useLiveUi } from '../liveUiStore';
import { cancelZoomRamp, nextStop, unitToZoom, zoomTapStops, zoomToUnit } from './zoom';

const DOUBLE_TAP_MS = 260;
/** Finger travel for the whole zoom range when dragging the chip (Mimo's vertical zoom slider). */
const DRAG_TRAVEL = 180;
/** Zoom writes while dragging, at most this often (the zoom pump cadence). */
const DRAG_WRITE_MS = 50;

/**
 * `ZoomChip`: tap cycles the camera's zoom stops; a double tap cycles the extended (long)
 * stops where the body has them; hold opens the continuous zoom dial and presets; drag up or
 * down zooms continuously (Mimo's vertical slider, shown while dragging). A translucent circle;
 * accent while the dial is open, amber text past optical.
 */
export function ZoomChip({ size, disabled, onOpenDial }: { size: number; disabled?: boolean; onOpenDial: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const dialOpen = useLiveUi((s) => s.zoomDialOpen);
  const session = useCameraSession();
  const zoom = useCamera((s) => s.zoom);
  const available = useCamera((s) => s.capabilities.zoom);
  const pendingTap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef({ start: 0, last: 0 });
  const { single, extended } = zoomTapStops(zoom);
  const digital = isDigitalZoom(zoom.factor, zoom.opticalMax);

  const cb = useRef({ onOpenDial, single, extended });
  cb.current = { onOpenDial, single, extended };

  const go = (stops: number[]) => {
    const z = session.getState().zoom;
    const target = nextStop(stops, z.factor);
    if (target == null) return;
    cancelZoomRamp();
    haptics.selection();
    session.control.setZoom(target).catch(() => {});
  };

  const onTap = () => {
    const { single: s1, extended: ext } = cb.current;
    if (ext.length === 0) {
      go(s1);
      return;
    }
    if (pendingTap.current) {
      clearTimeout(pendingTap.current);
      pendingTap.current = null;
      go(ext);
      return;
    }
    pendingTap.current = setTimeout(() => {
      pendingTap.current = null;
      go(cb.current.single);
    }, DOUBLE_TAP_MS);
  };

  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .runOnJS(true)
      .enabled(!disabled)
      .maxDuration(350)
      .onEnd((_e, ok) => {
        if (ok) onTap();
      });
    const hold = Gesture.LongPress()
      .runOnJS(true)
      .enabled(!disabled)
      .minDuration(380)
      .onStart(() => {
        haptics.medium();
        cb.current.onOpenDial();
      });
    const pan = Gesture.Pan()
      .runOnJS(true)
      .enabled(!disabled)
      .activeOffsetY([-8, 8])
      .failOffsetX([-24, 24])
      .onStart(() => {
        cancelZoomRamp();
        const z = session.getState().zoom;
        dragRef.current = { start: zoomToUnit(z, z.factor), last: 0 };
        haptics.light();
      })
      .onUpdate((e) => {
        const z = session.getState().zoom;
        const u = Math.min(1, Math.max(0, dragRef.current.start - e.translationY / DRAG_TRAVEL));
        setDrag(u);
        const now = Date.now();
        if (now - dragRef.current.last >= DRAG_WRITE_MS) {
          dragRef.current.last = now;
          session.control.setZoom(unitToZoom(z, u)).catch(() => {});
        }
      })
      .onEnd((e) => {
        const z = session.getState().zoom;
        const u = Math.min(1, Math.max(0, dragRef.current.start - e.translationY / DRAG_TRAVEL));
        session.control.setZoom(unitToZoom(z, u)).catch(() => {});
      })
      .onFinalize(() => setDrag(null));
    return Gesture.Race(pan, hold, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, session]);

  if (!available) return null;
  const shownFactor = drag != null ? unitToZoom(zoom, drag) : zoom.factor;
  return (
    <GestureDetector gesture={gesture}>
      <View
        testID="monitor.zoom.chip"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Zoom"
        accessibilityValue={{ text: zoomLabel(zoom.factor) }}
        accessibilityHint={
          extended.length
            ? `Tap cycles ${single.join(' and ')} times. Double tap cycles ${extended.join(' and ')} times. Drag up or down to zoom. Hold for presets and the dial.`
            : 'Tap cycles camera zoom stops. Drag up or down to zoom. Hold for presets and the dial.'
        }
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }, { name: 'longpress' }]}
        onAccessibilityAction={(e) => {
          const name = e.nativeEvent.actionName;
          if (name === 'activate') onTap();
          else if (name === 'longpress') onOpenDial();
          else {
            const z = session.getState().zoom;
            const u = Math.min(1, Math.max(0, zoomToUnit(z, z.factor) + (name === 'increment' ? 0.1 : -0.1)));
            session.control.setZoom(unitToZoom(z, u)).catch(() => {});
          }
        }}
        style={[
          styles.chip,
          { width: size, height: size, borderRadius: size / 2 },
          (dialOpen || drag != null) && { backgroundColor: colors.accent },
          disabled && styles.dim,
        ]}
      >
        <Text numberOfLines={1} style={[styles.label, { color: dialOpen || drag != null ? onVideo.dark : digital ? colors.warning : onVideo.ink }]}>
          {zoomLabel(shownFactor)}
        </Text>
        {drag != null ? (
          // The slider while dragging: a dotted track above the chip with the position marked.
          <View pointerEvents="none" style={[styles.track, { bottom: size + 8, left: size / 2 - 11 }]}>
            <View style={styles.trackLine} />
            <View style={[styles.trackEnd, { top: 0 }]} />
            <View style={[styles.trackEnd, { bottom: 0 }]} />
            <View style={[styles.knob, { top: (1 - drag) * (DRAG_TRAVEL * 0.6 - 22) }]} />
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

function createStyles(_colors: ThemeColors) {
  return {
    chip: { alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: 'rgba(0,0,0,0.32)' },
    label: { fontFamily: fonts.bold, fontSize: 13, fontVariant: ['tabular-nums' as const] },
    dim: { opacity: 0.4 },
    track: { position: 'absolute' as const, width: 22, height: DRAG_TRAVEL * 0.6, alignItems: 'center' as const },
    trackLine: { position: 'absolute' as const, top: 4, bottom: 4, width: 0, borderLeftWidth: 1.5, borderStyle: 'dotted' as const, borderColor: 'rgba(255,255,255,0.9)' },
    trackEnd: { position: 'absolute' as const, width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#ffffff' },
    knob: {
      position: 'absolute' as const,
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: '#ffffff',
      backgroundColor: 'rgba(0,0,0,0.25)',
    },
  };
}
