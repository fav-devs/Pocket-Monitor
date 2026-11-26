import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { useTheme } from '@/constants/theme';
import {
  DOUBLE_TAP_WINDOW_MS,
  KNOB_FRACTION,
  TapSequence,
  applyStickMapping,
  mapTouch,
  postDrive,
  releaseDrive,
  type StickMapping,
} from '@/features/input';
import { haptics } from '../haptics';
import { useLiveUi } from '../liveUiStore';
import { onVideo } from '../chrome/primitives';

/**
 * `LiveGimbalStick`: on-feed analog stick. Streams drive at ~30 Hz while held (via the shared
 * pump), rests on lift. Double-tap levels / recenters; triple-tap flips. Translucent well with
 * a white rim and knob; held, both turn accent.
 */
export function LiveGimbalStick({
  size,
  enabled,
  getMapping,
  onDoubleTap,
  onTripleTap,
}: {
  size: number;
  enabled: boolean;
  getMapping: () => StickMapping;
  onDoubleTap: () => void;
  onTripleTap: () => void;
}) {
  const { colors } = useTheme();
  const knob = size * KNOB_FRACTION;
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [contact, setContact] = useState(false);
  const engaged = useRef(false);
  const taps = useRef(new TapSequence());
  const pendingDouble = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setUi = useLiveUi((s) => s.set);
  const cb = useRef({ getMapping, onDoubleTap, onTripleTap, enabled });
  cb.current = { getMapping, onDoubleTap, onTripleTap, enabled };

  const cancelTaps = () => {
    if (pendingDouble.current) clearTimeout(pendingDouble.current);
    pendingDouble.current = null;
    taps.current.reset();
  };

  const release = () => {
    engaged.current = false;
    setOffset({ x: 0, y: 0 });
    setContact(false);
    setUi({ stickHeld: false });
    releaseDrive('screen');
  };

  useEffect(() => {
    if (!enabled) {
      cancelTaps();
      release();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(
    () => () => {
      cancelTaps();
      releaseDrive('screen');
    },
    [],
  );

  const handleTap = () => {
    const r = taps.current.tap(Date.now());
    if (r === 'second') {
      if (pendingDouble.current) clearTimeout(pendingDouble.current);
      pendingDouble.current = setTimeout(() => {
        pendingDouble.current = null;
        if (taps.current.commitDouble()) {
          haptics.medium();
          cb.current.onDoubleTap();
        }
      }, DOUBLE_TAP_WINDOW_MS);
    } else if (r === 'third') {
      if (pendingDouble.current) clearTimeout(pendingDouble.current);
      pendingDouble.current = null;
      haptics.heavy();
      cb.current.onTripleTap();
    }
  };

  const pan = usePanGesture({
    minDistance: 0,
    runOnJS: true,
    enabled,
    onBegin: () => {
      if (!cb.current.enabled) return;
      setContact(true);
      haptics.light();
    },
    onUpdate: (e) => {
      if (!cb.current.enabled) return;
      const m = mapTouch(e.translationX, e.translationY, size, knob, engaged.current);
      if (!m.engaged) return;
      if (!engaged.current) {
        cancelTaps();
        engaged.current = true;
        setUi({ stickHeld: true });
      }
      setOffset({ x: m.visualX, y: m.visualY });
      const v = applyStickMapping(m.commandX, m.commandY, cb.current.getMapping());
      postDrive('screen', v.x, v.y, true);
    },
    onFinalize: (e) => {
      if (engaged.current) {
        cancelTaps();
        release();
        return;
      }
      setContact(false);
      setOffset({ x: 0, y: 0 });
      if (!e.canceled && cb.current.enabled) handleTap();
    },
  });

  const ink = contact ? colors.accent : onVideo.ink;
  return (
    <GestureDetector gesture={pan}>
      <View
        testID="monitor.system.gimbal"
        accessible
        accessibilityLabel="Gimbal stick"
        accessibilityHint="Drag to move the gimbal. Double-tap to level. Triple-tap to flip."
        style={{ width: size, height: size, opacity: enabled ? 1 : 0.4 }}
      >
        <View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1.5,
            borderColor: contact ? colors.accent : 'rgba(255,255,255,0.7)',
            backgroundColor: onVideo.rail,
          }}
        />
        {/* Cardinal ticks: where the stick's travel ends. */}
        {[0, 90, 180, 270].map((deg) => (
          <View
            key={deg}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: size / 2 - 1,
              top: 6,
              width: 2,
              height: 6,
              borderRadius: 1,
              backgroundColor: 'rgba(255,255,255,0.45)',
              transform: [{ translateY: size / 2 - 9 }, { rotate: `${deg}deg` }, { translateY: -(size / 2 - 9) }],
            }}
          />
        ))}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: (size - knob) / 2 + offset.x,
            top: (size - knob) / 2 + offset.y,
            width: knob,
            height: knob,
            borderRadius: knob / 2,
            backgroundColor: ink,
            opacity: contact ? 1 : 0.9,
            shadowColor: '#000',
            shadowOpacity: 0.35,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
          }}
        />
      </View>
    </GestureDetector>
  );
}
