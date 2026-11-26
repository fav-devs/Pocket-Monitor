import { CameraView, useCameraPermissions } from 'expo-camera';
import { ScanLine, X } from 'lucide-react-native';
import { useRef } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MText, colors } from '@/theme';
import { IconButton } from '@/ui';
import { CameraPageButton } from './components/CameraPageButton';
import { NetworkSetupCopy } from './copy';
import { parseWifiQr, type WifiQr } from './presentation';

/** QR scanning is available on phones; web shows the typed form only. */
export const wifiQrScanAvailable = true;

/**
 * Full-screen Wi-Fi QR scanner (expo-camera). Calls `onScanned` once with the first valid
 * `WIFI:` payload; anything else is ignored.
 */
export function WifiQrScanner({
  visible,
  onClose,
  onScanned,
}: {
  visible: boolean;
  onClose: () => void;
  onScanned: (wifi: WifiQr) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const done = useRef(false);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => {
        done.current = false;
      }}>
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (done.current) return;
              const wifi = parseWifiQr(data);
              if (!wifi) return;
              done.current = true;
              onScanned(wifi);
            }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 }}>
            <ScanLine size={32} color={colors.accent} />
            <MText size={15} weight="semibold" align="center">
              Allow the camera to scan a Wi-Fi code
            </MText>
            <MText size={12.5} color={colors.muted} align="center">
              {NetworkSetupCopy.scanQrHint}
            </MText>
            <CameraPageButton title="Allow camera" primary onPress={() => requestPermission()} />
          </View>
        )}
        <View style={{ position: 'absolute', top: insets.top + 12, left: insets.left + 14 }}>
          <IconButton icon={X} label="Close scanner" variant="glass" onPress={onClose} />
        </View>
        {permission?.granted ? (
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 28, alignItems: 'center' }}>
            <View style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: colors.glassStrong }}>
              <MText size={12} weight="semibold">
                Point at a Wi-Fi QR code
              </MText>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
