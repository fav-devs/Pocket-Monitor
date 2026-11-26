import { Folder01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { CameraMediaItem } from '@/camera';
import { useCameraSession } from '@/camera';
import { Button } from '@/components/button';
import { FieldSection } from '@/components/field-section';
import { Icon } from '@/components/icon';
import { SegmentedControl } from '@/components/segmented-control';
import { SettingsRow } from '@/components/settings-ui';
import { Sheet } from '@/components/sheet';
import { fonts, radius, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { type MediaOutputCurve, type MediaShareFormat, useMediaPreferences } from '@/state/media';
import { deliveryPlatform } from './deliveryPlatform';
import { destinationIcon } from './DeliveryQueue';
import { type DeliveryDestination, destinationTitle, useDelivery } from './deliveryStore';
import { type ExportOptions, mediaExporter } from './export';
import { byteLabel, isLogColor } from './format';
import { type FrameioProject, useFrameioAccount } from './frameio';
import { Busy, SwitchRow, Tag, TextAction } from './MediaChips';

const copy = {
  convertUnavailableHelp: 'Needs a D-Log or D-Log2 clip.',
  exporterNotice: 'Originals only in this build.',
};
const NATIVE = 'Native exporter';

function selectionLabel(items: CameraMediaItem[]): string {
  const bytes = byteLabel(items.reduce((n, i) => n + i.sizeBytes, 0));
  if (items.length === 1) return `${items[0].fileName} · ${bytes}`;
  const videos = items.filter((i) => i.kind === 'video').length;
  const photos = items.length - videos;
  const parts = [videos ? `${videos} clip${videos === 1 ? '' : 's'}` : null, photos ? `${photos} photo${photos === 1 ? '' : 's'}` : null];
  return `${parts.filter(Boolean).join(' + ')} · ${bytes}`;
}

/**
 * `MonitorMediaDeliveryPanel`: choose a destination, then its options, then begin. The accepted
 * request joins the delivery queue; progress shows in the queue sheet and the compact pill.
 */
export function DeliverySheet({
  visible,
  items,
  onClose,
  onDismiss,
  initialDestination,
}: {
  visible: boolean;
  items: CameraMediaItem[];
  onClose: () => void;
  onDismiss?: () => void;
  initialDestination?: DeliveryDestination;
}) {
  const styles = useThemedStyles(createStyles);
  const session = useCameraSession();
  const demo = session.kind === 'demo';
  const prefs = useMediaPreferences();
  const account = useFrameioAccount();
  const enqueue = useDelivery((s) => s.enqueue);
  const initial = () => initialDestination ?? (useMediaPreferences.getState().postExportAction === 'save-to-photos' ? 'photos' : null);
  const [destination, setDestination] = useState<DeliveryDestination | null>(initial);

  // Each opening starts from the default destination.
  useEffect(() => {
    if (visible) setDestination(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (visible) void account.refresh(demo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, visible]);

  useEffect(() => {
    if (destination === 'frameio' && account.status === 'signed-in' && !account.projects && !account.loadingProjects) void account.loadProjects();
  }, [destination, account.status, account.projects, account.loadingProjects, account]);

  const anyLog = items.some((i) => i.kind === 'video' && isLogColor(i.colorMode));
  const anyVideo = items.some((i) => i.kind === 'video');
  const exporter = mediaExporter.available;
  const frameioReady = demo || (prefs.frameioEnabled && account.status !== 'not-configured');
  const project: FrameioProject | undefined = useMemo(
    () => account.projects?.find((p) => p.id === prefs.frameioProjectId) ?? undefined,
    [account.projects, prefs.frameioProjectId],
  );

  const options: ExportOptions = {
    convertLog: exporter && prefs.convertLog,
    outputCurve: prefs.outputCurve,
    bakeLUT: exporter && prefs.bakeLUT,
    bakeExposure: exporter && prefs.bakeExposure,
    format: exporter ? prefs.shareFormat : 'original',
    includeMetadata: prefs.includeMetadata,
  };

  const begin = () => {
    if (!destination) return;
    enqueue(session.media, { destination, items, options, project, demo });
    onClose();
  };

  const destinations: { id: DeliveryDestination; title: string; subtitle?: string; enabled: boolean }[] = [
    { id: 'share', title: 'Share', enabled: true },
    { id: 'photos', title: deliveryPlatform.photosTitle, enabled: true },
    {
      id: 'frameio',
      title: 'Frame.io upload',
      subtitle: frameioReady ? (demo ? 'Demo' : undefined) : 'Set up in Settings → Media',
      enabled: frameioReady,
    },
  ];

  const actionTitle = destination === 'frameio' ? 'Upload' : destination === 'photos' ? (deliveryPlatform.photosTitle === 'Download' ? 'Download' : 'Save') : 'Share';
  const canBegin = destination !== 'frameio' || (account.status === 'signed-in' && !!project);

  return (
    <Sheet
      visible={visible}
      title={destination ? destinationTitle(destination) : 'Share'}
      onClose={onClose}
      onDismiss={onDismiss}
      action={destination ? <TextAction title="Back" onPress={() => setDestination(null)} /> : undefined}
      footer={
        destination ? (
          <View style={styles.footer}>
            <Text style={styles.footerText} numberOfLines={2}>
              {destination === 'frameio' && !project ? 'Choose a project to upload into.' : `${items.length} item${items.length === 1 ? '' : 's'} · ${options.convertLog || options.bakeLUT ? 'Transformed' : 'Originals'}`}
            </Text>
            <Button title={actionTitle} icon={destinationIcon(destination)} onPress={begin} disabled={!canBegin} accessibilityLabel={`${actionTitle} ${items.length === 1 ? 'item' : 'items'}`} style={styles.footerButton} />
          </View>
        ) : undefined
      }
    >
      <View style={styles.summary}>
        <Text style={styles.summaryTitle} numberOfLines={2}>
          {selectionLabel(items)}
        </Text>
        {destination && !exporter && anyVideo ? <Text style={styles.muted}>{copy.exporterNotice}</Text> : null}
      </View>
      {!destination ? (
        <View style={styles.card}>
          {destinations.map((d, i) => (
            <SettingsRow
              key={d.id}
              icon={destinationIcon(d.id)}
              title={d.title}
              subtitle={d.subtitle}
              chevron
              disabled={!d.enabled}
              last={i === destinations.length - 1}
              onPress={() => setDestination(d.id)}
            />
          ))}
        </View>
      ) : (
        <View style={styles.sections}>
          {destination === 'frameio' ? <FrameioService project={project} /> : null}
          <FieldSection title="Export">
            {items.length === 1 ? (
              <View style={styles.fileRow}>
                <Text style={styles.fileLabel}>Filename</Text>
                <Text style={styles.fileName} numberOfLines={1} selectable>
                  {items[0].fileName}
                </Text>
              </View>
            ) : null}
            <View>
              {anyVideo ? (
                <>
                  <SwitchRow
                    inset={false}
                    title="Convert log"
                    help={anyLog ? undefined : copy.convertUnavailableHelp}
                    value={options.convertLog}
                    onChange={(v) => prefs.set('convertLog', v)}
                    disabled={!exporter || !anyLog}
                    tag={exporter ? undefined : NATIVE}
                  />
                  {options.convertLog ? (
                    <View style={styles.control}>
                      <SegmentedControl<MediaOutputCurve>
                        accessibilityLabel="Output curve"
                        value={prefs.outputCurve}
                        onChange={(v) => prefs.set('outputCurve', v)}
                        options={[
                          { value: 'rec709', label: 'Rec.709' },
                          { value: 'hlg', label: 'HLG' },
                        ]}
                      />
                    </View>
                  ) : null}
                  <SwitchRow
                    inset={false}
                    title="Bake LUT"
                    value={options.bakeLUT}
                    onChange={(v) => prefs.set('bakeLUT', v)}
                    disabled={!exporter}
                    tag={exporter ? undefined : NATIVE}
                  />
                  {options.bakeLUT ? (
                    <SwitchRow inset={false} title="Bake exposure" value={options.bakeExposure} onChange={(v) => prefs.set('bakeExposure', v)} />
                  ) : null}
                  <View style={[styles.control, styles.formatBlock]}>
                    <View style={styles.formatHead}>
                      <Text style={[styles.controlTitle, !exporter && styles.dim]}>Format</Text>
                      {exporter ? null : <Tag text={NATIVE} />}
                    </View>
                    <View style={!exporter && styles.dim} pointerEvents={exporter ? 'auto' : 'none'}>
                    <SegmentedControl<MediaShareFormat>
                      accessibilityLabel="Format"
                      value={options.format}
                      onChange={(v) => exporter && prefs.set('shareFormat', v)}
                      options={[
                        { value: 'original', label: 'Original' },
                        { value: 'h264', label: 'H.264' },
                        { value: 'hevc', label: 'HEVC' },
                      ]}
                    />
                    </View>
                  </View>
                </>
              ) : null}
              <SwitchRow inset={false} title="Include metadata" value={prefs.includeMetadata} onChange={(v) => prefs.set('includeMetadata', v)} />
              {destination === 'frameio' ? (
                <SwitchRow inset={false} title="Upload again" value={prefs.frameioReupload} onChange={(v) => prefs.set('frameioReupload', v)} />
              ) : null}
            </View>
          </FieldSection>
        </View>
      )}
    </Sheet>
  );
}

function FrameioService({ project }: { project?: FrameioProject }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const account = useFrameioAccount();
  const setPref = useMediaPreferences((s) => s.set);
  return (
    <FieldSection title={account.demo ? 'Frame.io · demo' : 'Frame.io'}>
      {account.status === 'signed-in' ? (
        <>
          <Text style={styles.muted}>{account.userName ? `Signed in as ${account.userName}` : 'Signed in'}</Text>
          {account.loadingProjects ? (
            <Busy label="Loading projects…" />
          ) : account.error ? (
            <View style={styles.inline}>
              <Text style={[styles.muted, { color: colors.destructive, flex: 1 }]}>{account.error}</Text>
              <TextAction title="Retry" onPress={() => void account.loadProjects()} />
            </View>
          ) : (account.projects ?? []).length === 0 ? (
            <Text style={styles.muted}>No projects in this account.</Text>
          ) : (
            <View style={styles.card}>
              {(account.projects ?? []).map((p, i, all) => {
                const on = p.id === project?.id;
                return (
                  <Pressable
                    key={p.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`Project ${p.name}`}
                    onPress={() => {
                      setPref('frameioProjectId', p.id);
                      setPref('frameioProjectName', p.name);
                      setPref('frameioRootFolderId', p.rootFolderId);
                      setPref('frameioAccountId', p.accountId);
                    }}
                    style={({ pressed }) => [styles.projectRow, i < all.length - 1 && styles.rowBorder, pressed && { opacity: 0.7 }]}
                  >
                    <Icon icon={Folder01Icon} size={18} color={on ? colors.primary : colors.mutedForeground} />
                    <View style={styles.projectText}>
                      <Text style={styles.projectName}>{p.name}</Text>
                      {p.workspaceName ? <Text style={styles.muted}>{p.workspaceName}</Text> : null}
                    </View>
                    {on ? <Icon icon={Tick02Icon} size={20} color={colors.primary} /> : null}
                  </Pressable>
                );
              })}
            </View>
          )}
        </>
      ) : account.status === 'signing-in' ? (
        <Busy label="Waiting for Adobe sign-in…" />
      ) : (
        <>
          <Text style={[styles.muted, account.error ? { color: colors.destructive } : null]}>{account.error ?? 'Use the Adobe ID of your Frame.io V4 account.'}</Text>
          <Button title="Sign in" onPress={() => void account.beginSignIn()} style={styles.signIn} />
        </>
      )}
    </FieldSection>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    summary: { gap: 4, paddingBottom: spacing.sm },
    summaryTitle: { fontFamily: fonts.semibold, fontSize: 17, color: colors.foreground },
    muted: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.mutedForeground },
    card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' as const },
    sections: { gap: spacing.md, paddingBottom: spacing.sm },
    fileRow: { gap: 2, padding: 12, borderRadius: radius.md, backgroundColor: colors.surface },
    fileLabel: { fontFamily: fonts.medium, fontSize: 12, color: colors.mutedForeground },
    fileName: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    control: { paddingBottom: 10 },
    formatBlock: { gap: 8, paddingTop: 8 },
    formatHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
    controlTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    dim: { opacity: 0.45 },
    inline: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm },
    projectRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, minHeight: 52, paddingHorizontal: spacing.md, paddingVertical: 8 },
    rowBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    projectText: { flex: 1, minWidth: 0, gap: 1 },
    projectName: { fontFamily: fonts.medium, fontSize: 15, color: colors.foreground },
    signIn: { alignSelf: 'flex-start' as const },
    footer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm + 4,
      paddingBottom: spacing.md,
      borderTopWidth: 0.5,
      borderTopColor: colors.border,
    },
    footerText: { flex: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground },
    footerButton: { minWidth: 132 },
  };
}
