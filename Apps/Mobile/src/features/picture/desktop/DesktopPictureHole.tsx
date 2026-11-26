import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { View, type LayoutChangeEvent, type LayoutRectangle } from 'react-native';
import { useCamera } from '@/camera';
import { invoke, listen } from '@/camera/desktop/tauri';
import { useAssists, usePictureEffects } from '@/state/assists';
import { pictureAspect, pictureRect, sameRect, type LivePictureProps } from '../LivePicture.shared';
import { punchThrough, type DesktopFit } from './hole';
import { ensureDesktopLut, useDesktopAutoLut, useDesktopSplit } from './luts';

/**
 * The live picture inside the desktop app. The picture itself is Vulkan, presented by the Rust
 * backend on a native surface *under* this web view; this view paints nothing and makes its
 * ancestors transparent so that surface shows through. It reports where it is
 * (`picture_layout`, CSS px of the viewport + devicePixelRatio) and sends the effects when they
 * change (`picture_set_effects`). Overlays are positioned on `picture://fit`, the letterbox Rust
 * actually drew, so React and the shader share one rectangle.
 */
export function DesktopPictureHole({ resizeMode = 'fit', onPictureRect, effects: override, context = 'live' }: LivePictureProps) {
  const derived = usePictureEffects(context);
  const base = override ?? derived;
  // Auto LUT on playback (P2): the official cube for the clip's colour, when it is in the
  // desktop's LUT folder, in place of the generated display transform.
  const autoPick = useAssists((s) => context === 'playback' && s.playbackOn.LUT && s.options.lut.selection === 'auto');
  const model = useCamera((s) => s.identity?.model ?? null);
  const autoLut = useDesktopAutoLut(autoPick && base.lutId == null ? (base.signal ?? base.sourceColor) : null, model);
  const effects = autoLut ? { ...base, lutId: autoLut } : base;
  const streamW = useCamera((s) => s.connection.streamWidth);
  const streamH = useCamera((s) => s.connection.streamHeight);
  const ref = useRef<ComponentRef<typeof View> | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const lastRect = useRef<LayoutRectangle | null>(null);
  const fitted = useRef(false);
  const report = useRef(onPictureRect);
  report.current = onPictureRect;
  // 'fill' fills the hole and crops in the native blit; Rust's `picture://fit` reports it.
  const fit = useRef(resizeMode);
  fit.current = resizeMode;
  const resend = useRef<() => void>(() => {});

  const publish = (rect: LayoutRectangle) => {
    if (sameRect(lastRect.current, rect)) return;
    lastRect.current = rect;
    report.current?.(rect);
  };

  // Effects go to the shader only when they change, never per frame. The desktop's LUT split
  // rides along as an extra field while a look is on.
  const split = useDesktopSplit();
  const graded = effects.lutId != null || effects.sourceColor !== 'rec709';
  const effectsKey = JSON.stringify(split !== 'off' && graded ? { ...effects, split } : effects);
  useEffect(() => {
    invoke('picture_set_effects', { effects: JSON.parse(effectsKey) }).catch(() => {});
  }, [effectsKey]);
  // A cube imported into web storage before is handed to Rust the first time it is used.
  useEffect(() => {
    void ensureDesktopLut(effects.lutId);
  }, [effects.lutId]);

  // Where the hole is. A move without a resize (a sheet sliding the layout) is caught by a
  // cheap poll; resizes by the observer.
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node || typeof node.getBoundingClientRect !== 'function') return;
    let last = '';
    const send = () => {
      const r = node.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const key = `${r.left}|${r.top}|${r.width}|${r.height}|${dpr}|${fit.current}`;
      if (key === last) return;
      last = key;
      invoke('picture_layout', { rect: { x: r.left, y: r.top, width: r.width, height: r.height }, dpr, fit: fit.current }).catch(() => {});
    };
    resend.current = send;
    send();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(send) : null;
    observer?.observe(node);
    window.addEventListener('resize', send);
    const poll = setInterval(send, 500);
    const restore = punchThrough(node);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', send);
      clearInterval(poll);
      restore();
      invoke('picture_layout', { rect: null }).catch(() => {});
    };
  }, []);

  // The letterbox Rust drew, in this view's coordinates.
  useEffect(
    () =>
      listen<DesktopFit>('picture://fit', (fit) => {
        const node = ref.current as unknown as HTMLElement | null;
        if (!node || typeof node.getBoundingClientRect !== 'function') return;
        const r = node.getBoundingClientRect();
        fitted.current = true;
        publish({ x: fit.x - r.left, y: fit.y - r.top, width: fit.width, height: fit.height });
      }),
    [],
  );

  // A changed resizeMode goes to Rust at once, not on the next poll.
  useEffect(() => {
    resend.current();
  }, [resizeMode]);

  // Until the first fit arrives, the shared formula (the native blit fits or fills the same way).
  useEffect(() => {
    if (fitted.current || size.width <= 0) return;
    publish(pictureRect(size, pictureAspect(effects, streamW, streamH), resizeMode));
  });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  };

  return (
    <View
      ref={ref}
      testID="live-picture-desktop-hole"
      style={{ flex: 1, backgroundColor: 'transparent' }}
      onLayout={onLayout}
      pointerEvents="none"
    />
  );
}
