import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, View } from 'react-native';
import { useCamera } from '@/camera';
import { MText, colors, withAlpha } from '@/theme';
import { isPhotoMode } from '../format';

const useNative = Platform.OS !== 'web';
/** `MonitorMotion.recPulseDuration`. */
const PULSE_MS = 1400;

/** `MonitorRecordLamp`: red ring, a rounded-square core while recording, white for stills. */
export function MonitorRecordLamp({ diameter, recording, photo }: { diameter: number; recording: boolean; photo: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const core = useRef(new Animated.Value(recording ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(core, { toValue: recording ? 1 : 0, useNativeDriver: useNative, speed: 18, bounciness: 6 }).start();
  }, [recording, core]);

  useEffect(() => {
    if (!recording) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: PULSE_MS / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: useNative }),
        Animated.timing(pulse, { toValue: 0, duration: PULSE_MS / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: useNative }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [recording, pulse]);

  const coreSize = Math.round((diameter - 10) * 0.52);
  const ring = photo ? '#FFFFFF' : colors.recording;
  return (
    <View
      style={{
        width: diameter,
        height: diameter,
        borderRadius: diameter / 2,
        backgroundColor: 'rgba(17,18,19,0.82)',
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          position: 'absolute',
          left: 5,
          top: 5,
          right: 5,
          bottom: 5,
          borderRadius: diameter,
          borderWidth: 4.5,
          borderColor: ring,
        }}
      />
      {photo && !recording ? (
        <View style={{ position: 'absolute', left: 12, top: 12, right: 12, bottom: 12, borderRadius: diameter, backgroundColor: '#FFFFFF' }} />
      ) : null}
      <Animated.View
        style={{
          width: coreSize,
          height: coreSize,
          borderRadius: Math.round(coreSize * 0.24),
          backgroundColor: colors.recording,
          opacity: core,
          transform: [{ scale: core.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) }],
          shadowColor: colors.recording,
          shadowOpacity: 0.6,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 0 },
        }}
      />
      {recording ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: coreSize + 12,
            height: coreSize + 12,
            borderRadius: Math.round(coreSize * 0.3),
            backgroundColor: withAlpha(colors.recording, 0.35),
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0.1] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1.05, 0.9] }) }],
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * `LiveRecordButton` / `MonitorCaptureButton`: tap records (or takes a still in a photo mode),
 * hold opens the shooting-mode drawer. The lock and a pending countdown keep it inert.
 */
export function LiveRecordButton({
  diameter,
  onPress,
  onHold,
  disabled,
}: {
  diameter: number;
  onPress: () => void;
  onHold?: () => void;
  disabled?: boolean;
}) {
  const recording = useCamera((s) => s.recording.recording);
  const photo = useCamera((s) => isPhotoMode(s.format.shootingMode));
  const busy = useCamera((s) => s.recording.countdown != null || s.recording.capturingStill);
  const live = useCamera((s) => s.connection.phase === 'live');
  const interactive = !disabled && !busy && live;
  return (
    <Pressable
      testID={photo ? 'monitor.system.shutter' : 'monitor.system.record'}
      accessibilityRole="button"
      accessibilityLabel={photo ? 'Take photo' : recording ? 'Stop recording' : 'Start recording'}
      accessibilityState={{ disabled: !interactive }}
      accessibilityValue={{ text: recording ? 'Recording' : 'Standby' }}
      accessibilityHint={onHold ? 'Hold to choose the shooting mode' : undefined}
      onPress={interactive ? onPress : undefined}
      onLongPress={interactive ? onHold : undefined}
      delayLongPress={450}
      style={({ pressed }) => ({
        opacity: disabled || !live ? 0.4 : pressed ? 0.8 : 1,
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}
    >
      <MonitorRecordLamp diameter={diameter} recording={recording} photo={photo} />
    </Pressable>
  );
}

/** Big 3-2-1 over the picture while a countdown start is pending. */
export function RecordCountdownOverlay() {
  const n = useCamera((s) => s.recording.countdown);
  if (n == null) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: 120,
          height: 120,
          borderRadius: 60,
          backgroundColor: 'rgba(0,0,0,0.45)',
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 3,
          borderColor: colors.recording,
        }}
      >
        <MText size={64} weight="semibold" mono accessibilityLiveRegion="assertive">
          {n}
        </MText>
      </View>
    </View>
  );
}
