import { useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useCamera, useCameraSession } from '@/camera';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { FieldLabel, StepperRow } from '../capture/controls';
import { isDigitalZoom, zoomCaption, zoomLabel } from '../format';
import { haptics } from '../haptics';
import { ZOOM_RAMP_CHOICES, rampLabel, useZoomPresets } from '../liveUiStore';
import { cancelZoomRamp, rampZoom, unitToZoom, zoomToUnit } from './zoom';

const THUMB = 22;

/** `MonitorZoomRulerChrome`: drag along the log-scale ruler for continuous zoom. */
function ZoomRuler() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const session = useCameraSession();
  const zoom = useCamera((s) => s.zoom);
  const [width, setWidth] = useState(240);
  const widthRef = useRef(width);
  widthRef.current = width;
  const lastSend = useRef(0);
  const opticalU = zoomToUnit(zoom, Math.min(zoom.max, Math.max(zoom.min, zoom.opticalMax)));
  const u = zoomToUnit(zoom, zoom.factor);

  const pan = useMemo(() => {
    const send = (x: number, force = false) => {
      const now = Date.now();
      if (!force && now - lastSend.current < 50) return;
      lastSend.current = now;
      const z = session.getState().zoom;
      cancelZoomRamp();
      const unit = Math.min(1, Math.max(0, x / Math.max(1, widthRef.current)));
      session.control.setZoom(Math.round(unitToZoom(z, unit) * 10) / 10).catch(() => {});
    };
    return Gesture.Pan()
      .runOnJS(true)
      .minDistance(0)
      .onBegin((e) => send(e.x, true))
      .onUpdate((e) => send(e.x))
      .onEnd((e) => send(e.x, true));
  }, [session]);

  return (
    <GestureDetector gesture={pan}>
      <View
        collapsable={false}
        accessibilityRole="adjustable"
        accessibilityLabel="Continuous zoom"
        accessibilityValue={{ text: zoomLabel(zoom.factor) }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={styles.ruler}
      >
        <View style={styles.track}>
          <View style={[styles.digital, { left: opticalU * width, backgroundColor: colors.warning }]} />
          <View style={[styles.fill, { width: u * width }]} />
        </View>
        {zoom.stops.map((s) => {
          const x = zoomToUnit(zoom, s) * width;
          return (
            <View key={s} pointerEvents="none" style={[styles.stop, { left: x - 14 }]}>
              <View style={styles.stopTick} />
              <Text style={styles.stopLabel}>{s}×</Text>
            </View>
          );
        })}
        <View pointerEvents="none" style={[styles.thumb, { left: u * width - THUMB / 2 }]} />
      </View>
    </GestureDetector>
  );
}

/**
 * Continuous zoom with the preset strip (`MonitorZoomDial`, `MonitorZoomPresetStrip`): tap a
 * preset to go (over the ramp time), hold to save the current zoom there. Shown in a Sheet.
 */
export function MonitorZoomDial() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const session = useCameraSession();
  const zoom = useCamera((s) => s.zoom);
  const { slots, rampSeconds, save, setRamp } = useZoomPresets();
  const caption = zoomCaption(zoom.factor, zoom.opticalMax, zoom.stops);
  const digital = isDigitalZoom(zoom.factor, zoom.opticalMax);
  const rampIndex = ZOOM_RAMP_CHOICES.indexOf(rampSeconds);

  return (
    <View style={styles.stack}>
      <View style={styles.readout}>
        <Text style={[styles.value, digital && { color: colors.warning }]}>{zoomLabel(zoom.factor)}</Text>
        <Text style={[styles.caption, digital && { color: colors.warning }]}>{caption}</Text>
      </View>
      <ZoomRuler />
      <View style={styles.group}>
        <FieldLabel>Presets · hold to save</FieldLabel>
        <View style={styles.presets}>
          {slots.map((slot, i) => {
            const usable = slot != null && slot <= zoom.max + 0.05;
            return (
              <Pressable
                key={i}
                accessibilityRole="button"
                accessibilityLabel={slot != null ? `Zoom preset ${i + 1}, ${zoomLabel(slot)}` : `Empty zoom preset ${i + 1}`}
                accessibilityHint="Hold to save the current zoom here"
                onPress={() => {
                  if (!usable || slot == null) return;
                  haptics.selection();
                  rampZoom(session, Math.min(slot, zoom.max), rampSeconds);
                }}
                onLongPress={() => {
                  haptics.medium();
                  save(i, session.getState().zoom.factor);
                }}
                delayLongPress={450}
                style={({ pressed }) => [
                  styles.preset,
                  slot == null && styles.presetEmpty,
                  slot != null && !usable && styles.faint,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.presetLabel, slot == null && styles.presetLabelEmpty]}>{slot != null ? zoomLabel(slot) : `P${i + 1}`}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <StepperRow
        title="Preset ramp"
        detail="Travel time to a preset"
        value={rampLabel(rampSeconds)}
        minusLabel="Shorter ramp"
        plusLabel="Longer ramp"
        minusDisabled={rampIndex <= 0}
        plusDisabled={rampIndex >= ZOOM_RAMP_CHOICES.length - 1}
        onMinus={() => setRamp(ZOOM_RAMP_CHOICES[Math.max(0, rampIndex - 1)])}
        onPlus={() => setRamp(ZOOM_RAMP_CHOICES[Math.min(ZOOM_RAMP_CHOICES.length - 1, rampIndex + 1)])}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    stack: { gap: spacing.md },
    group: { gap: spacing.sm },
    readout: { flexDirection: 'row' as const, alignItems: 'baseline' as const, gap: spacing.sm },
    value: { fontFamily: fonts.bold, fontSize: 28, color: colors.foreground, fontVariant: ['tabular-nums' as const] },
    caption: { fontFamily: fonts.semibold, fontSize: 11, letterSpacing: 1.2, color: colors.mutedForeground },
    ruler: { height: 52, justifyContent: 'flex-start' as const, paddingTop: 14, marginHorizontal: THUMB / 2 },
    track: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceStrong, overflow: 'hidden' as const },
    digital: { position: 'absolute' as const, right: 0, top: 0, bottom: 0, opacity: 0.35 },
    fill: { height: 6, borderRadius: 3, backgroundColor: colors.ink },
    stop: { position: 'absolute' as const, top: 24, width: 28, alignItems: 'center' as const },
    stopTick: { width: 1.5, height: 6, borderRadius: 1, backgroundColor: colors.borderStrong },
    stopLabel: { marginTop: 3, fontFamily: fonts.medium, fontSize: 11, color: colors.mutedForeground },
    thumb: {
      position: 'absolute' as const,
      top: 6,
      width: THUMB,
      height: THUMB,
      borderRadius: THUMB / 2,
      backgroundColor: colors.background,
      borderWidth: 2,
      borderColor: colors.ink,
    },
    presets: { flexDirection: 'row' as const, gap: spacing.sm },
    preset: {
      flex: 1,
      minHeight: 44,
      borderRadius: radius.md - 2,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: colors.surface,
    },
    presetEmpty: { backgroundColor: 'transparent', borderWidth: 1, borderStyle: 'dashed' as const, borderColor: colors.borderStrong },
    presetLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.foreground, fontVariant: ['tabular-nums' as const] },
    presetLabelEmpty: { color: colors.mutedForeground },
    faint: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
  };
}
