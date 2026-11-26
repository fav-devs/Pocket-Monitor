import {
  AlertCircleIcon,
  BluetoothIcon,
  Camera01Icon,
  EyeIcon,
  Link04Icon,
  Share08Icon,
  TouchInteraction01Icon,
  Video01Icon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { modelDisplayName } from '@/camera/defaults';
import type { ConnectionPhase } from '@/camera/types';
import { recordConnectionEvent } from '@/features/settings/diagnostics';
import { ProblemReportSheet } from '@/features/settings/ProblemReportSheet';
import { useShareDiagnostics } from '@/features/settings/useShareDiagnostics';
import { useSavedCameras } from '@/state/savedCameras';
import { SummaryGrid } from './components/PairPieces';
import { PairPage } from './components/PairPage';
import { PairingCheckRow } from './components/PairingCheckRow';
import {
  PairingWizardCopy,
  SessionRecoveryCopy,
  StartupConnectionCopy,
  friendlyConnectionError,
  opensSettings,
} from './copy';
import { usePendingConnect } from './pairingStore';
import { pathKindTitle, phaseIndex, spineSteps, wizardPage, type SpineStep } from './presentation';

const steps = PairingWizardCopy.titles.map((title) => ({ title }));
const stepIcons: Record<SpineStep['id'], IconSvgElement> = {
  bluetooth: BluetoothIcon,
  approve: TouchInteraction01Icon,
  wifi: Wifi01Icon,
  datalink: Link04Icon,
  live: Video01Icon,
};
const inFlight = new Set<ConnectionPhase>(['scanning', 'bluetooth', 'authorizing', 'wifi-handoff', 'joining-wifi', 'datalink', 'live-start']);

/**
 * The connection spine (BLE → Wi-Fi → datalink → live view) as the wizard's later pages, driven
 * only by `connection` from the session. Opens Live View the moment the picture is ready.
 */
export default function ConnectScreen() {
  const router = useRouter();
  const session = useCameraSession();
  const connection = useCamera((s) => s.connection);
  const identity = useCamera((s) => s.identity);
  const pending = usePendingConnect();
  const upsert = useSavedCameras((s) => s.upsert);
  const markConnected = useSavedCameras((s) => s.markConnected);
  const diagnostics = useShareDiagnostics();
  const [reporting, setReporting] = useState(false);
  const [reached, setReached] = useState<ConnectionPhase>(connection.phase);
  const navigated = useRef(false);

  const { phase } = connection;

  useEffect(() => {
    recordConnectionEvent(phase, connection.detail, connection.error);
    setReached((prev) => {
      const i = phaseIndex(phase);
      if (i < 0) return prev; // failed / recovering / disconnected keep where it stalled
      if (i <= 2) return phase; // a new attempt starts over
      return i > phaseIndex(prev) ? phase : prev;
    });
  }, [phase, connection.detail, connection.error]);

  // Live: remember the camera, then open the monitor.
  useEffect(() => {
    if (phase !== 'live' || navigated.current) return;
    navigated.current = true;
    const target = pending.target;
    if (target && !pending.demo) {
      if (pending.firstPair) {
        const ssid = target.path.ssid || identity?.ssid || '';
        upsert({ ...target, path: { ...target.path, ssid }, lastConnectedAt: Date.now() });
      } else {
        markConnected(target.id);
      }
    }
    router.replace('/live');
  }, [phase, pending, identity, upsert, markConnected, router]);

  const cameraName = pending.target?.name ?? identity?.name ?? 'The camera';
  const transport = pending.target?.path.kind;
  const network = pending.target?.path.ssid || identity?.ssid || undefined;
  const failed = phase === 'failed';
  const recovering = phase === 'recovering';
  const disconnected = phase === 'disconnected';
  const idle = phase === 'idle' && !pending.target;
  const busy = inFlight.has(phase);
  const page = wizardPage(reached);

  const exit = () => {
    if (busy || recovering) session.disconnect().catch(() => {});
    pending.clear();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const retry = () => {
    navigated.current = false;
    session.retry().catch(() => {});
  };

  const checks = spineSteps(connection, reached, { network, transport }).map((s) => ({
    title: s.title,
    subtitle: s.subtitle,
    state: s.state === 'done' ? ('complete' as const) : s.state === 'active' ? (failed || disconnected ? ('failed' as const) : ('active' as const)) : ('waiting' as const),
    stateLabel: s.stateLabel,
    icon: stepIcons[s.id],
  }));

  let title: string = PairingWizardCopy.titles[page];
  let body: string | null = PairingWizardCopy.bodies[page] || null;
  let error: string | null = null;
  let primary: { title: string; enabled: boolean; onPress: () => void } | null = null;
  let back: { title: string; onPress: () => void } | null = { title: 'Cancel', onPress: exit };
  let hero: { icon: IconSvgElement; tone?: 'default' | 'destructive' } | null = null;

  if (idle) {
    title = 'Nothing to connect';
    body = null;
    primary = { title: 'Cameras', enabled: true, onPress: () => router.replace('/') };
    back = null;
    hero = { icon: Camera01Icon };
  } else if (failed) {
    const raw = connection.error;
    error = friendlyConnectionError(raw);
    title = `Couldn't connect to ${cameraName}`;
    body = null;
    hero = { icon: AlertCircleIcon, tone: 'destructive' };
    primary = opensSettings(raw)
      ? { title: StartupConnectionCopy.openSettings, enabled: true, onPress: () => Linking.openSettings().catch(() => {}) }
      : { title: 'Try again', enabled: true, onPress: retry };
    back = { title: 'Back', onPress: exit };
  } else if (recovering) {
    title = SessionRecoveryCopy.retryingTitle;
    body = SessionRecoveryCopy.retrying;
    primary = { title: SessionRecoveryCopy.retryAction, enabled: true, onPress: retry };
    back = { title: SessionRecoveryCopy.menuAction, onPress: exit };
  } else if (disconnected) {
    title = SessionRecoveryCopy.waitingTitle;
    body = SessionRecoveryCopy.waiting;
    primary = { title: SessionRecoveryCopy.retryAction, enabled: !!pending.target || !!identity, onPress: retry };
    back = { title: SessionRecoveryCopy.menuAction, onPress: exit };
  }

  const summary = pending.target
    ? [
        { title: 'Camera', value: `${cameraName} · ${modelDisplayName(pending.target.model)}` },
        { title: 'Setup', value: network ? `${pathKindTitle(pending.target.path.kind)} · ${network}` : pathKindTitle(pending.target.path.kind) },
      ]
    : [];

  return (
    <>
      <PairPage
        heading={pending.demo ? 'Demo camera' : pending.firstPair ? 'Pair a camera' : 'Connect camera'}
        steps={steps}
        currentStep={idle ? 0 : page}
        title={title}
        body={body}
        hero={hero}
        hint={diagnostics.note}
        progress={busy ? connection.detail ?? 'Connecting' : null}
        error={error}
        primaryAction={primary}
        backAction={back}
        onExit={exit}
        menuItems={[
          { id: 'diagnostics', title: 'Share Diagnostics', icon: Share08Icon, onPress: () => void diagnostics.share() },
          { id: 'watch', title: 'Watch a feed', icon: EyeIcon, onPress: () => router.push('/watcher') },
        ]}
        onReportProblem={() => setReporting(true)}
      >
        {idle ? null : (
          <>
            <View style={{ gap: 2 }}>
              {checks.map((c) => (
                <PairingCheckRow key={c.title} check={c} />
              ))}
            </View>
            {summary.length ? <SummaryGrid items={summary} /> : null}
          </>
        )}
      </PairPage>
      <ProblemReportSheet visible={reporting} onClose={() => setReporting(false)} />
    </>
  );
}
