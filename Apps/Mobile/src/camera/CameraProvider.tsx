import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { DemoCameraSession } from './demo/DemoCameraSession';
import type { CameraModelId, CameraNotice } from './types';
import type { CameraSession, SessionEvent } from './session';
import type { CameraState } from './types';

interface CameraContextValue {
  session: CameraSession;
  /** Swap the active session (e.g. demo → native, or a watcher relay). */
  setSession: (session: CameraSession) => void;
}

const CameraContext = createContext<CameraContextValue | null>(null);

/** A fresh simulated camera (web preview, demo mode, "Try the demo camera"). */
export function createDemoSession(model?: CameraModelId): CameraSession {
  return new DemoCameraSession(model);
}

/**
 * Picks the initial session. `src/camera/bootstrap.ts` registers the native factory on phone
 * builds with the camera radios linked (and demo mode off); web and builds without the native
 * module keep the demo camera.
 */
let sessionFactory: () => CameraSession = () => createDemoSession();

export function registerSessionFactory(factory: () => CameraSession) {
  sessionFactory = factory;
}

/** A session from the registered factory (what the app would start with now). */
export function createDefaultSession(): CameraSession {
  return sessionFactory();
}

// Out-of-tree switching (bootstrap follows the demo-mode preference; settings can too).
type SwitchListener = (next: CameraSession) => void;
const switchListeners = new Set<SwitchListener>();
let pendingSession: CameraSession | null = null;
let activeSession: CameraSession | null = null;

/** The session the provider currently runs, or null before it mounts. */
export function currentCameraSession(): CameraSession | null {
  return activeSession ?? pendingSession;
}

/**
 * Replace the running session from outside React (e.g. `replaceCameraSession(createNativeSession())`).
 * The previous session is disconnected if it was connected. Before the provider mounts, the
 * replacement becomes its initial session.
 */
export function replaceCameraSession(next: CameraSession): void {
  if (switchListeners.size === 0) {
    pendingSession = next;
    return;
  }
  switchListeners.forEach((l) => l(next));
}

const IDLE_PHASES = new Set(['idle', 'disconnected', 'failed']);

/** Stop a session that is being replaced so its radios, timers and native session close. */
function retire(session: CameraSession) {
  if (IDLE_PHASES.has(session.getState().connection.phase)) return;
  session.disconnect().catch(() => {
    // Retiring is best effort; the replacement does not depend on it.
  });
}

export function CameraProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<CameraSession>(() => {
    const initial = pendingSession ?? sessionFactory();
    pendingSession = null;
    return initial;
  });
  const current = useRef(session);
  current.current = session;
  activeSession = session;

  const setSession = useCallback((next: CameraSession) => {
    const previous = current.current;
    if (next === previous) return;
    retire(previous);
    current.current = next;
    activeSession = next;
    setSessionState(next);
  }, []);

  useEffect(() => {
    switchListeners.add(setSession);
    if (pendingSession) {
      const next = pendingSession;
      pendingSession = null;
      setSession(next);
    }
    return () => {
      switchListeners.delete(setSession);
    };
  }, [setSession]);

  return <CameraContext.Provider value={{ session, setSession }}>{children}</CameraContext.Provider>;
}

/**
 * Additive: a subtree that reads and drives `session` instead of the app's current one, so the
 * live screen's pieces (capture sheets, gimbal, picture) can serve one Multiview tile. Swapping the
 * app's session from inside the scope still goes to the app's provider.
 */
export function CameraSessionScope({ session, children }: { session: CameraSession; children: ReactNode }) {
  const parent = useContext(CameraContext);
  const setSession = parent?.setSession;
  const value = useMemo<CameraContextValue>(() => ({ session, setSession: setSession ?? (() => {}) }), [session, setSession]);
  return <CameraContext.Provider value={value}>{children}</CameraContext.Provider>;
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
