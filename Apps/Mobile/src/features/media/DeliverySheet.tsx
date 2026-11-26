import { Check, ChevronLeft, ChevronRight, CloudUpload, Download, Folder, Share as ShareIcon } from 'lucide-react-native';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import type { CameraMediaItem } from '@/camera';
import { useCameraSession } from '@/camera';
import { useMediaPreferences } from '@/state/media';
import { MText, colors, minTouch, radius, withAlpha } from '@/theme';
import { PressableScale, SectionHeader } from '@/ui';
import { deliveryPlatform } from './deliveryPlatform';
import { type DeliveryDestination, useDelivery } from './deliveryStore';
import { type ExportOptions, mediaExporter } from './export';
import { byteLabel, isLogColor } from './format';
import { type FrameioProject, useFrameioAccount } from './frameio';
import { Badge, Busy, Segmented, ToggleRow } from './MediaChips';
import { ActionButton, CloseButton, OverlayCard } from './MediaOverlays';

const copy = {
  convertHelp: 'Choose one output curve for every selected D-Log or D-Log2 clip. Camera originals stay untouched.',
  convertUnavailableHelp: 'Needs a D-Log or D-Log2 clip. Rec.709 stays as-shot.',
  exporterNotice: 'Convert log, Bake LUT and re-encoding need the native exporter, which is not in this build yet. Originals are delivered unchanged.',
};

export function DestinationIcon({ destination, color = colors.accent, size = 18 }: { destination: DeliveryDestination; color?: string; size?: number }) {
  const Icon = destination === 'share' ? ShareIcon : destination === 'photos' ? Download : CloudUpload;
  return <Icon size={size} color={color} strokeWidth={1.9} />;
}

function selectionLabel(items: CameraMediaItem[]): string {
  const bytes = byteLabel(items.reduce((n, i) => n + i.sizeBytes, 0));
  if (items.length === 1) return `${items[0].fileName} · ${bytes}`;
  const videos = items.filter((i) => i.kind === 'video').length;
  const photos = items.length - videos;
  const parts = [videos ? `${videos} clip${videos === 1 ? '' : 's'}` : null, photos ? `${photos} photo${photos === 1 ? '' : 's'}` : null];
  return `${parts.filter(Boolean).join(' + ')} · ${bytes}`;
}

function Plate({ children, onPress, disabled, label }: { children: ReactNode; onPress?: () => void; disabled?: boolean; label: string }) {
  return (
    <PressableScale
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      noScale
      style={{
        minHeight: 56,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: radius.md,
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderWidth: 1,
        borderColor: colors.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      {children}
    </PressableScale>
  );
}

/**
 * `MonitorMediaDeliveryPanel`: choose a destination, then its options, then begin. The accepted
 * request joins the delivery queue; progress shows in the queue panel and the compact pill.
 */
export function DeliverySheet({ items, onClose, initialDestination }: { items: CameraMediaItem[]; onClose: () => void; initialDestination?: DeliveryDestination }) {
  const session = useCameraSession();
  const demo = session.kind === 'demo';
  const prefs = useMediaPreferences();
  const account = useFrameioAccount();
  const enqueue = useDelivery((s) => s.enqueue);
  const [destination, setDestination] = useState<DeliveryDestination | null>(
    initialDestination ?? (useMediaPreferences.getState().postExportAction === 'save-to-photos' ? 'photos' : null),
  );

  useEffect(() => {
    void account.refresh(demo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

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

  const destinations: { id: DeliveryDestination; title: string; subtitle: string; enabled: boolean }[] = [
    { id: 'share', title: 'Share', subtitle: deliveryPlatform.shareSubtitle, enabled: true },
    { id: 'photos', title: deliveryPlatform.photosTitle, subtitle: deliveryPlatform.photosSubtitle, enabled: true },
    {
      id: 'frameio',
      title: 'Frame.io upload',
      subtitle: frameioReady ? `Upload to your Frame.io project${demo ? ' (demo)' : ''}` : 'Set up in Settings → Media → Frame.io',
      enabled: frameioReady,
    },
  ];

  const actionTitle = destination === 'frameio' ? 'Upload' : destination === 'photos' ? (deliveryPlatform.photosTitle === 'Download' ? 'Download' : 'Save') : 'Share';
  const canBegin = destination !== 'frameio' || (account.status === 'signed-in' && !!project);

  return (
    <OverlayCard onDismiss={onClose} maxWidth={460} align="center" label="Share">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: destination ? 4 : 16, paddingRight: 8, paddingTop: 8 }}>
        {destination ? (
          <>
            <PressableScale accessibilityLabel="Back" onPress={() => setDestination(null)} style={{ minHeight: minTouch, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <ChevronLeft size={14} color={colors.accent} strokeWidth={2.2} />
              <MText size={13} weight="semibold" color={colors.accent}>
                Back
              </MText>
            </PressableScale>
            <View style={{ flex: 1, gap: 2 }}>
              <MText size={9} weight="bold" tracking={1.8} uppercase>
                {destinations.find((d) => d.id === destination)?.title}
              </MText>
              <MText size={11} weight="medium" color={colors.muted}>
                Options
              </MText>
            </View>
          </>
        ) : (
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ShareIcon size={14} color={colors.text} strokeWidth={2.2} />
            <MText size={14} weight="bold" tracking={1} uppercase>
              Share
            </MText>
          </View>
        )}
        <CloseButton onPress={onClose} />
      </View>
      <View style={{ flexShrink: 1 }}>
        <ScrollBody>
          <View style={{ gap: 6 }}>
            <MText size={15} weight="semibold">
              {selectionLabel(items)}
            </MText>
            {destination && !exporter && anyVideo ? (
              <MText size={12} color={colors.muted}>
                {copy.exporterNotice}
              </MText>
            ) : null}
          </View>
          {!destination ? (
            <View style={{ gap: 8 }}>
              <SectionHeader title="Destination" />
              {destinations.map((d) => (
                <Plate key={d.id} label={d.title} onPress={() => setDestination(d.id)} disabled={!d.enabled}>
                  <DestinationIcon destination={d.id} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <MText size={14} weight="semibold" color={d.enabled ? colors.text : colors.faint}>
                      {d.title}
                    </MText>
                    <MText size={11} color={colors.muted}>
                      {d.subtitle}
                    </MText>
                  </View>
                  <ChevronRight size={13} color={colors.faint} />
                </Plate>
              ))}
            </View>
          ) : (
            <View style={{ gap: 18 }}>
              {destination === 'frameio' ? <FrameioService project={project} /> : null}
              <View style={{ gap: 4 }}>
                <SectionHeader title="Export" />
                {items.length === 1 ? (
                  <View style={{ padding: 12, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.05)', gap: 4, marginBottom: 4 }}>
                    <MText size={12} weight="semibold" color={colors.muted}>
                      Filename
                    </MText>
                    <MText size={13} mono>
                      {items[0].fileName}
                    </MText>
                  </View>
                ) : null}
                {anyVideo ? (
                  <>
                    <ToggleRow
                      title="Convert log"
                      help={anyLog ? copy.convertHelp : copy.convertUnavailableHelp}
                      value={options.convertLog}
                      onChange={(v) => prefs.set('convertLog', v)}
                      disabled={!exporter || !anyLog}
                      badge={exporter ? undefined : 'Native exporter'}
                    />
                    {options.convertLog ? (
                      <Segmented
                        label="Output curve"
                        value={prefs.outputCurve}
                        onChange={(v) => prefs.set('outputCurve', v)}
                        options={[
                          { value: 'rec709', label: 'Rec.709' },
                          { value: 'hlg', label: 'HLG' },
                        ]}
                      />
                    ) : null}
                    <ToggleRow
                      title="Bake LUT"
                      help="Burn the monitoring LUT into the delivered file."
                      value={options.bakeLUT}
                      onChange={(v) => prefs.set('bakeLUT', v)}
                      disabled={!exporter}
                      badge={exporter ? undefined : 'Native exporter'}
                    />
                    {options.bakeLUT ? (
                      <ToggleRow title="Bake exposure" help="Apply the LUT exposure offset too." value={options.bakeExposure} onChange={(v) => prefs.set('bakeExposure', v)} />
                    ) : null}
                    <View style={{ gap: 6, paddingVertical: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <MText size={12.5} weight="semibold" color={exporter ? colors.text : colors.faint}>
                          Format
                        </MText>
                        {exporter ? null : <Badge text="Native exporter" />}
                      </View>
                      <Segmented
                        label="Format"
                        value={options.format}
                        onChange={(v) => exporter && prefs.set('shareFormat', v)}
                        options={[
                          { value: 'original', label: 'Original' },
                          { value: 'h264', label: 'H.264' },
                          { value: 'hevc', label: 'HEVC' },
                        ]}
                      />
                    </View>
                  </>
                ) : null}
                <ToggleRow title="Include metadata" help="Keep camera, lens and timecode tags." value={prefs.includeMetadata} onChange={(v) => prefs.set('includeMetadata', v)} />
                {destination === 'frameio' ? (
                  <ToggleRow title="Upload again" help="Upload clips already sent to Frame.io." value={prefs.frameioReupload} onChange={(v) => prefs.set('frameioReupload', v)} />
                ) : null}
              </View>
            </View>
          )}
        </ScrollBody>
      </View>
      {destination ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderTopWidth: 1, borderTopColor: colors.border }}>
          <MText size={11} color={colors.muted} style={{ flex: 1 }} numberOfLines={2}>
            {destination === 'frameio' && !project ? 'Choose a project to upload into.' : `${items.length} item${items.length === 1 ? '' : 's'} · ${options.convertLog || options.bakeLUT ? 'Transformed' : 'Originals'}`}
          </MText>
          <View style={{ width: 150, flexDirection: 'row' }}>
            <ActionButton title={actionTitle} onPress={begin} disabled={!canBegin} icon={<DestinationIcon destination={destination} color={colors.onAccent} size={15} />} />
          </View>
        </View>
      ) : null}
    </OverlayCard>
  );
}

function ScrollBody({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 16, paddingTop: 10, gap: 16 }} showsVerticalScrollIndicator={false}>
      {children}
    </ScrollView>
  );
}

function FrameioService({ project }: { project?: FrameioProject }) {
  const account = useFrameioAccount();
  const setPref = useMediaPreferences((s) => s.set);
  return (
    <View style={{ gap: 10 }}>
      <SectionHeader title={account.demo ? 'Frame.io · demo' : 'Frame.io'} />
      {account.status === 'signed-in' ? (
        <>
          <MText size={12} color={colors.muted}>
            {account.userName ? `Signed in as ${account.userName}` : 'Signed in'}
          </MText>
          {account.loadingProjects ? (
            <Busy label="Loading projects…" />
          ) : account.error ? (
            <View style={{ gap: 6 }}>
              <MText size={12} color={colors.accent}>
                {account.error}
              </MText>
              <ActionButton title="Retry" tone="plain" onPress={() => void account.loadProjects()} />
            </View>
          ) : (
            <View style={{ gap: 6 }}>
              {(account.projects ?? []).length === 0 ? (
                <MText size={12} color={colors.muted}>
                  No projects in this account.
                </MText>
              ) : null}
              {(account.projects ?? []).map((p) => {
                const on = p.id === project?.id;
                return (
                  <Plate
                    key={p.id}
                    label={`Project ${p.name}`}
                    onPress={() => {
                      setPref('frameioProjectId', p.id);
                      setPref('frameioProjectName', p.name);
                      setPref('frameioRootFolderId', p.rootFolderId);
                      setPref('frameioAccountId', p.accountId);
                    }}
                  >
                    <Folder size={15} color={on ? colors.accent : colors.muted} />
                    <View style={{ flex: 1 }}>
                      <MText size={13} weight="semibold">
                        {p.name}
                      </MText>
                      {p.workspaceName ? (
                        <MText size={10.5} color={colors.muted}>
                          {p.workspaceName}
                        </MText>
                      ) : null}
                    </View>
                    {on ? <Check size={15} color={colors.accent} strokeWidth={2.4} /> : null}
                  </Plate>
                );
              })}
            </View>
          )}
        </>
      ) : account.status === 'signing-in' ? (
        <Busy label="Waiting for Adobe sign-in…" />
      ) : (
        <View style={{ gap: 8 }}>
          <MText size={12} color={account.error ? colors.accent : colors.muted}>
            {account.error ?? 'Sign in with the Adobe ID linked to your Frame.io V4 account.'}
          </MText>
          <View style={{ flexDirection: 'row' }}>
            <ActionButton title="Sign in" onPress={() => void account.beginSignIn()} />
          </View>
        </View>
      )}
      {account.status === 'signed-in' ? null : (
        <View style={{ height: 1, backgroundColor: withAlpha('#FFFFFF', 0.06) }} />
      )}
    </View>
  );
}
