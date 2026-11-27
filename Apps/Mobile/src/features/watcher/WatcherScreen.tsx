/**
 * Join as watcher (§1.E): watch a feed a phone is sharing on this Wi-Fi.
 *
 * - Desktop app (Tauri): the Rust backend finds the sharing phones (`relay://hosts`), joins one
 *   and runs the whole viewfinder on its picture: the live screen reads the phone's state like a
 *   camera's, and controls the relay wire carries go to the phone once it grants control.
 * - Phones: the native relay (`PocketRelay`) browses `_pocket-mon._tcp` and the legacy
 *   `_opc-mon._tcp`, joins as a `WatcherCameraSession`, and the watcher monitor shows the
 *   picture with local assists (`WatcherBrowse` → `WatcherLiveView`).
 * - Browser preview: the same screens on simulated hosts and the demo picture.
 */
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ArrowLeft01Icon, LiveStreaming01Icon, SmartPhone01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { controlCopy, relay, type RelayHost, type RelayHosts, type RelayInfo } from '@/camera/desktop/relay';
import { isTauri } from '@/camera/desktop/tauri';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { TextField } from '@/components/text-field';
import { DEMO_HOSTS } from '@/camera/watcher/demo';
import { joinHostWifi, watcherWifiJoinAvailable, wifiJoinCopy } from '@/camera/watcher/joinWifi';
import { WifiQrScanner, wifiQrScanAvailable } from '@/features/pairing/WifiQrScanner';
import { useWatcher } from './useWatcher';
import { WatcherBrowse } from './WatcherBrowse';
import { WatcherLiveView } from './WatcherLiveView';
import { CONTENT_MAX_WIDTH } from '@/constants/layout';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function BackButton() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} onPress={goBack} style={({ pressed }) => [styles.back, pressed && { opacity: 0.7 }]}>
      <Icon icon={ArrowLeft01Icon} size={24} color={colors.foreground} />
    </Pressable>
  );
}

const demoLatency = (id: string) => DEMO_HOSTS.find((h) => h.id === id)?.latencyMs;

/** Phones and the browser preview. */
function PhoneWatcher() {
  const w = useWatcher();
  const [scanning, setScanning] = useState(false);
  const [wifi, setWifi] = useState<{ joining: boolean; message: string | null }>({ joining: false, message: null });
  const exit = () => {
    w.leave();
    goBack();
  };
  if (w.session && w.accepted) {
    return <WatcherLiveView session={w.session} info={w.info} onLeave={exit} onChooseFeed={w.chooseFeed} />;
  }
  const canScan = wifiQrScanAvailable && watcherWifiJoinAvailable;
  return (
    <>
      <WatcherBrowse
        hosts={w.hosts}
        host={w.host}
        info={w.info}
        onBack={exit}
        onJoin={(host) => w.join(host)}
        onPasscode={w.answerPasscode}
        onScanWifi={canScan ? () => setScanning(true) : null}
        wifiMessage={wifi.message}
        wifiJoining={wifi.joining}
        latency={w.simulated ? demoLatency : undefined}
      />
      {canScan ? (
        <WifiQrScanner
          visible={scanning}
          onClose={() => setScanning(false)}
          onScanned={(code) => {
            setScanning(false);
            setWifi({ joining: true, message: null });
            void joinHostWifi(code.ssid, code.password).then((result) => setWifi({ joining: false, message: wifiJoinCopy(result) }));
          }}
        />
      ) : null}
    </>
  );
}

function HostRow({ host, selected, onPress, last }: { host: RelayHost; selected: boolean; onPress: () => void; last: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={host.name}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.hostRow, !last && styles.rowBorder, pressed && { opacity: 0.75 }]}
    >
      <Squircle width={36} height={36} radius={12} color={selected ? colors.ink : colors.surfaceStrong}>
        <Icon icon={SmartPhone01Icon} size={18} color={selected ? colors.inkForeground : colors.foreground} strokeWidth={selected ? 2 : 1.5} />
      </Squircle>
      <View style={styles.hostText}>
        <Text style={styles.hostName} numberOfLines={1}>
          {host.name}
        </Text>
        {host.camera ? (
          <Text style={styles.hostMeta} numberOfLines={1}>
            {host.camera}
          </Text>
        ) : null}
      </View>
      {selected ? <Icon icon={Tick02Icon} size={20} color={colors.primary} /> : null}
    </Pressable>
  );
}

function Readout({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.readout, !last && styles.rowBorder]}>
      <Text style={styles.readoutLabel}>{label}</Text>
      <Text style={styles.readoutValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const PHASE_COPY: Record<RelayInfo['phase'], string> = {
  idle: 'Not watching',
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  failed: 'Lost',
};

/** The phone being watched: its readouts, the control lease, the viewfinder. */
function Watching({ info }: { info: RelayInfo }) {
  const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const canRequest = info.control === 'available';
  const canRelease = info.control === 'held' || info.control === 'requested';
  const leave = () => {
    setBusy(true);
    relay
      .leave()
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Text style={styles.title} numberOfLines={1}>
        {info.host || 'Phone'}
      </Text>
      <Text style={styles.subtitle} numberOfLines={2}>
        {info.detail || PHASE_COPY[info.phase]}
      </Text>
      <View style={styles.card}>
        <Readout label="Status" value={PHASE_COPY[info.phase]} />
        {info.camera ? <Readout label="Camera" value={info.camera} /> : null}
        {info.format ? <Readout label="Format" value={[info.format, info.liveFps].filter(Boolean).join(' · ')} /> : null}
        {info.color ? <Readout label="Colour" value={info.color} /> : null}
        <View style={styles.readout}>
          <Text style={styles.readoutLabel}>Control</Text>
          <Text style={[styles.readoutValue, { flex: 1 }]} numberOfLines={1}>
            {controlCopy(info)}
          </Text>
          {canRequest ? (
            <Pressable accessibilityRole="button" onPress={() => void relay.control(true)} hitSlop={8} style={styles.textAction}>
              <Text style={styles.textActionLabel}>Request</Text>
            </Pressable>
          ) : canRelease ? (
            <Pressable accessibilityRole="button" onPress={() => void relay.control(false)} hitSlop={8} style={styles.textAction}>
              <Text style={styles.textActionLabel}>Release</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={styles.footer}>
        <Button title="Open viewfinder" size="lg" icon={LiveStreaming01Icon} onPress={() => router.push('/live')} disabled={info.phase === 'failed'} />
        <Button title="Stop watching" variant="ghost" onPress={leave} loading={busy} />
      </View>
    </>
  );
}

function DesktopWatcher() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const [hosts, setHosts] = useState<RelayHosts>({ hosts: [], browsing: true, error: null });
  const [info, setInfo] = useState<RelayInfo | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [passcode, setPasscode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const watching = !!info && info.phase !== 'idle';

  useEffect(() => {
    const stops = [relay.onHosts(setHosts), relay.onInfo(setInfo)];
    relay
      .info()
      .then(setInfo)
      .catch(() => {});
    return () => stops.forEach((s) => s());
  }, []);

  // Look for phones only while the list is on screen.
  useEffect(() => {
    if (watching) return;
    relay
      .browse(true)
      .then(setHosts)
      .catch((e) => setError(String(e)));
    return () => {
      relay.browse(false).catch(() => {});
    };
  }, [watching]);

  const host = hosts.hosts.find((h) => h.name === picked) ?? (hosts.hosts.length === 1 ? hosts.hosts[0] : undefined);
  const join = () => {
    if (!host) return;
    setJoining(true);
    setError(null);
    relay
      .join({ name: host.name, passcode: passcode.trim(), addresses: host.addresses, port: host.port })
      .then(() => router.push('/live'))
      .catch((e) => setError(typeof e === 'string' ? e : 'Could not join the phone.'))
      .finally(() => setJoining(false));
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm, paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
      <BackButton />
      <ScrollView contentContainerStyle={styles.column} keyboardShouldPersistTaps="handled">
        {watching && info ? (
          <Watching info={info} />
        ) : (
          <>
            <Text style={styles.title}>Watch a phone</Text>
            <Text style={styles.subtitle}>Phones sharing on this Wi-Fi</Text>
            {hosts.hosts.length ? (
              <View style={styles.card}>
                {hosts.hosts.map((h, i) => (
                  <HostRow key={h.name} host={h} selected={host?.name === h.name} onPress={() => setPicked(h.name)} last={i === hosts.hosts.length - 1} />
                ))}
              </View>
            ) : (
              <View style={styles.empty}>
                <Squircle width={56} height={56} radius={18} color={colors.surface}>
                  {hosts.browsing && !hosts.error ? <Spinner opacity={1} color={colors.mutedForeground} /> : <Icon icon={SmartPhone01Icon} size={24} color={colors.mutedForeground} />}
                </Squircle>
                <Text style={styles.emptyTitle}>{hosts.error ? 'Can’t look for phones' : 'Looking for phones…'}</Text>
                <Text style={styles.line}>{hosts.error ?? 'Turn on Sharing on the phone.'}</Text>
              </View>
            )}
            <Text style={styles.fieldLabel}>Passcode</Text>
            <TextField
              value={passcode}
              onChangeText={setPasscode}
              placeholder="If the phone asks for one"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              onSubmitEditing={join}
              style={styles.input}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.footer}>
              <Button title={host ? `Watch ${host.name}` : 'Watch'} size="lg" onPress={join} loading={joining} disabled={!host} />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

export default function WatcherScreen() {
  return isTauri() ? <DesktopWatcher /> : <PhoneWatcher />;
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.md },
    back: { alignSelf: 'flex-start' as const, paddingVertical: 4, marginLeft: -4, minHeight: 44, justifyContent: 'center' as const },
    center: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, gap: spacing.sm },
    column: { width: '100%' as const, maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' as const, gap: spacing.sm, paddingTop: spacing.md, paddingBottom: spacing.lg },
    title: { fontFamily: fonts.semibold, fontSize: 28, letterSpacing: -0.6, color: colors.foreground },
    subtitle: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, marginBottom: spacing.sm },
    card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' as const },
    rowBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    hostRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingHorizontal: spacing.md, minHeight: 60 },
    hostText: { flex: 1, minWidth: 0, gap: 2 },
    hostName: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    hostMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
    empty: { alignItems: 'center' as const, gap: spacing.sm, paddingVertical: spacing.xl },
    emptyTitle: { fontFamily: fonts.semibold, fontSize: 20, color: colors.foreground },
    line: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, textAlign: 'center' as const },
    fieldLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground, marginTop: spacing.md },
    input: { minHeight: 44, fontSize: 15 },
    error: { fontFamily: fonts.regular, fontSize: 13, color: colors.destructive },
    footer: { gap: spacing.sm, marginTop: spacing.lg },
    readout: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingHorizontal: spacing.md, minHeight: 48 },
    readoutLabel: { fontFamily: fonts.regular, fontSize: 15, color: colors.mutedForeground, width: 84 },
    readoutValue: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground, flexShrink: 1 },
    textAction: { minHeight: 44, justifyContent: 'center' as const, paddingHorizontal: 4 },
    textActionLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.primary },
  };
}
