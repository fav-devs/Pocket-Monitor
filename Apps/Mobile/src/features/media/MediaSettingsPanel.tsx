import {
  AlertCircleIcon,
  ArrowUpDownIcon,
  AudioWave01Icon,
  Calendar03Icon,
  ChartHistogramIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  CloudUploadIcon,
  ColorsIcon,
  FileVideoIcon,
  Flag02Icon,
  Folder01Icon,
  GridViewIcon,
  Image01Icon,
  Layers01Icon,
  Logout01Icon,
  PaintBoardIcon,
  RefreshIcon,
  RepeatIcon,
  Share08Icon,
  SmartPhone01Icon,
  Tag01Icon,
  Tick02Icon,
  UserIcon,
  VolumeMute02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useCameraSession } from '@/camera';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { SegmentedControl } from '@/components/segmented-control';
import { SettingsDestructiveButton, SettingsGroup, SettingsRow } from '@/components/settings-ui';
import { Squircle } from '@/components/squircle';
import { TextField } from '@/components/text-field';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { defaultMediaPreferences, useMediaPreferences, type MediaPreferences } from '@/state/media';
import { BatchRow } from './DeliveryQueue';
import { deliveryPlatform } from './deliveryPlatform';
import { useDelivery } from './deliveryStore';
import { mediaExporter } from './export';
import { byteLabel } from './format';
import { urlScheme, useFrameioAccount, validateFrameioConfig } from './frameio';
import { useMediaLibrary } from './libraryStore';
import { Busy, SwitchRow, Tag, TextAction } from './MediaChips';
import DesktopOutputSettings from './desktop/DesktopOutputSettings';

const NATIVE = 'Native exporter';

/** A card row with an icon well, a title and a segmented choice under it. */
function ChoiceRow<T extends string>({
  icon,
  title,
  help,
  tag,
  value,
  options,
  onChange,
  disabled,
  last,
}: {
  icon: IconSvgElement;
  title: string;
  help?: string;
  tag?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  last?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.block, !last && styles.rowBorder]}>
      <View style={styles.blockHead}>
        <Squircle width={36} height={36} radius={12} color={colors.surfaceStrong}>
          <Icon icon={icon} size={18} color={colors.foreground} />
        </Squircle>
        <View style={styles.blockText}>
          <View style={styles.titleLine}>
            <Text style={styles.rowTitle}>{title}</Text>
            {tag ? <Tag text={tag} /> : null}
          </View>
          {help ? <Text style={styles.rowHelp}>{help}</Text> : null}
        </View>
      </View>
      <View style={disabled && styles.dim} pointerEvents={disabled ? 'none' : 'auto'}>
        <SegmentedControl<T> accessibilityLabel={title} value={value} onChange={onChange} options={options} />
      </View>
    </View>
  );
}

/** A padded block inside a card (queue lists, fields, account). */
function Block({ children, last, title, action }: { children: ReactNode; last?: boolean; title?: string; action?: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.block, !last && styles.rowBorder]}>
      {title ? (
        <View style={styles.blockTitleRow}>
          <Text style={[styles.rowTitle, { flex: 1 }]}>{title}</Text>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * Settings → Media: gallery, playback and delivery preferences, the delivery queue, the local
 * original cache, and Frame.io upload setup. Rendered by the settings feature (no props).
 */
export default function MediaSettingsPanel() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const prefs = useMediaPreferences();
  const set = prefs.set;
  const session = useCameraSession();
  const demo = session.kind === 'demo';
  const account = useFrameioAccount();
  const batches = useDelivery((s) => s.batches);
  const cancel = useDelivery((s) => s.cancel);
  const clearFinished = useDelivery((s) => s.clearFinished);
  const localFiles = useMediaLibrary((s) => s.localFiles);
  const items = useMediaLibrary((s) => s.items);
  const forgetLocal = useMediaLibrary((s) => s.forgetLocal);
  const [clientId, setClientId] = useState(prefs.frameioClientId);
  const [redirect, setRedirect] = useState(prefs.frameioRedirectUri);
  const exporter = mediaExporter.available;

  useEffect(() => {
    void account.refresh(demo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, prefs.frameioClientId, prefs.frameioRedirectUri]);

  const configError = validateFrameioConfig({ clientId, redirectUri: redirect });
  const dirty = clientId.trim() !== prefs.frameioClientId || redirect.trim() !== prefs.frameioRedirectUri;
  const saveConfig = () => {
    set('frameioClientId', clientId.trim());
    set('frameioRedirectUri', redirect.trim());
  };

  const cachedIds = Object.keys(localFiles);
  const cachedBytes = items.filter((i) => localFiles[i.id]).reduce((n, i) => n + i.sizeBytes, 0);
  const frameioBatches = [...batches.filter((b) => b.destination === 'frameio')].reverse();
  const otherBatches = [...batches.filter((b) => b.destination !== 'frameio')].reverse();
  const anyFinished = batches.some((b) => b.status !== 'running' && b.status !== 'queued');

  const toggle = <K extends keyof MediaPreferences>(key: K, icon: IconSvgElement, title: string, extra?: { disabled?: boolean; tag?: string; last?: boolean }) => (
    <SwitchRow icon={icon} title={title} value={prefs[key] as boolean} onChange={(v) => set(key, v as MediaPreferences[K])} disabled={extra?.disabled} tag={extra?.tag} last={extra?.last} />
  );
  const frameioOn = prefs.frameioEnabled || demo;

  return (
    <View style={styles.panel}>
      <SettingsGroup label="Gallery">
        <ChoiceRow<MediaPreferences['layout']>
          icon={GridViewIcon}
          title="Layout"
          value={prefs.layout}
          onChange={(v) => set('layout', v)}
          options={[
            { value: 'grid', label: 'Grid' },
            { value: 'list', label: 'List' },
          ]}
        />
        <ChoiceRow<MediaPreferences['thumbnailSize']>
          icon={Image01Icon}
          title="Thumbnails"
          value={prefs.thumbnailSize}
          onChange={(v) => set('thumbnailSize', v)}
          options={[
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
        />
        <ChoiceRow<MediaPreferences['sort']>
          icon={ArrowUpDownIcon}
          title="Sort"
          value={prefs.sort}
          onChange={(v) => set('sort', v)}
          options={[
            { value: 'newest', label: 'Newest' },
            { value: 'oldest', label: 'Oldest' },
            { value: 'largest', label: 'Largest' },
            { value: 'longest', label: 'Longest' },
          ]}
        />
        {toggle('groupByDay', Calendar03Icon, 'Group by day')}
        {toggle('stackBursts', Layers01Icon, 'Stack bursts', { last: true })}
      </SettingsGroup>

      <SettingsGroup label="Playback">
        {toggle('loopPlayback', RepeatIcon, 'Loop playback')}
        {toggle('mutePlayback', VolumeMute02Icon, 'Start muted')}
        {toggle('playbackTimecode', Clock01Icon, 'Timecode clock')}
        {toggle('playbackAssists', ChartHistogramIcon, 'Open with assists')}
        {toggle('playbackAudioMeters', AudioWave01Icon, 'Audio meters', { last: true })}
      </SettingsGroup>

      {/* Desktop app only: the virtual camera and this computer's media cache. */}
      <DesktopOutputSettings />

      <SettingsGroup label="Delivery">
        <ChoiceRow<MediaPreferences['postExportAction']>
          icon={Share08Icon}
          title="Default destination"
          value={prefs.postExportAction}
          onChange={(v) => set('postExportAction', v)}
          options={[
            { value: 'system-share', label: 'Share sheet' },
            { value: 'save-to-photos', label: deliveryPlatform.photosTitle },
          ]}
        />
        <ChoiceRow<MediaPreferences['shareFormat']>
          icon={FileVideoIcon}
          title="Default format"
          tag={exporter ? undefined : NATIVE}
          help={exporter ? undefined : 'Originals only for now.'}
          value={exporter ? prefs.shareFormat : 'original'}
          onChange={(v) => exporter && set('shareFormat', v)}
          disabled={!exporter}
          options={[
            { value: 'original', label: 'Original' },
            { value: 'h264', label: 'H.264' },
            { value: 'hevc', label: 'HEVC' },
          ]}
        />
        {toggle('convertLog', ColorsIcon, 'Convert log on export', { disabled: !exporter, tag: exporter ? undefined : NATIVE })}
        <ChoiceRow<MediaPreferences['outputCurve']>
          icon={ColorsIcon}
          title="Output curve"
          value={prefs.outputCurve}
          onChange={(v) => set('outputCurve', v)}
          options={[
            { value: 'rec709', label: 'Rec.709' },
            { value: 'hlg', label: 'HLG' },
          ]}
        />
        {toggle('bakeLUT', PaintBoardIcon, 'Bake LUT on export', { disabled: !exporter, tag: exporter ? undefined : NATIVE })}
        {toggle('includeMetadata', Tag01Icon, 'Include metadata')}
        {toggle('shareSidecar', Flag02Icon, 'Send markers file')}
        {toggle('keepOriginals', SmartPhone01Icon, 'Keep originals on this phone')}
        <SettingsRow
          icon={SmartPhone01Icon}
          title="Originals cache"
          subtitle={cachedIds.length ? `${cachedIds.length} · ${byteLabel(cachedBytes)}` : 'None'}
          accessory={
            <TextAction
              title="Clear"
              label="Clear originals cache"
              disabled={!cachedIds.length}
              onPress={() => {
                cachedIds.forEach((id) => {
                  void deliveryPlatform.discard(localFiles[id]);
                  forgetLocal(id);
                });
              }}
            />
          }
          last
        />
      </SettingsGroup>

      <SettingsGroup label="Delivery queue">
        {otherBatches.length === 0 ? (
          <SettingsRow icon={CloudUploadIcon} title="No deliveries" last />
        ) : (
          otherBatches.map((b, i) => <BatchRow key={b.id} batch={b} last={i === otherBatches.length - 1} onCancel={() => cancel(b.id)} />)
        )}
      </SettingsGroup>

      <View style={styles.groupWithNote}>
        <SettingsGroup label={demo ? 'Frame.io · demo' : 'Frame.io'}>
          {toggle('frameioEnabled', CloudUploadIcon, 'Frame.io upload', { last: !frameioOn })}
          {frameioOn ? (
            <>
              <Block>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Client ID</Text>
                  <TextField
                    accessibilityLabel="Client ID"
                    value={clientId}
                    onChangeText={setClientId}
                    placeholder="Adobe OAuth Native App client id"
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    style={styles.input}
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Default redirect URI</Text>
                  <TextField
                    accessibilityLabel="Default redirect URI"
                    value={redirect}
                    onChangeText={setRedirect}
                    placeholder="adobe+yourid://adobeid/your_client_id"
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    style={styles.input}
                  />
                </View>
                {clientId || redirect ? (
                  <View style={styles.status}>
                    <Icon icon={configError ? AlertCircleIcon : CheckmarkCircle02Icon} size={16} color={configError ? colors.warning : colors.success} />
                    <Text style={[styles.rowHelp, { flex: 1 }, configError ? { color: colors.warning } : null]}>
                      {configError ?? `Redirect scheme: ${urlScheme(redirect)}`}
                    </Text>
                  </View>
                ) : null}
                {dirty ? (
                  <View style={styles.buttons}>
                    <Button title="Revert" variant="secondary" onPress={() => (setClientId(prefs.frameioClientId), setRedirect(prefs.frameioRedirectUri))} style={styles.flex} />
                    <Button title="Save" disabled={!!configError} onPress={saveConfig} style={styles.flex} />
                  </View>
                ) : null}
              </Block>
              {account.status === 'signing-in' ? (
                <Block title="Account">
                  <Busy label="Waiting for Adobe sign-in…" />
                </Block>
              ) : account.status === 'signed-in' ? (
                <SettingsRow
                  icon={UserIcon}
                  title={account.userName ? `Signed in as ${account.userName}` : 'Signed in'}
                  accessory={
                    <Pressable accessibilityRole="button" accessibilityLabel="Sign out of Frame.io" onPress={() => void account.signOut()} hitSlop={6} style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.6 }]}>
                      <Icon icon={Logout01Icon} size={16} color={colors.destructive} />
                      <Text style={styles.signOutLabel}>Sign out</Text>
                    </Pressable>
                  }
                />
              ) : (
                <Block title="Account">
                  <Text style={[styles.rowHelp, account.error ? { color: colors.warning } : null]}>
                    {account.error ?? (account.status === 'not-configured' ? 'Save a Client ID and redirect URI to sign in.' : 'Not signed in.')}
                  </Text>
                  <Button title="Sign in with Adobe" disabled={account.status === 'not-configured' && !demo} onPress={() => void account.beginSignIn()} style={styles.selfStart} />
                </Block>
              )}
              {account.status === 'signed-in' ? (
                <Block title="Project" action={<TextAction title={account.projects ? 'Reload' : 'Load projects'} label="Reload projects" onPress={() => void account.loadProjects()} />}>
                  {account.loadingProjects ? <Busy label="Loading projects…" /> : null}
                  {(account.projects ?? []).map((p) => {
                    const on = p.id === prefs.frameioProjectId;
                    return (
                      <Pressable
                        key={p.id}
                        accessibilityRole="radio"
                        accessibilityLabel={`Upload into ${p.name}`}
                        accessibilityState={{ checked: on }}
                        onPress={() => {
                          set('frameioProjectId', p.id);
                          set('frameioProjectName', p.name);
                          set('frameioRootFolderId', p.rootFolderId);
                          set('frameioAccountId', p.accountId);
                        }}
                        style={({ pressed }) => [styles.project, pressed && { opacity: 0.7 }]}
                      >
                        <Icon icon={Folder01Icon} size={18} color={on ? colors.primary : colors.mutedForeground} />
                        <Text style={[styles.rowTitle, { flex: 1 }]}>{p.name}</Text>
                        {on ? <Icon icon={Tick02Icon} size={20} color={colors.primary} /> : null}
                      </Pressable>
                    );
                  })}
                  {!account.projects && prefs.frameioProjectName ? <Text style={styles.rowHelp}>Uploading into {prefs.frameioProjectName}</Text> : null}
                </Block>
              ) : null}
              <Block title="Upload queue" action={anyFinished ? <TextAction title="Clear finished" label="Clear finished deliveries" onPress={clearFinished} /> : undefined}>
                {frameioBatches.length === 0 ? <Text style={styles.rowHelp}>Nothing uploading.</Text> : null}
              </Block>
              {frameioBatches.map((b) => (
                <BatchRow key={b.id} batch={b} onCancel={() => cancel(b.id)} />
              ))}
              {toggle('frameioReupload', RefreshIcon, 'Upload again')}
              <SettingsRow
                icon={CheckmarkCircle02Icon}
                title="Upload history"
                subtitle={`${prefs.frameioUploaded.length} clip${prefs.frameioUploaded.length === 1 ? '' : 's'}`}
                accessory={<TextAction title="Forget" label="Forget upload history" disabled={!prefs.frameioUploaded.length} onPress={() => set('frameioUploaded', [])} />}
                last
              />
            </>
          ) : null}
        </SettingsGroup>
        {frameioOn ? (
          <Text style={styles.note}>Needs your own Adobe OAuth Native App (PKCE) with the Frame.io API, and a V4 account.</Text>
        ) : null}
      </View>

      <SettingsDestructiveButton
        title="Reset media settings"
        icon={RefreshIcon}
        onPress={() => {
          const { frameioClientId, frameioRedirectUri, frameioUploaded, ratings } = useMediaPreferences.getState();
          prefs.reset();
          // Keep the operator's own identifiers, upload history and ratings.
          set('frameioClientId', frameioClientId || defaultMediaPreferences.frameioClientId);
          set('frameioRedirectUri', frameioRedirectUri);
          set('frameioUploaded', frameioUploaded);
          set('ratings', ratings);
        }}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    panel: { gap: spacing.lg },
    groupWithNote: { gap: spacing.sm },
    note: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mutedForeground, paddingHorizontal: 4 },
    block: { paddingHorizontal: spacing.md, paddingVertical: 12, gap: 10 },
    blockHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12 },
    blockText: { flex: 1, minWidth: 0, gap: 2 },
    blockTitleRow: { flexDirection: 'row' as const, alignItems: 'center' as const, minHeight: 28 },
    rowBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    titleLine: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, flexWrap: 'wrap' as const },
    rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    rowHelp: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mutedForeground },
    dim: { opacity: 0.45 },
    field: { gap: 6 },
    fieldLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.mutedForeground },
    input: { minHeight: 44, fontSize: 15, backgroundColor: colors.background },
    status: { flexDirection: 'row' as const, alignItems: 'flex-start' as const, gap: 8 },
    buttons: { flexDirection: 'row' as const, gap: spacing.sm },
    flex: { flex: 1 },
    selfStart: { alignSelf: 'flex-start' as const },
    signOut: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, minHeight: 44 },
    signOutLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.destructive },
    project: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, minHeight: 44 },
  };
}
