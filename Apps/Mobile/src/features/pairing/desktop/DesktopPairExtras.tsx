/**
 * Desktop-only rows of the pair wizard (`docs/desktop-expo-port.md` C3, D-1, D-4):
 *
 * - *Already on camera Wi-Fi*: the PC joined the camera's network by hand, so link it at once
 *   with no Bluetooth (the old connection screen's skip).
 * - *Return to camera Wi-Fi*: a camera that was put on a home network goes back to hosting
 *   its own, and the PC forgets the home network.
 * - The home network's name is prefilled with the network this PC is on.
 */
import { ArrowRight01Icon, Wifi01Icon, WifiDisconnected01Icon } from '@hugeicons/core-free-icons';
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { desktopCameraEnabled } from '@/camera/bootstrap';
import { currentPcSsid, directTarget, isCancelled, returnCameraToOwnWifi } from '@/camera/desktop/connect';
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

/** Prefills the home network's name with the Wi-Fi this PC is on (D-1). */
export function useDesktopSsidPrefill(kind: SetupKind | null, setDraft: (update: (d: NetworkDraft) => NetworkDraft) => void) {
  useEffect(() => {
    if (!desktopCameraEnabled || kind !== 'station') return;
    let live = true;
    currentPcSsid()
      .then((ssid) => {
        if (live && ssid) setDraft((d) => (d.ssid ? d : { ...d, ssid }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [kind, setDraft]);
}

function createStyles(colors: ThemeColors) {
  return {
    pressed: { opacity: 0.75 },
    action: { fontFamily: fonts.semibold, fontSize: 14, color: colors.primary },
  };
}
