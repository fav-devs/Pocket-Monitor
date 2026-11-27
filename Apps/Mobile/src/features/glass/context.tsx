import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { glassSync, watchGlassNode } from './dom';
import { flatGlass, type GlassResolution } from './state';
import type { GlassKind } from './styles';
import type { GlassNode, GlassOptions } from './sync';

/** The shell's glass (`AppShell` provides it; flat everywhere else, and on phones). */
export const GlassContext = createContext<GlassResolution>(flatGlass);

export function useGlass(): GlassResolution {
  return useContext(GlassContext);
}

export interface GlassControl {
  /** Draw the control as glass: leave its own background out. */
  on: boolean;
  /** Spread on the control's root view (a `Pressable` or `View`). */
  props: { ref?: (node: unknown) => void; dataSet?: Record<string, string> };
}

/**
 * One glass control. `on` tells the component to drop its own fill; `props` (a `dataSet` for
 * the CSS glass and a ref for the native rect) go on its root view. Native glass is asked for
 * only when the shell draws native controls and `native` allows it (a disabled control stays
 * web glass, which dims with it).
 */
export function useGlassControl(
  kind: GlassKind,
  { radius, tint = null, native = true }: { radius: number; tint?: string | null; native?: boolean },
): GlassControl {
  const glass = useGlass();
  const on = glass.controls !== 'none';
  const wantNative = on && glass.controls === 'native' && native && kind !== 'surface' && Platform.OS === 'web';
  const [node, setNode] = useState<GlassNode | null>(null);
  const options = useRef<GlassOptions>({ radius, tint });
  options.current = { radius, tint };

  useEffect(() => {
    if (!wantNative || !node || typeof node.getBoundingClientRect !== 'function') return;
    return watchGlassNode(node, options.current);
  }, [wantNative, node]);

  useEffect(() => {
    if (wantNative && node) glassSync()?.update(node, { radius, tint });
  }, [wantNative, node, radius, tint]);

  const ref = useCallback((instance: unknown) => setNode((instance as GlassNode | null) ?? null), []);
  if (!on) return { on, props: {} };
  return { on, props: { ref, dataSet: { pocketGlass: kind } } };
}
