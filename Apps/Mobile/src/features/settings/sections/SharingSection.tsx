import { Key01Icon, LiveStreaming01Icon, QrCode01Icon, SignalFull02Icon, SmartPhone01Icon, UserMultipleIcon, ViewIcon } from '@hugeicons/core-free-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useCamera } from '@/camera';
import { CameraWiFiQRCode } from '@/core/ble/wifiQr';
import { readWifiPassword } from '@/features/pairing/credentials';
import { encodeQr, qrPath } from '@/features/watcher/qr';
import { reclaimFeedControl, useFeedSharingStatus, type FeedSharingStatus } from '@/features/watcher/useFeedSharing';
import { Chip } from '@/components/chip';
import { ChipRow } from '@/components/field-section';
import { SettingsRow } from '@/components/settings-ui';
import { Sheet } from '@/components/sheet';
import { TextField } from '@/components/text-field';
import { fonts, radius, spacing, type ThemeColors, useThemedStyles } from '@/constants/theme';
import { settingsFeedback } from '../components/feedback';
import { ActionRow, FieldRow, Group, LinkRow, SwitchRow } from '../components/ui';
import { SettingsCopy } from '../copy';
import { passcodeEntry, passcodeTooShortHint, useSettingsLocal, type BroadcastPriority } from '../settingsStore';

const priorities: BroadcastPriority[] = ['Lowest delay', 'Balanced', 'Steadier picture'];

/** The camera Wi-Fi as a scannable join code (standard `WIFI:` payload). */
function JoinCode({ payload, size = 184 }: { payload: string; size?: number }) {
  const styles = useThemedStyles(createStyles);
  const matrix = encodeQr(payload);
  if (!matrix) return null;
  return (
    <View style={styles.codePlate} accessibilityLabel="Camera Wi-Fi code">
      <Svg width={size} height={size} viewBox={`0 0 ${matrix.size} ${matrix.size}`}>
        <Path d={qrPath(matrix)} fill="#000" />
      </Svg>
    </View>
  );
}

/**
 * The join code's payload, built only while the sheet is open, from the current camera's saved
 * credentials for the SSID it joined. Cleared when the app backgrounds or the camera drops; never
 * logged or saved as an image.
 */
function useJoinPayload(open: boolean, cameraId: string | undefined, ssid: string | undefined, live: boolean) {
  const [payload, setPayload] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setPayload(null);
    setMissing(false);
    if (!open || !live || !cameraId || !ssid) return;
    let alive = true;
    readWifiPassword(cameraId, ssid)
      .then((password) => {
        if (!alive) return;
        const next = password ? CameraWiFiQRCode.payload(ssid, password) : null;
        setPayload(next);
        setMissing(!next);
      })
      .catch(() => alive && setMissing(true));
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') setPayload(null);
    });
    return () => {
      alive = false;
      sub.remove();
      setPayload(null);
    };
  }, [open, cameraId, ssid, live]);
  return { payload, missing };
}

/** One line under the Share group: what sharing is doing right now. */
function shareNote(live: boolean, sharing: boolean, status: FeedSharingStatus): string | undefined {
  if (!live) return SettingsCopy.shareNeedsCamera;
  if (!status.available) return sharing ? 'Sharing needs the phone app.' : undefined;
  if (status.state === 'failed') return status.error ?? 'Sharing could not start';
  if (!sharing || !status.active) return undefined;
  const watchers = status.watchers === 0 ? 'No watchers' : `${status.watchers} ${status.watchers === 1 ? 'watcher' : 'watchers'}`;
  return status.joinable || status.watchers > 0 ? `Sharing · ${watchers}` : `Sharing · ${watchers} · New watchers wait for a camera keyframe`;
}

/**
 * Feed sharing (`MonitorFeedSharingSettings`): the watcher relay host. Share this feed advertises
 * the live camera on its Wi-Fi (`useFeedSharing`); passcode, control requests and priority apply
 * to the running host at once.
 */
export function SharingSection() {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const live = useCamera((s) => s.connection.phase === 'live');
  const ssid = useCamera((s) => s.identity?.ssid);
  const cameraId = useCamera((s) => s.identity?.id);
  const status = useFeedSharingStatus();
  const sharing = useSettingsLocal((s) => s.shareThisFeed);
  const passcode = useSettingsLocal((s) => s.watcherPasscode);
  const controlRequests = useSettingsLocal((s) => s.controlRequests);
  const priority = useSettingsLocal((s) => s.broadcastPriority);
  const set = useSettingsLocal((s) => s.set);
  const [draft, setDraft] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const entry = draft === null ? null : passcodeEntry(draft);
  const join = useJoinPayload(showCode, cameraId, ssid, live);
  const watcherHolds = status.active && status.holder !== 'Host';

  return (
    <>
      <Group
        label="Share"
        note={shareNote(live, sharing, status)}
      >
        <SwitchRow
          icon={LiveStreaming01Icon}
          title="Share this feed"
          value={sharing}
          onChange={(v) => set('shareThisFeed', v)}
          disabled={!live}
        />
        <ActionRow
          icon={QrCode01Icon}
          title="Join camera Wi-Fi"
          action="Show code"
          disabled={!live}
          onPress={() => setShowCode(true)}
        />
        <SettingsRow
          icon={Key01Icon}
          title="Watcher passcode"
          subtitle={entry?.tooShort ? passcodeTooShortHint : undefined}
          accessory={
            <TextField
              value={draft ?? passcode}
              onChangeText={(text) => {
                setDraft(text);
                const next = passcodeEntry(text);
                if (next.passcode !== null && next.passcode !== passcode) set('watcherPasscode', next.passcode);
              }}
              onBlur={() => setDraft(null)}
              placeholder="Optional"
              secureTextEntry
              maxLength={12}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Watcher passcode"
              style={styles.passcode}
            />
          }
        />
        <SwitchRow
          icon={UserMultipleIcon}
          title="Control requests"
          value={controlRequests}
          onChange={(v) => set('controlRequests', v)}
        />
        {watcherHolds ? <ActionRow icon={SmartPhone01Icon} title={`Control · ${status.holder}`} action="Take back" onPress={reclaimFeedControl} /> : null}
        <FieldRow icon={SignalFull02Icon} title="Broadcast priority" last>
          <ChipRow>
            {priorities.map((p) => (
              <Chip
                key={p}
                label={p}
                selected={p === priority}
                onPress={() => {
                  if (p === priority) return;
                  settingsFeedback();
                  set('broadcastPriority', p);
                }}
              />
            ))}
          </ChipRow>
        </FieldRow>
      </Group>
      <Group label="Watch a feed">
        <LinkRow
          icon={ViewIcon}
          title="Join as watcher"
          onPress={() => router.push('/watcher')}
          last
        />
      </Group>
      <Sheet visible={showCode} title="Join camera Wi-Fi" onClose={() => setShowCode(false)} expandable={false}>
        <View style={styles.codeBody}>
          {join.payload ? <JoinCode payload={join.payload} /> : <View style={[styles.codePlate, styles.codeEmpty]} />}
          <Text style={styles.codeName}>{ssid ?? 'Camera Wi-Fi'}</Text>
          <Text style={styles.codeHelp}>{join.missing ? 'Wi-Fi password not saved on this phone.' : SettingsCopy.joinWifi}</Text>
        </View>
      </Sheet>
    </>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    passcode: {
      width: 128,
      minHeight: 40,
      borderRadius: 12,
      paddingHorizontal: 12,
      fontFamily: fonts.medium,
      fontSize: 14,
      textAlign: 'right' as const,
    },
    codeBody: { alignItems: 'center' as const, gap: spacing.sm, paddingVertical: spacing.md },
    codePlate: {
      padding: 14,
      backgroundColor: '#ffffff',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: spacing.sm,
    },
    codeName: { fontFamily: fonts.semibold, fontSize: 18, letterSpacing: -0.3, color: colors.foreground, textAlign: 'center' as const },
    codeHelp: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: colors.mutedForeground,
      textAlign: 'center' as const,
      maxWidth: 360,
    },
    codeEmpty: { width: 212, height: 212, backgroundColor: colors.surface, borderColor: colors.surface },
  };
}
