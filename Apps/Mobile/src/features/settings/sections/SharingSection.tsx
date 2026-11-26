import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useCamera } from '@/camera';
import { MText, colors } from '@/theme';
import { CardColumns } from '../components/CardColumns';
import {
  ActionPill,
  CardCaption,
  InlineTextInput,
  SegmentedControl,
  SettingsCard,
  SettingsRow,
  SwitchRow,
} from '../components/SettingsControls';
import { SettingsCopy } from '../copy';
import { OverlayScreen } from '../OverlayScreen';
import { passcodeEntry, passcodeTooShortHint, useSettingsLocal, type BroadcastPriority } from '../settingsStore';

const priorities: BroadcastPriority[] = ['Lowest delay', 'Balanced', 'Steadier picture'];

/** A deterministic placeholder matrix standing in for the join code until the relay exists. */
function CodeGlyph({ seed, size = 168 }: { seed: string; size?: number }) {
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
    <View style={{ padding: 12, backgroundColor: '#fff', borderRadius: 12 }}>
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
export function SharingSection({ width }: { width: number }) {
  const router = useRouter();
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
    <CardColumns width={width}>
      <SettingsCard key="share">
        <SwitchRow
          divider={false}
          title="Share this feed"
          help={SettingsCopy.shareThisFeed}
          value={sharing}
          onChange={(v) => set('shareThisFeed', v)}
          disabled={!live}
        />
        {!live ? <CardCaption>Connect to one camera from Your cameras to share its feed with watchers.</CardCaption> : null}
        <SettingsRow title="Join camera Wi-Fi" help={SettingsCopy.joinWifi}>
          <ActionPill title="Show Wi-Fi code" onPress={() => setShowCode(true)} disabled={!live} />
        </SettingsRow>
        <SettingsRow title="Watcher passcode" help={SettingsCopy.watcherPasscode}>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <InlineTextInput
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
              accessibilityLabel="Watcher passcode"
              width={130}
            />
            {entry?.tooShort ? (
              <MText size={10} color={colors.muted} style={{ maxWidth: 170, textAlign: 'right' }}>
                {passcodeTooShortHint}
              </MText>
            ) : null}
          </View>
        </SettingsRow>
        <SwitchRow
          title="Control requests"
          help={SettingsCopy.controlRequests}
          value={controlRequests}
          onChange={(v) => set('controlRequests', v)}
        />
        <SettingsRow title="Broadcast priority" help={SettingsCopy.broadcastPriority} stacked>
          <SegmentedControl options={priorities} value={priority} onChange={(v) => set('broadcastPriority', v)} />
        </SettingsRow>
      </SettingsCard>
      <SettingsCard key="watch" title="Watch a feed">
        <SettingsRow divider={false} title="Join as watcher" help="Watch another phone’s shared feed on the same camera Wi-Fi. Only the host opens a camera session.">
          <ActionPill title="Open" onPress={() => router.push('/watcher')} accessibilityLabel="Open Watch a feed" />
        </SettingsRow>
        <CardCaption>Watcher relay hosting is coming in a later build. Settings here are kept for when it arrives.</CardCaption>
      </SettingsCard>
    </CardColumns>
      <OverlayScreen visible={showCode} eyebrow="Feed sharing" title="Join camera Wi-Fi" onClose={() => setShowCode(false)}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 16 }}>
          <CodeGlyph seed={ssid ?? 'camera'} />
          <MText size={16} weight="semibold" align="center">
            {ssid ?? 'Camera Wi-Fi'}
          </MText>
          <MText size={12.5} color={colors.muted} align="center" style={{ maxWidth: 360 }}>
            {SettingsCopy.joinWifi}
          </MText>
          <MText size={10.5} color={colors.faint} align="center" style={{ maxWidth: 360 }}>
            Preview code. The scannable join code arrives with watcher relay hosting.
          </MText>
        </View>
      </OverlayScreen>
    </>
  );
}
