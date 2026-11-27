/**
 * The watcher flow's state on a phone (and the web demo): browse hosts, join one as the app's
 * camera session (`WatcherCameraSession`), answer a passcode, leave. Leaving, or closing the
 * screen, restores the app's own session.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createDefaultSession, useCameraSession, useSetCameraSession } from '@/camera';
import { createWatcherSession, relayTransport } from '@/camera/watcher/createWatcherSession';
import { idleWatcherInfo, type WatcherInfo } from '@/camera/watcher/mapping';
import type { RelayHostAdvert, RelayHostsEvent } from '@/camera/watcher/transport';
import { WatcherCameraSession } from '@/camera/watcher/WatcherCameraSession';

const noop = () => () => {};

/** Watcher info of `session`, or idle when there is none. */
export function useWatcherInfo(session: WatcherCameraSession | null): WatcherInfo {
  return useSyncExternalStore(
    session ? (cb) => session.subscribeWatcher(cb) : noop,
    () => session?.getWatcherInfo() ?? idleWatcherInfo,
    () => session?.getWatcherInfo() ?? idleWatcherInfo,
  );
}

/** The app session when it is a watcher. */
export function useActiveWatcher(): WatcherCameraSession | null {
  const session = useCameraSession();
  return session instanceof WatcherCameraSession ? session : null;
}

export function useWatcher() {
  const setSession = useSetCameraSession();
  const active = useActiveWatcher();
  const [session, setLocal] = useState<WatcherCameraSession | null>(active);
  const info = useWatcherInfo(session);
  const [hosts, setHosts] = useState<RelayHostsEvent>({ hosts: [], browsing: true });
  const [host, setHost] = useState<RelayHostAdvert | null>(null);
  /** The host accepted this join once: the live view stays up through errors from here on. */
  const [accepted, setAccepted] = useState(false);
  const transport = relayTransport();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (info.phase === 'live') setAccepted(true);
  }, [info.phase]);

  // Browse while choosing a feed.
  const browsing = !accepted;
  useEffect(() => {
    if (!browsing) return;
    return transport.browse((e) => setHosts({ ...e, hosts: e.hosts.filter((h) => h.watchable) }));
  }, [browsing, transport]);

  const join = useCallback(
    (next: RelayHostAdvert, passcode = '') => {
      let s = sessionRef.current;
      if (!s) {
        s = createWatcherSession();
        setLocal(s);
        setSession(s);
      }
      setHost(next);
      setAccepted(false);
      s.watch({ hostId: next.id, name: next.name, camera: next.camera }, passcode);
    },
    [setSession],
  );

  const answerPasscode = useCallback((code: string) => sessionRef.current?.answerPasscode(code), []);

  /** Back to the list; keeps the screen. */
  const chooseFeed = useCallback(() => {
    sessionRef.current?.leave();
    setAccepted(false);
    setHost(null);
  }, []);

  /** Leave the feed and give the app its own session back. */
  const leave = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    s.leave();
    setLocal(null);
    setAccepted(false);
    setHost(null);
    setSession(createDefaultSession());
  }, [setSession]);

  // Closing the screen leaves.
  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (s) {
        s.leave();
        setSession(createDefaultSession());
      }
    },
    [setSession],
  );

  return { session, info, hosts, host, accepted, simulated: transport.simulated, join, answerPasscode, chooseFeed, leave };
}
