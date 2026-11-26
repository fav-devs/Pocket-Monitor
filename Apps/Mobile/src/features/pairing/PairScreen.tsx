import { BluetoothIcon, EyeIcon, Location01Icon, Share08Icon, Wifi01Icon } from '@hugeicons/core-free-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useCameraSession } from '@/camera';
import { modelDisplayName } from '@/camera/defaults';
import type { CameraNetworkPath, DiscoveredCamera, SavedCamera } from '@/camera/types';
import { ProblemReportSheet } from '@/features/settings/ProblemReportSheet';
import { useShareDiagnostics } from '@/features/settings/useShareDiagnostics';
import { useSavedCameras } from '@/state/savedCameras';
import { DeviceRow, InfoRow, InstructionCard, ListGroup, NoteCard } from './components/PairPieces';
import { PairPage, type PairMenuItem } from './components/PairPage';
import { NetworkSetupCopy, PairingWizardCopy, PermissionCopy, SetupChooserText, StartupConnectionCopy, type SetupKind } from './copy';
import { saveWifiPassword } from './credentials';
import { rssiToBars } from './presentation';
import { HotspotForm, SetupChooser, StationNetworkForm, acceptsPassword, type NetworkDraft } from './SetupFlow';
import { useConnectActions } from './useConnectActions';

/** Permission explainer → scan → choose a setup → (Wi-Fi or Hotspot) network details. */
type Stage = 'permission' | 'find' | 'setup' | 'details';

let permissionsExplained = false;

const steps = PairingWizardCopy.titles.map((title) => ({ title }));
const permissionIcons = { bluetooth: BluetoothIcon, localNetwork: Wifi01Icon, location: Location01Icon } as const;

function PermissionList() {
  return (
    <ListGroup>
      {PermissionCopy.items.map((item, i) => (
        <InfoRow
          key={item.id}
          icon={permissionIcons[item.id as keyof typeof permissionIcons]}
          title={item.title}
          last={i === PermissionCopy.items.length - 1}
        />
      ))}
    </ListGroup>
  );
}

/**
 * The pair wizard's first page (`PairCameraPage` + `PairingWizard`): permissions, find the camera
 * over Bluetooth, then choose how it connects. The connect screen continues at Approve.
 * `?camera=<id>` preselects a sighting; `?camera=<id>&step=setup` adds a setup to a saved camera.
 */
export default function PairScreen() {
  const router = useRouter();
  const session = useCameraSession();
  const params = useLocalSearchParams<{ camera?: string; step?: string }>();
  const saved = useSavedCameras((s) => s.cameras);
  const upsert = useSavedCameras((s) => s.upsert);
  const { connectNew, connectSaved } = useConnectActions();
  const diagnostics = useShareDiagnostics();

  const addSetupFor = params.step === 'setup' ? saved.find((c) => c.id === params.camera) ?? null : null;
  const [stage, setStage] = useState<Stage>(() => (addSetupFor ? 'setup' : permissionsExplained ? 'find' : 'permission'));
  const [found, setFound] = useState<DiscoveredCamera[]>([]);
  const [selection, setSelection] = useState<string | null>(params.camera ?? null);
  const [scanLooksEmpty, setScanLooksEmpty] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [kind, setKind] = useState<SetupKind | null>(null);
  const [draft, setDraft] = useState<NetworkDraft>({ ssid: '', password: '' });
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    if (stage !== 'find') return;
    setScanning(true);
    setScanLooksEmpty(false);
    const stop = session.startScan((cams) => {
      setFound(cams);
      if (cams.length) setScanLooksEmpty(false);
    });
    const empty = setTimeout(() => setScanLooksEmpty(true), 10_000);
    return () => {
      clearTimeout(empty);
      stop();
      setScanning(false);
    };
  }, [stage, session]);

  const selected = found.find((c) => c.id === selection) ?? null;
  const savedIds = useMemo(() => new Set(saved.map((c) => c.id)), [saved]);
  const subject = addSetupFor ?? selected;

  const exit = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const menuItems: PairMenuItem[] = [
    { id: 'diagnostics', title: 'Share Diagnostics', icon: Share08Icon, onPress: () => void diagnostics.share() },
    { id: 'watch', title: 'Watch a feed', icon: EyeIcon, onPress: () => router.push('/watcher') },
  ];

  const pathFor = (k: SetupKind): CameraNetworkPath => {
    switch (k) {
      case 'station':
        return { kind: 'station', ssid: draft.ssid.trim() };
      case 'hotspot':
        return { kind: 'hotspot', ssid: draft.ssid.trim() };
      default:
        return { kind: 'softap', ssid: addSetupFor?.path.kind === 'softap' ? addSetupFor.path.ssid : '' };
    }
  };

  const setupValid =
    kind === 'softap' ||
    (kind === 'station' && draft.ssid.trim().length > 0 && acceptsPassword(draft.password, false)) ||
    (kind === 'hotspot' && draft.ssid.trim().length > 0 && acceptsPassword(draft.password, true));

  const finishSetup = async () => {
    if (!kind || !subject) return;
    const path = pathFor(kind);
    const password = kind === 'softap' ? undefined : draft.password || undefined;
    if (password && path.ssid) await saveWifiPassword(subject.id, path.ssid, password);
    if (addSetupFor) {
      const updated: SavedCamera = { ...addSetupFor, path };
      upsert(updated);
      connectSaved(updated);
      return;
    }
    if (!selected) return;
    const record: SavedCamera = { id: selected.id, name: selected.name, model: selected.model, path };
    // Camera Wi-Fi: the camera hands its network over Bluetooth. Shared networks: the record
    // carries the path the camera should join, with its password.
    if (kind === 'softap') connectNew(selected, record);
    else connectNew(selected, record, password);
  };

  const notReady = 'Not in pairing mode';
  const devices = found.map((cam) => ({
    id: cam.id,
    name: cam.name,
    subtitle: `${modelDisplayName(cam.model)}${cam.pairable ? '' : ` · ${notReady.toLowerCase()}`}`,
    selected: cam.id === selection,
    bars: rssiToBars(cam.rssi),
    badge: savedIds.has(cam.id) || cam.saved ? 'Saved' : undefined,
    disabled: !cam.pairable,
  }));

  let page: React.ReactNode;
  let title: string;
  let body: string | null = null;
  let primary: { title: string; enabled: boolean; onPress: () => void } | null;
  let back: { title: string; onPress: () => void } | null = null;

  if (stage === 'permission') {
    title = PermissionCopy.title;
    primary = {
      title: PermissionCopy.action,
      enabled: true,
      onPress: () => {
        permissionsExplained = true;
        setStage('find');
      },
    };
    page = <PermissionList />;
    back = saved.length ? { title: 'Back', onPress: exit } : null;
  } else if (stage === 'find') {
    title = PairingWizardCopy.titles[0];
    body = PairingWizardCopy.bodies[0];
    primary = { title: 'Continue', enabled: !!selected?.pairable, onPress: () => setStage('setup') };
    back = saved.length ? { title: 'Back', onPress: exit } : null;
    const looking = scanning && !scanLooksEmpty;
    page = (
      <>
        {devices.length ? (
          <ListGroup label="Nearby">
            {devices.map((d, i) => (
              <DeviceRow key={d.id} device={d} onPress={() => setSelection(d.id)} last={i === devices.length - 1} />
            ))}
          </ListGroup>
        ) : (
          <NoteCard title={looking ? 'Looking for cameras' : 'No cameras yet'} busy={looking} />
        )}
        <InstructionCard
          instruction={
            scanLooksEmpty && !found.length
              ? { title: StartupConnectionCopy.scanEmptyTitle, icon: 'camera', lines: [StartupConnectionCopy.scanEmptyHint] }
              : { title: StartupConnectionCopy.preCheckTitle, icon: 'phone', lines: [StartupConnectionCopy.preCheck] }
          }
        />
      </>
    );
  } else if (stage === 'setup') {
    title = SetupChooserText.title;
    // Camera Wi-Fi needs nothing typed, so it connects from here; the others ask for a network next.
    primary =
      kind === 'softap'
        ? { title: 'Connect', enabled: setupValid && !!subject, onPress: () => void finishSetup() }
        : { title: 'Continue', enabled: !!kind && !!subject, onPress: () => setStage('details') };
    back = { title: 'Back', onPress: () => (addSetupFor ? exit() : setStage('find')) };
    const added = addSetupFor ? { [addSetupFor.path.kind]: addSetupFor.path.ssid || 'saved' } : undefined;
    page = (
      <SetupChooser
        selected={kind}
        added={added}
        onSelect={(k) => {
          setKind(k);
          if (k !== kind) setDraft({ ssid: '', password: '' });
        }}
      />
    );
  } else {
    const hotspot = kind === 'hotspot';
    title = hotspot ? 'Personal Hotspot' : NetworkSetupCopy.networkTitle;
    body = hotspot ? null : NetworkSetupCopy.networkHint;
    primary = {
      title: kind === 'station' ? 'Connect over Wi-Fi' : kind === 'hotspot' ? 'Connect over Hotspot' : 'Connect',
      enabled: !!kind && setupValid && !!subject,
      onPress: () => void finishSetup(),
    };
    back = { title: 'Back', onPress: () => setStage('setup') };
    page = kind === 'station' ? <StationNetworkForm draft={draft} onChange={setDraft} /> : <HotspotForm draft={draft} onChange={setDraft} />;
  }

  return (
    <>
      <PairPage
        heading={addSetupFor ? 'Add setup' : 'Pair a camera'}
        steps={steps}
        currentStep={0}
        title={title}
        body={body}
        target={(stage === 'setup' || stage === 'details') && subject ? `${subject.name} · ${modelDisplayName(subject.model)}` : null}
        hint={diagnostics.note}
        progress={stage === 'find' && scanning && !scanLooksEmpty && found.length ? 'Scanning for camera…' : null}
        primaryAction={primary}
        backAction={back}
        onExit={exit}
        menuItems={menuItems}
        onReportProblem={() => setReporting(true)}
      >
        {page}
      </PairPage>
      <ProblemReportSheet visible={reporting} onClose={() => setReporting(false)} />
    </>
  );
}
