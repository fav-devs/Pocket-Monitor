/**
 * The sharing host (Settings → Feed sharing → Share this feed). While the switch is on and a real
 * camera is live, the native relay advertises `_pocket-mon._tcp` on the camera Wi-Fi and forwards
 * the camera's encoded picture to watchers natively (frames never cross JS). JS samples the camera
 * state for watchers at 5 Hz, carries out commands from the watcher holding control, and asks the
 * operator to Grant / Deny control requests.
 *
 * Sharing survives a camera recovery (watchers wait for the next camera keyframe) and stops, with
 * an explicit reason sent to watchers, when the camera disconnects or the switch goes off.
 *
 * Mounted once at the root (`<FeedSharingHost />`). Web and builds without the relay module never
 * advertise; the Settings rows say so.
 */
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { create } from 'zustand';
import { PocketRelay } from '@modules/pocket-native/src/native';
import type { RelayHostStatusEvent } from '@modules/pocket-native/src/types';
import { useCamera, useCameraSession } from '@/camera';
import type { CameraSession } from '@/camera/session';
import { applyHostAction } from '@/camera/watcher/host';
import { hostActionFor, relayStateFromCamera } from '@/camera/watcher/mapping';
import { RelayCopy, decodeCommand, encodeState } from '@/camera/watcher/protocol';
import { useSettingsLocal } from '@/features/settings/settingsStore';
import { sessionClock } from '@/camera/native/clock';
import { currentCameraSession } from '@/camera';
import { windowFor } from './hostSettings';

export interface FeedSharingStatus {
  /** This build can share (the native relay is linked). */
  available: boolean;
  /** Advertising (or starting) right now. */
  active: boolean;
  state: RelayHostStatusEvent['state'];
  watchers: number;
  holder: string;
  joinable: boolean;
  error: string | null;
}

const idle: FeedSharingStatus = {
  available: PocketRelay != null,
  active: false,
  state: 'stopped',
  watchers: 0,
  holder: 'Host',
  joinable: false,
  error: null,
};

export const useFeedSharingStatus = create<FeedSharingStatus>(() => idle);

export { windowFor };

const KEEP_PHASES = new Set(['live', 'recovering', 'live-start']);
const STATE_MS = 200;
const KEEPALIVE_MS = 1000;

/** Hands the lease back to the host operator. */
export function reclaimFeedControl() {
  PocketRelay?.reclaimControl();
}

export function useFeedSharing() {
  const session = useCameraSession();
  const phase = useCamera((s) => s.connection.phase);
  const cameraName = useCamera((s) => s.identity?.name ?? '');
  const share = useSettingsLocal((s) => s.shareThisFeed);
  const passcode = useSettingsLocal((s) => s.watcherPasscode);
  const controlRequests = useSettingsLocal((s) => s.controlRequests);
  const priority = useSettingsLocal((s) => s.broadcastPriority);
  const running = useRef<{ session: CameraSession; cameraSessionId: string } | null>(null);
  const settings = useRef({ passcode, controlRequests, priority });
  settings.current = { passcode, controlRequests, priority };

  const relay = PocketRelay;
  const eligible = !!relay && share && session.kind === 'native';
  const shouldStart = eligible && phase === 'live' && session.video.kind === 'native';
  const shouldKeep = eligible && KEEP_PHASES.has(phase);

  // Status and commands from the native host.
  useEffect(() => {
    if (!relay) return;
    const prompted = { key: '' };
    const status = relay.addListener('onHostStatus', (e) => {
      useFeedSharingStatus.setState({
        available: true,
        active: e.state === 'starting' || e.state === 'advertising',
        state: e.state,
        watchers: e.watchers,
        holder: e.holder,
        joinable: e.joinable,
        error: e.error ?? null,
      });
      const key = e.pending ? `${e.pending.watcherId}:${e.pending.name}` : '';
      if (key && key !== prompted.key) {
        prompted.key = key;
        Alert.alert(`Allow ${e.pending!.name} to control the camera?`, undefined, [
          { text: 'Deny', style: 'cancel', onPress: () => relay.denyControl() },
          { text: 'Grant', onPress: () => relay.grantControl() },
        ]);
      } else if (!key) prompted.key = '';
    });
    const command = relay.addListener('onHostCommand', (e) => {
      // Server mode can start the host as well: commands go to the app's live camera.
      const app = currentCameraSession();
      const host = running.current?.session ?? (app?.kind === 'native' ? app : null);
      const decoded = decodeCommand(e.json);
      if (!host || !decoded) return;
      const action = hostActionFor(decoded, host.getState());
      if (action) applyHostAction(host, action).catch(() => {});
    });
    return () => {
      status.remove();
      command.remove();
    };
  }, [relay]);

  // Start / stop with the switch and the camera.
  useEffect(() => {
    if (!relay) return;
    const current = running.current;
    const cameraSessionId = session.video.kind === 'native' ? session.video.sessionId : null;
    const moved = current && (current.session !== session || (cameraSessionId && current.cameraSessionId !== cameraSessionId));
    if (current && (!shouldKeep || moved)) {
      relay.stopHost(RelayCopy.hostStopped);
      running.current = null;
      useFeedSharingStatus.setState({ ...idle, available: true });
    }
    if (!running.current && shouldStart && cameraSessionId && !useFeedSharingStatus.getState().active) {
      running.current = { session, cameraSessionId };
      const s = settings.current;
      useFeedSharingStatus.setState({ ...idle, available: true, active: true, state: 'starting' });
      relay
        .startHost({
          cameraSessionId,
          hostName: '',
          cameraName,
          passcode: s.passcode,
          allowsControl: s.controlRequests,
          window: windowFor(s.priority),
        })
        .catch((e: unknown) => {
          if (running.current?.cameraSessionId !== cameraSessionId) return;
          running.current = null;
          useFeedSharingStatus.setState({ ...idle, available: true, state: 'failed', error: e instanceof Error ? e.message : 'Sharing could not start' });
        });
    }
  }, [relay, session, shouldStart, shouldKeep, cameraName]);

  // Passcode, control requests and priority apply to the running host, whoever started it.
  const hostActive = useFeedSharingStatus((st) => st.active);
  useEffect(() => {
    if (!relay || !hostActive) return;
    relay.updateHost({ passcode, allowsControl: controlRequests, window: windowFor(priority) });
    if (!controlRequests) relay.reclaimControl();
  }, [relay, hostActive, passcode, controlRequests, priority]);

  // Camera state for watchers: 5 Hz when it changes, at least once a second.
  useEffect(() => {
    if (!relay || !shouldKeep) return;
    let last = '';
    let sentAt = 0;
    // The session clock keeps ticking in the background under server mode (JS timers stop there).
    const timer = sessionClock.setInterval(() => {
      const host = running.current?.session;
      if (!host) return;
      const json = encodeState(relayStateFromCamera(host.getState(), settings.current.controlRequests));
      const now = sessionClock.now();
      if (json === last && now - sentAt < KEEPALIVE_MS) return;
      last = json;
      sentAt = now;
      relay.publishHostState(json);
    }, STATE_MS);
    return () => sessionClock.clearInterval(timer);
  }, [relay, shouldKeep]);

  // App teardown.
  useEffect(
    () => () => {
      if (running.current) relay?.stopHost(RelayCopy.hostStopped);
      running.current = null;
    },
    [relay],
  );
}

/** Root-mounted runner for the sharing host. Renders nothing. */
export function FeedSharingHost() {
  useFeedSharing();
  return null;
}
