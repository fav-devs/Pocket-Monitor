/**
 * Desktop-only rows of the pair wizard (`docs/desktop-expo-port.md` C3, D-1, D-4):
 *
 * - *Already on camera Wi-Fi*: the PC joined the camera's network by hand, so link it at once
 *   with no Bluetooth (the old connection screen's skip).
 * - *Return to camera Wi-Fi*: a camera that was put on a home network goes back to hosting
 *   its own, and the PC forgets the home network.
 * - The home network's name is prefilled with the network kept from last time, else the one this PC
 *   is on (asked again each second while empty: macOS gives it only once Location is allowed).
 * - *Remember this Wi-Fi* (on by default) and the kept network with *Forget* (main 95f567d): a kept
 *   network with its password joins with nothing typed; the password stays in the backend.
 */
import { ArrowRight01Icon, FloppyDiskIcon, Wifi01Icon, WifiDisconnected01Icon } from '@hugeicons/core-free-icons';
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { desktopCameraEnabled } from '@/camera/bootstrap';
import { currentPcSsid, directTarget, isCancelled, returnCameraToOwnWifi } from '@/camera/desktop/connect';
import { homeWifiLabel, prefillFromHome, useDesktopHomeWifi } from '@/camera/desktop/homeWifi';
import { SettingSwitch } from '@/features/settings/components/ui';
import { Icon } from '@/components/icon';
import { Spinner } from '@/components/spinner';
import { fonts, type ThemeColors, useTheme, useThemedStyles } from '@/constants/theme';
import type { SetupKind } from '../copy';
import { InfoRow, ListGroup } from '../components/PairPieces';
import type { NetworkDraft } from '../SetupFlow';
import { useConnectActions } from '../useConnectActions';

/** On the find page: link a camera whose Wi-Fi this PC is already on. */
export function DesktopAlreadyOnCameraWifi() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { connectSaved } = useConnectActions();
  if (!desktopCameraEnabled) return null;
  return (
    <ListGroup>
      <Pressable
        testID="pair.desktop.direct"
        accessibilityRole="button"
        accessibilityLabel="Already on camera Wi-Fi"
        onPress={() => void connectSaved(directTarget)}
        style={({ pressed }) => [pressed && styles.pressed]}
      >
        <InfoRow
          icon={Wifi01Icon}
          title="Already on camera Wi-Fi"
          last
          trailing={<Icon icon={ArrowRight01Icon} size={16} color={colors.mutedForeground} />}
        />
      </Pressable>
    </ListGroup>
  );
}

/** On the setup page, for a camera found over Bluetooth: back to its own Wi-Fi. */
export function DesktopReturnToCameraWifi({ address }: { address: string | null }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  if (!desktopCameraEnabled || !address) return null;
  const run = async () => {
    setState({ busy: true, note: null });
    try {
      await returnCameraToOwnWifi(address);
      setState({ busy: false, note: 'Back on its own Wi-Fi' });
    } catch (error) {
      setState({ busy: false, note: isCancelled(error) ? null : typeof error === 'string' ? error : 'The camera did not answer.' });
    }
  };
  return (
    <ListGroup>
      <Pressable
        testID="pair.desktop.resetStation"
        accessibilityRole="button"
        accessibilityLabel="Return to camera Wi-Fi"
        disabled={state.busy}
        onPress={() => void run()}
        style={({ pressed }) => [pressed && styles.pressed]}
      >
        <InfoRow
          icon={WifiDisconnected01Icon}
          title="Return to camera Wi-Fi"
          detail={state.note ?? undefined}
          last
          trailing={state.busy ? <Spinner size={16} opacity={1} color={colors.mutedForeground} /> : <Text style={styles.action}>Return</Text>}
        />
      </Pressable>
    </ListGroup>
  );
}

/** How long the name is asked for while macOS waits on the Location prompt (main 62a09c8). */
const SSID_TRIES = 30;

/**
 * Prefills the home network's name (D-1): the network kept from last time, else the Wi-Fi this PC
 * is on, asked once a second until there is one.
 */
export function useDesktopSsidPrefill(kind: SetupKind | null, setDraft: (update: (d: NetworkDraft) => NetworkDraft) => void) {
  const home = useDesktopHomeWifi((s) => s.home);
  const refresh = useDesktopHomeWifi((s) => s.refresh);
  useEffect(() => {
    if (desktopCameraEnabled) void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!desktopCameraEnabled || kind !== 'station') return;
    if (home) {
      setDraft((d) => prefillFromHome(d, home));
      return;
    }
    let live = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = () => {
      tries += 1;
      currentPcSsid()
        .then((ssid) => {
          if (!live) return;
          if (ssid) setDraft((d) => (d.ssid ? d : { ...d, ssid }));
          else if (tries < SSID_TRIES) timer = setTimeout(ask, 1000);
        })
        .catch(() => {});
    };
    ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [kind, home, setDraft]);
}

/** Under the home network's details: keep it for next time, and the network already kept. */
export function DesktopRememberWifi() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const home = useDesktopHomeWifi((s) => s.home);
  const remember = useDesktopHomeWifi((s) => s.remember);
  const setRemember = useDesktopHomeWifi((s) => s.setRemember);
  const forget = useDesktopHomeWifi((s) => s.forget);
  const [note, setNote] = useState<string | null>(null);
  if (!desktopCameraEnabled) return null;
  return (
    <ListGroup>
      <InfoRow
        icon={FloppyDiskIcon}
        title="Remember this Wi-Fi"
        last={!home}
        trailing={<SettingSwitch value={remember} onChange={setRemember} label="Remember this Wi-Fi" testID="pair.desktop.remember" />}
      />
      {home ? (
        <Pressable
          testID="pair.desktop.forgetHome"
          accessibilityRole="button"
          accessibilityLabel="Forget home Wi-Fi"
          onPress={() => {
            setNote(null);
            forget().catch((error) => setNote(typeof error === 'string' ? error : 'That did not work.'));
          }}
          style={({ pressed }) => [pressed && styles.pressed]}
        >
          <InfoRow
            icon={Wifi01Icon}
            title="Home Wi-Fi"
            detail={note ?? homeWifiLabel(home)}
            last
            trailing={<Text style={[styles.action, { color: colors.destructive }]}>Forget</Text>}
          />
        </Pressable>
      ) : null}
    </ListGroup>
  );
}

function createStyles(colors: ThemeColors) {
  return {
    pressed: { opacity: 0.75 },
    action: { fontFamily: fonts.semibold, fontSize: 14, color: colors.primary },
  };
}
