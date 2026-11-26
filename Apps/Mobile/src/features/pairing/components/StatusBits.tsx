import { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { MText, colors } from '@/theme';

/** Four rising bars (`CameraSignalBars`). */
export function SignalBars({ count }: { count: number }) {
  return (
    <View
      accessible
      accessibilityLabel={`Signal ${count} of 4`}
      style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}
    >
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
          style={{
            width: 3,
            height: 5 + i * 3,
            borderRadius: 1,
            backgroundColor: i < count ? colors.accent : 'rgba(255,255,255,0.14)',
          }}
        />
      ))}
    </View>
  );
}

/** A dot that breathes while something is in progress (`monitorPulse`). */
export function PulseDot({ color = colors.accent, size = 6, period = 1200 }: { color?: string; size?: number; period?: number }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.3, duration: period / 2, useNativeDriver: false }),
        Animated.timing(v, { toValue: 1, duration: period / 2, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v, period]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: v }} />;
}

/** Accent dot + caps label (`CameraProgressLabel`). */
export function ProgressLabel({ title }: { title: string }) {
  return (
    <View accessible accessibilityLabel={title} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <PulseDot />
      <MText size={10} weight="semibold" color={colors.accent}>
        {title}
      </MText>
    </View>
  );
}

/** Small caps group title with a faint note (`PAIRED  tap to reconnect`). */
export function GroupTitle({ title, note }: { title: string; note?: string }) {
  return (
    <View accessibilityRole="header" style={{ flexDirection: 'row', alignItems: 'baseline', gap: 9 }}>
      <MText size={8.5} weight="bold" tracking={1.7} color={colors.faint} uppercase>
        {title}
      </MText>
      {note ? (
        <MText size={9} tracking={0.9} color={colors.faint}>
          {note}
        </MText>
      ) : null}
    </View>
  );
}

/** Connection progress as one bar that fills per step with a sweep (`CameraConnectProgress`). */
export function ConnectProgressBar({ fraction }: { fraction: number }) {
  const sweep = useRef(new Animated.Value(0)).current;
  const fill = useRef(new Animated.Value(fraction)).current;
  useEffect(() => {
    Animated.timing(fill, { toValue: fraction, duration: 450, useNativeDriver: false }).start();
  }, [fraction, fill]);
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 1400, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [sweep]);
  const width = fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const left = sweep.interpolate({ inputRange: [0, 1], outputRange: ['-30%', '100%'] });
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
      style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginVertical: 2 }}
    >
      <Animated.View style={{ height: 4, width, borderRadius: 2, backgroundColor: colors.accent, overflow: 'hidden' }}>
        <Animated.View
          style={{ position: 'absolute', top: 0, bottom: 0, width: '30%', left, backgroundColor: 'rgba(255,255,255,0.35)' }}
        />
      </Animated.View>
    </View>
  );
}
