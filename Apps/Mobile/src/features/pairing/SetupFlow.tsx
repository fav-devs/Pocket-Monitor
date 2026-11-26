import { Check, QrCode, Radio, Settings as SettingsIcon, TriangleAlert, Wifi } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Platform, View, useWindowDimensions } from 'react-native';
import { MText, colors, withAlpha } from '@/theme';
import { PressableScale } from '@/ui';
import { FormField } from './components/FormField';
import { NetworkSetupCopy, SetupChooserCopy, SetupChooserText, setupOrder, type SetupKind } from './copy';
import { WifiQrScanner, wifiQrScanAvailable } from './WifiQrScanner';

/** The shared setup chooser (`AddSetupChooserView`): one card per way in. */
export function SetupChooser({
  detail,
  selected,
  added,
  onSelect,
  showTitle = true,
}: {
  showTitle?: boolean;
  detail: string;
  selected: SetupKind | null;
  /** Network already saved for a kind ("Added · Studio"). */
  added?: Partial<Record<SetupKind, string>>;
  onSelect: (kind: SetupKind) => void;
}) {
  const { width, height } = useWindowDimensions();
  const horizontal = width > height && width >= 640;
  return (
    <View style={{ gap: 12 }}>
      {showTitle ? (
        <View style={{ gap: 4 }}>
          <MText size={18} weight="semibold">
            {SetupChooserText.title}
          </MText>
          {detail ? (
            <MText size={13} color={colors.muted}>
              {detail}
            </MText>
          ) : null}
        </View>
      ) : null}
      <View style={{ flexDirection: horizontal ? 'row' : 'column', gap: 12, alignItems: horizontal ? 'stretch' : undefined }}>
        {setupOrder.map((kind) => {
          const copy = SetupChooserCopy[kind];
          const active = selected === kind;
          const lines = [added?.[kind] ? `Added · ${added[kind]}` : null, copy.body, copy.tag].filter(Boolean).join('\n');
          return (
            <View
              key={kind}
              style={{
                flex: horizontal ? 1 : undefined,
                gap: 6,
                padding: 12,
                borderRadius: 12,
                backgroundColor: colors.raised,
                borderWidth: 1,
                borderColor: active ? withAlpha(colors.accent, 0.5) : 'transparent',
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <MText size={15} weight="semibold" style={{ flex: 1 }}>
                  {copy.title}
                </MText>
                {active ? <Check size={16} color={colors.accent} strokeWidth={2.4} /> : null}
              </View>
              <MText size={12.5} color={colors.muted} style={{ lineHeight: 18, flexGrow: horizontal ? 1 : 0 }}>
                {lines}
              </MText>
              <PressableScale
                testID={`addSetup.${copy.id}`}
                accessibilityLabel={copy.action}
                accessibilityState={{ selected: active }}
                onPress={() => onSelect(kind)}
                style={{
                  alignSelf: 'flex-start',
                  minHeight: 44,
                  justifyContent: 'center',
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  backgroundColor: active ? withAlpha(colors.accent, 0.16) : 'rgba(255,255,255,0.08)',
                  marginTop: 2,
                }}
              >
                <MText size={13} weight="semibold" color={active ? colors.accent : colors.text}>
                  {copy.action}
                </MText>
              </PressableScale>
            </View>
          );
        })}
      </View>
      <MText size={12} color={colors.muted}>
        {SetupChooserText.footer}
      </MText>
    </View>
  );
}

function card(extra?: object) {
  return {
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...extra,
  };
}

function CheckLine({ title, detail, number }: { title: string; detail?: string; number?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: withAlpha(colors.accent, 0.16),
          marginTop: 1,
        }}
      >
        {number ? (
          <MText size={11} weight="bold" color={colors.accent}>
            {String(number)}
          </MText>
        ) : (
          <Check size={12} color={colors.accent} strokeWidth={2.6} />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <MText size={13} weight="semibold">
          {title}
        </MText>
        {detail ? (
          <MText size={11} color={colors.muted}>
            {detail}
          </MText>
        ) : null}
      </View>
    </View>
  );
}

export interface NetworkDraft {
  ssid: string;
  password: string;
}

/** A Wi-Fi password the camera accepts: open (empty) or WPA2 length. */
export function acceptsPassword(password: string, hotspot: boolean): boolean {
  if (hotspot) return password.length >= 8 && password.length <= 63;
  return password.length === 0 || (password.length >= 8 && password.length <= 63);
}

/** Shared Wi-Fi details (`StationNetworkSetupView` password page) with an optional QR scan. */
export function StationNetworkForm({ draft, onChange }: { draft: NetworkDraft; onChange: (d: NetworkDraft) => void }) {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<string | null>(null);
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 4 }}>
        <MText size={18} weight="semibold">
          {NetworkSetupCopy.networkTitle}
        </MText>
        <MText size={12} color={colors.muted}>
          {NetworkSetupCopy.networkHint}
        </MText>
      </View>
      {wifiQrScanAvailable ? (
        <PressableScale
          accessibilityLabel={NetworkSetupCopy.scanQr}
          onPress={() => setScanning(true)}
          style={[card(), { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 52 }]}
        >
          <QrCode size={19} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <MText size={13} weight="semibold">
              {NetworkSetupCopy.scanQr}
            </MText>
            <MText size={10.5} color={colors.muted}>
              {scanned ? `Filled from ${scanned}` : 'Fills the network name and password'}
            </MText>
          </View>
        </PressableScale>
      ) : (
        <View style={[card(), { flexDirection: 'row', gap: 10, padding: 12, alignItems: 'center' }]}>
          <QrCode size={17} color={colors.faint} />
          <MText size={11} color={colors.muted} style={{ flex: 1 }}>
            {NetworkSetupCopy.scanQrUnavailable}
          </MText>
        </View>
      )}
      <FormField
        label="NETWORK NAME"
        value={draft.ssid}
        onChangeText={(ssid) => onChange({ ...draft, ssid })}
        placeholder="Studio Wi-Fi"
        testID="setup.ssid"
      />
      <FormField
        label="PASSWORD"
        value={draft.password}
        onChangeText={(password) => onChange({ ...draft, password })}
        secure
        placeholder="Password"
        testID="setup.password"
        hint={`${draft.password.length > 0 && draft.password.length < 8 ? 'Wi-Fi passwords are at least 8 characters. ' : draft.password.length === 0 ? `${NetworkSetupCopy.openNetwork} ` : ''}${NetworkSetupCopy.passwordSaved}`}
      />
      <View style={[card(), { padding: 16, gap: 13 }]}>
        <MText size={8.5} weight="bold" tracking={1.5} color={colors.faint}>
          {NetworkSetupCopy.beforeYouConnect}
        </MText>
        {NetworkSetupCopy.checks.map((c) => (
          <CheckLine key={c.title} title={c.title} detail={c.detail} />
        ))}
      </View>
      <WifiQrScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onScanned={(wifi) => {
          setScanning(false);
          setScanned(wifi.ssid);
          onChange({ ssid: wifi.ssid, password: wifi.password });
        }}
      />
    </View>
  );
}

/** Personal Hotspot details (`StationNetworkSetupView` hotspot page). */
export function HotspotForm({ draft, onChange }: { draft: NetworkDraft; onChange: (d: NetworkDraft) => void }) {
  const warning = colors.linkWatch;
  return (
    <View style={{ gap: 14 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: 12,
          backgroundColor: withAlpha(warning, 0.1),
          borderWidth: 1,
          borderColor: withAlpha(warning, 0.3),
        }}
      >
        <TriangleAlert size={18} color={warning} />
        <MText size={13} weight="semibold" color={warning} style={{ flex: 1 }}>
          {NetworkSetupCopy.hotspotNotDetected}
        </MText>
      </View>
      <View style={[card(), { padding: 16, gap: 13 }]}>
        <MText size={8.5} weight="bold" tracking={1.5} color={colors.faint}>
          {NetworkSetupCopy.hotspotChecklistTitle}
        </MText>
        {NetworkSetupCopy.hotspotChecks.map((c, i) => (
          <CheckLine key={c.title} number={i + 1} title={c.title} detail={c.detail} />
        ))}
        {Platform.OS !== 'web' ? (
          <PressableScale
            accessibilityLabel="Open Settings"
            onPress={() => Linking.openSettings().catch(() => {})}
            style={{
              flexDirection: 'row',
              gap: 8,
              minHeight: 44,
              borderRadius: 12,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.raised,
            }}
          >
            <SettingsIcon size={16} color={colors.text} />
            <MText size={13.5} weight="semibold">
              Open Settings
            </MText>
          </PressableScale>
        ) : null}
      </View>
      <FormField
        label="HOTSPOT NAME"
        value={draft.ssid}
        onChangeText={(ssid) => onChange({ ...draft, ssid })}
        placeholder="iPhone"
        hint={NetworkSetupCopy.hotspotNameHint}
        testID="setup.hotspotName"
      />
      <FormField
        label="HOTSPOT PASSWORD"
        value={draft.password}
        onChangeText={(password) => onChange({ ...draft, password })}
        secure
        hint={NetworkSetupCopy.hotspotPasswordHint}
        testID="setup.hotspotPassword"
      />
    </View>
  );
}

/** Camera Wi-Fi needs nothing typed: what happens next, in two lines. */
export function SoftApSummary({ cameraName }: { cameraName: string }) {
  return (
    <View style={[card(), { flexDirection: 'row', gap: 12, padding: 14, alignItems: 'center' }]}>
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: withAlpha(colors.accent, 0.14),
        }}
      >
        <Wifi size={19} color={colors.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <MText size={14} weight="semibold">
          Camera Wi-Fi
        </MText>
        <MText size={11.5} color={colors.muted}>
          {`${cameraName} shares its own network over Bluetooth. Nothing to type.`}
        </MText>
      </View>
      <Radio size={16} color={colors.faint} />
    </View>
  );
}
