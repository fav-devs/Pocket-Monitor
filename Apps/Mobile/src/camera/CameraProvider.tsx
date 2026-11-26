import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { DemoCameraSession } from './demo/DemoCameraSession';
import type { CameraNotice } from './types';
import type { CameraSession, SessionEvent } from './session';
import type { CameraState } from './types';

interface CameraContextValue {
  session: CameraSession;
  /** Swap the active session (e.g. demo → native, or a watcher relay). */
  setSession: (session: CameraSession) => void;
}

const CameraContext = createContext<CameraContextValue | null>(null);

/**
 * Picks the initial session. The native session is registered by `src/camera/native` once it
 * exists; until then (and always on web) the app runs the demo camera.
 */
let sessionFactory: () => CameraSession = () => new DemoCameraSession();

export function registerSessionFactory(factory: () => CameraSession) {
  sessionFactory = factory;
}

export function CameraProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<CameraSession>(() => sessionFactory());
  return <CameraContext.Provider value={{ session, setSession }}>{children}</CameraContext.Provider>;
}

export function useCameraSession(): CameraSession {
  const ctx = useContext(CameraContext);
  if (!ctx) throw new Error('useCameraSession must be used inside <CameraProvider>');
  return ctx.session;
}

export function useSetCameraSession() {
  const ctx = useContext(CameraContext);
  if (!ctx) throw new Error('useSetCameraSession must be used inside <CameraProvider>');
  return ctx.setSession;
}

/**
 * Subscribe to a slice of camera state. The selector should return a stable reference
 * (a nested object from state, or a primitive) to avoid needless renders.
 */
export function useCamera<T>(selector: (state: CameraState) => T): T {
  const session = useCameraSession();
  return useSyncExternalStore(
    (cb) => session.subscribe(cb),
    () => selector(session.getState()),
    () => selector(session.getState()),
  );
}

export function useSessionEvents(handler: (event: SessionEvent) => void) {
  const session = useCameraSession();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => session.onEvent((e) => ref.current(e)), [session]);
}

/** Notices from the session plus local ones, for the toast host. */
export function useNotices(): [CameraNotice[], (n: Omit<CameraNotice, 'id'>) => void, (id: string) => void] {
  const [notices, setNotices] = useState<CameraNotice[]>([]);
  useSessionEvents((e) => {
    if (e.type === 'notice') setNotices((n) => [...n.slice(-2), e.notice]);
  });
  const push = (n: Omit<CameraNotice, 'id'>) =>
    setNotices((all) => [...all.slice(-2), { ...n, id: `${Date.now()}-${Math.random()}` }]);
  const dismiss = (id: string) => setNotices((all) => all.filter((n) => n.id !== id));
  return [notices, push, dismiss];
}
