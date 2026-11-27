import {
  ArrowRight01Icon,
  HotspotIcon,
  QrCodeIcon,
  Router01Icon,
  Settings02Icon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react-native';
import { useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { fonts, spacing, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import { FormField } from './components/FormField';
import { ChoiceRow, InfoRow, ListGroup } from './components/PairPieces';
import { NetworkSetupCopy, SetupChooserCopy, setupOrder, type SetupKind } from './copy';
import { WifiQrScanner, wifiQrScanAvailable } from './WifiQrScanner';

export const setupIcons: Record<SetupKind, IconSvgElement> = {
  softap: Wifi01Icon,
  station: Router01Icon,
  hotspot: HotspotIcon,
};

/** The shared setup chooser (`AddSetupChooserView`): one row per way in. */
export function SetupChooser({
  selected,
  added,
  onSelect,
}: {
  selected: SetupKind | null;
  /** Network already saved for a kind ("Added · Studio"). */
  added?: Partial<Record<SetupKind, string>>;
  onSelect: (kind: SetupKind) => void;
}) {
  return (
    <ListGroup>
      {setupOrder.map((kind, i) => {
        const copy = SetupChooserCopy[kind];
        return (
          <ChoiceRow
            key={kind}
            testID={`addSetup.${copy.id}`}
            accessibilityLabel={copy.action}
            icon={setupIcons[kind]}
            title={copy.title}
            subtitle={copy.body}
            meta={added?.[kind] ? `Added · ${added[kind]}` : undefined}
            selected={selected === kind}
            onPress={() => onSelect(kind)}
            last={i === setupOrder.length - 1}
          />
        );
      })}
    </ListGroup>
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
export function StationNetworkForm({
  draft,
  onChange,
  passwordPlaceholder,
}: {
  draft: NetworkDraft;
  onChange: (d: NetworkDraft) => void;
  /** "Saved" on the desktop when the kept network's password will be used. */
  passwordPlaceholder?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<string | null>(null);
  return (
    <View style={styles.stack}>
      {wifiQrScanAvailable ? (
        <ListGroup>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={NetworkSetupCopy.scanQr}
            onPress={() => setScanning(true)}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <InfoRow
              icon={QrCodeIcon}
              title={NetworkSetupCopy.scanQr}
              detail={scanned ? `Filled from ${scanned}` : undefined}
              last
              trailing={<Icon icon={ArrowRight01Icon} size={16} color={colors.mutedForeground} />}
            />
          </Pressable>
        </ListGroup>
      ) : (
        <ListGroup>
          <InfoRow icon={QrCodeIcon} title={NetworkSetupCopy.scanQr} detail={NetworkSetupCopy.scanQrUnavailable} last />
        </ListGroup>
      )}
      <FormField
        label="Network name"
        value={draft.ssid}
        onChangeText={(ssid) => onChange({ ...draft, ssid })}
        placeholder="Studio Wi-Fi"
        testID="setup.ssid"
      />
      <FormField
        label="Password"
        value={draft.password}
        onChangeText={(password) => onChange({ ...draft, password })}
        secure
        placeholder={passwordPlaceholder ?? 'Password'}
        testID="setup.password"
        hint={draft.password.length > 0 && draft.password.length < 8 ? NetworkSetupCopy.passwordTooShort : undefined}
      />
      <Text style={styles.note}>{NetworkSetupCopy.networkRules}</Text>
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
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.stack}>
      <ListGroup label="In Settings › Personal Hotspot">
        {NetworkSetupCopy.hotspotChecks.map((title, i) => (
          <InfoRow key={title} number={i + 1} title={title} last={i === NetworkSetupCopy.hotspotChecks.length - 1} />
        ))}
      </ListGroup>
      {Platform.OS !== 'web' ? (
        <Button
          title="Open Settings"
          variant="secondary"
          icon={Settings02Icon}
          onPress={() => Linking.openSettings().catch(() => {})}
        />
      ) : null}
      <FormField
        label="Hotspot name"
        value={draft.ssid}
        onChangeText={(ssid) => onChange({ ...draft, ssid })}
        placeholder="iPhone"
        hint={NetworkSetupCopy.hotspotNameHint}
        testID="setup.hotspotName"
      />
      <FormField
        label="Hotspot password"
        value={draft.password}
        onChangeText={(password) => onChange({ ...draft, password })}
        secure
        hint={draft.password.length > 0 && draft.password.length < 8 ? NetworkSetupCopy.passwordTooShort : undefined}
        testID="setup.hotspotPassword"
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    stack: { gap: spacing.md },
    note: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mutedForeground, paddingHorizontal: 4 },
    pressed: { opacity: 0.75 },
  };
}
