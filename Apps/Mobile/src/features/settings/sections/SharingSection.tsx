import { Key01Icon, LiveStreaming01Icon, QrCode01Icon, SignalFull02Icon, UserMultipleIcon, ViewIcon } from '@hugeicons/core-free-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useCamera } from '@/camera';
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

/** A deterministic placeholder matrix standing in for the join code until the relay exists. */
function CodeGlyph({ seed, size = 184 }: { seed: string; size?: number }) {
  const styles = useThemedStyles(createStyles);
  const n = 21;
  const cell = size / n;
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const bits: boolean[] = [];
  for (let i = 0; i < n * n; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    bits.push(((h >>> 7) & 1) === 1);
  }
  const finder = (x: number, y: number) => {
    const inBox = (ox: number, oy: number) => x >= ox && x < ox + 7 && y >= oy && y < oy + 7;
    const ring = (ox: number, oy: number) => {
      const dx = x - ox;
      const dy = y - oy;
      return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
    };
    if (inBox(0, 0)) return ring(0, 0) ? 1 : 0;
    if (inBox(n - 7, 0)) return ring(n - 7, 0) ? 1 : 0;
    if (inBox(0, n - 7)) return ring(0, n - 7) ? 1 : 0;
    return -1;
  };
  const rects = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const f = finder(x, y);
      const on = f === -1 ? bits[y * n + x] : f === 1;
      if (on) rects.push(<Rect key={`${x}-${y}`} x={x * cell} y={y * cell} width={cell} height={cell} fill="#000" />);
    }
  }
  return (
    <View style={styles.codePlate}>
      <Svg width={size} height={size}>
        {rects}
      </Svg>
    </View>
  );
}

/**
 * Feed sharing (`MonitorFeedSharingSettings`): watcher relay host options. The relay itself is not
 * built yet, so these values are stored and shown but do not start a broadcast.
 */
export function SharingSection() {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const live = useCamera((s) => s.connection.phase === 'live');
  const ssid = useCamera((s) => s.identity?.ssid);
  const sharing = useSettingsLocal((s) => s.shareThisFeed);
  const passcode = useSettingsLocal((s) => s.watcherPasscode);
  const controlRequests = useSettingsLocal((s) => s.controlRequests);
  const priority = useSettingsLocal((s) => s.broadcastPriority);
  const set = useSettingsLocal((s) => s.set);
  const [draft, setDraft] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const entry = draft === null ? null : passcodeEntry(draft);

  return (
    <>
      <Group
        label="Share"
        note={live ? SettingsCopy.relayPending : SettingsCopy.shareNeedsCamera}
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
          <CodeGlyph seed={ssid ?? 'camera'} />
          <Text style={styles.codeName}>{ssid ?? 'Camera Wi-Fi'}</Text>
          <Text style={styles.codeHelp}>{SettingsCopy.joinWifi}</Text>
          <Text style={styles.codeNote}>{SettingsCopy.previewCode}</Text>
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
    codeNote: { fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground, textAlign: 'center' as const, maxWidth: 360 },
  };
}
