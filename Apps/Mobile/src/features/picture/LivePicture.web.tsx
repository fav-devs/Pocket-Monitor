import { useEffect, useRef, useState } from 'react';
import { Text, View, type LayoutChangeEvent, type LayoutRectangle } from 'react-native';
import { useCamera } from '@/camera';
import { fonts } from '@/constants/theme';
import { usePictureEffects } from '@/state/assists';
import { SAMPLE_INTERVAL_MS, clearFrameSample, hasSampleDemand, publishFrameSample, useLatest } from './frameSample';
import { getLut, useEnsureLut, useLutVersion } from './lutLibrary';
import { demoExposureGain, demoSceneFor, pictureAspect, pictureRect, sameRect, type LivePictureProps } from './LivePicture.shared';
import { WebPictureRenderer } from './web/WebPictureRenderer';

export type { LivePictureProps } from './LivePicture.shared';

/** Web picture: WebGL2 demo camera + the monitor effects shader. */
export default function LivePicture({ source, resizeMode = 'fit', onPictureRect, effects: override, context = 'live', demoScene }: LivePictureProps) {
  const derived = usePictureEffects(context);
  const effects = override ?? derived;
  const exposure = useCamera((s) => s.exposure);
  const streamW = useCamera((s) => s.connection.streamWidth);
  const streamH = useCamera((s) => s.connection.streamHeight);
  const scene = demoSceneFor(source, demoScene);
  useEnsureLut(effects.lutId);
  useLutVersion();
  const lut = getLut(effects.lutId);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [failure, setFailure] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastRect = useRef<LayoutRectangle | null>(null);
  const rect = pictureRect(size, pictureAspect(effects, streamW, streamH), resizeMode);

  useEffect(() => {
    if (size.width <= 0 || sameRect(lastRect.current, rect)) return;
    lastRect.current = rect;
    onPictureRect?.(rect);
  });

  const live = useLatest({ scene, effects, gain: demoExposureGain(exposure), lut, context });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: WebPictureRenderer;
    try {
      renderer = new WebPictureRenderer(canvas);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'WebGL2 unavailable');
      return;
    }
    let raf = 0;
    let lastSample = 0;
    const start = performance.now();
    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
      setFailure('The picture lost its GPU context.');
    };
    canvas.addEventListener('webglcontextlost', onLost);
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const s = live.current;
      try {
        renderer.render((now - start) / 1000, { scene: s.scene, effects: s.effects, gain: s.gain, dpr }, s.lut, w, h);
        const ready = renderer.pollSample();
        if (ready && s.scene) publishFrameSample({ ...ready, context: s.context });
        if (s.scene && now - lastSample >= SAMPLE_INTERVAL_MS && hasSampleDemand()) {
          lastSample = now;
          renderer.requestSample();
        }
      } catch (e) {
        cancelAnimationFrame(raf);
        setFailure(e instanceof Error ? e.message : 'Render failed');
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost', onLost);
      renderer.dispose();
      clearFrameSample(live.current.context);
    };
  }, [live]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000', overflow: 'hidden' }} onLayout={onLayout} pointerEvents="none">
      <canvas
        ref={canvasRef}
        data-testid="live-picture-canvas"
        style={{
          position: 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          display: size.width > 0 && scene ? 'block' : 'none',
        }}
      />
      {failure ? (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' }}>
          <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>{failure}</Text>
        </View>
      ) : null}
    </View>
  );
}
