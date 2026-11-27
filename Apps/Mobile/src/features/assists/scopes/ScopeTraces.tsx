import { View } from 'react-native';
import { PocketScopeView } from '@modules/pocket-native/src/PocketVideoView';
import { histogramPlotRect, vectorscopeSquare, waveformPlotRect } from './scopeGeometry';
import type { ScopeTracesProps } from './ScopeTraces.types';

export type { ScopeTracesProps } from './ScopeTraces.types';

/**
 * Native scope traces: the GPU scope fed straight from the decoder (`PocketScopeView`), placed in
 * the same plot rect the SVG graticule draws around. Scopes measure the camera signal.
 */
export default function ScopeTraces({ kind, width, height, mode, brightness, zoom, lamps, effects, sessionId, demoScene }: ScopeTracesProps) {
  const plot = kind === 'vectorscope' ? vectorscopeSquare(width, height) : kind === 'histogram' ? histogramPlotRect(width, height, !!lamps) : waveformPlotRect(width, height);
  const options: Record<string, string | number | boolean> =
    kind === 'vectorscope'
      ? { zoom: zoom === '4x' ? 4 : zoom === '2x' ? 2 : 1 }
      : kind === 'histogram'
        ? { mode: 'rgb' }
        : { mode: String(mode ?? 'RGB').toLowerCase() };
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: plot.x, top: plot.y, width: plot.width, height: plot.height }}>
      <PocketScopeView
        style={{ flex: 1 }}
        sessionId={sessionId}
        demoScene={demoScene}
        kind={kind}
        options={options}
        brightness={Math.min(2, Math.max(0, brightness / 100))}
        measureAfterLut={false}
        effects={effects}
      />
    </View>
  );
}
