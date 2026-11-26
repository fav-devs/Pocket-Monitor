import { CircleAlert, CircleCheck, Folder, LogOut } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { useCameraSession } from '@/camera';
import { defaultMediaPreferences, useMediaPreferences, type MediaPreferences } from '@/state/media';
import { MText, colors, minTouch, radius } from '@/theme';
import { PressableScale, SectionHeader } from '@/ui';
import { BatchRow } from './DeliveryQueue';
import { deliveryPlatform } from './deliveryPlatform';
import { useDelivery } from './deliveryStore';
import { mediaExporter } from './export';
import { byteLabel } from './format';
import { urlScheme, useFrameioAccount, validateFrameioConfig } from './frameio';
import { useMediaLibrary } from './libraryStore';
import { Badge, Busy, Segmented, ToggleRow } from './MediaChips';
import { ActionButton } from './MediaOverlays';

function Section({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <SectionHeader title={title} detail={detail} />
      <View style={{ borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 8, gap: 4 }}>
        {children}
      </View>
    </View>
  );
}

function Row({ title, help, children, badge }: { title: string; help?: string; children: ReactNode; badge?: string }) {
  return (
    <View style={{ gap: 6, paddingVertical: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <MText size={12.5} weight="semibold">
          {title}
        </MText>
        {badge ? <Badge text={badge} /> : null}
      </View>
      {help ? (
        <MText size={10.5} color={colors.muted}>
          {help}
        </MText>
      ) : null}
      {children}
    </View>
  );
}

function Field({ label, value, onChange, placeholder, secure }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; secure?: boolean }) {
  return (
    <View style={{ gap: 5, paddingVertical: 6 }}>
      <MText size={11} weight="semibold" color={colors.muted}>
        {label}
      </MText>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        spellCheck={false}
        style={{
          minHeight: minTouch,
          borderRadius: radius.md,
          paddingHorizontal: 12,
          backgroundColor: colors.raised,
          borderWidth: 1,
          borderColor: colors.border,
          color: colors.text,
          fontFamily: 'Sora-Regular',
          fontSize: 13,
        }}
      />
    </View>
  );
}

function Divider() {
  return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 2 }} />;
}

/**
 * Settings → Media: gallery, playback and delivery preferences, the delivery queue, the local
 * original cache, and Frame.io upload setup. Rendered by the settings feature (no props).
 */
export default function MediaSettingsPanel() {
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
  const frameioBatches = batches.filter((b) => b.destination === 'frameio');
  const otherBatches = batches.filter((b) => b.destination !== 'frameio');

  const toggle = <K extends keyof MediaPreferences>(key: K, title: string, help?: string, extra?: { disabled?: boolean; badge?: string }) => (
    <ToggleRow title={title} help={help} value={prefs[key] as boolean} onChange={(v) => set(key, v as MediaPreferences[K])} disabled={extra?.disabled} badge={extra?.badge} />
  );

  return (
    <View style={{ gap: 22, paddingVertical: 8 }}>
      <Section title="Gallery">
        <Row title="Layout">
          <Segmented label="Layout" value={prefs.layout} onChange={(v) => set('layout', v)} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]} />
        </Row>
        <Row title="Thumbnails">
          <Segmented
            label="Thumbnail size"
            value={prefs.thumbnailSize}
            onChange={(v) => set('thumbnailSize', v)}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large' },
            ]}
          />
        </Row>
        <Row title="Sort">
          <Segmented
            label="Sort"
            value={prefs.sort}
            onChange={(v) => set('sort', v)}
            options={[
              { value: 'newest', label: 'Newest' },
              { value: 'oldest', label: 'Oldest' },
              { value: 'largest', label: 'Largest' },
              { value: 'longest', label: 'Longest' },
            ]}
          />
        </Row>
        <Divider />
        {toggle('groupByDay', 'Group by day', 'Day headers when sorted by date.')}
        {toggle('stackBursts', 'Stack bursts', 'Show a burst or panorama as one card with its frame count.')}
      </Section>

      <Section title="Playback">
        {toggle('loopPlayback', 'Loop playback')}
        {toggle('mutePlayback', 'Start muted')}
        {toggle('playbackTimecode', 'Timecode clock', 'Show HH:MM:SS:FF instead of minutes and seconds.')}
        {toggle('playbackAssists', 'Open with assists', 'Show the assist overlays when a clip opens.')}
        {toggle('playbackAudioMeters', 'Audio meters', 'Level meters over the picture while a clip plays.')}
      </Section>

      <Section title="Delivery">
        <Row title="Default destination" help="Where Share starts. You can still pick another.">
          <Segmented
            label="Default destination"
            value={prefs.postExportAction}
            onChange={(v) => set('postExportAction', v)}
            options={[
              { value: 'system-share', label: 'Share sheet' },
              { value: 'save-to-photos', label: deliveryPlatform.photosTitle },
            ]}
          />
        </Row>
        <Row title="Default format" badge={exporter ? undefined : 'Native exporter'} help={exporter ? undefined : 'Re-encoding needs the native exporter. Originals are delivered until it ships.'}>
          <Segmented
            label="Default format"
            value={exporter ? prefs.shareFormat : 'original'}
            onChange={(v) => exporter && set('shareFormat', v)}
            options={[
              { value: 'original', label: 'Original' },
              { value: 'h264', label: 'H.264' },
              { value: 'hevc', label: 'HEVC' },
            ]}
          />
        </Row>
        <Divider />
        {toggle('convertLog', 'Convert log on export', 'D-Log M / D-Log / D-Log2 clips to the output curve below.', { disabled: !exporter, badge: exporter ? undefined : 'Native exporter' })}
        <Row title="Output curve">
          <Segmented label="Output curve" value={prefs.outputCurve} onChange={(v) => set('outputCurve', v)} options={[{ value: 'rec709', label: 'Rec.709' }, { value: 'hlg', label: 'HLG' }]} />
        </Row>
        {toggle('bakeLUT', 'Bake LUT on export', 'Burn the monitoring LUT into delivered clips.', { disabled: !exporter, badge: exporter ? undefined : 'Native exporter' })}
        {toggle('includeMetadata', 'Include metadata', 'Keep camera, lens and timecode tags in delivered files.')}
        {toggle('keepOriginals', 'Keep originals on this phone', 'Leave downloaded originals in the cache after a delivery for faster re-shares and offline review.')}
        <Divider />
        <View style={{ paddingVertical: 8, gap: 8 }}>
          <MText size={12.5} weight="semibold">
            Queue
          </MText>
          {otherBatches.length === 0 ? (
            <MText size={10.5} color={colors.muted}>
              No deliveries in this session.
            </MText>
          ) : (
            [...otherBatches].reverse().map((b) => <BatchRow key={b.id} batch={b} onCancel={() => cancel(b.id)} />)
          )}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <MText size={12.5} weight="semibold">
              Originals cache
            </MText>
            <MText size={10.5} color={colors.muted}>
              {cachedIds.length ? `${cachedIds.length} on this phone · ${byteLabel(cachedBytes)}` : 'Nothing cached'}
            </MText>
          </View>
          <View style={{ width: 120, flexDirection: 'row' }}>
            <ActionButton
              title="Clear"
              tone="plain"
              disabled={!cachedIds.length}
              onPress={() => {
                cachedIds.forEach((id) => {
                  void deliveryPlatform.discard(localFiles[id]);
                  forgetLocal(id);
                });
              }}
            />
          </View>
        </View>
      </Section>

      <Section title="Frame.io" detail={demo ? 'demo camera: simulated' : undefined}>
        <MText size={10.5} color={colors.muted} style={{ paddingTop: 6 }}>
          Frame.io upload uses your own Adobe Developer Console project: add the Frame.io API, create an OAuth Native App credential (PKCE, no client secret), then paste its Client ID and the full Default redirect URI here. Your Frame.io account must be a V4 account linked to the same Adobe ID.
        </MText>
        {toggle('frameioEnabled', 'Frame.io upload', 'Offer Frame.io as a Share destination.')}
        {prefs.frameioEnabled || demo ? (
          <>
            <Field label="Client ID" value={clientId} onChange={setClientId} placeholder="Adobe OAuth Native App client id" />
            <Field label="Default redirect URI" value={redirect} onChange={setRedirect} placeholder="adobe+yourid://adobeid/your_client_id" />
            {clientId || redirect ? (
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start', paddingVertical: 4 }}>
                {configError ? <CircleAlert size={13} color={colors.linkWatch} /> : <CircleCheck size={13} color={colors.linkStable} />}
                <MText size={10.5} color={configError ? colors.linkWatch : colors.muted} style={{ flex: 1 }}>
                  {configError ?? `Redirect scheme: ${urlScheme(redirect)}. The app must register this URL scheme to finish sign-in (native build setting).`}
                </MText>
              </View>
            ) : null}
            {dirty ? (
              <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 6 }}>
                <ActionButton title="Revert" tone="plain" onPress={() => (setClientId(prefs.frameioClientId), setRedirect(prefs.frameioRedirectUri))} />
                <ActionButton title="Save" disabled={!!configError} onPress={saveConfig} />
              </View>
            ) : null}
            <Divider />
            <View style={{ paddingVertical: 8, gap: 8 }}>
              <MText size={12.5} weight="semibold">
                Account
              </MText>
              {account.status === 'signing-in' ? (
                <Busy label="Waiting for Adobe sign-in…" />
              ) : account.status === 'signed-in' ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <MText size={12} color={colors.secondary} style={{ flex: 1 }}>
                    {account.userName ? `Signed in as ${account.userName}` : 'Signed in'}
                  </MText>
                  <PressableScale accessibilityLabel="Sign out of Frame.io" onPress={() => void account.signOut()} style={{ minHeight: minTouch, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <LogOut size={13} color={colors.muted} />
                    <MText size={12} weight="semibold" color={colors.muted}>
                      Sign out
                    </MText>
                  </PressableScale>
                </View>
              ) : (
                <>
                  <MText size={10.5} color={account.error ? colors.linkWatch : colors.muted}>
                    {account.error ??
                      (account.status === 'not-configured' ? 'Save a Client ID and redirect URI to sign in.' : 'Not signed in.')}
                  </MText>
                  <View style={{ flexDirection: 'row' }}>
                    <ActionButton title="Sign in with Adobe" disabled={account.status === 'not-configured' && !demo} onPress={() => void account.beginSignIn()} />
                  </View>
                </>
              )}
              <MText size={9.5} color={colors.faint}>
                {Platform.OS === 'web' ? 'On web, tokens stay in memory and are gone after a reload.' : 'Tokens are kept in the device keychain, never in app settings.'}
              </MText>
            </View>
            {account.status === 'signed-in' ? (
              <View style={{ paddingVertical: 8, gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <MText size={12.5} weight="semibold" style={{ flex: 1 }}>
                    Project
                  </MText>
                  <PressableScale accessibilityLabel="Reload projects" onPress={() => void account.loadProjects()} style={{ minHeight: minTouch, paddingHorizontal: 8, justifyContent: 'center' }}>
                    <MText size={11.5} weight="semibold" color={colors.accent}>
                      {account.projects ? 'Reload' : 'Load projects'}
                    </MText>
                  </PressableScale>
                </View>
                {account.loadingProjects ? <Busy label="Loading projects…" /> : null}
                {(account.projects ?? []).map((p) => {
                  const on = p.id === prefs.frameioProjectId;
                  return (
                    <PressableScale
                      key={p.id}
                      accessibilityLabel={`Upload into ${p.name}`}
                      accessibilityState={{ selected: on }}
                      onPress={() => {
                        set('frameioProjectId', p.id);
                        set('frameioProjectName', p.name);
                        set('frameioRootFolderId', p.rootFolderId);
                        set('frameioAccountId', p.accountId);
                      }}
                      style={{ minHeight: minTouch, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, borderRadius: radius.md, backgroundColor: on ? colors.raised : 'transparent' }}
                    >
                      <Folder size={14} color={on ? colors.accent : colors.muted} />
                      <MText size={12.5} weight={on ? 'semibold' : 'regular'} style={{ flex: 1 }}>
                        {p.name}
                      </MText>
                      {on ? <CircleCheck size={14} color={colors.accent} /> : null}
                    </PressableScale>
                  );
                })}
                {!account.projects && prefs.frameioProjectName ? (
                  <MText size={11} color={colors.muted}>
                    Uploading into {prefs.frameioProjectName}
                  </MText>
                ) : null}
              </View>
            ) : null}
            <Divider />
            <View style={{ paddingVertical: 8, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <MText size={12.5} weight="semibold" style={{ flex: 1 }}>
                  Upload queue
                </MText>
                {batches.some((b) => b.status !== 'running' && b.status !== 'queued') ? (
                  <PressableScale accessibilityLabel="Clear finished deliveries" onPress={clearFinished} style={{ minHeight: minTouch, paddingHorizontal: 8, justifyContent: 'center' }}>
                    <MText size={11.5} weight="semibold" color={colors.accent}>
                      Clear finished
                    </MText>
                  </PressableScale>
                ) : null}
              </View>
              {frameioBatches.length === 0 ? (
                <MText size={10.5} color={colors.muted}>
                  Nothing uploading. In Media, select clips, then Share → Frame.io upload.
                </MText>
              ) : (
                [...frameioBatches].reverse().map((b) => <BatchRow key={b.id} batch={b} onCancel={() => cancel(b.id)} />)
              )}
              {toggle('frameioReupload', 'Upload again', 'Re-upload clips already sent to Frame.io.')}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <MText size={10.5} color={colors.muted} style={{ flex: 1 }}>
                  {prefs.frameioUploaded.length} clip{prefs.frameioUploaded.length === 1 ? '' : 's'} remembered as uploaded
                </MText>
                <PressableScale accessibilityLabel="Forget upload history" disabled={!prefs.frameioUploaded.length} onPress={() => set('frameioUploaded', [])} style={{ minHeight: minTouch, paddingHorizontal: 8, justifyContent: 'center' }}>
                  <MText size={11.5} weight="semibold" color={colors.accent}>
                    Forget
                  </MText>
                </PressableScale>
              </View>
            </View>
          </>
        ) : null}
      </Section>

      <View style={{ flexDirection: 'row' }}>
        <ActionButton
          title="Reset media settings"
          tone="plain"
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
    </View>
  );
}
