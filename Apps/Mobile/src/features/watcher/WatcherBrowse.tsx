/**
 * Watch a feed (`WatcherBrowse`): the feeds sharing on this camera Wi-Fi, the join with a passcode
 * when the host asks for one, and the host's Wi-Fi code scanner for joining its network first.
 * The join stays on this screen through connecting, passcode entry and errors; the monitor opens
 * only once the host accepts.
 */
import { ArrowLeft01Icon, ArrowRight01Icon, QrCode01Icon, SmartPhone01Icon } from '@hugeicons/core-free-icons';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WatcherInfo } from '@/camera/watcher/mapping';
import { RELAY_LEGACY_SERVICE_TYPE } from '@/camera/watcher/protocol';
import type { RelayHostAdvert, RelayHostsEvent } from '@/camera/watcher/transport';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { Squircle } from '@/components/squircle';
import { TextField } from '@/components/text-field';
import { WidePage } from '@/components/settings-ui';
import { CONTENT_MAX_WIDTH, useWideLayout } from '@/constants/layout';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { passcodeEntry } from '@/features/settings/settingsStore';

export interface WatcherBrowseProps {
  hosts: RelayHostsEvent;
  /** The feed being joined, if any. */
  host: RelayHostAdvert | null;
  info: WatcherInfo;
  onBack: () => void;
  onJoin: (host: RelayHostAdvert) => void;
  onPasscode: (code: string) => void;
  /** Scan the host's Wi-Fi code; null where there is no scanner (web). */
  onScanWifi: (() => void) | null;
  wifiMessage: string | null;
  wifiJoining: boolean;
  /** Simulated round trip per host id (the demo hosts). */
  latency?: (id: string) => number | undefined;
}

function HostRow({
  host,
  joining,
  status,
  latencyMs,
  last,
  onPress,
}: {
  host: RelayHostAdvert;
  joining: boolean;
  status: string | null;
  latencyMs?: number;
  last: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const meta = [host.camera, host.serviceType === RELAY_LEGACY_SERVICE_TYPE ? 'OpenPocketCine' : null].filter(Boolean).join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Watch ${host.name}`}
      accessibilityState={{ busy: joining }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !last && styles.rowBorder, pressed && styles.pressed]}
    >
      <Squircle width={36} height={36} radius={12} color={joining ? colors.ink : colors.surfaceStrong}>
        <Icon icon={SmartPhone01Icon} size={18} color={joining ? colors.inkForeground : colors.foreground} strokeWidth={joining ? 2 : 1.5} />
      </Squircle>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {host.name}
        </Text>
        {status || meta ? (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {status ?? meta}
          </Text>
        ) : null}
      </View>
      {latencyMs != null && !joining ? <Text style={styles.latency}>{latencyMs} ms</Text> : null}
      {joining ? <Spinner opacity={1} color={colors.mutedForeground} /> : <Icon icon={ArrowRight01Icon} size={18} color={colors.mutedForeground} />}
    </Pressable>
  );
}

export function WatcherBrowse({ hosts, host, info, onBack, onJoin, onPasscode, onScanWifi, wifiMessage, wifiJoining, latency }: WatcherBrowseProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const wideLayout = useWideLayout();
  const [passcode, setPasscode] = useState('');
  const needsPasscode = info.phase === 'needs-passcode';
  const joiningId = host && (info.phase === 'connecting' || info.phase === 'reconnecting') ? host.id : null;
  const answer = passcodeEntry(passcode).passcode;

  useEffect(() => {
    if (!needsPasscode) setPasscode('');
  }, [needsPasscode, host?.id]);

  const rowStatus = (h: RelayHostAdvert) => {
    if (host?.id !== h.id) return null;
    if (info.phase === 'connecting') return 'Joining…';
    if (info.phase === 'reconnecting') return `Reconnecting… ${info.attempt} of 3`;
    if (info.phase === 'needs-passcode') return 'Passcode needed';
    return null;
  };
  const submit = () => {
    if (answer) onPasscode(answer);
  };

  const list = (
    <>
      {hosts.hosts.length ? (
        <View style={styles.card}>
          {hosts.hosts.map((h, i) => (
            <HostRow
              key={h.id}
              host={h}
              joining={joiningId === h.id}
              status={rowStatus(h)}
              latencyMs={latency?.(h.id)}
              last={i === hosts.hosts.length - 1}
              onPress={() => onJoin(h)}
            />
          ))}
        </View>
      ) : (
        <View style={styles.empty}>
          <Squircle width={56} height={56} radius={18} color={colors.surface}>
            {hosts.browsing && !hosts.error ? <Spinner opacity={1} color={colors.mutedForeground} /> : <Icon icon={SmartPhone01Icon} size={24} color={colors.mutedForeground} />}
          </Squircle>
          <Text style={styles.emptyTitle}>{hosts.error ? 'Can’t look for feeds' : 'Looking for feeds…'}</Text>
          <Text style={styles.line}>{hosts.error ?? 'Join the camera Wi-Fi, then turn on Share this feed on the host.'}</Text>
        </View>
      )}

      {needsPasscode && host ? (
        <View style={styles.passcode}>
          <Text style={styles.fieldLabel}>{`Passcode for ${host.name}`}</Text>
          <TextField
            value={passcode}
            onChangeText={setPasscode}
            placeholder="Passcode"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            secureTextEntry
            returnKeyType="join"
            onSubmitEditing={submit}
            accessibilityLabel="Passcode"
            style={styles.input}
          />
          {info.error ? <Text style={styles.error}>{info.error}</Text> : null}
          <Button title="Join" size="lg" onPress={submit} disabled={!answer} />
        </View>
      ) : null}
      {info.phase === 'failed' && info.error ? <Text style={styles.error}>{info.error}</Text> : null}
      {wifiMessage ? <Text style={styles.error}>{wifiMessage}</Text> : null}

      {onScanWifi ? (
        <View style={[styles.footer, wideLayout && styles.footerWide]}>
          <Button title="Join camera Wi-Fi" variant="secondary" size="lg" icon={QrCode01Icon} onPress={onScanWifi} loading={wifiJoining} />
        </View>
      ) : null}
    </>
  );
  if (wideLayout) {
    return (
      <WidePage title="Watch a feed" detail="Feeds sharing on this Wi-Fi">
        <View style={styles.wideColumn}>{list}</View>
      </WidePage>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm, paddingBottom: Math.max(insets.bottom, spacing.md), paddingLeft: Math.max(insets.left, spacing.md), paddingRight: Math.max(insets.right, spacing.md) }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} onPress={onBack} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <Icon icon={ArrowLeft01Icon} size={24} color={colors.foreground} />
      </Pressable>
      <ScrollView contentContainerStyle={styles.column} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Watch a feed</Text>
        <Text style={styles.subtitle}>Feeds sharing on this Wi-Fi</Text>
        {list}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    root: { flex: 1, backgroundColor: colors.background },
    back: { alignSelf: 'flex-start' as const, paddingVertical: 4, marginLeft: -4, minHeight: 44, justifyContent: 'center' as const },
    pressed: { opacity: 0.7 },
    column: { width: '100%' as const, maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' as const, gap: spacing.sm, paddingTop: spacing.md, paddingBottom: spacing.lg },
    wideColumn: { gap: spacing.sm },
    title: { fontFamily: fonts.semibold, fontSize: 28, letterSpacing: -0.6, color: colors.foreground },
    subtitle: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, marginBottom: spacing.sm },
    card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' as const },
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingHorizontal: spacing.md, minHeight: 60 },
    rowBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    rowMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground },
    latency: { fontFamily: fonts.medium, fontSize: 12, color: colors.mutedForeground, fontVariant: ['tabular-nums' as const] },
    empty: { alignItems: 'center' as const, gap: spacing.sm, paddingVertical: spacing.xl },
    emptyTitle: { fontFamily: fonts.semibold, fontSize: 20, color: colors.foreground },
    line: { fontFamily: fonts.regular, fontSize: 14, color: colors.mutedForeground, textAlign: 'center' as const, maxWidth: 320 },
    passcode: { gap: spacing.sm, marginTop: spacing.md },
    fieldLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground },
    input: { minHeight: 44, fontSize: 15 },
    error: { fontFamily: fonts.regular, fontSize: 13, color: colors.destructive },
    footer: { gap: spacing.sm, marginTop: spacing.lg },
    footerWide: { alignItems: 'flex-start' as const },
  };
}
