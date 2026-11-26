import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useCameraSession } from '@/camera';
import { demandDesktopScopes, desktopScopesAvailable, getDesktopScopeFrame, subscribeDesktopScopes, type DesktopScopePlates } from '@/camera/desktop/picture';
import type { CrushClipCompensation, MonitorTransfer } from '@/core/media';
import { bundleFrom, type DesktopScopeBundle } from './scopeBundle';

export { bundleFrom, desktopFrameOf, ndFrom, platesFor, type DesktopScopeBundle } from './scopeBundle';

/** True when the live session is the desktop app's (the picture is native, so are the scopes). */
export function useDesktopScopeSource(): boolean {
  const session = useCameraSession();
  return session.kind === 'desktop' && desktopScopesAvailable();
}

/**
 * The desktop's `useScopeBundle`: registers `plates` with the scope thread while mounted (null
 * registers nothing) and returns the latest bundle. `crushClip` is part of `plates`.
 */
export function useDesktopScopeBundle(plates: DesktopScopePlates | null, transfer: MonitorTransfer, clipByte: number, _crushClip?: CrushClipCompensation): DesktopScopeBundle | null {
  const key = plates ? JSON.stringify(plates) : '';
  useEffect(() => {
    if (!key) return;
    const demand = demandDesktopScopes(JSON.parse(key) as DesktopScopePlates);
    return () => demand.release();
  }, [key]);
  const frame = useSyncExternalStore(
    subscribeDesktopScopes,
    () => (key ? getDesktopScopeFrame() : null),
    () => null,
  );
  const previous = useRef<DesktopScopeBundle | null>(null);
  return useMemo(() => {
    if (!frame) return null;
    const prev = previous.current;
    if (prev && prev.desktop === frame && prev.transfer === transfer && prev.clipByte === clipByte) return prev;
    const next = bundleFrom(frame, prev, transfer, clipByte);
    previous.current = next;
    return next;
  }, [frame, transfer, clipByte]);
}
