/**
 * Server (`/server`): keep one camera connected and share it with every watcher on the network,
 * with the screen off. Android runs a foreground service (src/camera/server); the web preview
 * shows the same UI with a simulated server; iOS says server mode is Android-only.
 */
import {
  BatteryCharging01Icon,
  Camera01Icon,
  Clock01Icon,
  HotspotIcon,
  Link01Icon,
  PlusSignIcon,
  Router01Icon,
  ServerStack01Icon,
  Settings02Icon,
  SmartPhone01Icon,
  StopIcon,
  UserGroupIcon,
  Wifi01Icon,
  WifiConnected01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react-native";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Linking, Platform, Text, View } from "react-native";
import { useCamera, useCameraSession } from "@/camera";
import { modelDisplayName } from "@/camera/defaults";
import {
  availableSetups,
  defaultSetup,
  linkLabel,
  serverBackground,
  serverController,
  serverPlatform,
  setupReadiness,
  useAppActive,
  useServer,
  watchersLabel,
  type ServerSetup,
} from "@/camera/server";
import type { SavedCamera } from "@/camera/types";
import { Button } from "@/components/button";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
} from "@/components/settings-ui";
import {
  fonts,
  radius,
  spacing,
  type ThemeColors,
  useTheme,
  useThemedStyles,
} from "@/constants/theme";
import { ChoiceRow, ListGroup } from "@/features/pairing/components/PairPieces";
import { DEMO_CAMERA } from "@/features/pairing/useConnectActions";
import LivePicture from "@/features/picture/LivePicture";
import { ValueText } from "@/features/settings/components/ui";
import { useSavedCameras } from "@/state/savedCameras";
import { recordRed } from '@/constants/monitor';
import type {
  ServerDeviceStatus,
  ServerPrimaryWifi,
} from "@modules/pocket-native/src/types";
import {
  phoneLabel,
  ServerScreenCopy as Copy,
  SetupCopy,
  uptimeLabel,
} from "./copy";

const setupIcons: Record<ServerSetup, IconSvgElement> = {
  station: Router01Icon,
  dual: WifiConnected01Icon,
  hotspot: HotspotIcon,
};

/** Web preview: the demo camera, already set up on the simulated "Studio" Wi-Fi. */
const PREVIEW_CAMERA: SavedCamera = {
  ...DEMO_CAMERA,
  path: { kind: "station", ssid: "Studio" },
};

export default function ServerScreen() {
  if (serverPlatform === "unsupported") return <AndroidOnly />;
  return <ServerPanel />;
}

function AndroidOnly() {
  const styles = useThemedStyles(createStyles);
  return (
    <SettingsPage title={Copy.title}>
      <Text style={styles.line}>{Copy.androidOnly}</Text>
    </SettingsPage>
  );
}

/** Polls a value while the screen is in front (JS timers stop in the background anyway). */
function usePolled<T>(
  read: () => Promise<T> | T,
  ms: number,
  enabled: boolean,
): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const run = () => {
      Promise.resolve()
        .then(read)
        .then((v) => alive && setValue(v))
        .catch(() => {});
    };
    run();
    const t = setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // `read` is a stable module call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, enabled]);
  return value;
}

function ServerPanel() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const server = useServer();
  const active = useAppActive();
  const session = useCameraSession();
  const saved = useSavedCameras((s) => s.cameras);
  const liveId = useCamera((s) =>
    s.connection.phase === "live" ? s.identity?.id : undefined,
  );
  const phase = useCamera((s) => s.connection.phase);
  const recording = useCamera((s) => s.recording.recording);
  const elapsed = useCamera((s) => s.recording.elapsedSec);
  const cameraSsid = useCamera((s) => s.identity?.ssid);

  const preview = serverPlatform === "preview";
  const cameras = useMemo(
    () =>
      preview && !saved.some((c) => c.id === PREVIEW_CAMERA.id)
        ? [...saved, PREVIEW_CAMERA]
        : saved,
    [preview, saved],
  );
  const caps = useMemo(() => serverBackground?.capabilities() ?? null, []);
  const available = useMemo(() => availableSetups(caps), [caps]);

  const serving = server.status === "serving" || server.status === "starting";
  const busy = server.status === "starting" || server.status === "stopping";
  const [pickedCamera, setPickedCamera] = useState<string | null>(null);
  const [pickedSetup, setPickedSetup] = useState<ServerSetup | null>(null);
  const cameraId =
    (serving ? server.cameraId : null) ??
    pickedCamera ??
    liveId ??
    cameras[0]?.id ??
    null;
  const camera = cameras.find((c) => c.id === cameraId) ?? null;
  const setup: ServerSetup =
    (serving ? server.setup : null) ??
    (pickedSetup && available.includes(pickedSetup)
      ? pickedSetup
      : defaultSetup(camera, available));

  const phoneWifi = usePolled<ServerPrimaryWifi | null>(
    () => serverBackground?.primaryWifi() ?? null,
    5000,
    active,
  );
  const device = usePolled<ServerDeviceStatus | null>(
    () => serverBackground?.deviceStatus() ?? null,
    10000,
    active,
  );
  const readiness = setupReadiness(setup, camera, phoneWifi?.ssid ?? null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!serving || !active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [serving, active]);

  const start = () => {
    if (!camera || !readiness.ready) return;
    void serverController.start(setup, camera);
  };
  const stop = () => void serverController.stop();

  const metaFor = (s: ServerSetup): string | undefined => {
    const r = setupReadiness(s, camera, phoneWifi?.ssid ?? null);
    if (!camera) return s === "station" ? Copy.recommended : undefined;
    if (r.ready)
      return s === "dual" ? "Camera Wi-Fi" : camera.path.ssid || undefined;
    if (r.need === "join-wifi") return r.ssid;
    return s === "station" ? Copy.recommended : Copy.notSetUp;
  };

  const networkValue = () => {
    const phone = phoneWifi?.ssid ?? "Wi-Fi";
    if (setup === "dual") return `${cameraSsid ?? "Camera Wi-Fi"} + ${phone}`;
    if (setup === "hotspot")
      return camera?.path.ssid ? `Hotspot · ${camera.path.ssid}` : "Hotspot";
    return phone;
  };

  const showPicture = serving && active && session.video.kind !== "none";
  const relayMissing = server.relay.state === "unavailable";
  const watcherNames = server.relay.names.join(", ");
  const linkColor =
    phase === "live"
      ? colors.success
      : phase === "failed"
        ? colors.destructive
        : colors.warning;

  const hint =
    !serving && readiness.ready === false && readiness.need === "join-wifi"
      ? Copy.joinFirst(readiness.ssid)
      : !serving && setup === "hotspot"
        ? Copy.hotspotStep
        : null;

  const openSettings = () => {
    if (Platform.OS === "android") {
      const action =
        setup === "hotspot"
          ? "android.settings.WIRELESS_SETTINGS"
          : "android.settings.WIFI_SETTINGS";
      Linking.sendIntent(action).catch(() =>
        Linking.openSettings().catch(() => {}),
      );
    }
  };

  return (
    <SettingsPage title={Copy.title}>
      {showPicture ? (
        <View style={styles.picture} testID="server.preview">
          <LivePicture source={session.video} resizeMode="fit" />
          <View style={styles.pills} pointerEvents="none">
            <View style={styles.pill}>
              <View style={[styles.dot, { backgroundColor: linkColor }]} />
              <Text style={styles.pillText}>{linkLabel(phase)}</Text>
            </View>
            {recording ? (
              <View style={styles.pill}>
                <View
                  style={[styles.dot, { backgroundColor: recordRed }]}
                />
                <Text
                  style={styles.pillText}
                >{`REC ${uptimeLabel(elapsed * 1000)}`}</Text>
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      {serving ? (
        <SettingsGroup label={Copy.status}>
          <SettingsRow
            icon={Link01Icon}
            title={Copy.rows.link}
            accessory={<ValueText value={linkLabel(phase)} color={linkColor} />}
          />
          <SettingsRow
            icon={Wifi01Icon}
            title={Copy.rows.network}
            accessory={<ValueText value={networkValue()} />}
          />
          <SettingsRow
            icon={UserGroupIcon}
            title={Copy.rows.watchers}
            subtitle={watcherNames || undefined}
            accessory={
              <ValueText
                value={
                  relayMissing
                    ? "Relay not in this build"
                    : watchersLabel(server.relay.watchers)
                }
              />
            }
          />
          <SettingsRow
            icon={Clock01Icon}
            title={Copy.rows.uptime}
            accessory={
              <ValueText
                value={
                  server.startedAt ? uptimeLabel(now - server.startedAt) : "—"
                }
              />
            }
          />
          <SettingsRow
            icon={device?.charging ? BatteryCharging01Icon : SmartPhone01Icon}
            title={Copy.rows.phone}
            accessory={<ValueText value={phoneLabel(device)} />}
            last
          />
        </SettingsGroup>
      ) : null}

      {serving ? null : cameras.length ? (
        <ListGroup label={Copy.camera}>
          {cameras.map((c, i) => (
            <ChoiceRow
              key={c.id}
              testID={`server.camera.${c.id}`}
              icon={Camera01Icon}
              title={c.name}
              meta={modelDisplayName(c.model)}
              selected={c.id === cameraId}
              disabled={serving || busy}
              onPress={() => setPickedCamera(c.id)}
              last={i === cameras.length - 1}
            />
          ))}
        </ListGroup>
      ) : (
        <SettingsGroup label={Copy.camera}>
          <SettingsRow
            icon={PlusSignIcon}
            title={Copy.pairCamera}
            chevron
            onPress={() => router.push("/pair")}
            last
          />
        </SettingsGroup>
      )}

      {serving ? null : (
        <View style={styles.block}>
          <ListGroup label={Copy.network}>
            {available.map((s, i) => (
              <ChoiceRow
                key={s}
                testID={`server.setup.${s}`}
                icon={setupIcons[s]}
                title={SetupCopy[s].title}
                meta={metaFor(s)}
                selected={s === setup}
                disabled={serving || busy}
                onPress={() => setPickedSetup(s)}
                last={i === available.length - 1}
              />
            ))}
          </ListGroup>
          {hint ? <Text style={styles.note}>{hint}</Text> : null}
        </View>
      )}

      <View style={styles.actions}>
        {server.status === "failed" && server.error ? (
          <Text style={styles.error}>{server.error}</Text>
        ) : null}
        {serving || server.status === "stopping" ? (
          <Button
            testID="server.stop"
            title={Copy.stop}
            icon={StopIcon}
            size="lg"
            variant="secondary"
            destructive
            loading={server.status === "stopping"}
            disabled={busy}
            onPress={stop}
          />
        ) : (
          <Button
            testID="server.start"
            title={Copy.start}
            icon={ServerStack01Icon}
            size="lg"
            disabled={!readiness.ready || busy}
            loading={server.status === "starting"}
            onPress={start}
          />
        )}
        {!serving &&
        !readiness.ready &&
        readiness.need === "add-setup" &&
        camera ? (
          <Button
            title={Copy.setUpCamera}
            variant="ghost"
            onPress={() =>
              router.push({
                pathname: "/pair",
                params: { camera: camera.id, step: "setup" },
              })
            }
          />
        ) : null}
        {!serving && !readiness.ready && readiness.need === "camera" ? (
          <Button
            title={Copy.pairCamera}
            variant="ghost"
            onPress={() => router.push("/pair")}
          />
        ) : null}
        {!serving &&
        Platform.OS === "android" &&
        (setup === "hotspot" ||
          (!readiness.ready && readiness.need === "join-wifi")) ? (
          <Button
            title="Open Settings"
            icon={Settings02Icon}
            variant="ghost"
            onPress={openSettings}
          />
        ) : null}
      </View>
    </SettingsPage>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    line: {
      fontFamily: fonts.regular,
      fontSize: 15,
      lineHeight: 21,
      color: colors.mutedForeground,
    },
    block: { gap: 8 },
    note: {
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 17,
      color: colors.mutedForeground,
      paddingHorizontal: 4,
    },
    actions: { gap: spacing.sm },
    error: {
      fontFamily: fonts.medium,
      fontSize: 13,
      lineHeight: 18,
      color: colors.destructive,
      paddingHorizontal: 4,
    },
    picture: {
      aspectRatio: 16 / 9,
      borderRadius: 14,
      overflow: "hidden" as const,
      backgroundColor: colors.preview,
    },
    pills: {
      position: "absolute" as const,
      top: 10,
      left: 10,
      right: 10,
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
    },
    pill: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      backgroundColor: "rgba(0,0,0,0.5)",
      borderRadius: radius.pill,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    dot: { width: 7, height: 7, borderRadius: 4 },
    pillText: {
      fontFamily: fonts.semibold,
      fontSize: 12,
      color: "#fff",
      textShadowColor: "rgba(0,0,0,0.55)",
      textShadowRadius: 4,
    },
  };
}
