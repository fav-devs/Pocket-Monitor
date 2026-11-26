import { useLocalSearchParams, useRouter } from 'expo-router';
import { Bluetooth, MapPin, Wifi } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useCameraSession } from '@/camera';
import { modelDisplayName } from '@/camera/defaults';
import type { CameraNetworkPath, DiscoveredCamera, SavedCamera } from '@/camera/types';
import { ProblemReportSheet } from '@/features/settings/ProblemReportSheet';
import { useShareDiagnostics } from '@/features/settings/useShareDiagnostics';
import { useSavedCameras } from '@/state/savedCameras';
import { MText, colors, withAlpha } from '@/theme';
import { DeviceRow, InstructionCard, NoteCard } from './components/PairPieces';
import { PairPage } from './components/PairPage';
import { PairingWizardCopy, PermissionCopy, SetupChooserCopy, SetupChooserText, StartupConnectionCopy, type SetupKind } from './copy';
import { saveWifiPassword } from './credentials';
import { rssiToBars } from './presentation';
import { HotspotForm, SetupChooser, SoftApSummary, StationNetworkForm, acceptsPassword, type NetworkDraft } from './SetupFlow';
import { useConnectActions } from './useConnectActions';

type Stage = 'permission' | 'find' | 'setup';

let permissionsExplained = false;

const steps = PairingWizardCopy.titles.map((title, i) => ({ title, subtitle: PairingWizardCopy.rail[i] }));

function PermissionList() {
  const icons = { bluetooth: Bluetooth, localNetwork: Wifi, location: MapPin } as const;
  return (
    <View style={{ gap: 8 }}>
      {PermissionCopy.items.map((item) => {
        const Icon = icons[item.id as keyof typeof icons];
        return (
          <View
            key={item.id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              padding: 13,
              borderRadius: 11,
              backgroundColor: 'rgba(255,255,255,0.03)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.06)',
            }}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: withAlpha(colors.accent, 0.12),
              }}
            >
              <Icon size={16} color={colors.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <MText size={13} weight="semibold">
                {item.title}
              </MText>
              <MText size={11} color={colors.muted}>
                {item.detail}
              </MText>
            </View>
          </View>
        );
      })}
    </View>
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
  const subjectName = subject?.name ?? null;

  const exit = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const menuItems = [
    { id: 'diagnostics', title: 'Share Diagnostics', onPress: () => void diagnostics.share() },
    { id: 'watch', title: 'Watch a feed', onPress: () => router.push('/watcher') },
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

  const notReady = 'Not in pairing mode yet';
  const devices = found.map((cam) => ({
    id: cam.id,
    name: cam.name,
    subtitle: `${modelDisplayName(cam.model)}${cam.pairable ? '' : ` · ${notReady.toLowerCase()}`}`,
    selected: cam.id === selection,
    bars: rssiToBars(cam.rssi),
    badge: savedIds.has(cam.id) || cam.saved ? 'SAVED' : undefined,
    disabled: !cam.pairable,
  }));

  let page: React.ReactNode;
  let title: string;
  let body: string;
  let hint: string;
  let primary: { title: string; enabled: boolean; onPress: () => void } | null;
  let back: { title: string; onPress: () => void } | null = null;

  if (stage === 'permission') {
    title = PermissionCopy.title;
    body = PermissionCopy.body;
    hint = 'Nothing is shared outside this phone and the camera';
    primary = {
      title: PermissionCopy.action,
      enabled: true,
      onPress: () => {
        permissionsExplained = true;
        setStage('find');
      },
    };
    page = (
      <>
        <PermissionList />
        <InstructionCard instruction={{ title: StartupConnectionCopy.preCheckTitle, icon: 'phone', lines: [StartupConnectionCopy.preCheck] }} />
      </>
    );
    back = saved.length ? { title: 'Back', onPress: exit } : null;
  } else if (stage === 'find') {
    title = PairingWizardCopy.titles[0];
    body = PairingWizardCopy.bodies[0];
    hint = selected ? `Selected ${selected.name}` : PairingWizardCopy.hints[0];
    primary = { title: 'Continue', enabled: !!selected?.pairable, onPress: () => setStage('setup') };
    back = saved.length ? { title: 'Back', onPress: exit } : null;
    page = (
      <>
        {devices.map((d) => (
          <DeviceRow key={d.id} device={d} onPress={() => setSelection(d.id)} />
        ))}
        {!found.length ? <NoteCard title={scanning && !scanLooksEmpty ? 'Looking for cameras' : 'No cameras yet'} /> : null}
        <InstructionCard
          instruction={
            scanLooksEmpty && !found.length
              ? { title: StartupConnectionCopy.scanEmptyTitle, icon: 'camera', lines: [StartupConnectionCopy.scanEmptyHint] }
              : { title: StartupConnectionCopy.preCheckTitle, icon: 'phone', lines: [StartupConnectionCopy.preCheck] }
          }
        />
      </>
    );
  } else {
    const chosen = kind ? SetupChooserCopy[kind] : null;
    const who = subject ? `${subject.name} · ${modelDisplayName(subject.model)}. ` : '';
    title = SetupChooserText.title;
    body = addSetupFor
      ? `${who}Choose another way to reach this camera.`
      : `${who}Camera Wi-Fi works anywhere with nothing to type.`;
    hint = chosen ? `${chosen.title} · ${chosen.tag}` : 'Choose a setup to continue';
    primary = {
      title: kind === 'station' ? 'Connect over Wi-Fi' : kind === 'hotspot' ? 'Connect over Hotspot' : 'Connect',
      enabled: !!kind && setupValid && !!subject,
      onPress: () => void finishSetup(),
    };
    back = { title: 'Back', onPress: () => (addSetupFor ? exit() : setStage('find')) };
    const detail = subject ? `${subject.name} · ${modelDisplayName(subject.model)}` : '';
    const added = addSetupFor ? { [addSetupFor.path.kind]: addSetupFor.path.ssid || 'saved' } : undefined;
    page = (
      <View style={{ gap: 16 }}>
        <SetupChooser
          showTitle={false}
          detail={detail}
          selected={kind}
          added={added}
          onSelect={(k) => {
            setKind(k);
            if (k !== kind) setDraft({ ssid: '', password: '' });
          }}
        />
        {kind === 'softap' ? <SoftApSummary cameraName={subjectName ?? 'The camera'} /> : null}
        {kind === 'station' ? <StationNetworkForm draft={draft} onChange={setDraft} /> : null}
        {kind === 'hotspot' ? <HotspotForm draft={draft} onChange={setDraft} /> : null}
      </View>
    );
  }

  return (
    <>
      <PairPage
        heading={addSetupFor ? 'Add setup' : 'Pair a camera'}
        steps={steps}
        currentStep={0}
        title={title}
        body={body}
        target={subjectName ?? 'Nothing selected yet'}
        hint={diagnostics.note ?? hint}
        progress={stage === 'find' && scanning && !scanLooksEmpty ? 'Scanning for camera…' : null}
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
