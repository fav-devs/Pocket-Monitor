import { Minus, Plus, X } from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, View } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { MText, colors, radius, withAlpha } from '@/theme';
import { GlassSurface } from '@/ui';
import { isDigitalZoom, zoomCaption, zoomLabel } from '../format';
import { haptics } from '../haptics';
import { ZOOM_RAMP_CHOICES, rampLabel, useZoomPresets } from '../liveUiStore';
import { cancelZoomRamp, rampZoom, unitToZoom, zoomToUnit } from './zoom';

/** `MonitorZoomRulerChrome`: drag along the log-scale ruler for continuous zoom. */
function ZoomRuler() {
  const session = useCameraSession();
  const zoom = useCamera((s) => s.zoom);
  const [width, setWidth] = useState(240);
  const widthRef = useRef(width);
  widthRef.current = width;
  const lastSend = useRef(0);
  const opticalU = zoomToUnit(zoom, Math.min(zoom.max, Math.max(zoom.min, zoom.opticalMax)));
  const u = zoomToUnit(zoom, zoom.factor);

  const send = (x: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastSend.current < 50) return;
    lastSend.current = now;
    const z = session.getState().zoom;
    cancelZoomRamp();
    session.control.setZoom(Math.round(unitToZoom(z, x / Math.max(1, widthRef.current)) * 10) / 10).catch(() => {});
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => send(e.nativeEvent.locationX, true),
        onPanResponderMove: (e) => send(e.nativeEvent.locationX),
        onPanResponderRelease: (e) => send(e.nativeEvent.locationX, true),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <View
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel="Continuous zoom"
      accessibilityValue={{ text: zoomLabel(zoom.factor) }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height: 44, justifyContent: 'center' }}
    >
      <View style={{ height: 4, borderRadius: 2, backgroundColor: withAlpha('#FFFFFF', 0.16), overflow: 'hidden' }}>
        <View
          style={{
            position: 'absolute',
            left: opticalU * width,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: withAlpha(colors.digitalCrop, 0.35),
          }}
        />
        <View style={{ width: u * width, height: 4, backgroundColor: colors.accent }} />
      </View>
      {zoom.stops.map((s) => {
        const x = zoomToUnit(zoom, s) * width;
        return (
          <View key={s} pointerEvents="none" style={{ position: 'absolute', left: x - 12, width: 24, top: 0, alignItems: 'center' }}>
            <View style={{ width: 1.5, height: 10, backgroundColor: colors.secondary }} />
            <MText size={9} mono color={colors.muted} style={{ marginTop: 18 }}>
              {s}
            </MText>
          </View>
        );
      })}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: u * width - 9,
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: '#FFFFFF',
          borderWidth: 2,
          borderColor: colors.accent,
        }}
      />
    </View>
  );
}

/**
 * Continuous zoom dial with the preset strip (`MonitorZoomDial`, `MonitorZoomPresetStrip`):
 * tap a preset to go (over the ramp time), hold to save the current zoom there.
 */
export function MonitorZoomDial({ width, onClose }: { width: number; onClose: () => void }) {
  const session = useCameraSession();
  const zoom = useCamera((s) => s.zoom);
  const { slots, rampSeconds, save, setRamp } = useZoomPresets();
  const caption = zoomCaption(zoom.factor, zoom.opticalMax, zoom.stops);
  const digital = isDigitalZoom(zoom.factor, zoom.opticalMax);
  const rampIndex = ZOOM_RAMP_CHOICES.indexOf(rampSeconds);

  return (
    <GlassSurface strong radius={radius.lg} style={{ width, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <MText size={10} weight="bold" tracking={1.4} color={digital ? colors.digitalCrop : colors.faint}>
            {caption}
          </MText>
          <MText size={22} weight="semibold" mono color={digital ? colors.digitalCrop : colors.text}>
            {zoomLabel(zoom.factor)}
          </MText>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Close zoom" onPress={onClose} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -10 }}>
          <X size={18} color={colors.secondary} />
        </Pressable>
      </View>
      <ZoomRuler />
      <View style={{ height: 14 }} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
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
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 44,
                borderRadius: radius.md,
                borderWidth: 1,
                borderStyle: slot == null ? 'dashed' : 'solid',
                borderColor: slot == null ? colors.borderStrong : colors.border,
                backgroundColor: slot != null ? withAlpha('#FFFFFF', 0.07) : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.72 : slot != null && !usable ? 0.4 : 1,
              })}
            >
              <MText size={13} weight="semibold" mono color={slot != null ? colors.text : colors.faint}>
                {slot != null ? zoomLabel(slot) : `P${i + 1}`}
              </MText>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
        <MText size={10} weight="bold" tracking={1.4} color={colors.faint} style={{ flex: 1 }}>
          PRESET RAMP
        </MText>
        <Pressable
          accessibilityLabel="Shorter ramp"
          disabled={rampIndex <= 0}
          onPress={() => setRamp(ZOOM_RAMP_CHOICES[Math.max(0, rampIndex - 1)])}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: rampIndex <= 0 ? 0.35 : 1 }}
        >
          <Minus size={16} color={colors.secondary} />
        </Pressable>
        <MText size={13} weight="semibold" mono style={{ minWidth: 44, textAlign: 'center' }}>
          {rampLabel(rampSeconds)}
        </MText>
        <Pressable
          accessibilityLabel="Longer ramp"
          disabled={rampIndex >= ZOOM_RAMP_CHOICES.length - 1}
          onPress={() => setRamp(ZOOM_RAMP_CHOICES[Math.min(ZOOM_RAMP_CHOICES.length - 1, rampIndex + 1)])}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Plus size={16} color={colors.secondary} />
        </Pressable>
      </View>
    </GlassSurface>
  );
}
