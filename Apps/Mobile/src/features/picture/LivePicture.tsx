import { useEffect, useRef, useState } from 'react';
import { View, type LayoutChangeEvent, type LayoutRectangle } from 'react-native';
import { useCamera } from '@/camera';
import { usePictureAllowed } from '@/camera/server';
import { usePictureEffects } from '@/state/assists';
import { PocketVideoView } from '@modules/pocket-native/src/PocketVideoView';
import { PocketVideo } from '@modules/pocket-native/src/native';
import { SAMPLE_HEIGHT, SAMPLE_INTERVAL_MS, SAMPLE_WIDTH, clearFrameSample, publishFrameSample, useSampleDemandValue } from './frameSample';
import { useEnsureLut } from './lutLibrary';
import { demoSceneFor, pictureAspect, pictureRect, sameRect, type LivePictureProps } from './LivePicture.shared';

export type { LivePictureProps } from './LivePicture.shared';

/**
 * Native picture: the decoder view with GPU effects (`PocketVideoView`). The native view owns
 * fit / fill and desqueeze; this reports the same rect for overlays and polls a small RGBA
 * sample for the JS meters while any scope or meter is shown.
 */
export default function LivePicture({ source, resizeMode = 'fit', onPictureRect, effects: override, context = 'live', demoScene, publishSamples = true }: LivePictureProps) {
  const derived = usePictureEffects(context);
  const effects = override ?? derived;
  const streamW = useCamera((s) => s.connection.streamWidth);
  const streamH = useCamera((s) => s.connection.streamHeight);
  useEnsureLut(effects.lutId);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const lastRect = useRef<LayoutRectangle | null>(null);
  const rect = pictureRect(size, pictureAspect(effects, streamW, streamH), resizeMode);
  const sessionId = source.kind === 'native' || source.kind === 'relay' ? source.sessionId : null;
  const scene = demoSceneFor(source, demoScene);
  // Android server mode with the app in the background: no picture view, so nothing decodes for
  // display with the screen off (the relay host does its own work natively).
  const allowed = usePictureAllowed();
  const wantsSample = useSampleDemandValue() && publishSamples && allowed;

  useEffect(() => {
    if (size.width <= 0 || sameRect(lastRect.current, rect)) return;
    lastRect.current = rect;
    onPictureRect?.(rect);
  });

  useEffect(() => {
    if (!wantsSample || !sessionId || !PocketVideo) return;
    let alive = true;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await PocketVideo!.sampleFrame(sessionId, SAMPLE_WIDTH, SAMPLE_HEIGHT);
        if (alive && s) publishFrameSample({ width: s.width, height: s.height, rgba: s.rgba, context });
      } catch {
        // Decoder not ready yet.
      } finally {
        busy = false;
      }
    }, SAMPLE_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      clearFrameSample(context);
    };
  }, [wantsSample, sessionId, context]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000', overflow: 'hidden' }} onLayout={onLayout} pointerEvents="none">
      {source.kind !== 'none' && allowed ? (
        <PocketVideoView
          style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
          sessionId={sessionId}
          demoScene={scene}
          effects={effects}
          resizeMode={resizeMode}
        />
      ) : null}
    </View>
  );
}
