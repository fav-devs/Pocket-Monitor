import type { LayoutRectangle } from 'react-native';
import type { VideoSource } from '@/camera';
import type { ExposureState } from '@/camera/types';
import { desqueezedAspect, fitRect, rasterAspect } from '@/core/media';
import type { DemoScene, PictureEffects } from '@modules/pocket-native/src/types';

export interface LivePictureProps {
  source: VideoSource;
  resizeMode?: 'fit' | 'fill';
  /** Reports where the picture is drawn inside this view (for overlays and touch mapping). */
  onPictureRect?: (rect: LayoutRectangle) => void;
  /** Override the effects (defaults to the live assists via `usePictureEffects('live')`). */
  effects?: PictureEffects;
  /** Which assist switches drive the effects and which sample bus to publish on. */
  context?: 'live' | 'playback';
  /** Force a demo scene (dev preview). */
  demoScene?: DemoScene;
  /**
   * Optional (additive). Publish frame samples for the scopes and meters (default true). Multiview
   * passes false for every tile but the selected one, so one camera feeds the sample bus.
   */
  publishSamples?: boolean;
}

/** Display aspect of the picture: stream raster (16:9 fallback) through the desqueeze. */
export function pictureAspect(effects: PictureEffects, streamWidth?: number, streamHeight?: number) {
  const base = rasterAspect(streamWidth, streamHeight);
  return effects.desqueeze.factor > 1.001 ? desqueezedAspect(base, effects.desqueeze.factor, effects.desqueeze.direction) : base;
}

export function pictureRect(container: { width: number; height: number }, aspect: number, mode: 'fit' | 'fill'): LayoutRectangle {
  return fitRect(container, aspect, mode);
}

export const sameRect = (a: LayoutRectangle | null, b: LayoutRectangle) =>
  !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/**
 * Scene exposure gain for the demo camera: auto exposure only follows EV compensation; manual
 * follows ISO and shutter around ISO 200 · 1/60.
 */
export function demoExposureGain(e: Pick<ExposureState, 'mode' | 'iso' | 'shutterDenom' | 'ev'>): number {
  if (e.mode === 'auto') return Math.pow(2, e.ev || 0);
  const iso = e.iso && e.iso > 0 ? e.iso / 200 : 1;
  const shutter = e.shutterDenom && e.shutterDenom > 0 ? 60 / e.shutterDenom : 1;
  return Math.min(64, Math.max(1 / 64, iso * shutter));
}

export function demoSceneFor(source: VideoSource, forced?: DemoScene): DemoScene | null {
  if (forced) return forced;
  return source.kind === 'demo' ? source.scene : null;
}
