import type { ParadeMode, VectorscopeZoom, WaveformMode } from '@/core/media';
import type { DemoScene, PictureEffects, ScopeKind } from '@modules/opc-native/src/types';
import type { ScopeBundle } from '@/features/picture/frameSample';

export interface ScopeTracesProps {
  kind: ScopeKind;
  width: number;
  height: number;
  /** Web: the analysed frame sample. Native ignores it (the GPU scope reads the decoder). */
  bundle: ScopeBundle | null;
  mode?: WaveformMode | ParadeMode;
  /** 0…200 (100 = default). */
  brightness: number;
  zoom?: VectorscopeZoom;
  /** Histogram leaves gutters for the traffic lamps. */
  lamps?: boolean;
  effects: PictureEffects;
  sessionId: string | null;
  demoScene: DemoScene | null;
}
