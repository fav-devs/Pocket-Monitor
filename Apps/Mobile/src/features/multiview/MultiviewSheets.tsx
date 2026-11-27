import { Camera01Icon, HotspotIcon, StopIcon, Wifi01Icon } from '@hugeicons/core-free-icons';
import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { CameraSessionScope, useCamera, type CameraSession } from '@/camera';
import { modelDisplayName } from '@/camera/defaults';
import type { MultiviewCamera, MultiviewNetwork, TileLook, TileSnapshot } from '@/camera/multiview/types';
import { Button } from '@/components/button';
import { Chip } from '@/components/chip';
import { ChipRow, FieldSection } from '@/components/field-section';
import { Icon } from '@/components/icon';
import { SegmentedControl } from '@/components/segmented-control';
import { SettingsGroup, SettingsRow } from '@/components/settings-ui';
import { Sheet } from '@/components/sheet';
import { Spinner } from '@/components/spinner';
import { TextField } from '@/components/text-field';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { recordRed } from '@/constants/monitor';
import { BUILT_IN_LOOKS } from '@/core/media';
import { MultiviewCopy } from '@/core/multicam';
import { formatChip } from '@/features/live/format';
import type { LutSelection } from '@/state/assists';
import type { AddChoice, AddGroups } from './addChoices';

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

// ───────────────────────────── network ─────────────────────────────

/** The shared network form: this phone's Wi-Fi or its Personal Hotspot, name and password. */
export function NetworkForm({
  initial,
  currentSsid,
  onSubmit,
}: {
  initial: MultiviewNetwork | null;
  currentSsid: string | null;
  onSubmit: (network: MultiviewNetwork, password: string) => Promise<void> | void;
}) {
  const styles = useThemedStyles(createStyles);
  const [kind, setKind] = useState<'wifi' | 'hotspot'>(initial?.hotspot ? 'hotspot' : 'wifi');
  const [ssid, setSsid] = useState(initial?.ssid ?? currentSsid ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ssid && currentSsid && kind === 'wifi') setSsid(currentSsid);
  }, [currentSsid, kind, ssid]);
  const submit = async () => {
    const name = ssid.trim();
    if (!name || utf8Length(name) > 32 || utf8Length(password) > 63 || (password.length > 0 && password.length < 8)) {
      setError(MultiviewCopy.checkNetwork);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ ssid: name, hotspot: kind === 'hotspot' }, password);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.stack}>
      <SegmentedControl
        accessibilityLabel="Network"
        options={[
          { value: 'wifi', label: 'Wi-Fi', icon: Wifi01Icon },
          { value: 'hotspot', label: 'Hotspot', icon: HotspotIcon },
        ]}
        value={kind}
        onChange={setKind}
      />
      <TextField testID="multiview.network.ssid" value={ssid} onChangeText={setSsid} placeholder={kind === 'hotspot' ? 'Hotspot name' : 'Network name'} autoCapitalize="none" autoCorrect={false} />
      <TextField testID="multiview.network.password" value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry autoCapitalize="none" autoCorrect={false} />
      {kind === 'hotspot' ? <Text style={styles.line}>Turn on Personal Hotspot and Allow Others to Join.</Text> : null}
      {error ? <Text style={[styles.line, styles.error]}>{error}</Text> : null}
      <Button testID="multiview.network.use" title="Use network" size="lg" loading={busy} onPress={submit} />
    </View>
  );
}

// ───────────────────────────── add camera ─────────────────────────────

export function AddCameraSheet({
  visible,
  onClose,
  demo,
  demoChoices,
  groups,
  network,
  networkLocked,
  currentSsid,
  scanning,
  onPick,
  onAddAllDemo,
  onNetwork,
}: {
  visible: boolean;
  onClose: () => void;
  demo: boolean;
  demoChoices: MultiviewCamera[];
  groups: AddGroups;
  network: MultiviewNetwork | null;
  /** Cameras are on the stage: the network stays as it is. */
  networkLocked: boolean;
  currentSsid: string | null;
  scanning: boolean;
  onPick: (camera: MultiviewCamera) => void;
  onAddAllDemo: () => void;
  onNetwork: (network: MultiviewNetwork, password: string) => Promise<void> | void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!visible) setEditing(false);
  }, [visible]);
  const showForm = !demo && (!network || editing);

  const rows = (choices: AddChoice[]) =>
    choices.map((c, i) => (
      <SettingsRow
        key={c.camera.id}
        icon={Camera01Icon}
        title={c.camera.name}
        subtitle={c.detail}
        chevron
        last={i === choices.length - 1}
        onPress={() => onPick(c.camera)}
      />
    ));

  return (
    <Sheet visible={visible} title={showForm ? 'Shared network' : 'Add camera'} onClose={onClose}>
      {demo ? (
        <View style={styles.stack}>
          {demoChoices.length ? (
            <SettingsGroup label="Demo cameras">
              {demoChoices.map((c, i) => (
                <SettingsRow key={c.id} icon={Camera01Icon} title={c.name} subtitle={modelDisplayName(c.model)} chevron last={i === demoChoices.length - 1} onPress={() => onPick(c)} />
              ))}
            </SettingsGroup>
          ) : (
            <Text style={styles.line}>{MultiviewCopy.full}</Text>
          )}
          {demoChoices.length > 1 ? <Button testID="multiview.add.allDemo" title={`Add ${demoChoices.length} demo cameras`} variant="secondary" size="lg" onPress={onAddAllDemo} /> : null}
        </View>
      ) : showForm ? (
        <NetworkForm
          initial={network}
          currentSsid={currentSsid}
          onSubmit={async (n, p) => {
            await onNetwork(n, p);
            setEditing(false);
          }}
        />
      ) : (
        <View style={styles.stack}>
          <SettingsGroup>
            <SettingsRow
              icon={network!.hotspot ? HotspotIcon : Wifi01Icon}
              title={network!.ssid}
              subtitle={network!.hotspot ? 'Personal Hotspot' : 'Wi-Fi'}
              chevron={!networkLocked}
              onPress={networkLocked ? undefined : () => setEditing(true)}
              last
            />
          </SettingsGroup>
          {groups.onNetwork.length ? <SettingsGroup label={`On ${network!.ssid}`}>{rows(groups.onNetwork)}</SettingsGroup> : null}
          {groups.toMove.length ? <SettingsGroup label="Cameras">{rows(groups.toMove)}</SettingsGroup> : null}
          {!groups.onNetwork.length && !groups.toMove.length ? (
            <View style={styles.scanRow}>
              {scanning ? <Spinner color={colors.mutedForeground} opacity={0.3} /> : null}
              <Text style={styles.line}>{scanning ? 'Looking for cameras' : 'No cameras found'}</Text>
            </View>
          ) : null}
          <Text style={styles.line}>{MultiviewCopy.pickerFooter(network!.ssid)}</Text>
        </View>
      )}
    </Sheet>
  );
}

// ───────────────────────────── camera settings ─────────────────────────────

const LOOK_CHOICES: LutSelection[] = ['auto', ...BUILT_IN_LOOKS.map((l) => `look:${l}` as LutSelection)];
const lookLabel = (s: LutSelection) => (s === 'auto' ? 'Auto' : s.startsWith('look:') ? s.slice(5) : 'Custom');

function ToggleLine({ title, value, onChange }: { title: string; value: boolean; onChange: (v: boolean) => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.toggleLine}>
      <Text style={styles.toggleTitle}>{title}</Text>
      <Switch accessibilityLabel={title} value={value} onValueChange={onChange} trackColor={{ true: colors.primary, false: colors.surfaceStrong }} />
    </View>
  );
}

function CameraValues({ tile }: { tile: TileSnapshot }) {
  const styles = useThemedStyles(createStyles);
  const format = useCamera((s) => formatChip(s.format.resolution, s.format.fps));
  const battery = useCamera((s) => s.power.batteryPercent);
  const fps = useCamera((s) => s.connection.videoFps);
  const host = tile.camera?.path && 'host' in tile.camera.path ? tile.camera.path.host : undefined;
  const values: [string, string][] = [
    ['Status', tile.recording ? 'Recording' : tile.status],
    ['Format', format],
    ['Battery', battery >= 0 && battery <= 100 ? `${battery}%` : '—'],
    ['Feed', fps > 0 ? `${fps} fps` : '—'],
  ];
  if (host) values.push(['Address', host]);
  return (
    <View style={styles.values}>
      {values.map(([k, v]) => (
        <View key={k} style={styles.valueCell}>
          <Text numberOfLines={1} style={styles.value}>
            {v}
          </Text>
          <Text style={styles.valueLabel}>{k}</Text>
        </View>
      ))}
    </View>
  );
}

/** One camera's sheet: its values, its tile look, and its own record / reconnect / remove. */
export function CameraSettingsSheet({
  tile,
  session,
  look,
  onClose,
  onLook,
  onRecord,
  onControls,
  onReconnect,
  onRemove,
  canRemove,
}: {
  tile: TileSnapshot | null;
  session: CameraSession | null;
  look: TileLook;
  onClose: () => void;
  onLook: (patch: Partial<TileLook>) => void;
  onRecord: () => void;
  onControls: () => void;
  onReconnect: () => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const visible = !!tile?.camera && !!session;
  const [last, setLast] = useState<{ tile: TileSnapshot; session: CameraSession } | null>(null);
  if (visible && (last?.tile !== tile || last?.session !== session)) setLast({ tile: tile!, session: session! });
  const shown = visible ? { tile: tile!, session: session! } : last;
  return (
    <Sheet visible={visible} title={shown?.tile.camera?.name ?? 'Camera'} onClose={onClose}>
      {shown ? (
        <CameraSessionScope session={shown.session}>
          <View style={styles.stack}>
            <CameraValues tile={shown.tile} />
            <FieldSection title="LUT" toggle={{ value: look.lut, onChange: (v) => onLook({ lut: v }) }}>
              {look.lut ? (
                <ChipRow>
                  {LOOK_CHOICES.map((sel) => (
                    <Chip key={sel} label={lookLabel(sel)} selected={look.selection === sel} onPress={() => onLook({ selection: sel })} />
                  ))}
                </ChipRow>
              ) : null}
            </FieldSection>
            <FieldSection title="Assists">
              <ToggleLine title="Peaking" value={look.peaking} onChange={(v) => onLook({ peaking: v })} />
              <ToggleLine title="Zebra" value={look.zebra} onChange={(v) => onLook({ zebra: v })} />
              <ToggleLine title="False Color" value={look.falseColor} onChange={(v) => onLook({ falseColor: v })} />
              <ToggleLine title="Mono" value={look.mono} onChange={(v) => onLook({ mono: v })} />
            </FieldSection>
            <View style={styles.actions}>
              {shown.tile.phase === 'live' ? (
                <Button
                  testID="multiview.camera.record"
                  title={shown.tile.recording ? 'Stop recording' : 'Record'}
                  variant="secondary"
                  size="lg"
                  loading={shown.tile.recordBusy}
                  onPress={onRecord}
                />
              ) : null}
              {shown.tile.phase === 'live' ? <Button title="Camera controls" variant="secondary" size="lg" onPress={onControls} /> : null}
              {shown.tile.phase !== 'live' ? <Button title="Reconnect" variant="secondary" size="lg" onPress={onReconnect} /> : null}
              <Button testID="multiview.camera.remove" title="Remove camera" variant="ghost" destructive disabled={!canRemove} onPress={onRemove} />
            </View>
          </View>
        </CameraSessionScope>
      ) : null}
    </Sheet>
  );
}

// ───────────────────────────── exit and group stop ─────────────────────────────

export function ExitSheet({
  visible,
  restore,
  closing,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  restore: boolean;
  closing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Sheet visible={visible} title="Close Multiview?" onClose={closing ? () => {} : onCancel} expandable={false}>
      {closing ? (
        <View style={styles.scanRow}>
          <Spinner color={colors.mutedForeground} opacity={0.3} />
          <Text style={styles.line}>{MultiviewCopy.closingProgress(restore)}</Text>
        </View>
      ) : (
        <>
          <Text style={styles.line}>{MultiviewCopy.closeQuestion(restore)}</Text>
          <View style={styles.row}>
            <Button title="Cancel" variant="secondary" size="lg" onPress={onCancel} style={styles.flex} />
            <Button testID="multiview.exit.confirm" title="Close" size="lg" onPress={onConfirm} style={styles.flex} />
          </View>
        </>
      )}
    </Sheet>
  );
}

export function GroupStopSheet({ visible, count, onCancel, onStop }: { visible: boolean; count: number; onCancel: () => void; onStop: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Sheet visible={visible} title={count === 1 ? 'Stop recording?' : `Stop ${count} cameras?`} onClose={onCancel} expandable={false}>
      <View style={styles.row}>
        <Button title="Keep recording" variant="secondary" size="lg" onPress={onCancel} style={styles.flex} />
        <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={onStop} style={({ pressed }) => [styles.stop, pressed && { opacity: 0.75 }]}>
          <Icon icon={StopIcon} size={18} color="#ffffff" strokeWidth={2} />
          <Text style={styles.stopLabel}>Stop</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    stack: { gap: spacing.md, paddingBottom: spacing.sm },
    line: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 19, color: colors.mutedForeground },
    error: { color: colors.destructive },
    scanRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, paddingVertical: spacing.sm },
    row: { flexDirection: 'row' as const, gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.xs },
    flex: { flex: 1 },
    actions: { gap: spacing.sm },
    toggleLine: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, minHeight: 44 },
    toggleTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    values: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: spacing.sm },
    valueCell: { minWidth: 76, flexGrow: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: colors.surface },
    value: { fontFamily: fonts.semibold, fontSize: 15, color: colors.foreground, fontVariant: ['tabular-nums' as const] },
    valueLabel: { fontFamily: fonts.medium, fontSize: 11, color: colors.mutedForeground, marginTop: 2 },
    stop: {
      flex: 1,
      minHeight: 50,
      borderRadius: radius.md,
      flexDirection: 'row' as const,
      gap: spacing.sm,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: recordRed,
    },
    stopLabel: { fontFamily: fonts.semibold, fontSize: 15, color: '#ffffff' },
  };
}
