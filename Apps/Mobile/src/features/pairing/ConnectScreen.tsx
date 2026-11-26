import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useCamera, useCameraSession } from '@/camera';
import { modelDisplayName } from '@/camera/defaults';
import type { ConnectionPhase } from '@/camera/types';
import { recordConnectionEvent } from '@/features/settings/diagnostics';
import { ProblemReportSheet } from '@/features/settings/ProblemReportSheet';
import { useShareDiagnostics } from '@/features/settings/useShareDiagnostics';
import { useSavedCameras } from '@/state/savedCameras';
import { InstructionCard, NoteCard, SummaryGrid, type Instruction } from './components/PairPieces';
import { PairPage } from './components/PairPage';
import { PairingCheckRow } from './components/PairingCheckRow';
import { ConnectProgressBar } from './components/StatusBits';
import {
  PairingWizardCopy,
  SessionRecoveryCopy,
  StartupConnectionCopy,
  friendlyConnectionError,
  opensSettings,
} from './copy';
import { usePendingConnect } from './pairingStore';
import { pathKindTitle, phaseIndex, spineSteps, wizardPage } from './presentation';

const steps = PairingWizardCopy.titles.map((title, i) => ({ title, subtitle: PairingWizardCopy.rail[i] }));
const phoneTitle = Platform.OS === 'ios' ? 'On iPhone' : 'On this phone';
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

  const checks = spineSteps(connection, reached, { cameraName, network, transport }).map((s) => ({
    title: s.title,
    subtitle: s.subtitle,
    state: s.state === 'done' ? ('complete' as const) : s.state === 'active' ? (failed || disconnected ? ('failed' as const) : ('active' as const)) : ('waiting' as const),
    stateLabel: s.stateLabel,
  }));
  const done = checks.filter((c) => c.state === 'complete').length;
  const active = checks.some((c) => c.state === 'active') ? 0.5 : 0;
  const fraction = Math.max(0.06, Math.min(1, (done + active) / checks.length));

  const instructions: Instruction[] =
    failed || disconnected || recovering
      ? []
      : page === 1
        ? [
            { title: 'On the camera', icon: 'camera', lines: PairingWizardCopy.approveLines },
            { title: phoneTitle, icon: 'phone', lines: PairingWizardCopy.approvePhoneLines },
          ]
        : page === 2
          ? [
              { title: 'On the camera', icon: 'camera', lines: PairingWizardCopy.joinLines },
              { title: phoneTitle, icon: 'phone', lines: PairingWizardCopy.joinPhoneLines },
            ]
          : [];

  let title: string = PairingWizardCopy.titles[page];
  let body: string = PairingWizardCopy.bodies[page];
  let hint: string = PairingWizardCopy.hints[page];
  let error: string | null = null;
  let primary: { title: string; enabled: boolean; onPress: () => void } | null = null;
  let back: { title: string; onPress: () => void } | null = { title: 'Cancel', onPress: exit };

  if (idle) {
    title = 'Nothing to connect';
    body = 'Choose a camera on Your cameras, pair a new one, or try the demo camera.';
    hint = 'Your cameras lists every camera saved on this phone';
    primary = { title: 'Your cameras', enabled: true, onPress: () => router.replace('/') };
    back = null;
  } else if (failed) {
    const raw = connection.error;
    error = friendlyConnectionError(raw);
    title = `Couldn't connect to ${cameraName}`;
    body = 'Nothing was changed on the camera. Fix what the message says, then try again.';
    hint = 'Retry keeps the camera you chose';
    primary = opensSettings(raw)
      ? { title: StartupConnectionCopy.openSettings, enabled: true, onPress: () => Linking.openSettings().catch(() => {}) }
      : { title: 'Try again', enabled: true, onPress: retry };
    back = { title: 'Back', onPress: exit };
  } else if (recovering) {
    title = SessionRecoveryCopy.retryingTitle;
    body = SessionRecoveryCopy.retrying(cameraName);
    hint = 'The camera reconnects on its own when it comes back';
    primary = { title: SessionRecoveryCopy.retryAction, enabled: true, onPress: retry };
    back = { title: SessionRecoveryCopy.menuAction, onPress: exit };
  } else if (disconnected) {
    title = SessionRecoveryCopy.waitingTitle;
    body = SessionRecoveryCopy.waiting(cameraName);
    hint = 'Turn the camera off and on if it does not come back';
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
        target={idle ? 'Nothing selected yet' : cameraName}
        hint={diagnostics.note ?? hint}
        progress={busy ? connection.detail ?? 'Connecting' : null}
        error={error}
        primaryAction={primary}
        backAction={back}
        onExit={exit}
        menuItems={[
          { id: 'diagnostics', title: 'Share Diagnostics', onPress: () => void diagnostics.share() },
          { id: 'watch', title: 'Watch a feed', onPress: () => router.push('/watcher') },
        ]}
        onReportProblem={() => setReporting(true)}
      >
        {idle ? (
          <NoteCard title="No camera is connecting" detail="Start from Your cameras." />
        ) : (
          <View style={{ gap: 8 }}>
            {busy ? <ConnectProgressBar fraction={fraction} /> : null}
            {checks.map((c) => (
              <PairingCheckRow key={c.title} check={c} />
            ))}
            {instructions.map((ins) => (
              <InstructionCard key={ins.title} instruction={ins} />
            ))}
            {summary.length ? <SummaryGrid items={summary} /> : null}
          </View>
        )}
      </PairPage>
      <ProblemReportSheet visible={reporting} onClose={() => setReporting(false)} />
    </>
  );
}
