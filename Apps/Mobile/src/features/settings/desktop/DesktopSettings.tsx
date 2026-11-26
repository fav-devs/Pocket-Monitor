/**
 * Settings rows only the desktop app has (`docs/desktop-expo-port.md` A2, D-2/D-3, Y1/Y2).
 * Each renders nothing outside the Tauri app.
 *
 * - `DesktopAppRows` (Operator): the old home screen's settings, kept in `desktop-app-v1.txt`.
 * - `DesktopNetworkRows` (Connection): the camera on this PC's home Wi-Fi, and a search for it.
 * - `DesktopSupportRows` (Support): the log, the folders, and a report written to disk.
 */
import { File01Icon, Folder01Icon, CameraSmileIcon, KeyboardIcon, Note01Icon, Router01Icon, Search01Icon, Video01Icon } from '@hugeicons/core-free-icons';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Text } from 'react-native';
import { useCameraSession } from '@/camera';
import { desktopCameraEnabled } from '@/camera/bootstrap';
import {
  appSettingsGet,
  appSettingsSet,
  diagnosticsPaths,
  findStationCamera,
  keyboardShortcuts,
  knownCameras,
  openDesktopFolder,
  writeDiagnostics,
  type DesktopAppSettings,
  type DesktopPaths,
  type KnownCamera,
} from '@/camera/desktop/connect';
import { fonts, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { usePreferences } from '@/state/preferences';
import { useSavedCameras } from '@/state/savedCameras';
import { ActionRow, Group, LinkRow, SwitchRow, ValueRow } from '../components/ui';
import { buildDiagnosticsReport } from '../diagnostics';

const message = (error: unknown) => (typeof error === 'string' ? error : error instanceof Error ? error.message : 'That did not work.');

/** Webcam gestures, open the camera at launch, and the viewfinder's key list (A2). */
export function DesktopAppRows() {
  const styles = useThemedStyles(createStyles);
  const [settings, setSettings] = useState<DesktopAppSettings | null>(null);
  const [keys, setKeys] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [gesturesChanged, setGesturesChanged] = useState(false);

  useEffect(() => {
    if (!desktopCameraEnabled) return;
    appSettingsGet()
      .then(setSettings)
      .catch(() => {});
  }, []);

  if (!desktopCameraEnabled) return null;

  const change = (patch: Partial<DesktopAppSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    appSettingsSet(next)
      .then(() => setNote(null))
      .catch((error) => {
        setSettings(settings);
        setNote(message(error));
      });
  };

  const toggleKeys = () => {
    if (keys) return setKeys(null);
    keyboardShortcuts()
      .then(setKeys)
      .catch(() => {});
  };

  return (
    <Group label="Desktop" note={note ?? (gesturesChanged ? 'Applies at the next launch.' : undefined)}>
      <SwitchRow
        icon={CameraSmileIcon}
        title="Webcam gestures"
        value={!!settings?.gestures}
        disabled={!settings}
        onChange={(gestures) => {
          setGesturesChanged(true);
          change({ gestures });
        }}
        testID="desktop.gestures"
      />
      <SwitchRow
        icon={Video01Icon}
        title="Open camera at launch"
        value={!!settings?.openCameraAtLaunch}
        disabled={!settings}
        onChange={(openCameraAtLaunch) => change({ openCameraAtLaunch })}
        testID="desktop.openAtLaunch"
      />
      <LinkRow icon={KeyboardIcon} title="Keyboard shortcuts" value={keys ? 'Hide' : undefined} onPress={toggleKeys} last={!keys} />
      {keys ? (
        <Text selectable style={styles.keys}>
          {keys}
        </Text>
      ) : null}
    </Group>
  );
}

/** The camera on this PC's Wi-Fi: which network, and a search for it now (D-2, D-3). */
export function DesktopNetworkRows() {
  const [station, setStation] = useState<KnownCamera | null>(null);
  const [state, setState] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });

  useEffect(() => {
    if (!desktopCameraEnabled) return;
    knownCameras()
      .then((known) => setStation(known.find((k) => k.kind === 'station') ?? null))
      .catch(() => {});
  }, []);

  if (!desktopCameraEnabled) return null;

  const find = async () => {
    setState({ busy: true, note: null });
    try {
      const host = await findStationCamera();
      setState({ busy: false, note: `Found at ${host}` });
    } catch (error) {
      setState({ busy: false, note: message(error) });
    }
  };

  return (
    <Group label="This PC" note={state.note}>
      <ValueRow icon={Router01Icon} title="Home Wi-Fi camera" value={station?.ssid ?? 'None'} last={!station} />
      {station ? (
        <ActionRow
          icon={Search01Icon}
          title="Find on this network"
          action={state.busy ? 'Searching…' : 'Find'}
          disabled={state.busy}
          onPress={() => void find()}
          testID="desktop.stationFind"
          last
        />
      ) : null}
    </Group>
  );
}

/** The log (Y1), the folders, and a report written beside the LUT folder (Y2). */
export function DesktopSupportRows() {
  const session = useCameraSession();
  const [paths, setPaths] = useState<DesktopPaths | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!desktopCameraEnabled) return;
    diagnosticsPaths()
      .then(setPaths)
      .catch(() => {});
  }, []);

  const write = useCallback(async () => {
    try {
      const report = buildDiagnosticsReport({
        session,
        saved: useSavedCameras.getState().cameras,
        preferences: usePreferences.getState(),
      });
      const path = await writeDiagnostics(report);
      setNote(`Written to ${path}`);
    } catch (error) {
      setNote(message(error));
    }
  }, [session]);

  if (!desktopCameraEnabled) return null;

  const open = (which: 'logs' | 'data' | 'luts') => openDesktopFolder(which).catch((error) => setNote(message(error)));
  const fileName = (path?: string | null) => (path ? (path.split(/[\\/]/).pop() ?? path) : 'None');

  return (
    <Group label="This PC" note={note}>
      <LinkRow icon={File01Icon} title="Log" value={fileName(paths?.log)} onPress={() => void open('logs')} testID="desktop.logs" />
      <ActionRow icon={Note01Icon} title="Diagnostics report" action="Write" onPress={() => void write()} testID="desktop.diagnostics" />
      <LinkRow icon={Folder01Icon} title="Settings folder" onPress={() => void open('data')} />
      <LinkRow icon={Folder01Icon} title="LUT folder" onPress={() => void open('luts')} last />
    </Group>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    keys: {
      fontFamily: Platform.OS === 'web' ? 'ui-monospace, Consolas, monospace' : fonts.regular,
      fontSize: 12,
      lineHeight: 18,
      color: colors.mutedForeground,
      paddingHorizontal: 16,
      paddingBottom: 14,
    },
  };
}
