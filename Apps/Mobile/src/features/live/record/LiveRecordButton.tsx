import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useCamera } from '@/camera';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { isPhotoMode } from '../format';
import { onVideo, textShadow, withAlphaHex } from '../chrome/primitives';

const SIZE = 84;
const CORE = SIZE - 20;
const CORE_RECORDING = 30;
const RING_IDLE = 'rgba(255,255,255,0.85)';

/**
 * ai-cut's record button: an 84pt ring (6pt white) around a dotPink core. Recording, the ring
 * grows to 1.15 and turns pink, the core becomes a 30pt rounded square. Stills: a white core.
 */
export function MonitorRecordLamp({ recording, photo }: { recording: boolean; photo: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const t = useSharedValue(recording ? 1 : 0);
  useEffect(() => {
    t.value = withTiming(recording ? 1 : 0, { duration: 220 });
  }, [recording, t]);
  const ringRecording = withAlphaHex(colors.dotPink, 0.45);
  const ring = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.15 * t.value }],
    borderColor: interpolateColor(t.value, [0, 1], [RING_IDLE, ringRecording]),
  }));
  const core = useAnimatedStyle(() => {
    const side = CORE + (CORE_RECORDING - CORE) * t.value;
    return { width: side, height: side, borderRadius: CORE / 2 + (8 - CORE / 2) * t.value };
  });
  return (
    <View style={styles.box}>
      <Animated.View style={[styles.ring, ring]} />
      <Animated.View style={[styles.core, photo && !recording && styles.corePhoto, core]} />
    </View>
  );
}

/**
 * `LiveRecordButton` / `MonitorCaptureButton`: tap records (or takes a still in a photo mode),
 * hold opens the shooting-mode sheet. The lock and a pending countdown keep it inert.
 */
export function LiveRecordButton({ onPress, onHold, disabled }: { onPress: () => void; onHold?: () => void; disabled?: boolean }) {
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
        opacity: disabled || !live ? 0.4 : 1,
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      <MonitorRecordLamp recording={recording} photo={photo} />
    </Pressable>
  );
}

/** Big 3-2-1 over the picture while a countdown start is pending (ai-cut's 120pt countdown). */
export function RecordCountdownOverlay() {
  const styles = useThemedStyles(createStyles);
  const n = useCamera((s) => s.recording.countdown);
  if (n == null) return null;
  return (
    <View pointerEvents="none" style={styles.countdown}>
      <Text style={styles.countdownText} accessibilityLiveRegion="assertive">
        {n}
      </Text>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    box: { width: SIZE, height: SIZE, alignItems: 'center' as const, justifyContent: 'center' as const },
    ring: {
      position: 'absolute' as const,
      width: SIZE,
      height: SIZE,
      borderRadius: SIZE / 2,
      borderWidth: 6,
      borderColor: RING_IDLE,
    },
    core: { width: CORE, height: CORE, borderRadius: CORE / 2, backgroundColor: colors.dotPink },
    corePhoto: { backgroundColor: onVideo.ink },
    countdown: {
      position: 'absolute' as const,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    countdownText: { fontFamily: fonts.bold, fontSize: 120, color: onVideo.ink, fontVariant: ['tabular-nums' as const], ...textShadow },
  };
}
